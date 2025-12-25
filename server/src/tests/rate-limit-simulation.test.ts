/**
 * Rate Limit Simulation Test
 * 
 * Simulates the bot's scheduled tasks over a time period and calculates
 * whether we would exceed rate limits on Hyperliquid and Lighter.
 * 
 * Based on actual rate limits:
 * - Hyperliquid: 1200 weight/minute (https://hyperliquid.gitbook.io/hyperliquid-docs)
 * - Lighter: 24,000 weight/60s for premium (https://apidocs.lighter.xyz/docs/rate-limits)
 */

// ==================== RATE LIMIT CONFIGURATION ====================

const RATE_LIMITS = {
  HYPERLIQUID: {
    maxWeightPerMinute: 1200,
    safetyBuffer: 0.8, // Use 80% to be safe
    get effectiveLimit() { return this.maxWeightPerMinute * this.safetyBuffer; }
  },
  LIGHTER: {
    maxWeightPerMinute: 24000, // Premium account
    safetyBuffer: 0.8,
    get effectiveLimit() { return this.maxWeightPerMinute * this.safetyBuffer; }
  }
};

// API weights based on exchange documentation
const WEIGHTS = {
  HYPERLIQUID: {
    INFO_LIGHT: 2,      // l2Book, allMids, clearinghouseState, orderStatus
    INFO_HEAVY: 20,     // Most other info requests
    EXCHANGE: 1,        // Order placement (+ floor(batch/40))
    USER_ROLE: 60,
  },
  LIGHTER: {
    SEND_TX: 1,         // Order placement
    INFO: 1,            // Info requests
    CANCEL: 0,          // Cancels don't consume quota
  }
};

// ==================== SCHEDULED TASKS CONFIGURATION ====================

interface ScheduledTask {
  name: string;
  intervalMs: number;
  calls: {
    exchange: 'HYPERLIQUID' | 'LIGHTER' | 'BOTH';
    operation: string;
    weight: number;
    count: number; // Number of times this call is made per task execution
    usesWebSocket?: boolean; // If true, call is skipped (no REST needed)
  }[];
}

// Current scheduled tasks from PerpKeeperScheduler.ts
const SCHEDULED_TASKS: ScheduledTask[] = [
  {
    name: 'cancelOrdersForPairedPositions',
    intervalMs: 30000, // 30s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
      { exchange: 'BOTH', operation: 'getOpenOrders', weight: 20, count: 1 },
    ]
  },
  {
    name: 'verifyRecentExecutionFills',
    intervalMs: 45000, // 45s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'checkPositionSizeBalance',
    intervalMs: 60000, // 60s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'checkProfitTaking',
    intervalMs: 120000, // 120s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'refreshCapitalMetrics',
    intervalMs: 60000, // 60s
    calls: [
      { exchange: 'BOTH', operation: 'getBalance', weight: 2, count: 1 },
    ]
  },
  {
    name: 'checkAndRetrySingleLegPositions',
    intervalMs: 90000, // 90s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'verifyPositionStateWithExchanges',
    intervalMs: 90000, // 90s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 2 }, // refresh x2
    ]
  },
  {
    name: 'updatePerformanceMetricsPeriodically',
    intervalMs: 120000, // 120s
    calls: [
      { exchange: 'BOTH', operation: 'getFundingHistory', weight: 20, count: 1 },
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'checkAndCloseUnprofitablePositions',
    intervalMs: 120000, // 120s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'verifyTrackedOrders',
    intervalMs: 180000, // 180s
    calls: [
      { exchange: 'BOTH', operation: 'getOpenOrders', weight: 20, count: 1 },
    ]
  },
  {
    name: 'cleanupStaleOrders',
    intervalMs: 300000, // 300s
    calls: [
      { exchange: 'BOTH', operation: 'getOpenOrders', weight: 20, count: 1 },
    ]
  },
  {
    name: 'syncExchangeOrderHistory',
    intervalMs: 300000, // 300s
    calls: [
      { exchange: 'BOTH', operation: 'getOrderHistory', weight: 20, count: 2 },
    ]
  },
  {
    name: 'checkSpreadRotation',
    intervalMs: 600000, // 600s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
      { exchange: 'BOTH', operation: 'getFundingRates', weight: 20, count: 1 },
    ]
  },
  {
    name: 'refreshMarketData',
    intervalMs: 900000, // 900s
    calls: [
      { exchange: 'BOTH', operation: 'getAllMarkets', weight: 20, count: 5 }, // Multiple markets
    ]
  },
];

// Simulated order activity (when actively trading)
const ORDER_ACTIVITY = {
  ordersPerHour: 20, // Estimated orders placed per hour
  cancelsPerHour: 10, // Estimated cancels per hour
  modifiesPerHour: 30, // Estimated order modifications per hour
};

// ==================== SLICED EXECUTION CONFIG ====================
// Based on server/src/domain/services/execution/SlicedExecutionService.ts
const SLICED_EXECUTION = {
  enabled: true, // NEW: Sliced execution is now wired in!
  avgSlicesPerPosition: 5, // Dynamic 2-10, assume 5 average
  fillCheckIntervalMs: 2000, // Check order status every 2s
  sliceFillTimeoutMs: 20000, // Wait up to 20s per slice
  
  // API calls per slice:
  // - 2 getMarkPrice (refresh prices before slice)
  // - 2 placeOrder (long + short)
  // - ~10 getOrderStatus calls (20s / 2s interval)
  // - 0-2 cancelOrder (if partial fill)
  
  get markPriceCallsPerSlice() { return 2; }, // Both exchanges
  get placeOrderCallsPerSlice() { return 2; }, // Long + short
  get statusChecksPerSlice() { 
    return Math.ceil(this.sliceFillTimeoutMs / this.fillCheckIntervalMs) * 2; 
  },
  get cancelCallsPerSlice() { return 0.5; }, // ~50% chance of needing cancel
  
  // Total calls per position (before: 2 orders, after: many more!)
  get callsPerPositionOld() { return 2; },
  get callsPerPositionNew() {
    return this.avgSlicesPerPosition * (
      this.markPriceCallsPerSlice +
      this.placeOrderCallsPerSlice +
      this.statusChecksPerSlice +
      this.cancelCallsPerSlice
    );
  }
};

// ==================== MAKER EFFICIENCY SERVICE CONFIG ====================
// Based on server/src/domain/services/strategy-rules/MakerEfficiencyService.ts

const MAKER_EFFICIENCY = {
  checkIntervalMs: 5000, // @Interval(5000) - runs every 5s
  
  // Per-exchange intervals for repricing (from processExchangeEfficiency)
  hyperliquidBaseIntervalMs: 5000, // 5s between order checks
  lighterBaseIntervalMs: 15000,     // 15s between order checks
  
  // How many orders typically waiting fill at any time
  avgWaitingOrdersPerExchange: 2, // Usually have 1-2 orders waiting on each side
  
  // What % of order checks actually result in a reprice?
  repriceRate: 0.3, // 30% of checks find price needs updating
  
  // API calls per reprice
  // modifyOrder: 1 call (if supported)
  // cancel+place: 2 calls (fallback)
  // Order book check: 0 calls (uses WebSocket!)
  callsPerReprice: 1, // modifyOrder is used
};

// ==================== SIMULATION ENGINE ====================

interface SimulationResult {
  exchange: string;
  simulationMinutes: number;
  totalCalls: number;
  totalWeight: number;
  weightPerMinute: number;
  limit: number;
  utilizationPercent: number;
  wouldExceedLimit: boolean;
  peakMinuteWeight: number;
  taskBreakdown: { task: string; calls: number; weight: number }[];
  operationBreakdown: { operation: string; calls: number; weight: number }[];
}

function simulateRateLimits(
  durationMinutes: number = 60,
  useWebSocketCache: boolean = false,
  activeTrading: boolean = true,
  hlWebSocketCache: boolean = false, // NEW: Hyperliquid WS cache option
): { hyperliquid: SimulationResult; lighter: SimulationResult } {
  
  const durationMs = durationMinutes * 60 * 1000;
  
  // Track calls per exchange
  const hlCalls: { task: string; operation: string; weight: number; timestamp: number }[] = [];
  const lighterCalls: { task: string; operation: string; weight: number; timestamp: number }[] = [];
  
  // Simulate scheduled tasks
  for (const task of SCHEDULED_TASKS) {
    const executions = Math.floor(durationMs / task.intervalMs);
    
    for (let i = 0; i < executions; i++) {
      const timestamp = i * task.intervalMs;
      
      for (const call of task.calls) {
        // Skip if using WebSocket cache for positions/orders
        const isPositionOrOrder = call.operation === 'getPositions' || call.operation === 'getOpenOrders';
        
        if (isPositionOrOrder) {
          // Check Lighter WebSocket cache
          if (useWebSocketCache && (call.exchange === 'LIGHTER' || call.exchange === 'BOTH')) {
            // Skip Lighter call - using WebSocket
            if (call.exchange === 'LIGHTER') continue;
            // For BOTH: Skip Lighter, but still check Hyperliquid below
          }
          
          // Check Hyperliquid WebSocket cache
          if (hlWebSocketCache && (call.exchange === 'HYPERLIQUID' || call.exchange === 'BOTH')) {
            // Skip Hyperliquid call - using WebSocket
            if (call.exchange === 'HYPERLIQUID') continue;
            if (call.exchange === 'BOTH' && useWebSocketCache) {
              // Both exchanges using WebSocket cache - skip entirely
              continue;
            }
          }
        }
        
        for (let c = 0; c < call.count; c++) {
          if (call.exchange === 'HYPERLIQUID' || call.exchange === 'BOTH') {
            // Skip if using Hyperliquid WebSocket cache for positions
            if (!(hlWebSocketCache && isPositionOrOrder)) {
              hlCalls.push({ task: task.name, operation: call.operation, weight: call.weight, timestamp });
            }
          }
          if (call.exchange === 'LIGHTER' || call.exchange === 'BOTH') {
            // Skip if using Lighter WebSocket cache for positions
            if (!(useWebSocketCache && isPositionOrOrder)) {
              lighterCalls.push({ task: task.name, operation: call.operation, weight: call.weight, timestamp });
            }
          }
        }
      }
    }
  }
  
  // Add order activity if actively trading
  if (activeTrading) {
    // ==================== SLICED EXECUTION OVERHEAD ====================
    // NEW: Sliced execution significantly increases API calls!
    // Each position now requires multiple slices with status checks
    
    const positionsPerHour = ORDER_ACTIVITY.ordersPerHour / 2; // Orders are paired
    const positionsInPeriod = Math.floor((positionsPerHour / 60) * durationMinutes);
    
    if (SLICED_EXECUTION.enabled) {
      // SLICED EXECUTION: Many more calls per position
      for (let p = 0; p < positionsInPeriod; p++) {
        const baseTimestamp = (p / positionsInPeriod) * durationMs;
        
        for (let slice = 0; slice < SLICED_EXECUTION.avgSlicesPerPosition; slice++) {
          const sliceTimestamp = baseTimestamp + (slice * SLICED_EXECUTION.sliceFillTimeoutMs);
          
          // 1. Mark price refresh (2 calls per slice - both exchanges)
          hlCalls.push({ 
            task: 'SlicedExecution', 
            operation: 'getMarkPrice', 
            weight: WEIGHTS.HYPERLIQUID.INFO_LIGHT, 
            timestamp: sliceTimestamp 
          });
          lighterCalls.push({ 
            task: 'SlicedExecution', 
            operation: 'getMarkPrice', 
            weight: WEIGHTS.LIGHTER.INFO, 
            timestamp: sliceTimestamp 
          });
          
          // 2. Place orders (2 calls per slice)
          hlCalls.push({ 
            task: 'SlicedExecution', 
            operation: 'placeOrder', 
            weight: WEIGHTS.HYPERLIQUID.EXCHANGE, 
            timestamp: sliceTimestamp 
          });
          lighterCalls.push({ 
            task: 'SlicedExecution', 
            operation: 'placeOrder', 
            weight: WEIGHTS.LIGHTER.SEND_TX, 
            timestamp: sliceTimestamp 
          });
          
          // 3. Order status checks while waiting for fill
          const statusChecks = Math.ceil(SLICED_EXECUTION.sliceFillTimeoutMs / SLICED_EXECUTION.fillCheckIntervalMs);
          for (let check = 0; check < statusChecks; check++) {
            const checkTimestamp = sliceTimestamp + (check * SLICED_EXECUTION.fillCheckIntervalMs);
            hlCalls.push({ 
              task: 'SlicedExecution', 
              operation: 'getOrderStatus', 
              weight: WEIGHTS.HYPERLIQUID.INFO_LIGHT, 
              timestamp: checkTimestamp 
            });
            lighterCalls.push({ 
              task: 'SlicedExecution', 
              operation: 'getOrderStatus', 
              weight: WEIGHTS.LIGHTER.INFO, 
              timestamp: checkTimestamp 
            });
          }
          
          // 4. Occasional cancel calls (partial fills)
          if (Math.random() < 0.3) { // 30% chance of needing cancel
            hlCalls.push({ 
              task: 'SlicedExecution', 
              operation: 'cancelOrder', 
              weight: WEIGHTS.HYPERLIQUID.EXCHANGE, 
              timestamp: sliceTimestamp + SLICED_EXECUTION.sliceFillTimeoutMs 
            });
            lighterCalls.push({ 
              task: 'SlicedExecution', 
              operation: 'cancelOrder', 
              weight: WEIGHTS.LIGHTER.CANCEL, // 0 weight for Lighter!
              timestamp: sliceTimestamp + SLICED_EXECUTION.sliceFillTimeoutMs 
            });
          }
        }
      }
    } else {
      // OLD: Simple order placement (2 calls per position)
      const ordersInPeriod = positionsInPeriod * 2;
      for (let i = 0; i < ordersInPeriod; i++) {
        const timestamp = (i / ordersInPeriod) * durationMs;
        hlCalls.push({ task: 'orderPlacement', operation: 'placeOrder', weight: WEIGHTS.HYPERLIQUID.EXCHANGE, timestamp });
        lighterCalls.push({ task: 'orderPlacement', operation: 'placeOrder', weight: WEIGHTS.LIGHTER.SEND_TX, timestamp });
      }
    }
    
    // Regular order modifications (repricing existing orders - not affected by slicing)
    const cancelsInPeriod = Math.floor((ORDER_ACTIVITY.cancelsPerHour / 60) * durationMinutes);
    const modifiesInPeriod = Math.floor((ORDER_ACTIVITY.modifiesPerHour / 60) * durationMinutes);
    
    for (let i = 0; i < cancelsInPeriod; i++) {
      const timestamp = (i / cancelsInPeriod) * durationMs;
      hlCalls.push({ task: 'orderCancel', operation: 'cancelOrder', weight: WEIGHTS.HYPERLIQUID.EXCHANGE, timestamp });
      lighterCalls.push({ task: 'orderCancel', operation: 'cancelOrder', weight: WEIGHTS.LIGHTER.CANCEL, timestamp });
    }
    
    for (let i = 0; i < modifiesInPeriod; i++) {
      const timestamp = (i / modifiesInPeriod) * durationMs;
      hlCalls.push({ task: 'orderModify', operation: 'modifyOrder', weight: WEIGHTS.HYPERLIQUID.EXCHANGE, timestamp });
      lighterCalls.push({ task: 'orderModify', operation: 'modifyOrder', weight: WEIGHTS.LIGHTER.SEND_TX, timestamp });
    }
    
    // ==================== MAKER EFFICIENCY SERVICE SIMULATION ====================
    // This service reprices orders to stay best on the book
    // Key insight: Order book checks use WebSocket (0 API cost!)
    // Only the actual modifyOrder() calls consume API weight
    
    // Calculate how many reprices would happen
    // Hyperliquid: checks every 5s, 2 orders avg, 30% actually reprice
    const hlCheckIntervalMs = MAKER_EFFICIENCY.hyperliquidBaseIntervalMs;
    const hlChecksPerOrder = Math.floor(durationMs / hlCheckIntervalMs);
    const hlTotalChecks = hlChecksPerOrder * MAKER_EFFICIENCY.avgWaitingOrdersPerExchange;
    const hlReprices = Math.floor(hlTotalChecks * MAKER_EFFICIENCY.repriceRate);
    
    // Lighter: checks every 15s, 2 orders avg, 30% actually reprice
    const lighterCheckIntervalMs = MAKER_EFFICIENCY.lighterBaseIntervalMs;
    const lighterChecksPerOrder = Math.floor(durationMs / lighterCheckIntervalMs);
    const lighterTotalChecks = lighterChecksPerOrder * MAKER_EFFICIENCY.avgWaitingOrdersPerExchange;
    const lighterReprices = Math.floor(lighterTotalChecks * MAKER_EFFICIENCY.repriceRate);
    
    // Add the reprice calls
    for (let i = 0; i < hlReprices; i++) {
      const timestamp = (i / hlReprices) * durationMs;
      hlCalls.push({ 
        task: 'MakerEfficiencyService', 
        operation: 'modifyOrder (reprice)', 
        weight: WEIGHTS.HYPERLIQUID.EXCHANGE, 
        timestamp 
      });
    }
    
    for (let i = 0; i < lighterReprices; i++) {
      const timestamp = (i / lighterReprices) * durationMs;
      lighterCalls.push({ 
        task: 'MakerEfficiencyService', 
        operation: 'modifyOrder (reprice)', 
        weight: WEIGHTS.LIGHTER.SEND_TX, 
        timestamp 
      });
    }
  }
  
  // Calculate per-minute weights to find peak
  const calculatePeakMinute = (calls: typeof hlCalls): number => {
    const minuteBuckets = new Map<number, number>();
    for (const call of calls) {
      const minute = Math.floor(call.timestamp / 60000);
      minuteBuckets.set(minute, (minuteBuckets.get(minute) || 0) + call.weight);
    }
    return Math.max(...Array.from(minuteBuckets.values()), 0);
  };
  
  // Build result for each exchange
  const buildResult = (
    exchange: string,
    calls: typeof hlCalls,
    limit: number
  ): SimulationResult => {
    const totalWeight = calls.reduce((sum, c) => sum + c.weight, 0);
    const weightPerMinute = totalWeight / durationMinutes;
    const peakMinuteWeight = calculatePeakMinute(calls);
    
    // Task breakdown
    const taskMap = new Map<string, { calls: number; weight: number }>();
    for (const call of calls) {
      const existing = taskMap.get(call.task) || { calls: 0, weight: 0 };
      existing.calls++;
      existing.weight += call.weight;
      taskMap.set(call.task, existing);
    }
    
    // Operation breakdown
    const opMap = new Map<string, { calls: number; weight: number }>();
    for (const call of calls) {
      const existing = opMap.get(call.operation) || { calls: 0, weight: 0 };
      existing.calls++;
      existing.weight += call.weight;
      opMap.set(call.operation, existing);
    }
    
    return {
      exchange,
      simulationMinutes: durationMinutes,
      totalCalls: calls.length,
      totalWeight,
      weightPerMinute: Math.round(weightPerMinute * 10) / 10,
      limit,
      utilizationPercent: Math.round((weightPerMinute / limit) * 1000) / 10,
      wouldExceedLimit: peakMinuteWeight > limit,
      peakMinuteWeight,
      taskBreakdown: Array.from(taskMap.entries())
        .map(([task, data]) => ({ task, ...data }))
        .sort((a, b) => b.weight - a.weight),
      operationBreakdown: Array.from(opMap.entries())
        .map(([operation, data]) => ({ operation, ...data }))
        .sort((a, b) => b.weight - a.weight),
    };
  };
  
  return {
    hyperliquid: buildResult('HYPERLIQUID', hlCalls, RATE_LIMITS.HYPERLIQUID.effectiveLimit),
    lighter: buildResult('LIGHTER', lighterCalls, RATE_LIMITS.LIGHTER.effectiveLimit),
  };
}

// ==================== TEST RUNNER ====================

function runSimulation() {
  console.log('='.repeat(80));
  console.log('RATE LIMIT SIMULATION TEST');
  console.log('='.repeat(80));
  console.log('\nSimulating 60 minutes of bot operation...\n');
  
  // Test 1: Without WebSocket caching (baseline)
  console.log('📊 SCENARIO 1: Without WebSocket Position Cache (Baseline)');
  console.log('-'.repeat(60));
  const withoutWS = simulateRateLimits(60, false, true, false);
  printResult(withoutWS.hyperliquid);
  printResult(withoutWS.lighter);
  
  // Test 2: With Lighter WebSocket caching only
  console.log('\n📊 SCENARIO 2: With Lighter WebSocket Cache Only');
  console.log('-'.repeat(60));
  const lighterWS = simulateRateLimits(60, true, true, false);
  printResult(lighterWS.hyperliquid);
  printResult(lighterWS.lighter);
  
  // Test 3: With BOTH exchanges using WebSocket caching (NEW!)
  console.log('\n📊 SCENARIO 3: With BOTH WebSocket Caches (Recommended!)');
  console.log('-'.repeat(60));
  const bothWS = simulateRateLimits(60, true, true, true);
  printResult(bothWS.hyperliquid);
  printResult(bothWS.lighter);
  
  // Test 4: Heavy trading scenario with both caches
  console.log('\n📊 SCENARIO 4: Heavy Trading (2x order activity) + Both WS Caches');
  console.log('-'.repeat(60));
  ORDER_ACTIVITY.ordersPerHour = 40;
  ORDER_ACTIVITY.cancelsPerHour = 20;
  ORDER_ACTIVITY.modifiesPerHour = 60;
  const heavyTrading = simulateRateLimits(60, true, true, true);
  printResult(heavyTrading.hyperliquid);
  printResult(heavyTrading.lighter);
  
  // Test 5: AGGRESSIVE MAKER REPRICING scenario
  // Simulates having 4 orders waiting and 50% reprice rate (volatile market)
  console.log('\n📊 SCENARIO 5: AGGRESSIVE Maker Repricing (Stress Test)');
  console.log('-'.repeat(60));
  ORDER_ACTIVITY.ordersPerHour = 20;
  ORDER_ACTIVITY.cancelsPerHour = 10;
  ORDER_ACTIVITY.modifiesPerHour = 30;
  MAKER_EFFICIENCY.avgWaitingOrdersPerExchange = 4; // 4 orders per side
  MAKER_EFFICIENCY.repriceRate = 0.5; // 50% of checks reprice
  const aggressiveReprice = simulateRateLimits(60, true, true, true);
  printResult(aggressiveReprice.hyperliquid);
  printResult(aggressiveReprice.lighter);
  
  // Reset to defaults
  MAKER_EFFICIENCY.avgWaitingOrdersPerExchange = 2;
  MAKER_EFFICIENCY.repriceRate = 0.3;
  
  // Test 6: Compare SLICED vs ALL-AT-ONCE execution
  console.log('\n📊 SCENARIO 6: SLICED EXECUTION vs ALL-AT-ONCE Comparison');
  console.log('-'.repeat(60));
  
  // 6a: With sliced execution (current default)
  SLICED_EXECUTION.enabled = true;
  const withSliced = simulateRateLimits(60, true, true, true);
  console.log('\n🍕 WITH SLICED EXECUTION (5 slices average):');
  printResult(withSliced.hyperliquid);
  printResult(withSliced.lighter);
  
  // 6b: Without sliced execution (old behavior)
  SLICED_EXECUTION.enabled = false;
  const withoutSliced = simulateRateLimits(60, true, true, true);
  console.log('\n⚡ WITHOUT SLICED EXECUTION (all-at-once):');
  printResult(withoutSliced.hyperliquid);
  printResult(withoutSliced.lighter);
  
  // Reset sliced to enabled (new default)
  SLICED_EXECUTION.enabled = true;
  
  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY & RECOMMENDATIONS');
  console.log('='.repeat(80));
  
  console.log('\n🔵 HYPERLIQUID (Limit: 1200/min, Using: 960/min safe limit)');
  console.log(`   Without WS cache: ${withoutWS.hyperliquid.weightPerMinute}/min (${withoutWS.hyperliquid.utilizationPercent}%)`);
  console.log(`   With WS cache:    ${bothWS.hyperliquid.weightPerMinute}/min (${bothWS.hyperliquid.utilizationPercent}%)`);
  const hlImprovement = withoutWS.hyperliquid.weightPerMinute > 0 
    ? Math.round((1 - bothWS.hyperliquid.weightPerMinute / withoutWS.hyperliquid.weightPerMinute) * 100)
    : 0;
  console.log(`   Improvement:      ${hlImprovement}% reduction ✅`);
  
  console.log('\n🟢 LIGHTER (Limit: 24000/min, Using: 19200/min safe limit)');
  console.log(`   Without WS cache: ${withoutWS.lighter.weightPerMinute}/min (${withoutWS.lighter.utilizationPercent}%)`);
  console.log(`   With WS cache:    ${bothWS.lighter.weightPerMinute}/min (${bothWS.lighter.utilizationPercent}%)`);
  const lighterImprovement = withoutWS.lighter.weightPerMinute > 0
    ? Math.round((1 - bothWS.lighter.weightPerMinute / withoutWS.lighter.weightPerMinute) * 100)
    : 0;
  console.log(`   Improvement:      ${lighterImprovement}% reduction ✅`);
  
  console.log('\n📊 TOTAL IMPROVEMENT WITH BOTH WEBSOCKET CACHES:');
  const totalBeforeWeight = withoutWS.hyperliquid.totalWeight + withoutWS.lighter.totalWeight;
  const totalAfterWeight = bothWS.hyperliquid.totalWeight + bothWS.lighter.totalWeight;
  const totalImprovement = totalBeforeWeight > 0 
    ? Math.round((1 - totalAfterWeight / totalBeforeWeight) * 100)
    : 0;
  console.log(`   Before: ${totalBeforeWeight} total weight/hour`);
  console.log(`   After:  ${totalAfterWeight} total weight/hour`);
  console.log(`   Improvement: ${totalImprovement}% reduction in API calls! 🚀`);
  
  console.log('\n📋 TOP OPERATIONS BY WEIGHT (Before WS Cache):');
  console.log('\n   Hyperliquid:');
  withoutWS.hyperliquid.operationBreakdown.slice(0, 5).forEach(op => {
    console.log(`   - ${op.operation}: ${op.calls} calls, ${op.weight} weight (${Math.round(op.weight / withoutWS.hyperliquid.totalWeight * 100)}%)`);
  });
  
  console.log('\n   Lighter:');
  withoutWS.lighter.operationBreakdown.slice(0, 5).forEach(op => {
    console.log(`   - ${op.operation}: ${op.calls} calls, ${op.weight} weight (${Math.round(op.weight / withoutWS.lighter.totalWeight * 100)}%)`);
  });
  
  console.log('\n✅ WEBSOCKET SUBSCRIPTIONS NOW ACTIVE:');
  console.log('   Hyperliquid: clearinghouseState (positions), openOrders');
  console.log('   Lighter:     account_all_positions, account_all_orders');
  
  // Sliced execution analysis
  console.log('\n' + '='.repeat(80));
  console.log('🍕 SLICED EXECUTION IMPACT ANALYSIS');
  console.log('='.repeat(80));
  
  console.log(`\n📊 API CALLS PER POSITION:`);
  console.log(`   Old (all-at-once): 2 order placements`);
  console.log(`   New (sliced, ${SLICED_EXECUTION.avgSlicesPerPosition} slices):`);
  console.log(`     - ${SLICED_EXECUTION.avgSlicesPerPosition * 2} markPrice calls`);
  console.log(`     - ${SLICED_EXECUTION.avgSlicesPerPosition * 2} placeOrder calls`);
  console.log(`     - ~${SLICED_EXECUTION.avgSlicesPerPosition * 10 * 2} getOrderStatus calls (waiting for fills)`);
  console.log(`     - ~${Math.floor(SLICED_EXECUTION.avgSlicesPerPosition * 0.3 * 2)} cancelOrder calls (partial fills)`);
  const totalNewCalls = SLICED_EXECUTION.avgSlicesPerPosition * (2 + 2 + 20 + 0.6);
  console.log(`   TOTAL: ~${Math.round(totalNewCalls)} calls vs 2 calls = ${Math.round(totalNewCalls / 2)}x increase`);
  
  console.log(`\n⚠️ SLICED EXECUTION TRADEOFFS:`);
  console.log(`   PROS:`);
  console.log(`     ✅ Limits single-leg exposure to 1 slice size`);
  console.log(`     ✅ Early abort if one side consistently fails`);
  console.log(`     ✅ Reconciliation between slices`);
  console.log(`     ✅ MARKET rollbacks guarantee close`);
  console.log(`   CONS:`);
  console.log(`     ⚠️ ${Math.round(totalNewCalls / 2)}x more API calls per position`);
  console.log(`     ⚠️ Higher rate limit pressure during trading`);
  console.log(`     ⚠️ May need to reduce scheduled task frequency`);
  
  const hlSlicedUtil = withSliced.hyperliquid.utilizationPercent;
  const lighterSlicedUtil = withSliced.lighter.utilizationPercent;
  console.log(`\n📈 RATE LIMIT IMPACT (with WS caching):`);
  console.log(`   Hyperliquid: ${withSliced.hyperliquid.weightPerMinute}/min (${hlSlicedUtil}% utilization)`);
  console.log(`   Lighter:     ${withSliced.lighter.weightPerMinute}/min (${lighterSlicedUtil}% utilization)`);
  
  if (hlSlicedUtil > 70 || lighterSlicedUtil > 70) {
    console.log(`\n🚨 RECOMMENDATION: Consider reducing:`);
    console.log(`   - SLICED_EXECUTION.avgSlicesPerPosition from 5 to 3`);
    console.log(`   - ORDER_ACTIVITY.ordersPerHour if above 20`);
    console.log(`   - Or increase fillCheckIntervalMs from 2s to 3s`);
  } else {
    console.log(`\n✅ Rate limits look OK with sliced execution enabled`);
  }
  
  // Return results for programmatic use
  return { withoutWS, lighterWS, bothWS, heavyTrading, withSliced, withoutSliced };
}

function printResult(result: SimulationResult) {
  const status = result.wouldExceedLimit ? '🔴' : result.utilizationPercent > 50 ? '🟡' : '🟢';
  
  console.log(`\n${status} ${result.exchange}`);
  console.log(`   Total calls: ${result.totalCalls} over ${result.simulationMinutes} minutes`);
  console.log(`   Total weight: ${result.totalWeight}`);
  console.log(`   Average: ${result.weightPerMinute}/min (limit: ${result.limit}/min)`);
  console.log(`   Utilization: ${result.utilizationPercent}%`);
  console.log(`   Peak minute: ${result.peakMinuteWeight}/min`);
  console.log(`   Would exceed limit: ${result.wouldExceedLimit ? 'YES ⚠️' : 'No ✅'}`);
  
  console.log(`   Top tasks by weight:`);
  result.taskBreakdown.slice(0, 3).forEach(t => {
    console.log(`     - ${t.task}: ${t.calls} calls, ${t.weight} weight`);
  });
}

// Run the simulation
const results = runSimulation();

// Export for Jest if needed
export { simulateRateLimits, SCHEDULED_TASKS, RATE_LIMITS, WEIGHTS, runSimulation };


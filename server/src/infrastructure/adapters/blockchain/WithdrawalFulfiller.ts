import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Contract, Wallet, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import type { 
  WithdrawalRequestedEvent,
  EmergencyRecallEvent,
  CapitalDeployedEvent,
  ImmediateWithdrawalEvent,
} from './KeeperStrategyEventListener';
import { 
  KEEPER_STRATEGY_EVENTS, 
  KeeperStrategyEventListener,
} from './KeeperStrategyEventListener';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import { OrderSide, OrderType, PerpOrderRequest } from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter } from '../../../domain/ports/IPerpExchangeAdapter';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { HyperliquidExchangeAdapter } from '../hyperliquid/HyperliquidExchangeAdapter';

/**
 * Withdrawal request tracking
 */
interface PendingWithdrawal {
  requestId: bigint;           // Strategy's request ID
  vaultRequestId?: bigint;     // Vault's request ID (for marking fulfilled)
  amount: bigint;
  deadline: Date;
  status: 'pending' | 'processing' | 'fulfilled' | 'failed';
  retryCount: number;
  lastError?: string;
}

/**
 * Delta-neutral position pair for unwinding
 */
interface DeltaNeutralPair {
  symbol: string;
  longPosition: PerpPosition;
  shortPosition: PerpPosition;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  combinedPnl: number;
  totalValue: number;
  // The smaller of the two sides (determines max we can reduce while staying delta-neutral)
  maxDeltaNeutralSize: number;
}

/**
 * Result of reducing a position
 */
interface PositionReductionResult {
  success: boolean;
  reducedSize: number;
  freedValue: number;
  error?: string;
}

/**
 * WithdrawalFulfiller - Handles withdrawal requests from KeeperStrategyManager
 * 
 * Responsibilities:
 * 1. Listen for WithdrawalRequested events
 * 2. Coordinate position unwinding across exchanges
 * 3. Bridge USDC back to HyperEVM
 * 4. Call fulfillWithdrawal() on the contract
 */
@Injectable()
export class WithdrawalFulfiller implements OnModuleInit {
  private readonly logger = new Logger(WithdrawalFulfiller.name);
  
  private wallet: Wallet | null = null;
  private provider: JsonRpcProvider | null = null;
  private contract: Contract | null = null;
  
  // Queue of pending withdrawal requests
  private readonly pendingWithdrawals: Map<string, PendingWithdrawal> = new Map();
  
  // Emergency mode flag
  private emergencyMode = false;

  // Contract ABI for fulfillment and capital management
  private readonly CONTRACT_ABI = [
    'function fulfillWithdrawal(uint256 requestId) external',
    'function fulfillWithdrawalBatch(uint256[] calldata requestIds) external',
    'function getWithdrawalRequest(uint256 requestId) external view returns (tuple(uint256 id, uint256 amount, uint256 requestedAt, uint256 deadline, bool fulfilled, bool cancelled))',
    'function withdrawToKeeper(uint256 amount) external',
    'function getIdleBalance() external view returns (uint256)',
    'function pendingWithdrawals() external view returns (uint256)',
  ];

  // USDC contract ABI for transfers
  private readonly ERC20_ABI = [
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function balanceOf(address account) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
  ];

  private readonly strategyAddress: string;
  private readonly usdcAddress: string;
  private readonly rpcUrl: string;
  private readonly vaultAddress: string;

  // Vault contract ABI for marking withdrawals fulfilled
  private readonly VAULT_ABI = [
    'function markWithdrawalFulfilled(uint256 requestId) external',
    'function markWithdrawalsFulfilledBatch(uint256[] calldata requestIds) external',
  ];
  
  private vaultContract: Contract | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly eventListener?: KeeperStrategyEventListener,
    @Optional() @Inject(forwardRef(() => HyperliquidExchangeAdapter)) 
    private readonly hyperliquidAdapter?: HyperliquidExchangeAdapter,
    @Optional() @Inject(forwardRef(() => PerpKeeperService))
    private readonly perpKeeperService?: PerpKeeperService,
  ) {
    this.strategyAddress = this.configService.get<string>('KEEPER_STRATEGY_ADDRESS', '');
    this.vaultAddress = this.configService.get<string>('BLOOM_VAULT_ADDRESS', '');
    this.usdcAddress = this.configService.get<string>('USDC_ADDRESS', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'); // Arbitrum native USDC
    this.rpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc');
  }

  async onModuleInit() {
    if (!this.strategyAddress) {
      this.logger.warn('KEEPER_STRATEGY_ADDRESS not configured, withdrawal fulfiller disabled');
      return;
    }

    await this.initialize();
  }

  /**
   * Initialize wallet and contract connections
   */
  private async initialize(): Promise<void> {
    const privateKey = this.configService.get<string>('KEEPER_PRIVATE_KEY') || 
                       this.configService.get<string>('PRIVATE_KEY');
    
    if (!privateKey) {
      this.logger.warn('KEEPER_PRIVATE_KEY/PRIVATE_KEY not configured, cannot fulfill withdrawals');
      return;
    }

    try {
      this.provider = new JsonRpcProvider(this.rpcUrl);
      this.wallet = new Wallet(privateKey, this.provider);
      this.contract = new Contract(this.strategyAddress, this.CONTRACT_ABI, this.wallet);
      
      // Initialize vault contract if address is configured
      if (this.vaultAddress) {
        this.vaultContract = new Contract(this.vaultAddress, this.VAULT_ABI, this.wallet);
      }

      // Subscribe to events from the event listener
      if (this.eventListener) {
        this.eventListener.events.on(
          KEEPER_STRATEGY_EVENTS.WITHDRAWAL_REQUESTED, 
          (event: WithdrawalRequestedEvent) => this.handleWithdrawalRequested(event),
        );
        this.eventListener.events.on(
          KEEPER_STRATEGY_EVENTS.EMERGENCY_RECALL,
          (event: EmergencyRecallEvent) => this.handleEmergencyRecall(event),
        );
        this.eventListener.events.on(
          KEEPER_STRATEGY_EVENTS.CAPITAL_DEPLOYED,
          (event: CapitalDeployedEvent) => this.processCapitalDeployment(event.deploymentId, event.amount),
        );
        this.eventListener.events.on(
          KEEPER_STRATEGY_EVENTS.IMMEDIATE_WITHDRAWAL,
          (event: ImmediateWithdrawalEvent) => this.handleImmediateWithdrawal(event),
        );
      }

      this.logger.log(`WithdrawalFulfiller initialized for strategy: ${this.strategyAddress}`);
      this.logger.log(`Vault address: ${this.vaultAddress || 'not configured'}`);
      this.logger.log(`Keeper address: ${this.wallet.address}`);
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle WithdrawalRequested events
   */
  async handleWithdrawalRequested(event: WithdrawalRequestedEvent): Promise<void> {
    const requestIdStr = event.requestId.toString();

    // Check if already tracking this request
    if (this.pendingWithdrawals.has(requestIdStr)) {
      this.logger.debug(`Already tracking withdrawal request ${requestIdStr}`);
      return;
    }

    const withdrawal: PendingWithdrawal = {
      requestId: event.requestId,
      vaultRequestId: event.vaultRequestId,  // Correlated vault request ID
      amount: event.amount,
      deadline: new Date(Number(event.deadline) * 1000),
      status: 'pending',
      retryCount: 0,
    };

    this.pendingWithdrawals.set(requestIdStr, withdrawal);

    this.logger.log(
      `📋 Queued withdrawal request (strategy: ${requestIdStr}, vault: ${event.vaultRequestId ?? 'unknown'}): ${formatUnits(event.amount, 6)} USDC, deadline: ${withdrawal.deadline.toISOString()}`,
    );

    // Start processing immediately if not in emergency mode
    if (!this.emergencyMode) {
      await this.processWithdrawal(withdrawal);
    }
  }

  /**
   * Handle EmergencyRecall events
   */
  async handleEmergencyRecall(event: EmergencyRecallEvent): Promise<void> {
    this.emergencyMode = true;
    
    this.logger.error(
      `🚨 EMERGENCY MODE ACTIVATED - Must return ${formatUnits(event.totalDeployed, 6)} USDC`,
    );

    // TODO: Implement emergency position closing
    // This should:
    // 1. Close ALL positions across all exchanges
    // 2. Withdraw ALL funds from exchanges
    // 3. Bridge everything back to HyperEVM
    // 4. Fulfill all pending withdrawals
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WITHDRAWAL PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process a single withdrawal request
   * 
   * Full flow:
   * 1. Check idle USDC on keeper wallet
   * 2. If insufficient, unwind positions (least profitable first)
   * 3. Withdraw from exchange to Arbitrum
   * 4. Wait for funds to arrive
   * 5. Transfer USDC to strategy contract
   * 6. Call strategy.fulfillWithdrawal()
   * 7. Call vault.markWithdrawalFulfilled()
   */
  async processWithdrawal(withdrawal: PendingWithdrawal): Promise<boolean> {
    const requestIdStr = withdrawal.requestId.toString();
    
    try {
      withdrawal.status = 'processing';
      
      this.logger.log(`\n${'═'.repeat(60)}`);
      this.logger.log(`Processing withdrawal ${requestIdStr}: ${formatUnits(withdrawal.amount, 6)} USDC`);
      this.logger.log(`${'═'.repeat(60)}`);

      // Step 1: Check if we have enough idle USDC on the keeper wallet (Arbitrum)
      let idleBalance = await this.getKeeperUsdcBalance();
      const requiredAmount = withdrawal.amount;

      this.logger.log(
        `Step 1: Check idle balance - Have: ${formatUnits(idleBalance, 6)} USDC, Need: ${formatUnits(requiredAmount, 6)} USDC`,
      );

      // Step 2: If insufficient, unwind positions and withdraw from exchanges
      if (idleBalance < requiredAmount) {
        const shortfall = requiredAmount - idleBalance;
        this.logger.log(`Step 2: Shortfall of ${formatUnits(shortfall, 6)} USDC - need to unwind positions`);
        
        const unwoundAmount = await this.unwindPositionsForWithdrawal(shortfall);
        
        if (unwoundAmount < shortfall) {
          this.logger.warn(
            `Could only free up ${formatUnits(unwoundAmount, 6)} USDC, still short ${formatUnits(shortfall - unwoundAmount, 6)} USDC`,
          );
          // Continue anyway - we'll fulfill what we can
        }
        
        // Re-check balance after unwinding
        idleBalance = await this.getKeeperUsdcBalance();
        this.logger.log(`Balance after unwinding: ${formatUnits(idleBalance, 6)} USDC`);
      }

      // Step 3: Transfer USDC to strategy contract
      const transferAmount = idleBalance < requiredAmount ? idleBalance : requiredAmount;
      
      if (transferAmount === 0n) {
        withdrawal.status = 'pending';
        withdrawal.lastError = 'No funds available to fulfill withdrawal';
        return false;
      }
      
      this.logger.log(`Step 3: Transferring ${formatUnits(transferAmount, 6)} USDC to strategy...`);
      await this.transferUsdcToStrategy(transferAmount);

      // Step 4: Call fulfillWithdrawal on strategy contract
      this.logger.log(`Step 4: Calling strategy.fulfillWithdrawal(${requestIdStr})...`);
      await this.callFulfillWithdrawal(withdrawal.requestId);

      // Step 5: Mark vault withdrawal as fulfilled (using vault's request ID)
      if (this.vaultContract && withdrawal.vaultRequestId !== undefined) {
        this.logger.log(`Step 5: Calling vault.markWithdrawalFulfilled(${withdrawal.vaultRequestId})...`);
        await this.markVaultWithdrawalFulfilled(withdrawal.vaultRequestId);
      } else if (this.vaultContract) {
        this.logger.warn(`Step 5: Vault request ID not available, cannot mark fulfilled`);
      }

      // Success
      withdrawal.status = 'fulfilled';
      this.pendingWithdrawals.delete(requestIdStr);
      
      this.logger.log(`\n✅ Withdrawal ${requestIdStr} fulfilled successfully!`);
      this.logger.log(`${'═'.repeat(60)}\n`);
      return true;

    } catch (error: any) {
      withdrawal.status = 'failed';
      withdrawal.retryCount++;
      withdrawal.lastError = error.message;
      
      this.logger.error(`❌ Failed to process withdrawal ${requestIdStr}: ${error.message}`);

      // Retry if not past deadline and under retry limit
      if (withdrawal.retryCount < 3 && new Date() < withdrawal.deadline) {
        this.logger.log(`Will retry withdrawal ${requestIdStr} (attempt ${withdrawal.retryCount + 1}/3)`);
        withdrawal.status = 'pending';
      }

      return false;
    }
  }

  /**
   * Unwind positions to free up USDC for withdrawal
   * 
   * DELTA-NEUTRAL STRATEGY:
   * For funding rate arbitrage, positions come in pairs:
   *   - LONG on one exchange (e.g., Hyperliquid)
   *   - SHORT on another exchange (e.g., Lighter)
   * 
   * To maintain delta neutrality, we must close BOTH legs proportionally.
   * We prioritize closing the least profitable pairs first.
   */
  private async unwindPositionsForWithdrawal(amountNeeded: bigint): Promise<bigint> {
    let totalFreed = 0n;
    const amountNeededNum = Number(formatUnits(amountNeeded, 6));
    
    this.logger.log(`\n${'═'.repeat(60)}`);
    this.logger.log(`🔄 DELTA-NEUTRAL UNWINDING: Need $${amountNeededNum.toFixed(2)} USDC`);
    this.logger.log(`${'═'.repeat(60)}\n`);
    
    // Step 1: Get all positions from all exchanges
    const allPositions = await this.getAllPositionsFromAllExchanges();
    
    if (allPositions.length === 0) {
      this.logger.log('No positions found across any exchange');
      return totalFreed;
    }
    
    this.logger.log(`Found ${allPositions.length} position(s) across all exchanges:`);
    for (const pos of allPositions) {
      this.logger.log(
        `  - ${pos.exchangeType}: ${pos.symbol} ${pos.side} ${Math.abs(pos.size).toFixed(4)} @ $${pos.markPrice.toFixed(2)}, PnL: $${pos.unrealizedPnl.toFixed(2)}`,
      );
    }
    
    // Step 2: Group positions by symbol to find delta-neutral pairs
    const positionsBySymbol = this.groupPositionsBySymbol(allPositions);
    
    // Step 3: Identify delta-neutral pairs and calculate their combined PnL
    const deltaNeutralPairs = this.identifyDeltaNeutralPairs(positionsBySymbol);
    
    // Step 4: Sort pairs by combined PnL (least profitable first)
    deltaNeutralPairs.sort((a, b) => a.combinedPnl - b.combinedPnl);
    
    this.logger.log(`\nIdentified ${deltaNeutralPairs.length} delta-neutral pair(s):`);
    for (const pair of deltaNeutralPairs) {
      this.logger.log(
        `  - ${pair.symbol}: ${pair.longExchange}(LONG) + ${pair.shortExchange}(SHORT), Combined PnL: $${pair.combinedPnl.toFixed(2)}, Value: $${pair.totalValue.toFixed(2)}`,
      );
    }
    
    // Step 5: REDUCE pairs (not close entirely) starting from least profitable until we have enough
    const exchangesWithFreedCapital = new Set<ExchangeType>();
    let freedFromClosing = 0;
    const remainingNeeded = () => amountNeededNum - freedFromClosing;
    
    for (const pair of deltaNeutralPairs) {
      if (freedFromClosing >= amountNeededNum) break;
      
      // Calculate how much to reduce (only what we need, not the whole position)
      const reductionNeeded = remainingNeeded();
      const avgPrice = pair.longPosition.markPrice; // Both sides have same underlying price
      
      // How much size do we need to reduce to free up the required amount?
      // Each unit of size freed = avgPrice USD (from each leg, so 2x total)
      const sizeToReduce = Math.min(
        reductionNeeded / (2 * avgPrice), // Only reduce what we need
        pair.maxDeltaNeutralSize,          // Can't reduce more than smallest leg
      );
      
      const isFullClose = sizeToReduce >= pair.maxDeltaNeutralSize * 0.99; // 99% = effectively full close
      const actionWord = isFullClose ? 'Closing' : 'Reducing';
      const reductionPercent = (sizeToReduce / pair.maxDeltaNeutralSize * 100).toFixed(1);
      
      this.logger.log(`\n${actionWord} delta-neutral pair: ${pair.symbol} (${reductionPercent}% reduction, Combined PnL: $${pair.combinedPnl.toFixed(2)})...`);
      this.logger.log(`  Size to reduce: ${sizeToReduce.toFixed(4)} (of ${pair.maxDeltaNeutralSize.toFixed(4)} max)`);
      
      try {
        // Reduce BOTH legs simultaneously to maintain delta neutrality
        const reduceResults = await Promise.allSettled([
          this.reducePosition(pair.longPosition, pair.longExchange, sizeToReduce),
          this.reducePosition(pair.shortPosition, pair.shortExchange, sizeToReduce),
        ]);
        
        let totalFreedFromPair = 0;
        for (let i = 0; i < reduceResults.length; i++) {
          const result = reduceResults[i];
          const exchange = i === 0 ? pair.longExchange : pair.shortExchange;
          const side = i === 0 ? 'LONG' : 'SHORT';
          
          if (result.status === 'fulfilled' && result.value.success) {
            this.logger.log(`  ✅ Reduced ${side} leg on ${exchange} by ${result.value.reducedSize.toFixed(4)}`);
            exchangesWithFreedCapital.add(exchange);
            totalFreedFromPair += result.value.freedValue;
          } else {
            const error = result.status === 'rejected' ? result.reason : result.value.error;
            this.logger.warn(`  ❌ Failed to reduce ${side} leg on ${exchange}: ${error}`);
          }
        }
        
        if (totalFreedFromPair > 0) {
          freedFromClosing += totalFreedFromPair;
          this.logger.log(`  💰 Freed ~$${totalFreedFromPair.toFixed(2)} from ${actionWord.toLowerCase()} pair`);
        }
      } catch (pairError: any) {
        this.logger.warn(`Failed to reduce pair ${pair.symbol}: ${pairError.message}`);
      }
      
      // Small delay between reductions
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Step 6: Also reduce any unpaired positions (least profitable first)
    const unpairedPositions = this.getUnpairedPositions(allPositions, deltaNeutralPairs);
    if (unpairedPositions.length > 0 && freedFromClosing < amountNeededNum) {
      this.logger.log(`\nReducing ${unpairedPositions.length} unpaired position(s)...`);
      
      // Sort by PnL (least profitable first)
      unpairedPositions.sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);
      
      for (const position of unpairedPositions) {
        if (freedFromClosing >= amountNeededNum) break;
        
        const positionSize = Math.abs(position.size);
        const positionValue = positionSize * position.markPrice;
        
        // Calculate how much to reduce
        const reductionNeeded = remainingNeeded();
        const sizeToReduce = Math.min(
          reductionNeeded / position.markPrice,
          positionSize,
        );
        
        const isFullClose = sizeToReduce >= positionSize * 0.99;
        
        try {
          const result = await this.reducePosition(position, position.exchangeType, sizeToReduce);
          if (result.success) {
            freedFromClosing += result.freedValue;
            exchangesWithFreedCapital.add(position.exchangeType);
            const action = isFullClose ? 'Closed' : 'Reduced';
            this.logger.log(`  ✅ ${action} unpaired ${position.symbol} on ${position.exchangeType}, freed ~$${result.freedValue.toFixed(2)}`);
          }
        } catch (closeError: any) {
          this.logger.warn(`  ❌ Failed to reduce ${position.symbol}: ${closeError.message}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    // Step 7: Withdraw freed capital from all exchanges where we closed positions
    this.logger.log(`\nWithdrawing freed capital from ${exchangesWithFreedCapital.size} exchange(s)...`);
    
    for (const exchangeType of exchangesWithFreedCapital) {
      try {
        const withdrawn = await this.withdrawFromExchange(exchangeType, amountNeededNum - Number(formatUnits(totalFreed, 6)));
        if (withdrawn > 0) {
          totalFreed += parseUnits(withdrawn.toFixed(6), 6);
          this.logger.log(`  ✅ Withdrew $${withdrawn.toFixed(2)} from ${exchangeType}`);
        }
      } catch (withdrawError: any) {
        this.logger.warn(`  ❌ Failed to withdraw from ${exchangeType}: ${withdrawError.message}`);
      }
    }
    
    this.logger.log(`\n${'═'.repeat(60)}`);
    this.logger.log(`🔄 UNWINDING COMPLETE: Freed $${formatUnits(totalFreed, 6)} USDC`);
    this.logger.log(`${'═'.repeat(60)}\n`);
    
    return totalFreed;
  }

  /**
   * Get positions from all available exchanges
   */
  private async getAllPositionsFromAllExchanges(): Promise<PerpPosition[]> {
    const allPositions: PerpPosition[] = [];
    
    // Try PerpKeeperService first (has all adapters)
    if (this.perpKeeperService) {
      try {
        const positions = await this.perpKeeperService.getAllPositions();
        allPositions.push(...positions);
        return allPositions;
      } catch (error: any) {
        this.logger.warn(`PerpKeeperService.getAllPositions failed: ${error.message}`);
      }
    }
    
    // Fallback to individual adapter
    if (this.hyperliquidAdapter) {
      try {
        const positions = await this.hyperliquidAdapter.getPositions();
        allPositions.push(...positions);
      } catch (error: any) {
        this.logger.warn(`Hyperliquid getPositions failed: ${error.message}`);
      }
    }
    
    return allPositions;
  }

  /**
   * Group positions by symbol
   */
  private groupPositionsBySymbol(positions: PerpPosition[]): Map<string, PerpPosition[]> {
    const grouped = new Map<string, PerpPosition[]>();
    
    for (const position of positions) {
      const symbol = position.symbol;
      if (!grouped.has(symbol)) {
        grouped.set(symbol, []);
      }
      grouped.get(symbol)!.push(position);
    }
    
    return grouped;
  }

  /**
   * Identify delta-neutral pairs (same symbol, opposite sides on different exchanges)
   */
  private identifyDeltaNeutralPairs(positionsBySymbol: Map<string, PerpPosition[]>): DeltaNeutralPair[] {
    const pairs: DeltaNeutralPair[] = [];
    
    for (const [symbol, positions] of positionsBySymbol) {
      // Find long and short positions
      const longs = positions.filter(p => p.side === OrderSide.LONG);
      const shorts = positions.filter(p => p.side === OrderSide.SHORT);
      
      // Match longs with shorts on different exchanges
      for (const longPos of longs) {
        for (const shortPos of shorts) {
          // Must be on different exchanges for delta-neutral arb
          if (longPos.exchangeType !== shortPos.exchangeType) {
            const longSize = Math.abs(longPos.size);
            const shortSize = Math.abs(shortPos.size);
            const longValue = longSize * longPos.markPrice;
            const shortValue = shortSize * shortPos.markPrice;
            
            // The max we can reduce while staying delta-neutral is the smaller of the two
            const maxDeltaNeutralSize = Math.min(longSize, shortSize);
            
            pairs.push({
              symbol,
              longPosition: longPos,
              shortPosition: shortPos,
              longExchange: longPos.exchangeType,
              shortExchange: shortPos.exchangeType,
              combinedPnl: longPos.unrealizedPnl + shortPos.unrealizedPnl,
              totalValue: longValue + shortValue,
              maxDeltaNeutralSize,
            });
          }
        }
      }
    }
    
    return pairs;
  }

  /**
   * Get positions that are not part of any delta-neutral pair
   */
  private getUnpairedPositions(allPositions: PerpPosition[], pairs: DeltaNeutralPair[]): PerpPosition[] {
    const pairedPositionIds = new Set<string>();
    
    for (const pair of pairs) {
      pairedPositionIds.add(`${pair.longExchange}-${pair.symbol}-LONG`);
      pairedPositionIds.add(`${pair.shortExchange}-${pair.symbol}-SHORT`);
    }
    
    return allPositions.filter(pos => {
      const id = `${pos.exchangeType}-${pos.symbol}-${pos.side}`;
      return !pairedPositionIds.has(id);
    });
  }

  /**
   * Reduce a position by a specific size (not necessarily close entirely)
   * 
   * @param position - The position to reduce
   * @param exchangeType - The exchange where the position is
   * @param sizeToReduce - How much size to reduce (0 < sizeToReduce <= position.size)
   * @returns Result with success status and freed value
   */
  private async reducePosition(
    position: PerpPosition, 
    exchangeType: ExchangeType,
    sizeToReduce: number,
  ): Promise<PositionReductionResult> {
    const adapter = await this.getAdapterForExchange(exchangeType);
    if (!adapter) {
      return {
        success: false,
        reducedSize: 0,
        freedValue: 0,
        error: `No adapter available for ${exchangeType}`,
      };
    }
    
    const positionSize = Math.abs(position.size);
    
    // Validate reduction size
    if (sizeToReduce <= 0) {
      return {
        success: false,
        reducedSize: 0,
        freedValue: 0,
        error: 'Reduction size must be positive',
      };
    }
    
    // Cap at position size
    const actualReduction = Math.min(sizeToReduce, positionSize);
    
    // Determine order side (opposite of position side to reduce)
    const reduceSide = position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
    
    try {
      const reduceOrder = new PerpOrderRequest(
        position.symbol,
        reduceSide,
        OrderType.MARKET,
        actualReduction,
        undefined,
        undefined,
        true, // reduceOnly - important! This ensures we only reduce, not flip
      );
      
      await adapter.placeOrder(reduceOrder);
      
      // Calculate freed value (margin released)
      const freedValue = actualReduction * position.markPrice;
      
      return {
        success: true,
        reducedSize: actualReduction,
        freedValue,
      };
    } catch (error: any) {
      return {
        success: false,
        reducedSize: 0,
        freedValue: 0,
        error: error.message,
      };
    }
  }

  /**
   * Close a single position entirely on an exchange
   * Convenience method that reduces by full position size
   */
  private async closePosition(position: PerpPosition, exchangeType: ExchangeType): Promise<PositionReductionResult> {
    return this.reducePosition(position, exchangeType, Math.abs(position.size));
  }

  /**
   * Get adapter for a specific exchange
   */
  private async getAdapterForExchange(exchangeType: ExchangeType): Promise<IPerpExchangeAdapter | null> {
    // Try PerpKeeperService first
    if (this.perpKeeperService) {
      try {
        const adapter = this.perpKeeperService.getExchangeAdapter(exchangeType);
        if (adapter) return adapter;
      } catch (error: any) {
        // getExchangeAdapter throws if not found, that's ok
      }
    }
    
    // Fallback to direct adapters
    if (exchangeType === ExchangeType.HYPERLIQUID && this.hyperliquidAdapter) {
      return this.hyperliquidAdapter;
    }
    
    return null;
  }

  /**
   * Withdraw USDC from an exchange to Arbitrum
   */
  private async withdrawFromExchange(exchangeType: ExchangeType, maxAmount: number): Promise<number> {
    const adapter = await this.getAdapterForExchange(exchangeType);
    if (!adapter) {
      this.logger.warn(`No adapter for ${exchangeType}, cannot withdraw`);
      return 0;
    }
    
    try {
      const availableBalance = await adapter.getBalance();
      const minBalance = 1; // Keep minimum for fees
      
      if (availableBalance <= minBalance) {
        this.logger.debug(`${exchangeType} balance ($${availableBalance.toFixed(2)}) too low to withdraw`);
        return 0;
      }
      
      const withdrawAmount = Math.min(availableBalance - minBalance, maxAmount);
      
      if (withdrawAmount <= minBalance) {
        return 0;
      }
      
      this.logger.log(`Withdrawing $${withdrawAmount.toFixed(2)} from ${exchangeType}...`);
      
      const keeperAddress = this.wallet?.address;
      if (!keeperAddress) {
        this.logger.warn('No keeper address available for withdrawal');
        return 0;
      }
      
      // Different exchanges have different withdrawal methods
      if (exchangeType === ExchangeType.HYPERLIQUID && this.hyperliquidAdapter) {
        await this.hyperliquidAdapter.withdrawExternal(withdrawAmount, 'USDC', keeperAddress);
      } else if ('withdrawExternal' in adapter) {
        await (adapter as any).withdrawExternal(withdrawAmount, 'USDC', keeperAddress);
      } else {
        this.logger.warn(`${exchangeType} does not support external withdrawals`);
        return 0;
      }
      
      // Wait for funds to arrive
      const startBalance = await this.getKeeperUsdcBalance();
      const maxWait = 120000; // 2 minutes
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const currentBalance = await this.getKeeperUsdcBalance();
        if (currentBalance > startBalance) {
          const received = Number(formatUnits(currentBalance - startBalance, 6));
          this.logger.log(`✅ Received $${received.toFixed(2)} on Arbitrum from ${exchangeType}`);
          return received;
        }
        
        this.logger.debug(`Waiting for ${exchangeType} withdrawal... (${Math.floor((Date.now() - startTime) / 1000)}s)`);
      }
      
      this.logger.warn(`Timeout waiting for ${exchangeType} withdrawal`);
      return 0;
    } catch (error: any) {
      this.logger.error(`Failed to withdraw from ${exchangeType}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Mark withdrawal as fulfilled on the vault contract
   */
  private async markVaultWithdrawalFulfilled(requestId: bigint): Promise<void> {
    if (!this.vaultContract) {
      this.logger.warn('Vault contract not initialized');
      return;
    }

    const tx = await this.vaultContract.markWithdrawalFulfilled(requestId);
    this.logger.debug(`Mark fulfilled tx: ${tx.hash}`);

    const receipt = await tx.wait();
    this.logger.debug(`Mark fulfilled confirmed in block ${receipt.blockNumber}`);
  }

  /**
   * Handle ImmediateWithdrawal event - strategy had idle funds and fulfilled immediately
   * We need to mark the corresponding vault request(s) as fulfilled
   */
  async handleImmediateWithdrawal(event: ImmediateWithdrawalEvent): Promise<void> {
    this.logger.log(
      `⚡ Processing ImmediateWithdrawal: ${formatUnits(event.amount, 6)} USDC`,
    );

    if (!this.vaultContract) {
      this.logger.warn('Vault contract not initialized, cannot mark vault requests as fulfilled');
      return;
    }

    try {
      // Get pending vault requests and mark them as fulfilled
      // We need to find requests that match the amount and aren't fulfilled yet
      const vaultAbi = [
        'function getPendingRequests() view returns (tuple(uint256 id, address user, uint256 assets, uint256 shares, uint256 requestedAt, bool fulfilled, bool claimed)[])',
        'function markWithdrawalFulfilled(uint256 requestId)',
      ];
      
      const vault = new Contract(this.vaultAddress, vaultAbi, this.wallet!);
      const pendingRequests = await vault.getPendingRequests();
      
      // Find unfulfilled requests to mark
      let remainingAmount = event.amount;
      
      for (const req of pendingRequests) {
        if (remainingAmount <= 0n) break;
        
        if (!req.fulfilled && req.assets <= remainingAmount) {
          this.logger.log(`Marking vault request ${req.id} as fulfilled (${formatUnits(req.assets, 6)} USDC)`);
          
          try {
            const tx = await vault.markWithdrawalFulfilled(req.id);
            await tx.wait();
            this.logger.log(`✅ Vault request ${req.id} marked as fulfilled`);
            remainingAmount -= req.assets;
          } catch (markError: any) {
            this.logger.warn(`Failed to mark request ${req.id}: ${markError.message}`);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to process ImmediateWithdrawal: ${error.message}`);
    }
  }

  /**
   * Get USDC balance on keeper wallet (on HyperEVM)
   */
  private async getKeeperUsdcBalance(): Promise<bigint> {
    if (!this.wallet || !this.provider) {
      throw new Error('Wallet not initialized');
    }

    const usdc = new Contract(this.usdcAddress, this.ERC20_ABI, this.provider);
    return await usdc.balanceOf(this.wallet.address);
  }

  /**
   * Transfer USDC from keeper wallet to strategy contract
   */
  private async transferUsdcToStrategy(amount: bigint): Promise<void> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }

    this.logger.log(`Transferring ${formatUnits(amount, 6)} USDC to strategy...`);

    const usdc = new Contract(this.usdcAddress, this.ERC20_ABI, this.wallet);
    
    const tx = await usdc.transfer(this.strategyAddress, amount);
    this.logger.debug(`Transfer tx: ${tx.hash}`);
    
    const receipt = await tx.wait();
    this.logger.debug(`Transfer confirmed in block ${receipt.blockNumber}`);
  }

  /**
   * Call fulfillWithdrawal on the strategy contract
   */
  private async callFulfillWithdrawal(requestId: bigint): Promise<void> {
    if (!this.contract) {
      throw new Error('Contract not initialized');
    }

    this.logger.log(`Calling fulfillWithdrawal(${requestId})...`);

    const tx = await this.contract.fulfillWithdrawal(requestId);
    this.logger.debug(`Fulfill tx: ${tx.hash}`);

    const receipt = await tx.wait();
    this.logger.debug(`Fulfill confirmed in block ${receipt.blockNumber}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BATCH PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process all pending withdrawals that are due
   * Called periodically by the scheduler
   */
  async processPendingWithdrawals(): Promise<{
    processed: number;
    fulfilled: number;
    failed: number;
  }> {
    const results = { processed: 0, fulfilled: 0, failed: 0 };
    
    const now = new Date();
    const pendingList = Array.from(this.pendingWithdrawals.values())
      .filter(w => w.status === 'pending' && w.deadline > now);

    if (pendingList.length === 0) {
      return results;
    }

    this.logger.log(`Processing ${pendingList.length} pending withdrawal(s)...`);

    for (const withdrawal of pendingList) {
      results.processed++;
      
      const success = await this.processWithdrawal(withdrawal);
      if (success) {
        results.fulfilled++;
      } else {
        results.failed++;
      }

      // Small delay between withdrawals
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * Batch fulfill multiple withdrawal requests
   */
  async fulfillBatch(requestIds: bigint[]): Promise<void> {
    if (!this.contract || requestIds.length === 0) return;

    this.logger.log(`Batch fulfilling ${requestIds.length} withdrawal(s)...`);

    const tx = await this.contract.fulfillWithdrawalBatch(requestIds);
    this.logger.debug(`Batch fulfill tx: ${tx.hash}`);

    const receipt = await tx.wait();
    this.logger.log(`Batch fulfill confirmed in block ${receipt.blockNumber}`);

    // Remove fulfilled from pending
    for (const requestId of requestIds) {
      this.pendingWithdrawals.delete(requestId.toString());
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC GETTERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get list of pending withdrawal requests
   */
  getPendingWithdrawalsList(): PendingWithdrawal[] {
    return Array.from(this.pendingWithdrawals.values());
  }

  /**
   * Get total amount of pending withdrawals
   */
  getTotalPendingAmount(): bigint {
    let total = 0n;
    for (const w of this.pendingWithdrawals.values()) {
      if (w.status !== 'fulfilled') {
        total += w.amount;
      }
    }
    return total;
  }

  /**
   * Check if in emergency mode
   */
  isEmergencyMode(): boolean {
    return this.emergencyMode;
  }

  /**
   * Get keeper wallet address
   */
  getKeeperAddress(): string | null {
    return this.wallet?.address || null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAPITAL DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Withdraw funds from contract to keeper wallet for deployment on exchanges
   * Called when CapitalDeployed event is received
   */
  async withdrawCapitalToKeeper(amount: bigint): Promise<boolean> {
    if (!this.contract || !this.wallet) {
      this.logger.warn('Contract not initialized, cannot withdraw capital');
      return false;
    }

    try {
      this.logger.log(`Withdrawing ${formatUnits(amount, 6)} USDC from contract to keeper...`);

      const tx = await this.contract.withdrawToKeeper(amount);
      this.logger.debug(`WithdrawToKeeper tx: ${tx.hash}`);

      const receipt = await tx.wait();
      this.logger.log(`✅ Capital withdrawn to keeper in block ${receipt.blockNumber}`);

      return true;
    } catch (error: any) {
      this.logger.error(`Failed to withdraw capital: ${error.message}`);
      return false;
    }
  }

  /**
   * Get available capital that can be withdrawn (idle - pending withdrawals)
   */
  async getAvailableCapital(): Promise<bigint> {
    if (!this.contract) {
      return 0n;
    }

    try {
      const [idleBalance, pendingWithdrawals] = await Promise.all([
        this.contract.getIdleBalance(),
        this.contract.pendingWithdrawals(),
      ]);

      const idle = BigInt(idleBalance);
      const pending = BigInt(pendingWithdrawals);

      return idle > pending ? idle - pending : 0n;
    } catch (error: any) {
      this.logger.warn(`Failed to get available capital: ${error.message}`);
      return 0n;
    }
  }

  /**
   * Process newly deployed capital - withdraw to keeper for exchange deployment
   * Called when CapitalDeployed event is received
   */
  async processCapitalDeployment(deploymentId: bigint, amount: bigint): Promise<void> {
    this.logger.log(
      `📥 Processing capital deployment #${deploymentId}: ${formatUnits(amount, 6)} USDC`,
    );

    // Check available capital
    const available = await this.getAvailableCapital();
    
    if (available < amount) {
      this.logger.warn(
        `Only ${formatUnits(available, 6)} USDC available (requested ${formatUnits(amount, 6)})`,
      );
    }

    // Withdraw available capital
    const toWithdraw = available < amount ? available : amount;
    
    if (toWithdraw > 0n) {
      const success = await this.withdrawCapitalToKeeper(toWithdraw);
      
      if (success) {
        this.logger.log(
          `✅ Deployment #${deploymentId} processed - ${formatUnits(toWithdraw, 6)} USDC now in keeper wallet`,
        );
        // TODO: Bridge to exchanges (Hyperliquid, Lighter, Aster)
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REWARD DEPOSIT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Deposit rewards (profits) to the strategy contract
   * Called by RewardHarvester after withdrawing profits from exchanges
   * 
   * The funds are sent to the strategy contract where they become available
   * for the vault to call claimRewards()
   * 
   * @param amount Amount in USDC to deposit (as number, will be converted to 6 decimals)
   * @returns true if successful, false otherwise
   */
  async depositRewardsToStrategy(amount: number): Promise<boolean> {
    if (!this.wallet || !this.provider) {
      this.logger.error('Wallet not initialized, cannot deposit rewards');
      return false;
    }

    if (amount < 1) {
      this.logger.debug('Amount too small to deposit');
      return false;
    }

    try {
      const usdcAddress = this.configService.get<string>(
        'USDC_ADDRESS',
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum native USDC
      );

      // USDC contract
      const usdcAbi = [
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function balanceOf(address account) external view returns (uint256)',
      ];
      const usdcContract = new Contract(usdcAddress, usdcAbi, this.wallet);

      // Check keeper wallet balance
      const balance = await usdcContract.balanceOf(this.wallet.address);
      const balanceUsdc = Number(formatUnits(balance, 6));

      if (balanceUsdc < amount) {
        this.logger.warn(
          `Insufficient balance to deposit rewards: have $${balanceUsdc.toFixed(2)}, need $${amount.toFixed(2)}`,
        );
        // Deposit what we have
        if (balanceUsdc < 1) {
          return false;
        }
        amount = balanceUsdc;
      }

      const amountWei = parseUnits(amount.toFixed(6), 6);

      this.logger.log(
        `💰 Depositing $${amount.toFixed(2)} rewards to strategy contract ${this.strategyAddress}...`,
      );

      // Transfer USDC to strategy contract
      const tx = await usdcContract.transfer(this.strategyAddress, amountWei);
      const receipt = await tx.wait();

      this.logger.log(
        `✅ Rewards deposited successfully in block ${receipt.blockNumber}`,
      );

      return true;
    } catch (error: any) {
      this.logger.error(`Failed to deposit rewards: ${error.message}`);
      return false;
    }
  }

  /**
   * Get the current balance of rewards available in the strategy contract
   * This is the idle balance that can be claimed by the vault via claimRewards()
   */
  async getRewardsAvailable(): Promise<number> {
    if (!this.contract) {
      return 0;
    }

    try {
      const [, lastReportedNAV, , idleBalance, pnl] = await this.contract.getStrategySummary();
      
      // Available rewards = min(idle balance, profit)
      // We can only send profits that are actually sitting in the contract
      const idleUsdc = Number(formatUnits(idleBalance, 6));
      const pnlUsdc = Number(formatUnits(pnl, 6));
      
      // If PnL is positive and we have idle funds, that's the available reward
      return pnlUsdc > 0 ? Math.min(idleUsdc, pnlUsdc) : 0;
    } catch (error: any) {
      this.logger.debug(`Failed to get rewards available: ${error.message}`);
      return 0;
    }
  }
}


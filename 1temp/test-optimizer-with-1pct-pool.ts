#!/usr/bin/env npx tsx
/**
 * Test optimizer with 1% pool to verify calculations
 */

import { RangeOptimizer } from '../../server/src/domain/services/RangeOptimizer';
import { Volatility } from '../../server/src/domain/value-objects/Volatility';
import { DriftVelocity } from '../../server/src/domain/value-objects/DriftVelocity';

const optimizer = new RangeOptimizer();

// Test parameters matching live bot
const volatility = new Volatility(0.773); // 77.3%
const drift = new DriftVelocity(5.0); // 5.00 (check if this is percentage or decimal)
const positionValue = 37.73; // $37.73
const baseFeeApr = 32.83; // From logs
const gasPriceGwei = 0.0014; // From logs
const ethPrice = 2940.88; // From logs

console.log('');
console.log('═'.repeat(80));
console.log('🧪 TESTING OPTIMIZER WITH 1% POOL');
console.log('═'.repeat(80));
console.log('');
console.log(`Volatility: ${volatility.value * 100}%`);
console.log(`Drift: ${drift.clampedValue} (raw value: ${drift.value})`);
console.log(`Base APR: ${baseFeeApr}%`);
console.log(`Position: $${positionValue}`);
console.log(`Gas: ${gasPriceGwei} Gwei | ETH: $${ethPrice}`);
console.log('');

const result = optimizer.optimize(
  volatility,
  drift,
  positionValue,
  baseFeeApr,
  gasPriceGwei,
  ethPrice,
  0, // incentiveApr
  0, // fundingApr
);

console.log('═'.repeat(80));
console.log('📊 OPTIMIZER RESULT');
console.log('═'.repeat(80));
console.log('');
console.log(`Optimal Range: ${(result.optimalWidth * 100).toFixed(2)}%`);
console.log(`Estimated Net APY: ${result.estimatedNetApy.toFixed(2)}%`);
console.log(`Rebalances/year: ${result.rebalanceFrequency.toFixed(1)}`);
console.log(`Annual Cost: $${result.estimatedAnnualCost.toFixed(2)}`);
console.log('');

// Test different drift values to see impact
console.log('═'.repeat(80));
console.log('🔍 DRIFT IMPACT TEST');
console.log('═'.repeat(80));
console.log('');

for (const driftVal of [0.05, 0.5, 5.0]) {
  const testDrift = new DriftVelocity(driftVal);
  const testResult = optimizer.optimize(
    volatility,
    testDrift,
    positionValue,
    baseFeeApr,
    gasPriceGwei,
    ethPrice,
    0,
    0,
  );
  
  console.log(`Drift: ${driftVal} → Range: ${(testResult.optimalWidth * 100).toFixed(2)}%, APY: ${testResult.estimatedNetApy.toFixed(2)}%`);
}

console.log('');
console.log('═'.repeat(80));
console.log('💡 EXPECTED WITH 1% POOL FEE');
console.log('═'.repeat(80));
console.log('');
console.log('With POOL_FEE_TIER = 0.01 (1%):');
console.log('  - Pool fee per rebalance: $37.73 × 0.5 × 0.01 = $0.19');
console.log('  - Gas cost per rebalance: ~$0.0006');
console.log('  - Total per rebalance: ~$0.19');
console.log('');
console.log('If rebalancing 20x/year:');
console.log('  - Annual cost: $0.19 × 20 = $3.80');
console.log('  - Cost drag: $3.80 / $37.73 × 100 = 10.1%');
console.log('');
console.log('If rebalancing 50x/year:');
console.log('  - Annual cost: $0.19 × 50 = $9.50');
console.log('  - Cost drag: $9.50 / $37.73 × 100 = 25.2%');
console.log('');











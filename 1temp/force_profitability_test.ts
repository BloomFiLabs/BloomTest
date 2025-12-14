#!/usr/bin/env node
import 'dotenv/config';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

async function main() {
  console.log('🔬 FORCING PROFITABILITY: Scenario Analysis\n');
  console.log('='.repeat(80));

  const baseApr = 33.05;
  const currentVol = 0.74;
  const baseGas = 0.50;
  const capital = 10000;

  // Scenario 1: Current Conditions (Baseline)
  console.log('\n1️⃣  SCENARIO: Current Market (0.05% Fee, 74% Vol)');
  runSimulation(baseApr, 0.0005, currentVol, baseGas, capital);

  // Scenario 2: 1% Pool (Higher Fees Captured, Higher Rebalance Cost)
  // Assuming 1% pool has similar APR (conservative) or higher? 
  // Let's assume 40% APR for 1% pool (often higher fee capture)
  console.log('\n2️⃣  SCENARIO: 1% Pool (1.00% Fee, 40% APR, 74% Vol)');
  runSimulation(40.0, 0.01, currentVol, baseGas, capital);

  // Scenario 3: Low Volatility (Regime Change)
  console.log('\n3️⃣  SCENARIO: Low Volatility (0.05% Fee, 33% APR, 40% Vol)');
  runSimulation(baseApr, 0.0005, 0.40, baseGas, capital);

  // Scenario 4: "Perfect" Conditions (1% Pool + Low Vol)
  console.log('\n4️⃣  SCENARIO: Perfect Storm (1.00% Fee, 40% APR, 40% Vol)');
  runSimulation(40.0, 0.01, 0.40, baseGas, capital);
}

function runSimulation(apr: number, feeTier: number, vol: number, gas: number, position: number) {
  const costModel = {
    gasCostPerRebalance: gas,
    poolFeeTier: feeTier,
    positionValueUSD: position
  };

  const ranges = [0.01, 0.02, 0.05, 0.10, 0.20, 0.395];
  let bestNet = -Infinity;
  let bestWidth = 0;

  console.log('Range | Rebal/Yr | Efficiency | Gross APY | Cost Drag | Net APY');
  console.log('-'.repeat(70));

  for (const width of ranges) {
    const res = RangeOptimizer.estimateAPYForRange(
      width, apr, 0, 0, vol, costModel, 5.0
    );
    const net = res.netAPY || -Infinity;
    
    if (net > bestNet) {
      bestNet = net;
      bestWidth = width;
    }

    const highlight = net > 35 ? '✨' : (net > 0 ? '✅' : '❌');
    
    console.log(
      `${(width * 100).toFixed(1).padStart(4)}% | ` +
      `${res.rebalanceFrequency.toFixed(1).padStart(8)} | ` +
      `${res.feeCaptureEfficiency.toFixed(1).padStart(9)}% | ` +
      `${res.expectedAPY.toFixed(2).padStart(8)}% | ` +
      `${res.annualCostDrag?.toFixed(2).padStart(8)}% | ` +
      `${net.toFixed(2).padStart(6)}% ${highlight}`
    );
  }
  
  console.log(`👉 Best: ${(bestWidth*100).toFixed(1)}% Range yielding ${bestNet.toFixed(2)}% APY`);
}

main().catch(console.error);


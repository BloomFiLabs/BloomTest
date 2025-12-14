#!/usr/bin/env node
import 'dotenv/config';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

// Override the multiplier logic inside a test function since it's hardcoded in the class
// We'll simulate the calculation manually to see the impact

function simulateFeeDensityImpact(width: number, power: number) {
  const referenceWidth = 0.05; // 5%
  return Math.pow(referenceWidth / width, power);
}

console.log('🔬 FEE DENSITY SENSITIVITY ANALYSIS\n');
console.log('Does a narrower range yield 10x fees or 6x fees?');
console.log('-'.repeat(60));
console.log('Range | Density (0.8 - Current) | Density (1.0 - Linear) | Impact');
console.log('-'.repeat(60));

const ranges = [0.20, 0.10, 0.05, 0.02, 0.01];

for (const w of ranges) {
  const conservative = simulateFeeDensityImpact(w, 0.8);
  const aggressive = simulateFeeDensityImpact(w, 1.0);
  const diff = ((aggressive - conservative) / conservative) * 100;
  
  console.log(
    `${(w*100).toFixed(1)}%  | ` +
    `${conservative.toFixed(2).padStart(20)}x | ` +
    `${aggressive.toFixed(2).padStart(20)}x | ` +
    `+${diff.toFixed(0)}% Boost`
  );
}

console.log('\n📊 What this means for APY (at 5% Volatility, 1% Range):');
// Quick calc:
// Base APR 33% * Density * Efficiency (approx 95% for low vol)
const baseApr = 33;
const efficiency = 0.95;
const costDrag = 5; // Assumed low for 5% vol

const apyConservative = (baseApr * 3.62 * efficiency) - costDrag; // 3.62 is density at 1% with 0.8 power
const apyAggressive = (baseApr * 5.00 * efficiency) - costDrag;   // 5.00 is density at 1% with 1.0 power

console.log(`Current Model (0.8 power): ~${apyConservative.toFixed(2)}% APY`);
console.log(`Linear Model (1.0 power):  ~${apyAggressive.toFixed(2)}% APY`);


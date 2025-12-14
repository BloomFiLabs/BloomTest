import 'dotenv/config';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import axios from 'axios';

/**
 * Backtest sUSDe / USDC Leverage Loop
 * 
 * Objective: Simulate the returns of supplying sUSDe and borrowing USDC on Aave V3.
 * 
 * Data Sources:
 * 1. Aave V3 Subgraph (Borrow Rates)
 * 2. Ethena API / Curve Pool (sUSDe Price & Yield History) - simulated here via static params
 *    since we don't have a direct adapter for Ethena APY history yet.
 */

// --- Configuration ---
const INITIAL_CAPITAL = 1_000_000; // $1M
const LEVERAGE = 3.5; // 3.5x Leverage (Supply $3.5M, Borrow $2.5M)
const BORROW_ASSET = 'USDC';
const SUPPLY_ASSET = 'sUSDe';

// Ethena Yield Assumptions (Conservative history)
// sUSDe yield fluctuates. We'll simulate a range based on historical averages.
// Low: 5% (Bearish), Avg: 15% (Normal), High: 30% (Bullish)
const SUSDE_YIELD_HISTORY = [
  { period: 'Bearish', apy: 5.0 },
  { period: 'Normal', apy: 15.0 },
  { period: 'Bullish', apy: 25.0 },
];

async function getAaveBorrowRates() {
  const API_KEY = process.env.THE_GRAPH_API_KEY;
  const SUBGRAPH_ID = 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk'; // Aave V3 Mainnet
  
  const url = `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
  
  // Fetch last 30 days of USDC borrow rates to get a realistic cost baseline
  // Note: This graph might not have full history, falling back to "markets" current rate if needed
  const query = `
    {
      reserves(where: { symbol: "USDC" }) {
        symbol
        variableBorrowRate
        averageStableBorrowRate
      }
    }
  `;

  try {
    const response = await axios.post(url, { query });
    const usdc = response.data.data.reserves[0];
    
    // Rate is in ray (1e27)
    const borrowRate = parseFloat(usdc.variableBorrowRate) / 1e27 * 100;
    
    return borrowRate;
  } catch (e) {
    console.warn('Failed to fetch Aave rates, using fallback 5.5%');
    return 5.5;
  }
}

async function main() {
  console.log(`\n🧪 BACKTEST: ${SUPPLY_ASSET} / ${BORROW_ASSET} Loop`);
  console.log(`   Leverage: ${LEVERAGE}x`);
  console.log(`   Principal: $${INITIAL_CAPITAL.toLocaleString()}`);
  
  // 1. Get Cost of Capital
  const borrowRate = await getAaveBorrowRates();
  console.log(`   Current Borrow Cost (${BORROW_ASSET}): ${borrowRate.toFixed(2)}%\n`);

  console.log('📊 Scenario Analysis (Annualized):');
  console.log('   ' + '-'.repeat(60));
  console.log('   Market Condition | sUSDe Yield | Net Spread | Net APY');
  console.log('   ' + '-'.repeat(60));

  // 2. Run Scenarios
  SUSDE_YIELD_HISTORY.forEach(scenario => {
    const supplyYield = scenario.apy;
    
    // Math:
    // Total Assets = Principal * Leverage
    // Total Debt = Principal * (Leverage - 1)
    // Gross Income = Total Assets * Supply Yield
    // Interest Cost = Total Debt * Borrow Rate
    // Net Profit = Gross Income - Interest Cost
    // Net APY = Net Profit / Principal

    const totalAssets = INITIAL_CAPITAL * LEVERAGE;
    const totalDebt = INITIAL_CAPITAL * (LEVERAGE - 1);
    
    const grossIncome = totalAssets * (supplyYield / 100);
    const interestCost = totalDebt * (borrowRate / 100);
    const netProfit = grossIncome - interestCost;
    const netAPY = (netProfit / INITIAL_CAPITAL) * 100;
    
    const spread = supplyYield - borrowRate;

    console.log(
      `   ${scenario.period.padEnd(16)} | ` +
      `${scenario.apy.toFixed(1)}%`.padEnd(11) + ` | ` +
      `${spread > 0 ? '+' : ''}${spread.toFixed(1)}%`.padEnd(10) + ` | ` +
      `avg ${netAPY.toFixed(2)}%`
    );
  });
  console.log('   ' + '-'.repeat(60));

  // 3. Risk Warning
  console.log('\n⚠️  RISK FACTORS:');
  console.log('   1. De-peg: If sUSDe drops below $0.98, liquidation risk spikes.');
  console.log('   2. Funding Reversal: If sUSDe yield drops below borrowing cost (Bearish scenario), APY can go negative.');
  console.log('      - Breakeven Supply Yield: ' + (borrowRate * (LEVERAGE - 1) / LEVERAGE).toFixed(2) + '%');
}

main();

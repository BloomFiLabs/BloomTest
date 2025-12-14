import * as fs from 'fs';
import * as path from 'path';

const resultsPath = path.join(__dirname, '../results/main-backtest.json');
const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

const fundingPos = data.positions.find((p: any) => p.strategyId === 'eth-funding');

if (!fundingPos) {
  console.log('No funding position found');
  process.exit(1);
}

console.log('Funding Position Details:');
console.log(JSON.stringify(fundingPos, null, 2));

const currentPrice = fundingPos.currentPrice;
const amount = fundingPos.amount;
const assetValue = amount * currentPrice;

// Initial assumptions based on config
const initialEquity = 20000; // 20% of $100k
const leverage = 3.0;
const initialDebt = initialEquity * (leverage - 1); // $40,000

// Estimate debt interest
// We know the backtest used real Aave rates, but we can't see the accumulated debt in JSON.
// However, BacktestEngine PnL usually subtracts costs from Cash, or updates Position?
// If FundingRateCaptureStrategy returns 'Net Yield', then BacktestEngine adds Net Yield to the Position Value (or Cash).
// If it adds to Position Value (reinvest), then `assetValue` ALREADY includes the deduction of borrow cost.
// Wait, `feesEarned` (Net Yield) is added to `tracker` and usually handled as Cash Flow?
// BacktestEngine logic: `this.portfolio.addCash(Amount.create(feesEarned));`
// So Yield is in CASH, not in Position Amount.

// IF Yield is in Cash, then `fundingPos.amount` only reflects Asset Price Change?
// But `amount` grew from ~14 to 34?
// If fees are used to BUY more?
// The BacktestEngine doesn't auto-reinvest fees into position unless `rebalance` does it.
// `FundingRateCaptureStrategy` doesn't implement rebalance logic to buy more.

// So why did `amount` grow?
// Maybe `BacktestEngine` adds IL or Yield to amount?
// `updatedPosition = Position.create({ amount: ilAdjustedAmount ... })`
// Only for IL.
// Yield is separate.

// If `amount` grew, maybe it's because `trades` were executed multiple times?
// Did it buy more?
// JSON `trades` array lists ALL trades.
// Let's count trades for `eth-funding`.
const fundingTrades = data.trades.filter((t: any) => t.strategyId === 'eth-funding');
console.log(`\nTrade Count: ${fundingTrades.length}`);
let totalBoughtETH = 0;
let totalSpentUSD = 0;

fundingTrades.forEach((t: any) => {
    if (t.side === 'buy') {
        totalBoughtETH += t.amount;
        totalSpentUSD += t.amount * t.price;
    }
});

console.log(`Total ETH Bought: ${totalBoughtETH}`);
console.log(`Total USD Spent: ${totalSpentUSD}`);

// If final amount matches total bought, then it just kept buying.
// If it kept buying, it used Cash (from Yield?).

const estimatedFinalValue = assetValue; // Assuming debt is handled externally or we net it out
// Actually, if we hold Debt, we must subtract it.
// If the engine doesn't track debt, then `assetValue` is Gross.
// We must subtract Initial Debt + Interest manually to get Net Equity.

const days = 90; // Approx
const interestRate = 0.08; // Conservative
const estInterest = initialDebt * interestRate * (days / 365);
const finalDebt = initialDebt + estInterest;

const netEquity = assetValue - finalDebt;

// Add Cash accumulated from Yield?
// We can't easily separate Cash by strategy in the global Portfolio Cash.
// But `netEquity` gives us the Asset Liquidation Value.

const totalReturn = (netEquity - initialEquity) / initialEquity;
const apy = Math.pow(1 + totalReturn, 365 / days) - 1;

console.log(`\n--- Funding Rate Strategy Analysis ---`);
console.log(`Initial Equity: $${initialEquity.toFixed(2)}`);
console.log(`Initial Debt:   $${initialDebt.toFixed(2)}`);
console.log(`Final Asset Val:$${assetValue.toFixed(2)}`);
console.log(`Est. Final Debt:$${finalDebt.toFixed(2)}`);
console.log(`Net Liquidation:$${netEquity.toFixed(2)}`);
console.log(`Total Return:   ${(totalReturn * 100).toFixed(2)}%`);
console.log(`Annualized APY: ${(apy * 100).toFixed(2)}%`);







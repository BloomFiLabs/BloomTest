import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.HYPERLIQUID_RPC_URL);
  const strategy = new ethers.Contract('0x8a84642BF5FF4316dad8Bc01766DE68d6287f126', [
    'function getUsdcBal() view returns (uint256)',
    'function totalPrincipal() view returns (uint256)',
    'function getLendData() view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
    'function getPerpEquity() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
    'function getLPPosition() view returns (uint256,uint128,int24,int24)',
  ], provider);

  const [usdcBal, principal, lendData, perpEquity, totalAssets, lpPos] = await Promise.all([
    strategy.getUsdcBal(),
    strategy.totalPrincipal(),
    strategy.getLendData(),
    strategy.getPerpEquity(),
    strategy.totalAssets(),
    strategy.getLPPosition(),
  ]);

  console.log('📊 RAW ON-CHAIN VALUES:');
  console.log('  USDC Balance (raw):', usdcBal.toString());
  console.log('  Principal (raw):', principal.toString());
  console.log('  Collateral (raw, 8 decimals):', lendData[0].toString());
  console.log('  Debt (raw, 8 decimals):', lendData[1].toString());
  console.log('  Perp Equity (raw):', perpEquity.toString());
  console.log('  Total Assets (raw):', totalAssets.toString());
  console.log('  LP TokenId:', lpPos[0].toString());
  console.log('  LP Liquidity (raw):', lpPos[1].toString());

  console.log('\n💰 PARSED VALUES:');
  const collateral = Number(lendData[0]) / 1e8; // HyperLend uses 8 decimals
  const debt = Number(lendData[1]) / 1e8;
  const usdcBalance = Number(usdcBal) / 1e6;
  const principalUSD = Number(principal) / 1e6;
  const perpEquityUSD = Number(perpEquity) / 1e6;
  const totalAssetsUSD = Number(totalAssets) / 1e6;
  
  console.log('  USDC Balance: $' + usdcBalance.toFixed(2));
  console.log('  Principal: $' + principalUSD.toFixed(2));
  console.log('  Collateral: $' + collateral.toFixed(2));
  console.log('  Debt: $' + debt.toFixed(2));
  console.log('  Net Equity (collateral - debt): $' + (collateral - debt).toFixed(2));
  console.log('  Perp Equity: $' + perpEquityUSD.toFixed(2));
  console.log('  Total Assets (from contract): $' + totalAssetsUSD.toFixed(2));
  console.log('  LP has liquidity:', lpPos[1].toString() !== '0');

  console.log('\n🔢 MANUAL NAV CALCULATION:');
  const manualNAV = (collateral - debt) + usdcBalance + perpEquityUSD;
  console.log('  Manual NAV = (collateral - debt) + usdcBalance + perpEquity');
  console.log('  Manual NAV = (' + collateral.toFixed(2) + ' - ' + debt.toFixed(2) + ') + ' + usdcBalance.toFixed(2) + ' + ' + perpEquityUSD.toFixed(2));
  console.log('  Manual NAV = $' + manualNAV.toFixed(2));
  
  console.log('\n💸 ACTUAL PnL:');
  const actualPnL = manualNAV - principalUSD;
  console.log('  PnL = NAV - Principal');
  console.log('  PnL = $' + manualNAV.toFixed(2) + ' - $' + principalUSD.toFixed(2));
  console.log('  PnL = $' + actualPnL.toFixed(2));
  
  console.log('\n❓ ISSUE CHECK:');
  console.log('  Contract totalAssets(): $' + totalAssetsUSD.toFixed(2));
  console.log('  Manual NAV: $' + manualNAV.toFixed(2));
  console.log('  Difference: $' + (totalAssetsUSD - manualNAV).toFixed(2));
  if (Math.abs(totalAssetsUSD - manualNAV) > 1) {
    console.log('  ⚠️  WARNING: Contract totalAssets() seems inflated!');
  }
}

main().catch(console.error);






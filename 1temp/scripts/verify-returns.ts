import * as dotenv from 'dotenv';
import * as path from 'path';

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy, StrategyMode } from '../src/infrastructure/adapters/strategies';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';

async function verify() {
  console.log('\n🔍 VERIFYING RETURNS\n');
  console.log('='.repeat(70));
  
  const apiKey = process.env.THE_GRAPH_API_KEY!;
  const ethUsdcAdapter = new UniswapV3Adapter({
    apiKey,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: true,
  });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  
  const ethUsdcRealAPR = await ethUsdcAdapter.calculateActualAPR('ETH-USDC', startDate, endDate);
  
  const useCase = new RunBacktestUseCase();
  
  const result = await useCase.execute({
    startDate,
    endDate,
    initialCapital: 100000,
    dataDirectory: './data',
    strategies: [
      {
        strategy: new VolatilePairStrategy('eth-usdc-test', 'ETH/USDC Test'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          mode: StrategyMode.HYBRID,
          checkIntervalHours: 24,
          rangeWidth: 0.005,
          optimizeForNarrowest: true,
          ammFeeAPR: ethUsdcRealAPR,
          incentiveAPR: 0,
          fundingAPR: 0,
          allocation: 1.0, // 100% allocation for isolated test
          dataAdapter: ethUsdcAdapter,
        }),
        allocation: 1.0,
      }
    ],
    customDataAdapter: ethUsdcAdapter,
    calculateIV: false,
    useRealFees: true,
    applyIL: true,
    applyCosts: true,
    costModel: {
      slippageBps: 5,
      gasModel: {
        gasUnitsPerRebalance: 450000,
        gasPriceGwei: 0.001,
        nativeTokenPriceUSD: 3000,
        network: 'base',
      },
    },
    outputPath: './results/verify-test.json',
  });
  
  console.log(`\n📊 Results:`);
  console.log(`   Initial: $${(100000).toLocaleString()}`);
  console.log(`   Final: $${result.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Expected (from simulation): ~14.0%`);
  console.log(`   Difference: ${(result.metrics.totalReturn - 14.0).toFixed(2)}%`);
  
  if (Math.abs(result.metrics.totalReturn - 14.0) > 5) {
    console.log(`\n   ⚠️  Large discrepancy detected!`);
    console.log(`      Check for yield compounding or calculation issues`);
  }
  
  console.log('\n' + '='.repeat(70));
}

verify().catch(console.error);



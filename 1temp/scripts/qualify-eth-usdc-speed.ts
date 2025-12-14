import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root (1temp directory)
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { VolatilePairStrategy, StrategyMode } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { Portfolio } from '../src/domain/entities/Portfolio';
import { TheGraphDataAdapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { Amount, Price } from '../src/domain/value-objects';

// --- Strategy Config: ETH/USDC Speed Mode ---
const STRATEGY_CONFIG = {
    mode: StrategyMode.SPEED,
    poolFee: 0.0005, // 0.05% Fee
    targetAPR: 0.30,
    allocation: 1000000, // $1M Test
    checkIntervalHours: 5 // Speed mode: 5h checks
};

async function loadHourlyHistory(pair: string, start: Date, end: Date): Promise<any[]> {
    const apiKey = process.env.THE_GRAPH_API_KEY;
    let url = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3';
    
    if (apiKey) {
        url = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`;
    }

    // ETH/USDC 0.05% pool address
    const adapter = new TheGraphDataAdapter({
        subgraphUrl: url,
        token0Symbol: 'ETH',
        token1Symbol: 'USDC',
        poolAddress: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' // ETH/USDC 0.05%
    });
    
    let data: any[] = [];
    try {
        data = await adapter.fetchHourlyOHLCV('ETH', start, end);
    } catch (error) {
        console.warn(`⚠️ Failed to fetch live data: ${(error as Error).message}`);
    }
    
    if (!data || data.length === 0) {
        throw new Error('No data available for qualification');
    }
    
    return data;
}

async function main() {
    console.log(`\n🧪 Qualifying ETH/USDC Strategy: SPEED Mode`);
    console.log(`   Check Interval: ${STRATEGY_CONFIG.checkIntervalHours}h`);

    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);
    console.log(`   Fetching data from ${start.toISOString()} to ${end.toISOString()}...`);
    
    let hourlyData = [];
    try {
        hourlyData = await loadHourlyHistory('ETH-USDC', start, end);
    } catch (e) {
        console.error("Error loading data:", e);
        return;
    }
    
    if (hourlyData.length === 0) {
        console.error("❌ No data found.");
        return;
    }
    console.log(`   ✅ Loaded ${hourlyData.length} hourly ticks.`);

    const portfolio = Portfolio.create({
        id: 'test-portfolio',
        initialCapital: Amount.create(STRATEGY_CONFIG.allocation)
    });
    const strategy = new VolatilePairStrategy('eth-usdc-speed', 'ETH/USDC Speed Strategy');
    
    console.log(`   Running simulation...`);
    
    let rebalanceCount = 0;
    
    for (const tick of hourlyData) {
        const marketData = {
            timestamp: tick.timestamp,
            price: tick.close,
            volume: tick.volume,
        };

        const result = await strategy.execute(portfolio, marketData, {
            pair: 'ETH/USDC',
            mode: STRATEGY_CONFIG.mode,
            checkIntervalHours: STRATEGY_CONFIG.checkIntervalHours,
            allocation: 0.95,
            rangeWidth: 0.10,
            targetAPY: 40,
            ammFeeAPR: 30, 
            costModel: {
                gasCostPerRebalance: 50,
                poolFeeTier: STRATEGY_CONFIG.poolFee,
                positionValueUSD: portfolio.totalValue().value * 0.95
            }
        });
        
        if (result.shouldRebalance) {
            rebalanceCount++;
        }
    }
    
    console.log(`   ✅ Simulation complete.`);
    console.log(`   Total Rebalances: ${rebalanceCount} (over 90 days)`);
    console.log(`   Rebalance Frequency: ${(rebalanceCount/90).toFixed(2)}/day`);
    console.log(`   Expected Behavior: Speed mode should rebalance more frequently (> 1/day typically)`);
    
    if (rebalanceCount/90 >= 1.0) {
        console.log(`   ✅ PASSED: Speed mode frequency is within expected range.`);
    } else {
        console.log(`   ⚠️ WARNING: Rebalance frequency seems low for Speed mode.`);
    }
}

main().catch(console.error);


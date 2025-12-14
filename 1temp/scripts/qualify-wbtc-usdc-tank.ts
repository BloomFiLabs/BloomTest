import * as dotenv from 'dotenv';
import * as path from 'path';

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { VolatilePairStrategy, StrategyMode } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { Portfolio } from '../src/domain/entities/Portfolio';
import { TheGraphDataAdapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { Amount, Price } from '../src/domain/value-objects';

// --- Strategy Config: WBTC/USDC Tank Mode ---
const STRATEGY_CONFIG = {
    mode: StrategyMode.TANK,
    poolFee: 0.003, // 0.3% Fee
    targetAPR: 0.30,
    allocation: 1000000,
    checkIntervalHours: 37 // Tank mode: 37h checks
};

async function loadHourlyHistory(pair: string, start: Date, end: Date): Promise<any[]> {
    const apiKey = process.env.THE_GRAPH_API_KEY;
    let url = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3';
    
    if (apiKey) {
        url = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`;
    }

    // WBTC/USDC 0.3% pool address
    const adapter = new TheGraphDataAdapter({
        subgraphUrl: url,
        token0Symbol: 'WBTC',
        token1Symbol: 'USDC',
        poolAddress: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35' // WBTC/USDC 0.3%
    });
    
    let data: any[] = [];
    try {
        data = await adapter.fetchHourlyOHLCV('WBTC', start, end);
    } catch (error) {
        console.warn(`⚠️ Failed to fetch live data: ${(error as Error).message}`);
    }
    
    if (!data || data.length === 0) {
        throw new Error('No data available for qualification');
    }
    
    return data;
}

async function main() {
    console.log(`\n🧪 Qualifying WBTC/USDC Strategy: TANK Mode`);
    console.log(`   Check Interval: ${STRATEGY_CONFIG.checkIntervalHours}h`);

    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);
    console.log(`   Fetching data from ${start.toISOString()} to ${end.toISOString()}...`);
    
    let hourlyData = [];
    try {
        hourlyData = await loadHourlyHistory('WBTC-USDC', start, end);
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
    const strategy = new VolatilePairStrategy('wbtc-usdc-tank', 'WBTC/USDC Tank Strategy');
    
    console.log(`   Running simulation...`);
    
    let rebalanceCount = 0;
    let heartbeatCount = 0;
    let positionCreated = false;
    let firstPrice: number | null = null;
    let lastPrice: number | null = null;
    
    for (let i = 0; i < hourlyData.length; i++) {
        const tick = hourlyData[i];
        if (i === 0) firstPrice = tick.close.value;
        if (i === hourlyData.length - 1) lastPrice = tick.close.value;
        
        const marketData = {
            timestamp: tick.timestamp,
            price: tick.close,
            volume: tick.volume,
        };

        const result = await strategy.execute(portfolio, marketData, {
            pair: 'WBTC/USDC',
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
        
        result.positions.forEach(pos => {
            const existing = portfolio.getPosition(pos.id);
            if (existing) {
                portfolio.updatePosition(pos);
            } else {
                portfolio.addPosition(pos);
                if (!positionCreated) positionCreated = true;
            }
        });
        
        if (result.shouldRebalance) {
            rebalanceCount++;
            heartbeatCount++;
        } else if (result.positions.length > 0 || result.trades.length > 0) {
            heartbeatCount++;
        }
    }
    
    console.log(`   ✅ Simulation complete.`);
    console.log(`   Total Ticks: ${hourlyData.length}`);
    console.log(`   Heartbeat Ticks: ${heartbeatCount}`);
    console.log(`   Position Created: ${positionCreated}`);
    console.log(`   First Price: $${firstPrice?.toFixed(2)}`);
    console.log(`   Last Price: $${lastPrice?.toFixed(2)}`);
    console.log(`   Price Change: ${firstPrice && lastPrice ? ((lastPrice - firstPrice) / firstPrice * 100).toFixed(2) + '%' : 'N/A'}`);
    console.log(`   Total Rebalances: ${rebalanceCount} (over 90 days)`);
    console.log(`   Rebalance Frequency: ${(rebalanceCount/90).toFixed(2)}/day`);
    console.log(`   Expected Behavior: Tank mode should rebalance infrequently (< 1/day typically)`);
    
    if (rebalanceCount/90 < 1.5) {
        console.log(`   ✅ PASSED: Tank mode frequency is within expected range.`);
    } else {
        console.log(`   ⚠️ WARNING: Rebalance frequency seems high for Tank mode.`);
    }
}

main().catch(console.error);



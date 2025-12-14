import { VolatilePairStrategy, StrategyMode } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { BacktestEngine } from '../src/domain/services/BacktestEngine';
import { Portfolio } from '../src/domain/entities/Portfolio';
import { TheGraphDataAdapter, HourlyPoolData } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { Amount, Price } from '../src/domain/value-objects';

// --- Strategy Config ---
const STRATEGY_CONFIG = {
    mode: StrategyMode.TANK,
    poolFee: 0.003, // 0.3% Fee
    targetAPR: 0.30, // 30% Target for Range Optimization
    allocation: 1000000, // $1M Test
    checkIntervalHours: 39 
};

async function loadHourlyHistory(pair: string, start: Date, end: Date): Promise<any[]> {
    const apiKey = process.env.THE_GRAPH_API_KEY;
    let url = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3';
    
    if (apiKey) {
        url = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`;
    } else {
        console.warn("⚠️ No THE_GRAPH_API_KEY found. Using deprecated public endpoint (may fail).");
    }

    const adapter = new TheGraphDataAdapter({
        subgraphUrl: url,
        token0Symbol: 'ETH',
        token1Symbol: 'USDT',
        poolAddress: '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36'
    });
    
    return await adapter.fetchHourlyOHLCV('ETH', start, end);
}

async function main() {
    console.log(`\n🧪 Qualifying ETH/USDT Strategy: TANK Mode`);
    console.log(`   Check Interval: ${STRATEGY_CONFIG.checkIntervalHours}h`);

    // 1. Fetch Data
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);
    console.log(`   Fetching data from ${start.toISOString()} to ${end.toISOString()}...`);
    
    let hourlyData = [];
    try {
        hourlyData = await loadHourlyHistory('ETH-USDT', start, end);
    } catch (e) {
        console.error("Error loading data:", e);
        return;
    }
    
    if (hourlyData.length === 0) {
        console.error("❌ No data found.");
        return;
    }
    console.log(`   ✅ Loaded ${hourlyData.length} hourly ticks.`);

    // 2. Initialize Strategy & Portfolio
    const portfolio = Portfolio.create({
        id: 'test-portfolio',
        initialCapital: Amount.create(STRATEGY_CONFIG.allocation)
    });
    const strategy = new VolatilePairStrategy('eth-usdt-tank', 'ETH/USDT Tank Strategy');
    
    // 3. Run Simulation Loop (Manually ticking the strategy)
    console.log(`   Running simulation...`);
    
    let rebalanceCount = 0;
    let heartbeatCount = 0;
    let positionCreated = false;
    let firstPrice: number | null = null;
    let lastPrice: number | null = null;
    let priceSamples: number[] = [];
    
    for (let i = 0; i < hourlyData.length; i++) {
        const tick = hourlyData[i];
        
        // Sample prices for debugging
        if (i === 0) firstPrice = tick.close.value;
        if (i === hourlyData.length - 1) lastPrice = tick.close.value;
        if (i % 200 === 0) priceSamples.push(tick.close.value);
        
        const marketData = {
            timestamp: tick.timestamp,
            price: tick.close,
            volume: tick.volume,
        };

        const result = await strategy.execute(portfolio, marketData, {
            pair: 'ETH/USDT',
            mode: STRATEGY_CONFIG.mode,
            checkIntervalHours: STRATEGY_CONFIG.checkIntervalHours,
            allocation: 0.95,
            rangeWidth: 0.10, // Strategy will optimize this
            targetAPY: 40,
            ammFeeAPR: 30, 
            costModel: {
                gasCostPerRebalance: 50,
                poolFeeTier: STRATEGY_CONFIG.poolFee,
                positionValueUSD: portfolio.totalValue().value * 0.95
            }
        });
        
        // Update portfolio with returned positions and trades
        result.positions.forEach(pos => {
            const existing = portfolio.getPosition(pos.id);
            if (existing) {
                portfolio.updatePosition(pos);
            } else {
                portfolio.addPosition(pos);
            }
        });
        
        // Debug first few ticks and any rebalances
        if (i < 10 || result.shouldRebalance || result.trades.length > 0 || result.positions.length > 0) {
            const entryPrice = portfolio.positions.find(p => p.strategyId === strategy.id && p.asset === 'ETH/USDT')?.entryPrice?.value || 0;
            const priceChange = entryPrice > 0 ? ((tick.close.value - entryPrice) / entryPrice * 100).toFixed(2) : 'N/A';
            console.log(`   [Tick ${i}] Price=$${tick.close.value.toFixed(2)}, Entry=$${entryPrice.toFixed(2)}, Change=${priceChange}%, Rebalance=${result.shouldRebalance}, Trades=${result.trades.length}, Positions=${result.positions.length}, Reason=${result.rebalanceReason || 'none'}`);
        }
        
        if (result.positions.length > 0 && !positionCreated) {
            positionCreated = true;
            console.log(`   ✅ Position created at tick ${i}`);
        }
        
        if (result.shouldRebalance) {
            rebalanceCount++;
            heartbeatCount++;
        } else if (result.positions.length > 0 || result.trades.length > 0) {
            heartbeatCount++;
        }
    }
    
    console.log(`   ✅ Simulation complete.`);
    console.log(`   Total Ticks Processed: ${hourlyData.length}`);
    console.log(`   Heartbeat Ticks: ${heartbeatCount}`);
    console.log(`   Position Created: ${positionCreated}`);
    console.log(`   First Price: $${firstPrice?.toFixed(2)}`);
    console.log(`   Last Price: $${lastPrice?.toFixed(2)}`);
    console.log(`   Price Change: ${firstPrice && lastPrice ? ((lastPrice - firstPrice) / firstPrice * 100).toFixed(2) + '%' : 'N/A'}`);
    console.log(`   Price Samples: ${priceSamples.map(p => p.toFixed(2)).join(', ')}`);
    console.log(`   Total Rebalances: ${rebalanceCount} (over 90 days)`);
    console.log(`   Rebalance Frequency: ${(rebalanceCount/90).toFixed(2)}/day`);
}

main().catch(console.error);

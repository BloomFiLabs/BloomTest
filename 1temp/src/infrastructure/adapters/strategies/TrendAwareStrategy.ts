import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '../../../domain/entities/Strategy';
import { APR, Price } from '../../../domain/value-objects';
import { Position } from '../../../domain/entities/Position';
import { Trade } from '../../../domain/entities/Trade';
import { VolatilePairConfig } from './VolatilePairStrategy';
import { HurstCalculator } from '../../../shared/utils/HurstCalculator';
import { RangeOptimizer } from '../../../shared/utils/RangeOptimizer';

export class TrendAwareStrategy extends BaseStrategy {
  private entryPrices: Map<string, Price> = new Map();
  private lastCheckTimes: Map<string, Date> = new Map();
  private priceHistory: number[] = [];
  private readonly WINDOW_SIZE = 48; 

  constructor(id: string, name: string = 'Trend Aware Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const volatileConfig = config as VolatilePairConfig;
    
    // 1. Update History
    this.priceHistory.push(marketData.price.value);
    if (this.priceHistory.length > this.WINDOW_SIZE) {
      this.priceHistory.shift();
    }

    // 2. Calculate Metrics
    let hurst = 0.5;
    let volatility = 0.6; 
    let trendVelocity = 0; 

    if (this.priceHistory.length >= this.WINDOW_SIZE) {
        hurst = HurstCalculator.calculate(this.priceHistory);
        
        const returns = [];
        for(let i=1; i<this.priceHistory.length; i++) {
            returns.push(Math.log(this.priceHistory[i] / this.priceHistory[i-1]));
        }
        if (returns.length > 0) {
            const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
            const variance = returns.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / returns.length;
            volatility = Math.sqrt(variance) * Math.sqrt(365 * 24);
            
            // Trend Velocity: Abs(Total Return) / Time
            // Annualized Drift.
            const totalRet = Math.abs(Math.log(this.priceHistory[this.priceHistory.length-1] / this.priceHistory[0]));
            const hours = this.priceHistory.length;
            // Clamp velocity to avoid exploding the optimizer (max 500% APY equivalent)
            trendVelocity = Math.min(5.0, (totalRet / hours) * (365 * 24));
        }
    }

    let activeRangeWidth = 0.05; 

    // --- COST-AWARE SOLVER (UNIFIED) ---
    // We use the solver for ALL regimes.
    // The Solver uses Drift-Diffusion math to automatically widen/tighten based on Trend Velocity.
    // No manual "Hibernate" logic needed.
    
    const allocation = volatileConfig.allocation !== undefined ? volatileConfig.allocation : 0.25;
    const totalValue = portfolio.totalValue().value;
    const positionValue = totalValue * allocation;

    const gasCost = volatileConfig.costModel?.gasCostPerRebalance || 0.5;
    const feeTier = volatileConfig.costModel?.poolFeeTier || 0.0005;

    const optimization = RangeOptimizer.findOptimalNarrowestRange(
        volatileConfig.ammFeeAPR || 20,
        volatileConfig.incentiveAPR || 0,
        volatileConfig.fundingAPR || 0,
        volatility,
        0.005, // Min 0.5%
        0.20,  // Max 20%
        {
            gasCostPerRebalance: gasCost,
            poolFeeTier: feeTier,
            positionValueUSD: positionValue
        },
        trendVelocity 
    );
    
    activeRangeWidth = optimization.optimalRangeWidth;

    // --- Heartbeat ---
    // If the optimized range is Wide (> 10%), we can check less often.
    const checkIntervalHours = activeRangeWidth > 0.10 ? 12 : 4;
    const checkIntervalMs = checkIntervalHours * 60 * 60 * 1000;
    const positionId = `${this.id}-${volatileConfig.pair}`;
    const lastCheck = this.lastCheckTimes.get(positionId);
    
    let isHeartbeat = false;
    if (!lastCheck) {
      isHeartbeat = true;
      this.lastCheckTimes.set(positionId, marketData.timestamp);
    } else {
      const timeSinceLastCheck = marketData.timestamp.getTime() - lastCheck.getTime();
      if (timeSinceLastCheck >= checkIntervalMs) {
        isHeartbeat = true;
        this.lastCheckTimes.set(positionId, marketData.timestamp);
      }
    }

    const trades: Trade[] = [];
    const positions: Position[] = [];
    let shouldRebalance = false;
    let rebalanceReason: string | undefined;
    
    const existingPosition = portfolio.getPosition(positionId);

    if (!isHeartbeat) {
        if (existingPosition) {
            positions.push(existingPosition.updatePrice(Price.create(1.0)));
        }
        return { trades, positions, shouldRebalance: false };
    }

    // --- Execution Logic ---
    const allocatedAmount = portfolio.totalValue().multiply(allocation);

    if (!existingPosition && allocatedAmount.value > 0) {
        const entryPrice = marketData.price;
        this.entryPrices.set(positionId, entryPrice);

        const position = Position.create({
            id: positionId,
            strategyId: this.id,
            asset: volatileConfig.pair,
            amount: allocatedAmount,
            entryPrice: entryPrice,
            currentPrice: entryPrice
        });
        positions.push(position);

        trades.push(this.createTradeForStrategy(
            volatileConfig.pair, 'buy', allocatedAmount, entryPrice, marketData.timestamp
        ));

    } else if (existingPosition) {
        if (allocatedAmount.value > 0) {
            let trackedEntryPrice = this.entryPrices.get(positionId);
            if (!trackedEntryPrice) {
                trackedEntryPrice = marketData.price;
                this.entryPrices.set(positionId, trackedEntryPrice);
            }

            const priceChange = trackedEntryPrice.percentageChange(marketData.price);
            const absPriceChange = Math.abs(priceChange);
            
            // Check using the Optimized Range
            const rebalanceThreshold = 0.9; 
            const rebalanceTrigger = activeRangeWidth * rebalanceThreshold * 100;

            if (absPriceChange >= rebalanceTrigger) {
                shouldRebalance = true;
                rebalanceReason = `[Drift V=${trendVelocity.toFixed(1)} w=${(activeRangeWidth*100).toFixed(2)}%] Rebalance: ${absPriceChange.toFixed(2)}%`;
            }

            if (shouldRebalance) {
                this.entryPrices.set(positionId, marketData.price);
                
                // Emit a placeholder trade so the engine accounts for costs/PnL
                 trades.push(this.createTradeForStrategy(
                    volatileConfig.pair, 'sell', allocatedAmount, marketData.price, marketData.timestamp
                ));
            }

            positions.push(existingPosition.updatePrice(Price.create(1.0)));
        }
    }

    return { trades, positions, shouldRebalance, rebalanceReason };
  }

  calculateExpectedYield(config: StrategyConfig, _marketData: MarketData): APR {
    const volatileConfig = config as VolatilePairConfig;
    return APR.create((volatileConfig.ammFeeAPR || 20) + (volatileConfig.incentiveAPR || 15));
  }

  validateConfig(config: StrategyConfig): boolean {
    return true;
  }
}

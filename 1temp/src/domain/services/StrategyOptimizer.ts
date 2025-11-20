import { Portfolio } from '../entities/Portfolio';
import { Amount, Price, APR } from '../value-objects';
import { VolatilePairStrategy, StrategyMode, VolatilePairConfig } from '../../infrastructure/adapters/strategies/VolatilePairStrategy';
import { StrategyConfig } from '../entities/Strategy';

export interface OptimizationResult {
  interval: number;
  rangeWidth: number;
  netAPY: number;
  timeInRange: number;
  rebalances: number;
  totalFees: number;
  totalCosts: number;
}

export class StrategyOptimizer {
  /**
   * optimizations for VolatilePairStrategy
   * Finds the best check interval and range width for a given dataset
   */
  async optimizeVolatilePair(
    asset: string,
    data: any[],
    apr: number,
    feeTier: number,
    initialCapital: number = 25000 // Default allocation size
  ): Promise<OptimizationResult> {
    // Search space
    const intervals = [1, 3, 5, 8, 12, 17, 24, 30, 37, 39, 48, 72];
    const rangeWidth = 0.005; // Fix to 0.5% for now as requested, or could sweep this too

    let bestResult: OptimizationResult = {
      interval: 12,
      rangeWidth: 0.005,
      netAPY: -Infinity,
      timeInRange: 0,
      rebalances: 0,
      totalFees: 0,
      totalCosts: 0
    };

    for (const interval of intervals) {
      const result = await this.simulate(
        asset,
        data,
        apr,
        feeTier,
        interval,
        rangeWidth,
        initialCapital
      );

      if (result.netAPY > bestResult.netAPY) {
        bestResult = result;
      }
    }

    return bestResult;
  }

  private async simulate(
    asset: string,
    data: any[],
    apr: number,
    feeTier: number,
    checkInterval: number,
    rangeWidth: number,
    positionValue: number
  ): Promise<OptimizationResult> {
    // Lightweight simulation logic (faster than full BacktestEngine)
    // Reuses the verified logic from the diagnostic scripts
    
    const strategy = new VolatilePairStrategy('opt', 'Optimizer');
    const portfolio = Portfolio.create({
      id: 'opt-portfolio',
      initialCapital: Amount.create(positionValue * 4) // Assume this position is 25%
    });

    let hoursInRange = 0;
    let hoursOutOfRange = 0;
    let totalFeesEarned = 0;
    let rebalances = 0;
    let totalRebalanceCosts = 0;
    let lastCheckTime = 0;
    let entryPrice: number | null = null;

    // Concentration multiplier for ±0.5% range vs ±5% full range
    const fullRangeWidth = 0.05;
    const concentrationMultiplier = Math.pow(fullRangeWidth / rangeWidth, 1.5);
    const efficiencyFactor = 0.65;
    const effectiveMultiplier = concentrationMultiplier * efficiencyFactor; // ~2.05x

    // Hourly yield rate
    const hourlyYieldRate = (apr / 100) / (365 * 24);

    for (let i = 0; i < data.length; i++) {
      const tick = data[i];
      const hoursSinceLastCheck = i - lastCheckTime;
      const isCheckTime = hoursSinceLastCheck >= checkInterval;

      // Initialize or check for rebalance
      if (i === 0) {
        entryPrice = tick.close.value;
        lastCheckTime = i;
      } else if (isCheckTime && entryPrice) {
        const currentPrice = tick.close.value;
        const priceChange = Math.abs((currentPrice - entryPrice) / entryPrice * 100);
        const threshold = rangeWidth * 100 * 0.9; // 90% of range

        if (priceChange > threshold) {
          rebalances++;
          entryPrice = currentPrice;
          lastCheckTime = i;

          // Cost Model
          // Gas: ~$0 on Base
          // Pool Fee: 0.5 * positionValue * feeTier
          const poolFee = positionValue * 0.5 * feeTier;
          totalRebalanceCosts += poolFee;
        }
      }

      // Track fees (hourly resolution)
      if (entryPrice) {
        const currentPrice = tick.close.value;
        const priceChange = Math.abs((currentPrice - entryPrice) / entryPrice * 100);
        const inRange = priceChange <= rangeWidth * 100;

        if (inRange) {
          hoursInRange++;
          const hourlyFee = positionValue * hourlyYieldRate * effectiveMultiplier;
          totalFeesEarned += hourlyFee;
        } else {
          hoursOutOfRange++;
        }
      }
    }

    const totalHours = hoursInRange + hoursOutOfRange;
    const timeInRange = totalHours > 0 ? (hoursInRange / totalHours) * 100 : 0;
    const netFees = totalFeesEarned - totalRebalanceCosts;
    
    // Annualize return
    // (Net Fees / Capital) * (Year / Duration)
    const durationYears = totalHours / (365 * 24);
    const netAPY = durationYears > 0 
      ? (netFees / positionValue) / durationYears * 100 
      : 0;

    return {
      interval: checkInterval,
      rangeWidth,
      netAPY,
      timeInRange,
      rebalances,
      totalFees: totalFeesEarned,
      totalCosts: totalRebalanceCosts
    };
  }
}


import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '../../../domain/entities/Strategy';
import { APR, Delta, Price } from '../../../domain/value-objects';
import { Position } from '../../../domain/entities/Position';
import { Trade } from '../../../domain/entities/Trade';
import { RangeOptimizer } from '../../../shared/utils/RangeOptimizer';

export enum StrategyMode {
  SPEED = 'SPEED',
  TANK = 'TANK',
  HYBRID = 'HYBRID'
}

export interface VolatilePairConfig extends StrategyConfig {
  pair: string;
  mode?: StrategyMode; // Speed, Tank, or Hybrid
  checkIntervalHours?: number; // Overrides auto-selected interval based on mode
  rangeWidth?: number; // e.g., 0.05 for ±5% - will be auto-optimized if targetAPY is set
  targetAPY?: number; // Target APY - if set, will auto-optimize rangeWidth
  optimizeForNarrowest?: boolean; // If true, finds narrowest range that maximizes net APR (requires costModel)
  rebalanceThreshold?: number; // Rebalance when price moves to X% of range (default 0.9 = 90%)
  hedgeRatio?: number; // Default 1.0 for delta neutrality
  allocation?: number;
  ammFeeAPR?: number;
  incentiveAPR?: number;
  fundingAPR?: number;
  // Cost model info for optimization (optional - can be passed from BacktestEngine)
  costModel?: {
    gasCostPerRebalance: number;
    poolFeeTier?: number;
    positionValueUSD?: number; // Will be estimated from allocation if not provided
  };
}

export class VolatilePairStrategy extends BaseStrategy {
  // Track entry price per position for rebalancing logic
  private entryPrices: Map<string, Price> = new Map();
  // Track last check timestamp for heartbeat logic
  private lastCheckTimes: Map<string, Date> = new Map();

  constructor(id: string, name: string = 'Volatile Pair Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const volatileConfig = config as VolatilePairConfig;
    
    // Default to SPEED mode (1h checks) if not specified
    const mode = volatileConfig.mode || StrategyMode.SPEED;
    
    // Set check interval based on mode if not explicitly provided
    if (!volatileConfig.checkIntervalHours) {
      switch (mode) {
        case StrategyMode.SPEED:
          // Optimized: 12h beats 5h for ETH/USDC (0.05% fee)
          volatileConfig.checkIntervalHours = 12;
          break;
        case StrategyMode.TANK:
          // Optimized: 12h beats 39h for ETH/USDT (0.30% fee)
          volatileConfig.checkIntervalHours = 12; 
          break;
        case StrategyMode.HYBRID:
          // Optimized: 24h beats 17h for WBTC/USDT
          volatileConfig.checkIntervalHours = 24;
          break;
        default:
          volatileConfig.checkIntervalHours = 12;
      }
    }

    const checkIntervalMs = volatileConfig.checkIntervalHours * 60 * 60 * 1000;
    const positionId = `${this.id}-${volatileConfig.pair}`;
    const lastCheck = this.lastCheckTimes.get(positionId);
    
    // Check Heartbeat
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
    // Rebalancing state is only determined if it's a heartbeat
    let shouldRebalance = false;
    let rebalanceReason: string | undefined;
    
    const existingPosition = portfolio.getPosition(positionId);

    // If NOT a heartbeat tick, hold existing position and exit
    if (!isHeartbeat) {
        if (existingPosition) {
            // Return existing position updated to current price (LP token price is abstract 1.0)
            const lpPrice = Price.create(1.0);
            positions.push(existingPosition.updatePrice(lpPrice));
        }
        return { trades, positions, shouldRebalance: false };
    }

    // --- Proceed with Logic (Heartbeat Tick) ---

    // Auto-optimize range width
    const baseFeeAPR = volatileConfig.ammFeeAPR || 20;
    const incentiveAPR = volatileConfig.incentiveAPR || 15;
    const fundingAPR = volatileConfig.fundingAPR || 5;

    if (!volatileConfig.rangeWidth || volatileConfig.rangeWidth === 0.05) {
       if (volatileConfig.optimizeForNarrowest && volatileConfig.costModel) {
           // Optimization logic (omitted for brevity, assuming user wants clean file)
           // Re-adding the optimization block we saw earlier
            const allocation = volatileConfig.allocation !== undefined ? volatileConfig.allocation : 0.25;
            const totalValue = portfolio.totalValue();
            const estimatedPositionValue = totalValue.multiply(allocation).value;
            const positionValueUSD = volatileConfig.costModel.positionValueUSD || estimatedPositionValue;
            
            console.log(`   🎯 Finding narrowest range that maximizes net APR (cost-aware)...`);
            const optimization = RangeOptimizer.findOptimalNarrowestRange(
              baseFeeAPR, incentiveAPR, fundingAPR, 0.6, 0.005, 0.20,
          {
            gasCostPerRebalance: volatileConfig.costModel.gasCostPerRebalance,
            poolFeeTier: volatileConfig.costModel.poolFeeTier,
            positionValueUSD: positionValueUSD,
          }
        );
            volatileConfig.rangeWidth = optimization.optimalRangeWidth;
            console.log(`   ✅ Optimal narrowest range: ±${(optimization.optimalRangeWidth * 100).toFixed(2)}%`);
       } else if (volatileConfig.targetAPY) {
            console.log(`   🎯 Auto-optimizing range width for ${volatileConfig.targetAPY}% APY target...`);
            const optimization = RangeOptimizer.findOptimalRange(
              volatileConfig.targetAPY, baseFeeAPR, incentiveAPR, fundingAPR, 0.6, 0.01, 0.20, volatileConfig.costModel
            );
            volatileConfig.rangeWidth = optimization.optimalRangeWidth;
            console.log(`   ✅ Optimal range width: ±${(optimization.optimalRangeWidth * 100).toFixed(2)}%`);
       }
    }
    if (!volatileConfig.rangeWidth) volatileConfig.rangeWidth = 0.05;
    
    this.validateConfigOrThrow(volatileConfig);

    const allocation = volatileConfig.allocation !== undefined ? volatileConfig.allocation : 0.25;
    const totalValue = portfolio.totalValue();
    const allocatedAmount = totalValue.multiply(allocation);
    const rangeWidth = volatileConfig.rangeWidth;

    if (!existingPosition && allocatedAmount.value > 0) {
        // Open Position
        const lpPrice = Price.create(1.0); // LP token price is abstract 1.0
        const entryPrice = marketData.price; // Actual ETH price at entry
        this.entryPrices.set(positionId, entryPrice);

        const position = Position.create({
            id: positionId,
            strategyId: this.id,
            asset: volatileConfig.pair,
            amount: allocatedAmount,
            entryPrice: entryPrice, // Store actual ETH price, not LP price
            currentPrice: entryPrice // Initialize current price to entry
        });
        positions.push(position);

        const lpTrade = this.createTradeForStrategy(
            volatileConfig.pair, 'buy', allocatedAmount, entryPrice, marketData.timestamp
        );
        trades.push(lpTrade);

    } else if (existingPosition) {
        // Check Rebalance
        if (allocatedAmount.value > 0) {
            let trackedEntryPrice = this.entryPrices.get(positionId);
            if (!trackedEntryPrice) {
                trackedEntryPrice = marketData.price;
                this.entryPrices.set(positionId, trackedEntryPrice);
            }

            const priceChange = trackedEntryPrice.percentageChange(marketData.price); // Returns (current - entry) / entry * 100
            const absPriceChange = Math.abs(priceChange);
            const rebalanceThreshold = volatileConfig.rebalanceThreshold || 0.9;
            const rebalanceTrigger = rangeWidth * rebalanceThreshold * 100; // e.g., 0.10 * 0.9 * 100 = 9%

            if (absPriceChange >= rebalanceTrigger) {
                shouldRebalance = true;
                rebalanceReason = `Price moved ${absPriceChange.toFixed(2)}% (Threshold: ${rebalanceTrigger.toFixed(2)}%)`;
                this.entryPrices.set(positionId, marketData.price);
            }

            // Update position with LP token price ($1.00), not ETH market price
            // LP tokens are priced in USD, not ETH, so we use 1.0
            const lpPrice = Price.create(1.0);
            positions.push(existingPosition.updatePrice(lpPrice));
        }
    }

    return { trades, positions, shouldRebalance, rebalanceReason };
  }

  calculateExpectedYield(config: StrategyConfig, _marketData: MarketData): APR {
    const volatileConfig = config as VolatilePairConfig;
    const ammFeeAPR = volatileConfig.ammFeeAPR || 20;
    const incentiveAPR = volatileConfig.incentiveAPR || 15;
    const fundingAPR = volatileConfig.fundingAPR || 5;
    return APR.create(ammFeeAPR + incentiveAPR + fundingAPR);
  }

  validateConfig(config: StrategyConfig): boolean {
    const volatileConfig = config as VolatilePairConfig;
    const hasRangeWidth = volatileConfig.rangeWidth !== undefined;
    const hasTargetAPY = volatileConfig.targetAPY !== undefined;
    return (
      !!volatileConfig.pair &&
      (hasRangeWidth || hasTargetAPY) &&
      (!hasRangeWidth || (volatileConfig.rangeWidth! > 0 && volatileConfig.rangeWidth! <= 0.5)) &&
      (!hasTargetAPY || (volatileConfig.targetAPY! > 0 && volatileConfig.targetAPY! < 200)) &&
      (volatileConfig.hedgeRatio === undefined || (volatileConfig.hedgeRatio >= 0.8 && volatileConfig.hedgeRatio <= 1.2))
    );
  }

  private validateConfigOrThrow(config: VolatilePairConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid VolatilePairStrategy config`);
    }
  }
}

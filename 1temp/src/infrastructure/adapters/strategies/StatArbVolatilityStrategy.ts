import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '../../../domain/entities/Strategy';
import { APR, Price } from '../../../domain/value-objects';
import { Position } from '../../../domain/entities/Position';
import { Trade } from '../../../domain/entities/Trade';
import { VolatilePairConfig } from './VolatilePairStrategy';

export class StatArbVolatilityStrategy extends BaseStrategy {
  private entryPrices: Map<string, Price> = new Map();
  private lastCheckTimes: Map<string, Date> = new Map();
  private priceHistory: number[] = [];
  private readonly WINDOW_SIZE = 24; // 24 periods (hours) for volatility calc

  constructor(id: string, name: string = 'Stat Arb Volatility Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const volatileConfig = config as VolatilePairConfig;
    
    // 1. Update Price History
    this.priceHistory.push(marketData.price.value);
    if (this.priceHistory.length > this.WINDOW_SIZE) {
      this.priceHistory.shift();
    }

    // 2. Calculate Volatility & Bands
    let volatility = 0;
    let upperBand = 0;
    let lowerBand = 0;
    let sma = 0;

    if (this.priceHistory.length >= this.WINDOW_SIZE) {
        // Calculate SMA
        const sum = this.priceHistory.reduce((a, b) => a + b, 0);
        sma = sum / this.WINDOW_SIZE;

        // Calculate StdDev
        const squaredDiffs = this.priceHistory.map(p => Math.pow(p - sma, 2));
        const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / this.WINDOW_SIZE;
        const stdDev = Math.sqrt(avgSquaredDiff);
        
        // Annualized Volatility (approx, assuming hourly data)
        // Daily Vol = StdDev / SMA
        // Annualized = Daily * sqrt(365) ? No, if data is hourly:
        // Hourly Vol = stdDev / sma
        // Daily Vol = Hourly * sqrt(24)
        const hourlyVol = stdDev / sma;
        volatility = hourlyVol * Math.sqrt(24); // Daily Volatility

        upperBand = sma + (2 * stdDev);
        lowerBand = sma - (2 * stdDev);
    }

    // 3. Smart Logic: Adjust Range Width based on Volatility
    // Default is 0.05 (5%)
    let activeRangeWidth = volatileConfig.rangeWidth || 0.05;
    let regime = "NORMAL";

    if (volatility > 0) {
        if (volatility < 0.02) { // Low Vol (< 2% Daily) -> Tighten
            activeRangeWidth = 0.025; // 2.5%
            regime = "LOW_VOL";
        } else if (volatility > 0.05) { // High Vol (> 5% Daily) -> Widen
            activeRangeWidth = 0.10; // 10%
            regime = "HIGH_VOL";
        }
    }

    // --- Heartbeat Logic (Same as VolatilePair) ---
    const checkIntervalHours = volatileConfig.checkIntervalHours || 1; // Check hourly for Stat Arb
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

    const allocation = volatileConfig.allocation !== undefined ? volatileConfig.allocation : 0.25;
    const totalValue = portfolio.totalValue();
    const allocatedAmount = totalValue.multiply(allocation);

    if (!existingPosition && allocatedAmount.value > 0) {
        // Open Position
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

            const currentPriceVal = marketData.price.value;
            const priceChange = trackedEntryPrice.percentageChange(marketData.price);
            const absPriceChange = Math.abs(priceChange);
            
            // 4. Smart Rebalance Trigger
            // A. Standard Threshold Check (using Dynamic Range)
            const rebalanceThreshold = volatileConfig.rebalanceThreshold || 0.9;
            const rebalanceTrigger = activeRangeWidth * rebalanceThreshold * 100;

            if (absPriceChange >= rebalanceTrigger) {
                shouldRebalance = true;
                rebalanceReason = `[${regime}] Threshold Hit: ${absPriceChange.toFixed(2)}% >= ${rebalanceTrigger.toFixed(2)}%`;
            }

            // B. Bollinger Breakout Check
            if (upperBand > 0) { // Ensure bands are initialized
                if (currentPriceVal > upperBand || currentPriceVal < lowerBand) {
                    shouldRebalance = true;
                    rebalanceReason = `[${regime}] Bollinger Breakout: Price ${currentPriceVal.toFixed(2)} outside [${lowerBand.toFixed(2)}, ${upperBand.toFixed(2)}]`;
                }
            }

            if (shouldRebalance) {
                this.entryPrices.set(positionId, marketData.price);
            }

            positions.push(existingPosition.updatePrice(Price.create(1.0)));
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
    return true; // Simplify for now
  }
}


import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '@domain/entities/Strategy';
import { Amount, Price, APR, FundingRate, HealthFactor } from '@domain/value-objects';
import { Position } from '@domain/entities/Position';
import { Trade } from '@domain/entities/Trade';
import { SynthetixFundingRatesAdapter } from '../data/SynthetixFundingRatesAdapter';
import { HyperliquidAdapter } from '../data/HyperliquidAdapter';

import { AaveV3Adapter } from '../data/AaveV3Adapter';

export interface FundingRateConfig extends StrategyConfig {
  asset: string;
  fundingThreshold?: number; // Default 0.0001 (0.01% per 8h)
  leverage?: number; // 1.5-3x
  healthFactorThreshold?: number;
  allocation?: number;
  // Optional: use Synthetix adapter for dynamic funding rates
  fundingAdapter?: SynthetixFundingRatesAdapter;
  // Optional: use Hyperliquid adapter for dynamic funding rates
  hyperliquidAdapter?: HyperliquidAdapter;
  // Optional: use Aave adapter for borrow rates
  borrowRateAdapter?: AaveV3Adapter;
  borrowAsset?: string; // e.g. 'USDC'
  marketKey?: string; // e.g., 'sETH', 'sBTC'
}

export class FundingRateCaptureStrategy extends BaseStrategy {
  constructor(id: string, name: string = 'Funding Rate Capture Strategy') {
    super(id, name);
  }

  private static hardcodedFundingRateLogged = false;

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const fundingConfig = config as FundingRateConfig;
    this.validateConfigOrThrow(fundingConfig);

    const trades: Trade[] = [];
    const positions: Position[] = [];
    let shouldRebalance = false;

    const threshold = fundingConfig.fundingThreshold || 0.0001;
    let fundingRate = marketData.fundingRate;

    // 1. Try Synthetix Adapter
    if (fundingConfig.fundingAdapter && fundingConfig.marketKey) {
      try {
        const dayStart = new Date(marketData.timestamp);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const updates = await fundingConfig.fundingAdapter.fetchFundingHistory(
          fundingConfig.marketKey,
          dayStart,
          dayEnd
        );

        if (updates && updates.length > 0) {
          const latestUpdate = updates[updates.length - 1];
          fundingRate = FundingRate.create(latestUpdate.fundingRatePerInterval);
        }
      } catch (error) {
        console.warn(`Failed to fetch Synthetix funding rates: ${error}`);
      }
    }

    // 2. Try Hyperliquid Adapter (Preferred)
    if (fundingConfig.hyperliquidAdapter) {
      try {
        const rate = await fundingConfig.hyperliquidAdapter.fetchFundingRate(
          fundingConfig.asset, 
          marketData.timestamp
        );
        if (rate && !isNaN(rate.value)) {
          fundingRate = rate;
        }
      } catch (error) {
        // Fall through
      }
    }

    // 3. Hardcoded Fallback
    if (!fundingRate) {
      const annualizedRate = 0.10; // 10% baseline
      const hourlyRate = annualizedRate / (365 * 24);
      fundingRate = FundingRate.create(hourlyRate);
    }

    // Only execute if funding is non-zero
    if (!fundingRate || fundingRate.value === 0) {
      return { trades, positions, shouldRebalance };
    }

    const allocation = fundingConfig.allocation || 0.15;
    const leverage = fundingConfig.leverage || 2.0;
    const totalValue = portfolio.totalValue();
    const baseAmount = totalValue.multiply(allocation);
    const notionalAmountUSD = baseAmount.multiply(leverage);
    const notionalTokenAmount = notionalAmountUSD.divide(marketData.price.value);
    
    // DEBUG: Check for negative amounts
    if (baseAmount.value < 0 || notionalAmountUSD.value < 0) {
      console.error(`Negative amounts detected: base=$${baseAmount.value}, notional=$${notionalAmountUSD.value}, portfolio=$${totalValue.value}`);
      return { trades, positions, shouldRebalance };
    }
    
    const borrowedAmount = notionalAmountUSD.subtract(baseAmount);

    // Check health factor
    const healthFactor = HealthFactor.create(leverage / 0.8);
    if (healthFactor.isAtRisk(fundingConfig.healthFactorThreshold || 1.5)) {
      shouldRebalance = true;
    }

    const existingPosition = portfolio.positions.find(
      (p) => p.strategyId === this.id && p.asset === (fundingConfig.borrowAsset || 'USDC')
    );
    
    if (!existingPosition && baseAmount.value > 0) {
      try {
        // Create Synthetic Delta Neutral Position (Collateral only)
        // We track it as USDC so value doesn't fluctuate with ETH price
        const stableAsset = fundingConfig.borrowAsset || 'USDC';
        
        // Trade is just for logging/cash flow (selling ETH to USDC? or just converting cash?)
        // Actually we just reserve the cash into the position
        // We model "buying" the position
        const spotTrade = this.createTradeForStrategy(
          stableAsset,
          'buy',
          baseAmount, // Equity Amount
          Price.create(1.0),
          marketData.timestamp
        );

        trades.push(spotTrade);

        const position = Position.create({
          id: `${this.id}-${fundingConfig.asset}-${Date.now()}`,
          strategyId: this.id,
          asset: stableAsset, // 'USDC'
          amount: baseAmount, // Equity
          entryPrice: Price.create(1.0),
          currentPrice: Price.create(1.0),
          collateralAmount: baseAmount,
          borrowedAmount: borrowedAmount, // Metadata
        });

        positions.push(position);
      } catch (error) {
        // Failed to create position (likely negative amount error)
        // This can happen if portfolio has insufficient cash
        // Just skip position creation and try again next tick
        console.warn(`Funding strategy failed to create position: ${(error as Error).message}`);
        return { trades: [], positions: [], shouldRebalance: false };
      }
    } else if (existingPosition && fundingRate && !fundingRate.isPositive()) {
      // Close position if funding turns negative
      shouldRebalance = true;
    } else if (existingPosition) {
      // Keep price at 1.0 (Delta Neutral)
      positions.push(existingPosition.updatePrice(Price.create(1.0)));
    }

    return { trades, positions, shouldRebalance };
  }

  async calculateExpectedYield(config: StrategyConfig, marketData: MarketData): Promise<APR> {
    const fundingConfig = config as FundingRateConfig;
    let fundingRate = marketData.fundingRate;
    
    // 1. Try Hyperliquid Adapter (Preferred)
    if (fundingConfig.hyperliquidAdapter) {
      try {
        const rate = await fundingConfig.hyperliquidAdapter.fetchFundingRate(
          fundingConfig.asset, 
          marketData.timestamp
        );
        // Use rate if valid (positive OR negative)
        if (rate && !isNaN(rate.value)) {
          fundingRate = rate;
        }
      } catch (error) {
        // Fall through
      }
    }

    // 2. Fallback to Hardcoded if missing
    if (!fundingRate) {
      const annualizedRate = 0.10; // 10% baseline
      const hourlyRate = annualizedRate / (365 * 24);
      fundingRate = FundingRate.create(hourlyRate);
    }

    const leverage = fundingConfig.leverage || 2.0;
    const fundingAPR = fundingRate.toAPR();
    const fundingValue = fundingAPR / 100; // Decimal value

    // STRATEGY SELECTION: Standard (Long Spot/Short Perp) vs Reverse (Short Spot/Long Perp)
    
    // Standard Strategy: Profits when Funding > 0
    // Cost: USDC Borrow Rate (User observed: 5%)
    const usdcBorrowRate = 0.05; 
    // Net Standard = (Funding * Lev) - (USDC Borrow * (Lev - 1))
    const standardYield = (fundingValue * leverage) - (usdcBorrowRate * (leverage - 1));

    // Reverse Strategy: Profits when Funding < 0
    // Revenue: |Funding| + USDC Supply (User observed: 3.89%)
    // Cost: ETH Borrow Rate (User observed: 1.92%)
    const usdcSupplyRate = 0.0389;
    const ethBorrowRate = 0.0192;
    
    // For Reverse:
    // Equity $100. Lev 3x -> $300 Exposure.
    // Long Perp $300 -> Earns |Funding|
    // Short Spot $300 -> Borrow $300 ETH (Pay 1.92%), Sell for $300 USDC.
    // Total USDC = $100 + $300 = $400. Lend at 3.89%.
    // Net = (|Funding| * 300) + (400 * 3.89%) - (300 * 1.92%)
    // Yield on $100 = 3*|Funding| + 15.56 - 5.76 = 3*|Funding| + 9.8%
    // Normalized: (|Funding| * Lev) + ((Lev+1)*Supply - Lev*Borrow)
    
    // Precise Reverse Yield:
    const reverseYield = (Math.abs(fundingValue) * leverage) + 
                         (usdcSupplyRate * (leverage + 1)) - 
                         (ethBorrowRate * leverage);

    // DECISION LOGIC
    let finalAPR = 0;
    
    if (fundingValue > 0) {
        // Positive Funding -> Standard Strategy
        finalAPR = standardYield;
    } else {
        // Negative Funding -> Reverse Strategy
        finalAPR = reverseYield;
    }

    // Check against threshold (ensure net yield is positive enough)
    // We use a lower threshold for yield than raw funding
    if (finalAPR < 0.01) { // Min 1% APY to execute
        return APR.zero();
    }

    return APR.create(finalAPR * 100);
  }

  validateConfig(config: StrategyConfig): boolean {
    const fundingConfig = config as FundingRateConfig;
    return (
      !!fundingConfig.asset &&
      (fundingConfig.leverage === undefined ||
        (fundingConfig.leverage >= 1.0 && fundingConfig.leverage <= 3.0))
    );
  }

  private validateConfigOrThrow(config: FundingRateConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid FundingRateCaptureStrategy config`);
    }
  }
}


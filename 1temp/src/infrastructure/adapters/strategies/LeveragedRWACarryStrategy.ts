import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '@domain/entities/Strategy';
import { Price, APR, HealthFactor } from '@domain/value-objects';
import { Position } from '@domain/entities/Position';
import { Trade } from '@domain/entities/Trade';
import { AaveV3Adapter } from '@infrastructure/adapters/data/AaveV3Adapter';

export interface LeveragedRWAConfig extends StrategyConfig {
  rwaVault: string;
  couponRate: number; // 7-10%
  leverage?: number; // 3-4x
  borrowAPR?: number; // 2-8% (static fallback)
  borrowAssetAddress?: string; // Address of borrow asset (e.g., USDC)
  healthFactorThreshold?: number;
  allocation?: number;
  maturityDays?: number; // 30-90
  borrowRatesAdapter?: AaveV3Adapter; // Optional: dynamic borrow rate fetching
}

export class LeveragedRWACarryStrategy extends BaseStrategy {
  constructor(id: string, name: string = 'Leveraged RWA Carry Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const rwaConfig = config as LeveragedRWAConfig;
    this.validateConfigOrThrow(rwaConfig);

    const trades: Trade[] = [];
    const positions: Position[] = [];
    let shouldRebalance = false;

    // Fetch dynamic borrow rate if adapter provided
    let currentBorrowAPR = rwaConfig.borrowAPR || 4;

    if (rwaConfig.borrowRatesAdapter && rwaConfig.borrowAssetAddress) {
      try {
        const dayStart = new Date(marketData.timestamp);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const rates = await rwaConfig.borrowRatesAdapter.fetchReserveRatesHistory(
          rwaConfig.borrowAssetAddress,
          dayStart,
          dayEnd
        );

        if (rates && rates.length > 0) {
          const latestRate = rates[rates.length - 1];
          currentBorrowAPR = latestRate.borrowAPR;
        }
      } catch (error) {
        console.warn(`Failed to fetch dynamic borrow rates, using static config: ${error}`);
      }
    }

    const leverage = rwaConfig.leverage || 3.5;
    const allocation = rwaConfig.allocation || 0.15;
    const totalValue = portfolio.totalValue();
    const baseAmount = totalValue.multiply(allocation);
    const notionalAmount = baseAmount.multiply(leverage);
    const borrowedAmount = notionalAmount.subtract(baseAmount);

    // Check health factor
    const healthFactor = HealthFactor.create(leverage / 0.8);
    if (healthFactor.isAtRisk(rwaConfig.healthFactorThreshold || 1.5)) {
      shouldRebalance = true;
    }

    const existingPosition = portfolio.positions.find(
      (p) => p.strategyId === this.id && p.asset === rwaConfig.rwaVault
    );

    if (!existingPosition && baseAmount.value > 0) {
      // Buy RWA vault tokens
      const trade = this.createTradeForStrategy(
        rwaConfig.rwaVault,
        'buy',
        notionalAmount,
        Price.create(1.0), // RWA tokens typically trade at NAV
        marketData.timestamp
      );

      trades.push(trade);

      const position = Position.create({
        id: `${this.id}-${rwaConfig.rwaVault}-${Date.now()}`,
        strategyId: this.id,
        asset: rwaConfig.rwaVault,
        amount: notionalAmount,
        entryPrice: Price.create(1.0),
        currentPrice: Price.create(1.0),
        collateralAmount: baseAmount,
        borrowedAmount,
      });

      positions.push(position);
    } else if (existingPosition) {
      positions.push(existingPosition.updatePrice(marketData.price));
    }

    return { trades, positions, shouldRebalance };
  }

  async calculateExpectedYield(config: StrategyConfig, marketData: MarketData): Promise<APR> {
    const rwaConfig = config as LeveragedRWAConfig;
    const couponRate = rwaConfig.couponRate || 8;
    const leverage = rwaConfig.leverage || 3.5;
    
    // Try to fetch dynamic borrow rate
    let borrowAPR = rwaConfig.borrowAPR || 4;

    if (rwaConfig.borrowRatesAdapter && rwaConfig.borrowAssetAddress) {
      try {
        const dayStart = new Date(marketData.timestamp);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const rates = await rwaConfig.borrowRatesAdapter.fetchReserveRatesHistory(
          rwaConfig.borrowAssetAddress,
          dayStart,
          dayEnd
        );

        if (rates && rates.length > 0) {
          const latestRate = rates[rates.length - 1];
          borrowAPR = latestRate.borrowAPR;
        }
      } catch (error) {
        // Use static fallback
      }
    }

    // Net carry = coupon * leverage - borrow cost * (leverage - 1)
    const netCarry = couponRate * leverage - borrowAPR * (leverage - 1);
    return APR.create(Math.max(0, netCarry));
  }

  validateConfig(config: StrategyConfig): boolean {
    const rwaConfig = config as LeveragedRWAConfig;
    return (
      !!rwaConfig.rwaVault &&
      typeof rwaConfig.couponRate === 'number' &&
      rwaConfig.couponRate >= 5 &&
      rwaConfig.couponRate <= 15 &&
      (rwaConfig.leverage === undefined ||
        (rwaConfig.leverage >= 2.0 && rwaConfig.leverage <= 5.0))
    );
  }

  private validateConfigOrThrow(config: LeveragedRWAConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid LeveragedRWACarryStrategy config`);
    }
  }
}


import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '@domain/entities/Strategy';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Amount, APR, HealthFactor } from '@domain/value-objects';
import { Position } from '@domain/entities/Position';
import { Trade } from '@domain/entities/Trade';
import { AaveV3Adapter } from '@infrastructure/adapters/data/AaveV3Adapter';

export interface LeveragedLendingConfig extends StrategyConfig {
  asset: string;
  assetAddress?: string; // Asset address for Aave lookups
  loops?: number; // 3-5 recursive loops
  healthFactorThreshold?: number; // Default 1.5
  borrowAPR?: number; // Static fallback if no adapter
  supplyAPR?: number; // Static fallback if no adapter
  incentiveAPR?: number; // Static fallback if no adapter
  allocation?: number;
  ratesAdapter?: AaveV3Adapter; // Optional: dynamic rate fetching
}

export class LeveragedLendingStrategy extends BaseStrategy {
  constructor(id: string, name: string = 'Leveraged Lending Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const lendingConfig = config as LeveragedLendingConfig;
    this.validateConfigOrThrow(lendingConfig);

    const trades: Trade[] = [];
    const positions: Position[] = [];
    let shouldRebalance = false;

    // Fetch dynamic rates if adapter provided
    let currentSupplyAPR = lendingConfig.supplyAPR || 6;
    let currentBorrowAPR = lendingConfig.borrowAPR || 8;
    let currentIncentiveAPR = lendingConfig.incentiveAPR || 10;

    if (lendingConfig.ratesAdapter && lendingConfig.assetAddress) {
      try {
        const dayStart = new Date(marketData.timestamp);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const rates = await lendingConfig.ratesAdapter.fetchReserveRatesHistory(
          lendingConfig.assetAddress,
          dayStart,
          dayEnd
        );

        if (rates && rates.length > 0) {
          const latestRate = rates[rates.length - 1];
          currentSupplyAPR = latestRate.supplyAPR;
          currentBorrowAPR = latestRate.borrowAPR;
          currentIncentiveAPR = latestRate.incentiveAPR;
        }
      } catch (error) {
        console.warn(`Failed to fetch dynamic rates, using static config: ${error}`);
      }
    }

    const loops = lendingConfig.loops || 3;
    const allocation = lendingConfig.allocation || 0.2;
    const totalValue = portfolio.totalValue();
    const baseAmount = totalValue.multiply(allocation);

    // Calculate effective leverage
    const ltv = 0.8; // 80% LTV
    const effectiveLeverage = 1 / (1 - ltv * (loops - 1) / loops);

    // Check health factor
    const healthFactor = HealthFactor.create(effectiveLeverage / ltv);
    if (healthFactor.isAtRisk(lendingConfig.healthFactorThreshold || 1.5)) {
      shouldRebalance = true;
    }

    const existingPosition = portfolio.positions.find(
      (p) => p.strategyId === this.id && p.asset === lendingConfig.asset
    );

    if (!existingPosition && baseAmount.value > 0) {
      // Create leveraged position through recursive loops
      const notionalAmount = baseAmount.multiply(effectiveLeverage);
      const borrowedAmount = notionalAmount.subtract(baseAmount);

      const trade = this.createTradeForStrategy(
        lendingConfig.asset,
        'buy',
        notionalAmount,
        marketData.price,
        marketData.timestamp
      );

      trades.push(trade);

      const position = Position.create({
        id: `${this.id}-${lendingConfig.asset}-${Date.now()}`,
        strategyId: this.id,
        asset: lendingConfig.asset,
        amount: notionalAmount,
        entryPrice: marketData.price,
        currentPrice: marketData.price,
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
    const lendingConfig = config as LeveragedLendingConfig;
    
    // Try to fetch dynamic rates
    let supplyAPR = lendingConfig.supplyAPR || 6;
    let incentiveAPR = lendingConfig.incentiveAPR || 10;
    let borrowAPR = lendingConfig.borrowAPR || 8;

    if (lendingConfig.ratesAdapter && lendingConfig.assetAddress) {
      try {
        const dayStart = new Date(marketData.timestamp);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const rates = await lendingConfig.ratesAdapter.fetchReserveRatesHistory(
          lendingConfig.assetAddress,
          dayStart,
          dayEnd
        );

        if (rates && rates.length > 0) {
          const latestRate = rates[rates.length - 1];
          supplyAPR = latestRate.supplyAPR;
          borrowAPR = latestRate.borrowAPR;
          incentiveAPR = latestRate.incentiveAPR;
        }
      } catch (error) {
        // Use static fallback
      }
    }

    const loops = lendingConfig.loops || 3;
    const leverage = 1 / (1 - 0.8 * (loops - 1) / loops);

    const grossYield = (supplyAPR + incentiveAPR) * leverage - borrowAPR * (leverage - 1);
    return APR.create(Math.max(0, grossYield));
  }

  validateConfig(config: StrategyConfig): boolean {
    const lendingConfig = config as LeveragedLendingConfig;
    return (
      !!lendingConfig.asset &&
      (lendingConfig.loops === undefined || (lendingConfig.loops >= 2 && lendingConfig.loops <= 5))
    );
  }

  private validateConfigOrThrow(config: LeveragedLendingConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid LeveragedLendingStrategy config`);
    }
  }
}


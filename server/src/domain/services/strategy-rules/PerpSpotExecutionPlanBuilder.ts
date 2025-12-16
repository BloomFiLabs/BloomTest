import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ISpotExchangeAdapter } from '../../ports/ISpotExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { PositionSize } from '../../value-objects/PositionSize';
import { Result } from '../../common/Result';
import {
  DomainException,
  ExchangeException,
  ValidationException,
  InsufficientBalanceException,
} from '../../exceptions/DomainException';
import {
  PerpOrderRequest,
  OrderSide,
  OrderType,
  TimeInForce,
} from '../../value-objects/PerpOrder';
import { SpotOrderRequest } from '../../value-objects/SpotOrder';
import { PerpSpotBalanceManager } from './PerpSpotBalanceManager';
import { CostCalculator } from './CostCalculator';

/**
 * Execution plan for perp-spot delta-neutral strategy
 */
export interface PerpSpotExecutionPlan {
  opportunity: ArbitrageOpportunity;
  perpOrder: PerpOrderRequest;
  spotOrder: SpotOrderRequest;
  positionSize: PositionSize; // Position size in base asset (same for both perp and spot)
  estimatedCosts: {
    perpFees: number;
    spotFees: number;
    slippage: number;
    basisRisk: number; // Risk from perp-spot price divergence
    total: number;
  };
  expectedNetReturn: number; // After costs
  timestamp: Date;
}

/**
 * Execution plan builder for perp-spot delta-neutral strategies
 *
 * Builds execution plans where:
 * - Perp and spot positions are on the same exchange
 * - Position sizes are equal (delta neutral)
 * - Opposite sides: Long perp + Short spot OR Short perp + Long spot
 */
@Injectable()
export class PerpSpotExecutionPlanBuilder {
  private readonly logger = new Logger(PerpSpotExecutionPlanBuilder.name);

  constructor(
    private readonly balanceManager: PerpSpotBalanceManager,
    private readonly costCalculator: CostCalculator,
  ) {}

  /**
   * Build execution plan for perp-spot opportunity
   *
   * 1. Optimize balance distribution (transfer funds if needed)
   * 2. Calculate position size (constrained by balances and max size)
   * 3. Create perp and spot orders (opposite sides, same size)
   * 4. Calculate costs and expected return
   */
  async buildExecutionPlan(
    opportunity: ArbitrageOpportunity,
    perpAdapter: IPerpExchangeAdapter,
    spotAdapter: ISpotExchangeAdapter,
    config: StrategyConfig,
    maxPositionSizeUsd?: number,
    leverageOverride?: number,
  ): Promise<Result<PerpSpotExecutionPlan, DomainException>> {
    try {
      if (opportunity.strategyType !== 'perp-spot') {
        return Result.failure(
          new ValidationException(
            `Expected perp-spot opportunity, got ${opportunity.strategyType}`,
            'INVALID_STRATEGY_TYPE',
          ),
        );
      }

      if (
        !opportunity.spotExchange ||
        opportunity.spotExchange !== opportunity.longExchange
      ) {
        return Result.failure(
          new ValidationException(
            'Perp-spot opportunity must have spotExchange same as longExchange',
            'INVALID_SPOT_EXCHANGE',
          ),
        );
      }

      const leverage = leverageOverride ?? config.leverage;
      const exchange = opportunity.longExchange;

      // Get current balances
      const [perpBalance, spotBalance] = await Promise.all([
        perpAdapter.getBalance(),
        spotAdapter
          .getSpotBalance('USDC')
          .catch(() => spotAdapter.getSpotBalance('USDT').catch(() => 0)),
      ]);

      // Get mark price
      let markPrice: number;
      try {
        markPrice = await perpAdapter.getMarkPrice(opportunity.symbol);
      } catch (error: any) {
        return Result.failure(
          new ExchangeException(
            `Failed to get mark price: ${error.message}`,
            exchange,
            { symbol: opportunity.symbol, error: error.message },
          ),
        );
      }

      // Calculate target position size (before rebalancing)
      const targetPositionSize = this.calculateTargetPositionSize(
        perpBalance,
        spotBalance,
        leverage,
        maxPositionSizeUsd,
        config,
      );

      // Step 1: Optimize balance distribution
      const rebalanceResult =
        await this.balanceManager.ensureOptimalBalanceDistribution(
          exchange,
          perpAdapter,
          spotAdapter,
          targetPositionSize,
          leverage,
        );

      if (rebalanceResult.isFailure) {
        this.logger.warn(
          `Balance rebalancing failed (continuing with original balances): ${rebalanceResult.error.message}`,
        );
      }

      // Re-fetch balances after rebalancing
      const [updatedPerpBalance, updatedSpotBalance] = await Promise.all([
        perpAdapter.getBalance(),
        spotAdapter
          .getSpotBalance('USDC')
          .catch(() => spotAdapter.getSpotBalance('USDT').catch(() => 0)),
      ]);

      // Step 2: Calculate final position size
      const positionSizeResult = this.calculatePositionSize(
        updatedPerpBalance,
        updatedSpotBalance,
        leverage,
        markPrice,
        maxPositionSizeUsd,
        config,
      );

      if (positionSizeResult.isFailure) {
        return Result.failure(positionSizeResult.error);
      }

      const positionSize = positionSizeResult.value;

      // Step 3: Determine order sides based on funding rate
      // Positive funding: Long spot + Short perp (receive funding on short)
      // Negative funding: Short spot + Long perp (receive funding on long)
      const perpRate = opportunity.longRate.toDecimal();
      const perpSide = perpRate > 0 ? OrderSide.SHORT : OrderSide.LONG;
      const spotSide = perpRate > 0 ? OrderSide.LONG : OrderSide.SHORT;

      // Step 4: Create orders
      const perpOrder = new PerpOrderRequest(
        opportunity.symbol,
        perpSide,
        OrderType.MARKET,
        positionSize.toBaseAsset(),
        undefined, // Market order
        TimeInForce.IOC,
        false, // Not reduce-only
      );

      const spotOrder = new SpotOrderRequest(
        opportunity.symbol,
        spotSide,
        OrderType.MARKET,
        positionSize.toBaseAsset(), // Same size for delta neutrality
        undefined, // Market order
        TimeInForce.IOC,
      );

      // Step 5: Calculate costs
      const costs = await this.calculateCosts(
        opportunity,
        positionSize.toBaseAsset(),
        markPrice,
        perpAdapter,
        spotAdapter,
        config,
      );

      // Step 6: Calculate expected net return
      const grossReturn = opportunity.expectedReturn.toAPY();
      const netReturn =
        grossReturn -
        (costs.total / (positionSize.toBaseAsset() * markPrice)) * 100;

      const plan: PerpSpotExecutionPlan = {
        opportunity,
        perpOrder,
        spotOrder,
        positionSize,
        estimatedCosts: costs,
        expectedNetReturn: netReturn,
        timestamp: new Date(),
      };

      this.logger.log(
        `✅ Perp-spot execution plan created: ${opportunity.symbol} on ${exchange}, ` +
          `size=${positionSize.toBaseAsset().toFixed(4)}, netReturn=${netReturn.toFixed(2)}%`,
      );

      return Result.success(plan);
    } catch (error: any) {
      this.logger.error(
        `Failed to build perp-spot execution plan: ${error.message}`,
      );
      return Result.failure(
        new DomainException(
          `Failed to build perp-spot execution plan: ${error.message}`,
          'EXECUTION_PLAN_BUILD_FAILED',
          error,
        ),
      );
    }
  }

  /**
   * Calculate target position size before rebalancing
   */
  private calculateTargetPositionSize(
    perpBalance: number,
    spotBalance: number,
    leverage: number,
    maxPositionSizeUsd: number | undefined,
    config: StrategyConfig,
  ): number {
    // Calculate current capacity
    const perpCapacity = perpBalance * leverage;
    const spotCapacity = spotBalance;
    const currentMaxPosition = Math.min(perpCapacity, spotCapacity);

    // Apply max position size constraint
    const maxPosition = maxPositionSizeUsd ?? Infinity;
    const targetPosition = Math.min(currentMaxPosition, maxPosition);

    return targetPosition;
  }

  /**
   * Calculate position size after rebalancing
   * Ensures spotSize = perpSize (delta neutral requirement)
   */
  private calculatePositionSize(
    perpBalance: number,
    spotBalance: number,
    leverage: number,
    markPrice: number,
    maxPositionSizeUsd: number | undefined,
    config: StrategyConfig,
  ): Result<PositionSize, DomainException> {
    // Calculate capacity
    const perpCapacity = perpBalance * leverage;
    const spotCapacity = spotBalance;

    // Position size is constrained by the smaller of the two
    const maxPositionUsd = Math.min(perpCapacity, spotCapacity);

    // Apply max position size constraint
    const maxPosition = maxPositionSizeUsd ?? Infinity;
    const finalMaxPosition = Math.min(maxPositionUsd, maxPosition);

    if (finalMaxPosition <= 0) {
      return Result.failure(
        new InsufficientBalanceException(
          finalMaxPosition,
          Math.min(perpCapacity, spotCapacity),
          'USDC',
          {
            perpBalance,
            spotBalance,
            leverage,
            perpCapacity,
            spotCapacity,
            message: `Insufficient balance for perp-spot position. Perp capacity: $${perpCapacity.toFixed(2)}, Spot capacity: $${spotCapacity.toFixed(2)}`,
          },
        ),
      );
    }

    // Convert to base asset size
    const positionSize = finalMaxPosition / markPrice;

    try {
      return Result.success(PositionSize.fromBaseAsset(positionSize));
    } catch (error: any) {
      return Result.failure(
        new ValidationException(
          `Invalid position size: ${error.message}`,
          'INVALID_POSITION_SIZE',
        ),
      );
    }
  }

  /**
   * Calculate costs for perp-spot execution
   */
  private async calculateCosts(
    opportunity: ArbitrageOpportunity,
    positionSize: number,
    markPrice: number,
    perpAdapter: IPerpExchangeAdapter,
    spotAdapter: ISpotExchangeAdapter,
    config: StrategyConfig,
  ): Promise<{
    perpFees: number;
    spotFees: number;
    slippage: number;
    basisRisk: number;
    total: number;
  }> {
    const positionValue = positionSize * markPrice;

    // Get best bid/ask for slippage calculation
    let perpBidAsk: { bestBid: number; bestAsk: number };
    if (
      'getBestBidAsk' in perpAdapter &&
      typeof (perpAdapter as any).getBestBidAsk === 'function'
    ) {
      perpBidAsk = await (perpAdapter as any).getBestBidAsk(opportunity.symbol);
    } else {
      // Fallback to mark price
      const perpMarkPrice = await perpAdapter.getMarkPrice(opportunity.symbol);
      const estimatedSpread = perpMarkPrice * 0.001;
      perpBidAsk = {
        bestBid: perpMarkPrice - estimatedSpread / 2,
        bestAsk: perpMarkPrice + estimatedSpread / 2,
      };
    }

    let spotBidAsk: { bestBid: number; bestAsk: number };
    if (
      'getBestBidAsk' in spotAdapter &&
      typeof (spotAdapter as any).getBestBidAsk === 'function'
    ) {
      spotBidAsk = await (spotAdapter as any).getBestBidAsk(opportunity.symbol);
    } else {
      // Fallback to spot price
      const spotPrice = await spotAdapter.getSpotPrice(opportunity.symbol);
      const estimatedSpread = spotPrice * 0.001;
      spotBidAsk = {
        bestBid: spotPrice - estimatedSpread / 2,
        bestAsk: spotPrice + estimatedSpread / 2,
      };
    }

    // Perp fees (using cost calculator)
    const perpFees = this.costCalculator.calculateFees(
      positionValue,
      opportunity.longExchange,
      true, // Maker order
      true, // Entry fee
    );

    // Spot fees (typically similar to perp, but may differ)
    // Use same fee rate as perp for now (can be adjusted per exchange)
    const spotFees = this.costCalculator.calculateFees(
      positionValue,
      opportunity.longExchange,
      true, // Maker order
      true, // Entry fee
    );

    // Slippage (estimate) - use perp slippage as proxy
    const slippage = this.costCalculator.calculateSlippageCost(
      positionValue,
      perpBidAsk.bestBid,
      perpBidAsk.bestAsk,
      opportunity.longOpenInterest || 0,
      OrderType.MARKET,
    );

    // Basis risk: perp-spot price divergence
    // Estimate as 0.1% of position value (conservative)
    const basisRisk = positionValue * 0.001;

    const total = perpFees + spotFees + slippage + basisRisk;

    return {
      perpFees,
      spotFees,
      slippage,
      basisRisk,
      total,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { OrderType } from '../../value-objects/PerpOrder';
import { StrategyConfig } from '../../value-objects/StrategyConfig';

/**
 * Cost calculator for funding arbitrage strategy
 * Calculates slippage, fees, funding rate impact, and break-even metrics
 */
@Injectable()
export class CostCalculator {
  constructor(private readonly config: StrategyConfig) {}

  /**
   * Calculate slippage cost based on order book depth and position size
   * Uses square root model: slippage increases with sqrt(order_size / liquidity)
   */
  calculateSlippageCost(
    positionSizeUsd: number,
    bestBid: number,
    bestAsk: number,
    openInterest: number,
    orderType: OrderType,
  ): number {
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadPercent = midPrice > 0 ? spread / midPrice : 0.001; // Default 0.1% if no price

    // Base slippage: limit orders have minimal slippage (we're adding liquidity)
    // Market orders would pay half the spread
    const baseSlippage =
      orderType === OrderType.MARKET
        ? spreadPercent / 2 // Pay half the spread for market orders
        : 0.0001; // Minimal slippage for limit orders (0.01%)

    // Market impact: how much our order size affects price
    // Use open interest as proxy for liquidity
    // Position size should be < 5% of OI to avoid significant impact
    if (openInterest > 0) {
      const liquidityRatio = positionSizeUsd / openInterest;
      // Square root model: impact increases with sqrt(size/liquidity)
      // Cap impact at 2% for very large orders
      const impactSlippage = Math.min(
        Math.sqrt(Math.min(liquidityRatio, 1)) * spreadPercent * 2,
        0.02, // Cap at 2%
      );

      return positionSizeUsd * (baseSlippage + impactSlippage);
    }

    // Fallback: use conservative estimate if no OI data
    const conservativeSlippage =
      orderType === OrderType.MARKET ? 0.0005 : 0.0001;
    return positionSizeUsd * conservativeSlippage;
  }

  /**
   * Predict how our position size will affect the funding rate calculation
   * Funding rates are typically calculated based on OI-weighted premium index
   * Our position affects OI, which can shift the funding rate
   *
   * @param positionSizeUsd Our position size in USD
   * @param openInterest Current open interest in USD
   * @param currentFundingRate Current funding rate (as decimal, e.g., 0.0001 = 0.01%)
   * @returns Predicted change in funding rate (positive = rate increases, negative = rate decreases)
   */
  predictFundingRateImpact(
    positionSizeUsd: number,
    openInterest: number,
    currentFundingRate: number,
  ): number {
    if (openInterest <= 0) {
      return 0; // Can't predict impact without OI data
    }

    // Validate funding rate is valid number
    if (
      currentFundingRate === undefined ||
      currentFundingRate === null ||
      isNaN(currentFundingRate)
    ) {
      return 0; // Can't predict impact with invalid funding rate
    }

    // Calculate our position as a percentage of OI
    const positionRatio = positionSizeUsd / openInterest;

    // Funding rate impact is typically small unless position > 5% of OI
    // Model: impact scales with position ratio, but capped at reasonable levels
    // For long positions: increases funding rate (more longs = higher premium)
    // For short positions: decreases funding rate (more shorts = lower premium)

    // Impact factor: how much our position affects the rate
    // Small positions (< 1% of OI): minimal impact (~0.1% of current rate)
    // Medium positions (1-5% of OI): moderate impact (~1-5% of current rate)
    // Large positions (> 5% of OI): significant impact (~5-10% of current rate)
    const impactFactor = Math.min(
      Math.sqrt(positionRatio) * 0.1, // Square root model, capped at 10% impact
      0.1, // Maximum 10% impact on funding rate
    );

    // Apply impact: long positions increase funding rate, short positions decrease it
    // Since we're taking a long position, it increases the rate
    // The impact is proportional to current rate magnitude
    const impact = currentFundingRate * impactFactor;

    // Validate result is not NaN
    return isNaN(impact) ? 0 : impact;
  }

  /**
   * Calculate fees for a position
   * @param positionSizeUsd Position size in USD
   * @param exchangeType Exchange type
   * @param isMaker Whether this is a maker order (true) or taker order (false)
   * @param isEntry Whether this is an entry fee (true) or exit fee (false)
   * @returns Fee amount in USD
   */
  calculateFees(
    positionSizeUsd: number,
    exchangeType: ExchangeType,
    isMaker: boolean,
    isEntry: boolean,
  ): number {
    const feeRates = isMaker
      ? this.config.exchangeFeeRates
      : this.config.takerFeeRates;

    const feeRate =
      feeRates.has(exchangeType)
        ? feeRates.get(exchangeType)!
        : 0.0005; // Default 0.05% if unknown

    return positionSizeUsd * feeRate;
  }

  /**
   * Calculate break-even hours: how many hours to cover all costs
   * @param totalCosts Total costs (entry fees + exit fees + slippage)
   * @param hourlyReturn Expected hourly return in USD
   * @returns Break-even hours, or null if never breaks even
   */
  calculateBreakEvenHours(
    totalCosts: number,
    hourlyReturn: number,
  ): number | null {
    if (hourlyReturn <= 0) {
      return null; // Never breaks even if no return
    }

    if (totalCosts <= 0) {
      return 0; // Already profitable if no costs
    }

    return totalCosts / hourlyReturn;
  }
}


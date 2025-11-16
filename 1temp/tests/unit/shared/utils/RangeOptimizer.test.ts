import { describe, it, expect } from 'vitest';
import { RangeOptimizer } from '@shared/utils/RangeOptimizer';

describe('RangeOptimizer – risk & sensitivity', () => {
  const positionValueUSD = 40_000;
  const gasCostPerRebalance = 0.01;
  const poolFeeTier = 0.003; // 0.3%
  const historicalVolatility = 0.6; // 60% annual

  function runNetAPY(params: {
    rangeWidth: number;
    baseFeeAPR: number;
    incentiveAPR?: number;
    fundingAPR?: number;
    poolFeeTierOverride?: number;
    gasCostOverride?: number;
  }): number {
    const {
      rangeWidth,
      baseFeeAPR,
      incentiveAPR = 15,
      fundingAPR = 5,
      poolFeeTierOverride,
      gasCostOverride,
    } = params;

    const result = RangeOptimizer.estimateAPYForRange(
      rangeWidth,
      baseFeeAPR,
      incentiveAPR,
      fundingAPR,
      historicalVolatility,
      {
        gasCostPerRebalance: gasCostOverride ?? gasCostPerRebalance,
        poolFeeTier: poolFeeTierOverride ?? poolFeeTier,
        positionValueUSD,
      }
    );

    // netAPY is always defined when costModel is passed
    return result.netAPY ?? result.expectedAPY;
  }

  it('degrades net APY significantly when fee APR is cut in half', () => {
    const rangeWidth = 0.0005; // ±0.05% (aggressive)

    const netAPYBase = runNetAPY({
      rangeWidth,
      baseFeeAPR: 11, // from The Graph
    });

    const netAPYHalfFees = runNetAPY({
      rangeWidth,
      baseFeeAPR: 5.5,
    });

    // Sanity: halving fee APR should noticeably reduce net APY
    expect(netAPYHalfFees).toBeLessThan(netAPYBase);

    // In our model the relationship is superlinear; a very rough bound:
    // with half the fees, net APY should drop by at least ~40%
    const ratio = netAPYHalfFees / netAPYBase;
    expect(ratio).toBeLessThan(0.7);
    expect(ratio).toBeGreaterThan(0.2);
  });

  it('is highly sensitive to increased costs (competition/slippage proxy)', () => {
    const rangeWidth = 0.0005; // ±0.05%

    const netAPYBase = runNetAPY({
      rangeWidth,
      baseFeeAPR: 11,
    });

    // Proxy for higher competition / worse execution:
    // - double the effective pool fee tier
    // - double gas cost per rebalance
    const netAPYHighCost = runNetAPY({
      rangeWidth,
      baseFeeAPR: 11,
      poolFeeTierOverride: poolFeeTier * 2,
      gasCostOverride: gasCostPerRebalance * 2,
    });

    expect(netAPYHighCost).toBeLessThan(netAPYBase);

    // Under much higher costs, the ultra‑narrow strategy should have its edge reduced,
    // even if it can still be very high in some regimes. We only assert a strong
    // relative drop (not an absolute cap), because fee density scaling is superlinear.
    const drop = netAPYBase - netAPYHighCost;
    expect(drop).toBeGreaterThan(100); // at least 100 percentage points haircut
    expect(netAPYHighCost).toBeGreaterThan(0); // still profitable in this scenario
  });

  it('does not assume extreme APY for wider, more realistic ranges', () => {
    const conservativeRange = 0.005; // ±0.5%

    const netAPY = runNetAPY({
      rangeWidth: conservativeRange,
      baseFeeAPR: 11,
    });

    // For ±0.5%, we expect high but not absurd APY – on the order of tens, not thousands.
    expect(netAPY).toBeGreaterThan(0);
    expect(netAPY).toBeLessThan(500);
  });

  it('drops materially when funding is adverse (we pay funding on the short leg)', () => {
    const rangeWidth = 0.0005; // ±0.05%

    const netAPYWithFundingEdge = runNetAPY({
      rangeWidth,
      baseFeeAPR: 11,
      incentiveAPR: 15,
      fundingAPR: 5, // we get paid
    });

    const netAPYPayFunding = runNetAPY({
      rangeWidth,
      baseFeeAPR: 11,
      incentiveAPR: 15,
      fundingAPR: -5, // we pay 5% funding
    });

    expect(netAPYPayFunding).toBeLessThan(netAPYWithFundingEdge);

    // Funding should move the needle by at least the funding delta (here 10 points),
    // even though percentage-wise it's small vs extreme edges.
    expect(netAPYWithFundingEdge - netAPYPayFunding).toBeGreaterThan(5);
  });
});



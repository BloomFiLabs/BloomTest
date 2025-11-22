/**
 * Range Optimizer
 * Optimizes LP range width to hit target APY
 */

import { Price, Amount, APR } from '../../domain/value-objects';

export interface OptimizationResult {
  optimalRangeWidth: number;
  expectedAPY: number; // Gross APY (before costs)
  netAPY?: number; // Net APY (after costs)
  rebalanceFrequency: number; // Estimated rebalances per year
  feeCaptureEfficiency: number; // Estimated % of time in range
  annualCostDrag?: number; // Annual cost drag in percentage points
}

export class RangeOptimizer {
  /**
   * Estimate APY for a given range width
   */
  static estimateAPYForRange(
    rangeWidth: number,
    baseFeeAPR: number,
    incentiveAPR: number,
    fundingAPR: number,
    historicalVolatility: number = 0.6,
    costModel?: {
      gasCostPerRebalance: number; 
      poolFeeTier?: number;
      positionValueUSD?: number;
    },
    trendVelocity: number = 0 // Absolute trend drift per year
  ): OptimizationResult {
    
    const rangePercent = rangeWidth * 100;
    const volatilityPercent = historicalVolatility * 100;
    
    // Efficiency Model
    // REMOVED: trendImpact on efficiency.
    // Reasoning: While in range, fee collection is valid regardless of trend speed.
    // The "penalty" of a trend is the Frequency of exiting, not the efficiency of collection while inside.
    
    const efficiencyRatio = Math.max(0.1, Math.min(0.95, 1 - (volatilityPercent / rangePercent) * 0.3));
    
    const referenceRangeWidth = 0.05; 
    const feeDensityMultiplier = Math.pow(referenceRangeWidth / rangeWidth, 1.5);
    
    const effectiveFeeAPR = baseFeeAPR * feeDensityMultiplier * efficiencyRatio;
    const totalAPR = effectiveFeeAPR + incentiveAPR + fundingAPR;
    
    // Rebalance Frequency with Drift-Diffusion
    const rebalanceThreshold = 0.9;
    const effectiveRebalanceRange = rangeWidth * rebalanceThreshold;
    
    // Diffusion component
    const diffusionRate = (volatilityPercent / (effectiveRebalanceRange * 100)) * 1.2;
    
    // Drift component
    const driftRate = (trendVelocity * 100) / (effectiveRebalanceRange * 100);
    
    // Total Frequency
    const rebalanceFrequency = diffusionRate + driftRate;
    
    let annualCostDrag = 0;
    let netAPY = totalAPR;
    
    if (costModel) {
      const gasCostPerRebalance = costModel.gasCostPerRebalance;
      
      let poolFeeCostPerRebalance = 0;
      if (costModel.poolFeeTier && costModel.positionValueUSD) {
        const estimatedSwapNotional = costModel.positionValueUSD * 0.5;
        poolFeeCostPerRebalance = estimatedSwapNotional * costModel.poolFeeTier;
      }
      
      const totalCostPerRebalance = gasCostPerRebalance + poolFeeCostPerRebalance;
      const annualCosts = totalCostPerRebalance * rebalanceFrequency;
      
      if (costModel.positionValueUSD && costModel.positionValueUSD > 0) {
        annualCostDrag = (annualCosts / costModel.positionValueUSD) * 100;
        netAPY = totalAPR - annualCostDrag;
      }
    }
    
    return {
      optimalRangeWidth: rangeWidth,
      expectedAPY: totalAPR,
      netAPY: costModel ? netAPY : undefined,
      rebalanceFrequency,
      feeCaptureEfficiency: efficiencyRatio * 100,
      annualCostDrag: costModel ? annualCostDrag : undefined,
    };
  }

  static findOptimalRange(
    targetAPY: number,
    baseFeeAPR: number,
    incentiveAPR: number,
    fundingAPR: number,
    historicalVolatility: number = 0.6,
    minRange: number = 0.01,
    maxRange: number = 0.20,
    costModel?: {
      gasCostPerRebalance: number;
      poolFeeTier?: number;
      positionValueUSD?: number;
    }
  ): OptimizationResult {
    let bestResult: OptimizationResult | null = null;
    let smallestDiff = Number.POSITIVE_INFINITY;
    const steps = 100;

    for (let i = 0; i <= steps; i++) {
      const w = minRange + (maxRange - minRange) * (i / steps);
      const res = this.estimateAPYForRange(
        w,
        baseFeeAPR,
        incentiveAPR,
        fundingAPR,
        historicalVolatility,
        costModel
      );
      const diff = Math.abs(res.expectedAPY - targetAPY);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        bestResult = res;
      }
    }

    return bestResult ?? this.estimateAPYForRange(
      minRange,
      baseFeeAPR,
      incentiveAPR,
      fundingAPR,
      historicalVolatility,
      costModel
    );
  }

  static findOptimalNarrowestRange(
    baseFeeAPR: number,
    incentiveAPR: number,
    fundingAPR: number,
    historicalVolatility: number = 0.6,
    minRange: number = 0.005,
    maxRange: number = 0.20,
    costModel: {
      gasCostPerRebalance: number;
      poolFeeTier?: number;
      positionValueUSD: number;
    },
    trendVelocity: number = 0 
  ): OptimizationResult {
    if (!costModel.positionValueUSD || costModel.positionValueUSD <= 0) {
      throw new Error('positionValueUSD is required for cost calculation');
    }

    // Numerical Search for Max Net APY
    let bestWidth = minRange;
    let bestNetAPY = -Infinity;
    let bestResult: OptimizationResult | null = null;

    const steps = 100;
    for (let i = 0; i <= steps; i++) {
        const w = minRange + (maxRange - minRange) * (i / steps);
        
        const res = this.estimateAPYForRange(
            w, baseFeeAPR, incentiveAPR, fundingAPR, historicalVolatility, 
            costModel, trendVelocity
        );
        
        const net = res.netAPY || -Infinity;
        if (net > bestNetAPY) {
            bestNetAPY = net;
            bestWidth = w;
            bestResult = res;
        }
    }

    return bestResult!;
  }
}

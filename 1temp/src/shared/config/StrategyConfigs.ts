/**
 * Centralized configuration for all backtesting strategies.
 * This file contains default parameters and configuration templates for each strategy.
 */

import type {
  StablePairConfig,
  VolatilePairConfig,
  LeveragedLendingConfig,
  FundingRateConfig,
  OptionsOverlayConfig,
  IVRegimeConfig,
  LeveragedRWAConfig,
} from '@infrastructure/adapters/strategies';

/**
 * Default configuration for Stable Pair Strategy
 * Narrow-band AMM with leverage
 */
export const DEFAULT_STABLE_PAIR_CONFIG: StablePairConfig = {
  pair: 'USDC-USDT',
  rangeWidth: 0.002, // ±0.2% range
  leverage: 2.0, // 2x leverage
  collateralRatio: 1.6, // 160% collateral ratio
  allocation: 0.25, // 25% of portfolio
  ammFeeAPR: 12, // 12% APR from AMM fees
  incentiveAPR: 15, // 15% APR from incentives
  borrowAPR: 3, // 3% borrow cost
};

/**
 * Default configuration for Volatile Pair Strategy
 * Delta-neutral concentrated LP with perp hedges
 * Optimized based on backtest results: 12h interval, ±0.5% range
 */
export const DEFAULT_VOLATILE_PAIR_CONFIG: VolatilePairConfig = {
  pair: 'ETH-USDC',
  mode: 'SPEED' as any, // Default mode
  checkIntervalHours: 12, // Optimal interval for most pools
  rangeWidth: 0.005, // ±0.5% range (optimal)
  hedgeRatio: 1.0, // Delta neutral
  allocation: 0.2, // 20% of portfolio
  ammFeeAPR: 20, // Placeholder
  incentiveAPR: 0, 
  fundingAPR: 0,
};

/**
 * Default configuration for Leveraged Lending Strategy
 * Recursive stable loops
 */
export const DEFAULT_LEVERAGED_LENDING_CONFIG: LeveragedLendingConfig = {
  asset: 'USDC',
  loops: 3, // 3 recursive loops
  healthFactorThreshold: 1.5, // Unwind at 1.4
  borrowAPR: 8, // 8% borrow APR
  supplyAPR: 6, // 6% supply APR
  incentiveAPR: 10, // 10% incentive APR
  allocation: 0.2, // 20% of portfolio
};

/**
 * Default configuration for Funding Rate Capture Strategy
 * Perp/spot basis trading
 */
export const DEFAULT_FUNDING_RATE_CONFIG: FundingRateConfig = {
  asset: 'ETH',
  fundingThreshold: 0.0001, // 0.01% per 8h (~10-15% APR)
  leverage: 2.0, // 2x leverage
  healthFactorThreshold: 1.5,
  allocation: 0.15, // 15% of portfolio
};

/**
 * Default configuration for Options Overlay Strategy
 * Synthetic range extension on LP
 */
export const DEFAULT_OPTIONS_OVERLAY_CONFIG: OptionsOverlayConfig = {
  pair: 'ETH-USDC',
  lpRangeWidth: 0.03, // ±3% LP band
  optionStrikeDistance: 0.05, // ±5% outside LP band
  optionTenor: 7, // Weekly options
  overlaySizing: 0.4, // 40% of LP notional
  allocation: 0.2, // 20% of portfolio
};

/**
 * Default configuration for IV Regime Switcher Strategy
 * Dynamic LP ↔ Options allocator
 */
export const DEFAULT_IV_REGIME_CONFIG: IVRegimeConfig = {
  lowIVThreshold: 30, // Below 30% IV = LP only
  highIVThreshold: 70, // Above 70% IV = Options only
  hysteresis: 5, // 5 IV points hysteresis
  minHoldPeriod: 3, // 3 days minimum hold
  allocation: 0.3, // 30% of portfolio
};

/**
 * Default configuration for Leveraged RWA Carry Strategy
 * Stable → RWA vault carry
 */
export const DEFAULT_RWA_CARRY_CONFIG: LeveragedRWAConfig = {
  rwaVault: 'USDC-RWA-VAULT',
  couponRate: 8, // 8% coupon rate
  leverage: 3.5, // 3.5x leverage
  borrowAPR: 4, // 4% borrow APR
  healthFactorThreshold: 1.5,
  allocation: 0.15, // 15% of portfolio
  maturityDays: 60, // 60 day maturity
};

/**
 * Complete strategy configuration registry
 */
export interface StrategyConfigRegistry {
  'stable-pair': StablePairConfig;
  'volatile-pair': VolatilePairConfig;
  'leveraged-lending': LeveragedLendingConfig;
  'funding-rate': FundingRateConfig;
  'options-overlay': OptionsOverlayConfig;
  'iv-regime': IVRegimeConfig;
  'rwa-carry': LeveragedRWAConfig;
}

/**
 * Get default configuration for a strategy type
 */
export function getDefaultConfig<T extends keyof StrategyConfigRegistry>(
  strategyType: T
): StrategyConfigRegistry[T] {
  const configs: Record<keyof StrategyConfigRegistry, StrategyConfigRegistry[keyof StrategyConfigRegistry]> = {
    'stable-pair': DEFAULT_STABLE_PAIR_CONFIG,
    'volatile-pair': DEFAULT_VOLATILE_PAIR_CONFIG,
    'leveraged-lending': DEFAULT_LEVERAGED_LENDING_CONFIG,
    'funding-rate': DEFAULT_FUNDING_RATE_CONFIG,
    'options-overlay': DEFAULT_OPTIONS_OVERLAY_CONFIG,
    'iv-regime': DEFAULT_IV_REGIME_CONFIG,
    'rwa-carry': DEFAULT_RWA_CARRY_CONFIG,
  };

  return configs[strategyType] as StrategyConfigRegistry[T];
}

/**
 * Merge user configuration with defaults
 */
export function mergeWithDefaults<T extends keyof StrategyConfigRegistry>(
  strategyType: T,
  userConfig: Partial<StrategyConfigRegistry[T]>
): StrategyConfigRegistry[T] {
  const defaults = getDefaultConfig(strategyType);
  return { ...defaults, ...userConfig } as StrategyConfigRegistry[T];
}

/**
 * Validate and normalize configuration
 */
export function normalizeConfig<T extends keyof StrategyConfigRegistry>(
  strategyType: T,
  config: Partial<StrategyConfigRegistry[T]>
): StrategyConfigRegistry[T] {
  return mergeWithDefaults(strategyType, config);
}


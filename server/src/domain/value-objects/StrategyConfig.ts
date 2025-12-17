import { ConfigService } from '@nestjs/config';
import { ExchangeType } from './ExchangeConfig';
import { Percentage } from './Percentage';

/**
 * Strategy configuration value object
 * Contains all configuration constants for the funding arbitrage strategy
 */
export class StrategyConfig {
  private readonly _exchangeFeeRates: Map<ExchangeType, Percentage>;
  private readonly _takerFeeRates: Map<ExchangeType, Percentage>;
  private readonly _leverageOverrides: Map<string, number>;

  constructor(
    public readonly defaultMinSpread: Percentage,
    public readonly minPositionSizeUsd: number,
    public readonly balanceUsagePercent: Percentage,
    public readonly leverage: number,
    public readonly maxWorstCaseBreakEvenDays: number,
    public readonly minOpenInterestUsd: number,
    public readonly minTotalOpenInterestUsd: number,
    exchangeFeeRates: Map<ExchangeType, Percentage>,
    takerFeeRates: Map<ExchangeType, Percentage>,
    public readonly limitOrderPriceImprovement: Percentage,
    public readonly asymmetricFillTimeoutMs: number,
    public readonly maxExecutionRetries: number,
    public readonly executionRetryDelays: number[],
    public readonly maxOrderWaitRetries: number,
    public readonly orderWaitBaseInterval: number,
    public readonly maxBackoffDelayOpening: number,
    public readonly maxBackoffDelayClosing: number,
    public readonly minFillBalance: Percentage,
    // Dynamic leverage configuration
    // Default to TRUE - leverage should be based on realized volatility, not static
    public readonly useDynamicLeverage: boolean = true,
    public readonly minLeverage: number = 1,
    public readonly maxLeverage: number = 10,
    public readonly volatilityLookbackHours: number = 24,
    leverageOverrides: Map<string, number> = new Map(),
    // Volume-based liquidity filter (prevents trading illiquid pairs)
    // Dynamic scaling: required_volume = position_size * (100 / maxPositionToVolumePercent)
    public readonly min24hVolumeUsd: number = 0, // Absolute floor (0 = use dynamic only)
    public readonly maxPositionToVolumePercent: number = 5, // Position can't exceed 5% of 24h volume
    // Perp-spot configuration
    public readonly enablePerpSpotHedging: boolean = true,
    public readonly perpSpotMaxPositionSizeUsd: number = 10000,
    public readonly deltaNeutralityTolerance: Percentage = Percentage.fromDecimal(
      0.01,
    ), // 1% tolerance
    public readonly preferPerpSpotOverPerpPerp: boolean = false, // Automatic selection
  ) {
    this._exchangeFeeRates = new Map(exchangeFeeRates);
    this._takerFeeRates = new Map(takerFeeRates);
    this._leverageOverrides = new Map(leverageOverrides);

    // Validation
    if (minPositionSizeUsd <= 0) {
      throw new Error('minPositionSizeUsd must be greater than 0');
    }

    if (
      balanceUsagePercent.toDecimal() <= 0 ||
      balanceUsagePercent.toDecimal() > 1
    ) {
      throw new Error('balanceUsagePercent must be between 0 and 1');
    }

    if (leverage < 1) {
      throw new Error('leverage must be at least 1');
    }

    if (minLeverage < 1) {
      throw new Error('minLeverage must be at least 1');
    }

    if (maxLeverage < minLeverage) {
      throw new Error(
        'maxLeverage must be greater than or equal to minLeverage',
      );
    }

    if (volatilityLookbackHours < 1) {
      throw new Error('volatilityLookbackHours must be at least 1');
    }

    if (maxExecutionRetries <= 0) {
      throw new Error('maxExecutionRetries must be greater than 0');
    }

    if (maxOrderWaitRetries <= 0) {
      throw new Error('maxOrderWaitRetries must be greater than 0');
    }

    if (orderWaitBaseInterval <= 0) {
      throw new Error('orderWaitBaseInterval must be greater than 0');
    }

    if (executionRetryDelays.length === 0) {
      throw new Error('executionRetryDelays must not be empty');
    }

    if (minFillBalance.toDecimal() <= 0 || minFillBalance.toDecimal() > 1) {
      throw new Error('minFillBalance must be between 0 and 1');
    }

    if (
      balanceUsagePercent.toDecimal() <= 0 ||
      balanceUsagePercent.toDecimal() > 1
    ) {
      throw new Error('balanceUsagePercent must be between 0 and 1');
    }
  }

  /**
   * Get exchange fee rate as number (for backward compatibility)
   */
  getExchangeFeeRate(exchange: ExchangeType): number {
    return this._exchangeFeeRates.get(exchange)?.toDecimal() ?? 0;
  }

  /**
   * Get taker fee rate as number (for backward compatibility)
   */
  getTakerFeeRate(exchange: ExchangeType): number {
    return this._takerFeeRates.get(exchange)?.toDecimal() ?? 0;
  }

  /**
   * Get exchange fee rates map (for backward compatibility)
   */
  get exchangeFeeRates(): Map<ExchangeType, number> {
    const result = new Map<ExchangeType, number>();
    for (const [exchange, percentage] of this._exchangeFeeRates) {
      result.set(exchange, percentage.toDecimal());
    }
    return result;
  }

  /**
   * Get taker fee rates map (for backward compatibility)
   */
  get takerFeeRates(): Map<ExchangeType, number> {
    const result = new Map<ExchangeType, number>();
    for (const [exchange, percentage] of this._takerFeeRates) {
      result.set(exchange, percentage.toDecimal());
    }
    return result;
  }

  /**
   * Get leverage overrides map
   */
  get leverageOverrides(): Map<string, number> {
    return new Map(this._leverageOverrides);
  }

  /**
   * Get leverage for a specific symbol (uses override if available)
   */
  getLeverageForSymbol(symbol: string): number {
    const normalized = symbol
      .toUpperCase()
      .replace('USDT', '')
      .replace('USDC', '')
      .replace('-PERP', '');
    return this._leverageOverrides.get(normalized) ?? this.leverage;
  }

  /**
   * Create StrategyConfig from ConfigService
   * Reads leverage settings from environment
   */
  static fromConfigService(configService: ConfigService): StrategyConfig {
    const leverage = parseFloat(
      configService.get<string>('KEEPER_LEVERAGE') || '2.0',
    );
    const useDynamicLeverage =
      configService.get<string>('USE_DYNAMIC_LEVERAGE') === 'true';
    const minLeverage = parseFloat(
      configService.get<string>('LEVERAGE_MIN') || '1',
    );
    const maxLeverage = parseFloat(
      configService.get<string>('LEVERAGE_MAX') || '10',
    );
    const volatilityLookbackHours = parseInt(
      configService.get<string>('LEVERAGE_LOOKBACK_HOURS') || '24',
    );

    // Volume-based liquidity filters (prevents trading illiquid pairs)
    const min24hVolumeUsd = parseFloat(
      configService.get<string>('MIN_24H_VOLUME_USD') || '500000',
    );
    const maxPositionToVolumePercent = parseFloat(
      configService.get<string>('MAX_POSITION_TO_VOLUME_PERCENT') || '5',
    );

    // Parse leverage overrides from env (format: "BTC:5,ETH:3,DOGE:2")
    const leverageOverrides = new Map<string, number>();
    const overridesStr = configService.get<string>('LEVERAGE_OVERRIDES') || '';
    if (overridesStr) {
      for (const pair of overridesStr.split(',')) {
        const [symbol, lev] = pair.split(':');
        if (symbol && lev) {
          leverageOverrides.set(symbol.trim().toUpperCase(), parseFloat(lev));
        }
      }
    }

    // Perp-spot configuration
    const enablePerpSpotHedging =
      configService.get<string>('PERP_SPOT_ENABLED') !== 'false';
    const perpSpotMaxPositionSizeUsd = parseFloat(
      configService.get<string>('PERP_SPOT_MAX_POSITION_SIZE_USD') || '10000',
    );
    const deltaNeutralityTolerance = Percentage.fromDecimal(
      parseFloat(
        configService.get<string>('PERP_SPOT_DELTA_TOLERANCE') || '0.01',
      ),
    );
    const preferPerpSpotOverPerpPerp =
      configService.get<string>('PREFER_PERP_SPOT_OVER_PERP_PERP') === 'true';

    return StrategyConfig.withDefaults(
      leverage,
      useDynamicLeverage,
      minLeverage,
      maxLeverage,
      volatilityLookbackHours,
      leverageOverrides,
      min24hVolumeUsd,
      maxPositionToVolumePercent,
      enablePerpSpotHedging,
      perpSpotMaxPositionSizeUsd,
      deltaNeutralityTolerance,
      preferPerpSpotOverPerpPerp,
    );
  }

  /**
   * Create StrategyConfig with default values
   */
  static withDefaults(
    leverage: number = 2.0,
    useDynamicLeverage: boolean = true, // Default to dynamic leverage based on realized vol
    minLeverage: number = 1,
    maxLeverage: number = 10,
    volatilityLookbackHours: number = 24,
    leverageOverrides: Map<string, number> = new Map(),
    min24hVolumeUsd: number = 500000,
    maxPositionToVolumePercent: number = 5,
    enablePerpSpotHedging: boolean = true,
    perpSpotMaxPositionSizeUsd: number = 10000,
    deltaNeutralityTolerance: Percentage = Percentage.fromDecimal(0.01),
    preferPerpSpotOverPerpPerp: boolean = false,
  ): StrategyConfig {
    const exchangeFeeRates = new Map<ExchangeType, Percentage>([
      [ExchangeType.HYPERLIQUID, Percentage.fromDecimal(0.00015)], // 0.0150% maker fee (tier 0)
      [ExchangeType.ASTER, Percentage.fromDecimal(0.00005)], // 0.0050% maker fee
      [ExchangeType.LIGHTER, Percentage.fromDecimal(0)], // 0% fees (no trading fees)
      [ExchangeType.EXTENDED, Percentage.fromDecimal(0.0001)], // 0.01% maker fee
    ]);

    const takerFeeRates = new Map<ExchangeType, Percentage>([
      [ExchangeType.HYPERLIQUID, Percentage.fromDecimal(0.0002)], // 0.0200% taker fee (tier 0)
      [ExchangeType.ASTER, Percentage.fromDecimal(0.0004)], // 0.0400% taker fee
      [ExchangeType.LIGHTER, Percentage.fromDecimal(0)], // 0% fees (no trading fees)
      [ExchangeType.EXTENDED, Percentage.fromDecimal(0.0002)], // 0.02% taker fee
    ]);

    return new StrategyConfig(
      Percentage.fromDecimal(0.0001), // defaultMinSpread
      5, // minPositionSizeUsd
      Percentage.fromDecimal(0.9), // balanceUsagePercent
      leverage, // leverage
      7, // maxWorstCaseBreakEvenDays
      10000, // minOpenInterestUsd
      20000, // minTotalOpenInterestUsd
      exchangeFeeRates,
      takerFeeRates,
      Percentage.fromDecimal(0.0001), // limitOrderPriceImprovement
      30 * 1000, // asymmetricFillTimeoutMs (30 seconds - reduced from 2 minutes for faster response)
      3, // maxExecutionRetries
      [5000, 10000], // executionRetryDelays
      10, // maxOrderWaitRetries
      2000, // orderWaitBaseInterval
      8000, // maxBackoffDelayOpening
      32000, // maxBackoffDelayClosing
      Percentage.fromDecimal(0.95), // minFillBalance
      useDynamicLeverage,
      minLeverage,
      maxLeverage,
      volatilityLookbackHours,
      leverageOverrides,
      min24hVolumeUsd, // Minimum 24h volume to trade a pair
      maxPositionToVolumePercent, // Position can't exceed X% of 24h volume
      enablePerpSpotHedging,
      perpSpotMaxPositionSizeUsd,
      deltaNeutralityTolerance,
      preferPerpSpotOverPerpPerp,
    );
  }
}

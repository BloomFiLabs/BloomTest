/**
 * Cost Calculator
 * Calculates slippage, gas costs, and Uniswap pool fees for trades and rebalances
 */

import { Amount, Price } from '@domain/value-objects';
import { Trade } from '@domain/entities/Trade';
import { Position } from '@domain/entities/Position';
import { GasPriceService } from './GasPriceService';

export interface CostModel {
  slippageBps: number; // Basis points (e.g., 10 = 0.1%) - base slippage for small trades
  gasCostUSD?: number; // Gas cost in USD per transaction (deprecated - use gasModel instead)
  gasModel?: {
    gasUnitsPerRebalance: number; // Gas units for a full rebalance (mint + burn + swap)
    gasPriceGwei?: number; // Current gas price in Gwei (optional - will fetch if network provided)
    nativeTokenPriceUSD: number; // Price of native token (ETH) in USD
    network?: string; // Network name (e.g., 'base', 'mainnet', 'arbitrum') - will fetch gas price if provided
  };
  poolFeeTier?: number; // Uniswap pool fee tier (e.g., 0.0005 = 0.05%, 0.003 = 0.3%, 0.01 = 1%)
  poolTVL?: number; // Pool TVL in USD - used for dynamic slippage calculation
  useDynamicSlippage?: boolean; // If true, calculate slippage based on trade size / pool depth
}

export class CostCalculator {
  private slippageBps: number;
  private gasCostUSD: number; // Legacy field for backward compatibility
  private gasModel?: {
    gasUnitsPerRebalance: number;
    gasPriceGwei?: number;
    nativeTokenPriceUSD: number;
    network?: string;
  };
  private poolFeeTier?: number; // Pool fee tier as decimal (e.g., 0.003 = 0.3%)
  private poolTVL?: number; // Pool TVL in USD
  private useDynamicSlippage: boolean;
  private cachedGasPriceGwei?: number; // Cache fetched gas price to avoid repeated RPC calls

  constructor(config: CostModel = { slippageBps: 10, gasCostUSD: 50 }) {
    this.slippageBps = config.slippageBps;
    this.gasCostUSD = config.gasCostUSD || 50; // Default to 50 if not provided
    this.gasModel = config.gasModel;
    this.poolFeeTier = config.poolFeeTier;
    this.poolTVL = config.poolTVL;
    this.useDynamicSlippage = config.useDynamicSlippage || false;
  }

  /**
   * Calculate slippage cost for a trade
   * @param trade The trade to calculate slippage for
   * @returns Slippage amount in USD
   */
  calculateSlippage(trade: Trade): Amount {
    const tradeValue = trade.totalCost().value;
    
    if (this.useDynamicSlippage && this.poolTVL && this.poolTVL > 0) {
      // Dynamic slippage model: Impact increases with square root of (trade size / pool depth)
      // Formula: BaseSlippage + (TradeSize / PoolLiquidity)^0.5 * ImpactFactor
      const baseSlippage = this.slippageBps / 10000;
      const tradeSizeRatio = tradeValue / (this.poolTVL / 2); // Divide by 2 for single-side liquidity
      const impactFactor = 0.03; // 3% impact at 100% of pool depth
      const dynamicSlippage = baseSlippage + Math.sqrt(tradeSizeRatio) * impactFactor;
      
      // Cap slippage at 20% (catastrophic but prevents negative values)
      const cappedSlippage = Math.min(dynamicSlippage, 0.20);
      const slippageAmount = tradeValue * cappedSlippage;
      
      
      return Amount.create(slippageAmount);
    } else {
      // Static slippage (legacy behavior)
      const slippagePercent = this.slippageBps / 10000;
      const slippageAmount = tradeValue * slippagePercent;
      return Amount.create(slippageAmount);
    }
  }

  /**
   * Get gas cost for a transaction
   * Uses gasModel if available, otherwise falls back to gasCostUSD
   * @returns Gas cost in USD
   */
  getGasCost(): Amount {
    if (this.gasModel && this.gasModel.gasPriceGwei) {
      // Calculate: gasUnits * (gasPriceGwei / 1e9) * nativeTokenPriceUSD
      const gasCostETH = (this.gasModel.gasUnitsPerRebalance * this.gasModel.gasPriceGwei) / 1e9;
      const gasCostUSD = gasCostETH * this.gasModel.nativeTokenPriceUSD;
      return Amount.create(gasCostUSD);
    }
    return Amount.create(this.gasCostUSD);
  }

  /**
   * Estimate gas cost for a rebalance operation
   * Fetches real-time gas price if network is provided (cached after first fetch)
   * @returns Gas cost in USD
   */
  async estimateGasCostUSD(): Promise<number> {
    if (this.gasModel) {
      let gasPriceGwei = this.gasModel.gasPriceGwei;
      
      // Fetch real-time gas price if network is provided and not already cached
      if (this.gasModel.network && !gasPriceGwei && this.cachedGasPriceGwei === undefined) {
        try {
          const gasPriceResult = await GasPriceService.fetchGasPrice(this.gasModel.network);
          gasPriceGwei = gasPriceResult.gasPriceGwei;
          this.cachedGasPriceGwei = gasPriceGwei; // Cache for subsequent calls
        } catch (error) {
          console.warn(`⚠️  Failed to fetch gas price, using default for ${this.gasModel.network}`);
          // Use network default
          const networkConfig = GasPriceService.getNetworkConfig(this.gasModel.network);
          gasPriceGwei = networkConfig?.defaultGasPriceGwei || 0.1;
          this.cachedGasPriceGwei = gasPriceGwei; // Cache the fallback
        }
      } else if (this.cachedGasPriceGwei !== undefined) {
        // Use cached gas price
        gasPriceGwei = this.cachedGasPriceGwei;
      }
      
      if (!gasPriceGwei) {
        gasPriceGwei = 0.1; // Default fallback
      }
      
      const gasCostETH = (this.gasModel.gasUnitsPerRebalance * gasPriceGwei) / 1e9;
      return gasCostETH * this.gasModel.nativeTokenPriceUSD;
    }
    return this.gasCostUSD;
  }

  /**
   * Estimate Uniswap pool fee cost for a rebalance
   * A rebalance typically involves:
   * 1. Burning old LP position (no fee)
   * 2. Swapping tokens to rebalance (pays pool fee)
   * 3. Minting new LP position (no fee)
   * 
   * We approximate this as: positionValue * poolFeeTier
   * (assuming we swap roughly half the position value to rebalance)
   * 
   * @param position The LP position being rebalanced
   * @param marketPrice Current market price for calculating position value
   * @returns Pool fee cost in USD
   */
  estimateRebalanceFeeCost(position: Position, marketPrice: Price): Amount {
    if (!this.poolFeeTier) {
      return Amount.create(0); // No pool fee configured
    }

    // For LP positions, the amount is already in USD value (LP tokens priced at $1.00)
    // For non-LP positions, calculate market value
    const isPairPosition = position.asset.includes('-');
    const positionValue = isPairPosition 
      ? position.amount.value  // LP positions: amount is already USD value
      : position.marketValue().value;  // Non-LP: calculate market value
    
    // Estimate swap notional: typically need to swap ~50% of position value to rebalance
    // This is a conservative estimate - actual swap amount depends on price deviation
    const estimatedSwapNotional = positionValue * 0.5;
    
    // Pool fee = swap notional * fee tier
    // Fee tier is already a decimal (e.g., 0.003 = 0.3%, 0.0005 = 0.05%)
    const poolFeeCost = estimatedSwapNotional * this.poolFeeTier;
    
    // Cap the fee cost to a reasonable maximum (e.g., 1% of position value)
    // This prevents unrealistic costs if poolFeeTier is misconfigured
    const maxFeeCost = positionValue * 0.01;
    const finalFeeCost = Math.min(poolFeeCost, maxFeeCost);
    
    return Amount.create(finalFeeCost);
  }

  /**
   * Estimate total rebalance cost (gas + pool fees + slippage)
   * @param position The LP position being rebalanced
   * @param marketPrice Current market price
   * @returns Total rebalance cost in USD
   */
  async estimateTotalRebalanceCost(position: Position, marketPrice: Price): Promise<Amount> {
    const gasCost = await this.estimateGasCostUSD();
    const poolFeeCost = this.estimateRebalanceFeeCost(position, marketPrice);
    
    // Calculate realistic slippage for concentrated liquidity rebalancing
    // For Uni V3, rebalancing means: remove liquidity from old range, swap to rebalance, add to new range
    // The swap amount is typically small (just rebalancing the 50/50 ratio after price moved)
    const positionValue = position.marketValue().value;
    
    // Estimate swap size: when price moves, you need to rebalance the ratio
    // For a 1% price move, you'd swap ~1-2% of position value to maintain 50/50
    // For concentrated positions, this is amplified, so use ~5% of position value as swap size
    const estimatedSwapSize = positionValue * 0.05; // 5% of position for rebalancing swaps
    
    // Calculate actual price impact using constant product formula
    // Price impact = (tradeSize / poolLiquidity) for small trades
    // For larger trades, use: impact = 1 - (1 - tradeSize/poolDepth)^0.5
    let slippageCost = 0;
    
    if (this.useDynamicSlippage && this.poolTVL && this.poolTVL > 0) {
      const poolDepth = this.poolTVL / 2; // Single-sided liquidity depth
      const tradeSizeRatio = estimatedSwapSize / poolDepth;
      
      // Constant product AMM price impact formula
      // For x*y=k, when you trade Δx, price impact = Δx / (x + Δx)
      const priceImpactPercent = tradeSizeRatio / (1 + tradeSizeRatio);
      
      // Slippage cost = average price impact * trade size
      // Average impact is half of the max impact (linear approximation)
      slippageCost = estimatedSwapSize * priceImpactPercent * 0.5;
    } else {
      // Fallback: use static slippage model
      const staticSlippage = this.slippageBps / 10000;
      slippageCost = estimatedSwapSize * staticSlippage;
    }
    
    return Amount.create(gasCost + poolFeeCost.value + slippageCost);
  }

  /**
   * Calculate total cost (slippage + gas) for a trade
   * @param trade The trade
   * @returns Total cost in USD
   */
  calculateTotalCost(trade: Trade): Amount {
    const slippage = this.calculateSlippage(trade);
    const gas = this.getGasCost();
    return slippage.add(gas);
  }

  /**
   * Apply slippage to trade price
   * @param trade The trade
   * @returns New price with slippage applied
   */
  applySlippageToPrice(trade: Trade): Price {
    const slippagePercent = this.slippageBps / 10000;
    const priceMultiplier = trade.side === 'buy' 
      ? 1 + slippagePercent  // Buy: pay more
      : 1 - slippagePercent; // Sell: receive less
    
    return Price.create(trade.price.value * priceMultiplier);
  }
}


import { Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import {
  IExecutableStrategy,
  StrategyExecutionResult,
} from './IExecutableStrategy';
import { MarketDataContext } from '../services/MarketDataContext';

/**
 * Delta-Neutral Funding Strategy - KEEPER LOGIC
 *
 * Uses SHARED MarketDataContext - does NOT fetch its own data!
 *
 * Strategy: Borrow ETH from HyperLend + Short ETH on HyperLiquid Perps
 * Result: Delta = 0, Profit = Funding Rate - Borrow Rate
 */

export interface DeltaNeutralFundingConfig {
  id: string;
  name: string;
  chainId: number;
  contractAddress: string;
  vaultAddress: string;
  hyperLendPool: string;
  wethAddress: string;
  enabled: boolean;
  asset: string;
  assetId: number;

  riskParams: {
    minHealthFactor: number;
    targetHealthFactor: number;
    emergencyHealthFactor: number;
    maxLeverage: number;
    targetLeverage: number;
    minLeverage: number;
  };

  fundingParams: {
    minFundingRateThreshold: number;
    fundingFlipThreshold: number;
    minAnnualizedAPY: number;
  };

  positionParams: {
    maxPositionSizeUSD: number;
    maxDeltaDriftPercent: number;
    rebalanceCooldownSeconds: number;
  };
}

const STRATEGY_ABI = [
  'function getHyperLendData() external view returns (uint256 totalCollateral, uint256 totalDebt, uint256 availableBorrows, uint256 liquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getPerpPositions() external view returns (tuple(uint256 coin, int256 szi, int256 entryPx, int256 positionValue, int256 unrealizedPnl, int256 liquidationPx, int256 marginUsed, int256 maxLeverage, int256 cumFunding)[])',
  'function getPerpEquity() external view returns (uint256)',
  'function getWethBalance() external view returns (uint256)',
  'function getIdleUSDC() external view returns (uint256)',
  'function totalPrincipal() external view returns (uint256)',
  'function depositCollateral(uint256 amount) external',
  'function withdrawCollateral(uint256 amount) external',
  'function borrow(address asset, uint256 amount) external',
  'function repay(address asset, uint256 amount) external',
  'function placePerpOrder(bool isLong, uint64 size, uint64 limitPrice, bool reduceOnly) external',
  'function transferUSD(uint64 amount, bool toPerp) external',
  'function closeAllPerpPositions() external',
  'function emergencyWithdrawAll() external',
  // New rescue functions
  'function rescueHyperLendFromPerp(uint64 perpSizeToClose, uint64 limitPrice) external',
  'function movePerpProfitToCollateral(uint64 amount) external',
  'function rescuePerpFromHyperLend(uint256 amount) external',
  'function rescueAndReleverage(uint64 closeSize, uint64 closePrice, uint256 depositAmount, uint64 reopenSize, uint64 reopenPrice, bool reopenIsLong) external',
];

export class DeltaNeutralFundingStrategy implements IExecutableStrategy {
  private readonly logger = new Logger(DeltaNeutralFundingStrategy.name);
  private contract: ethers.Contract;
  private enabled: boolean;
  private lastRebalanceTime: number = 0;

  // Tracked state
  private currentSpotSize: number = 0;
  private currentPerpSize: number = 0;
  private isPositionOpen: boolean = false;

  // Last metrics for monitoring
  private lastMetrics: Record<string, number | string> = {};

  constructor(
    public readonly config: DeltaNeutralFundingConfig,
    private readonly provider: ethers.Provider,
    private readonly wallet: ethers.Wallet,
  ) {
    this.contract = new ethers.Contract(
      config.contractAddress,
      STRATEGY_ABI,
      wallet,
    );
    this.enabled = config.enabled;
    this.logger.log(`Initialized ${config.name} for ${config.asset}`);
  }

  // IExecutableStrategy implementation
  get id(): string {
    return this.config.id;
  }
  get name(): string {
    return this.config.name;
  }
  get chainId(): number {
    return this.config.chainId;
  }
  get contractAddress(): string {
    return this.config.contractAddress;
  }

  // Assets this strategy needs
  get requiredAssets(): string[] {
    return [this.config.asset];
  }
  get requiredPools(): string[] {
    return [];
  } // No LP pools needed

  isEnabled(): boolean {
    return this.enabled;
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.logger.log(
      `Strategy ${this.name} ${enabled ? 'enabled' : 'disabled'}`,
    );
  }

  /**
   * Main execution - uses SHARED context, doesn't fetch own data
   */
  async execute(context: MarketDataContext): Promise<StrategyExecutionResult> {
    const baseResult: StrategyExecutionResult = {
      strategyName: this.name,
      executed: false,
      reason: '',
    };

    if (!this.enabled) {
      return { ...baseResult, action: 'DISABLED', reason: 'Strategy disabled' };
    }

    try {
      // Get data from SHARED context (already fetched by orchestrator)
      const fundingData = context.funding.get(this.config.asset);
      const lendingData = context.lending.get(this.config.asset);
      const priceData = context.prices.get(this.config.asset);
      const volData = context.volatility.get(this.config.asset);

      if (!fundingData || !priceData) {
        return {
          ...baseResult,
          reason: `Missing market data for ${this.config.asset}`,
        };
      }

      const fundingRate = fundingData.currentRate;
      const fundingAPY = fundingData.fundingAPY;
      const borrowAPY = lendingData?.borrowAPY || 5; // Default 5% if not available
      const markPrice = priceData.price;
      const netCarryAPY = fundingAPY - borrowAPY;

      // Fetch on-chain state (strategy-specific, not shared)
      const [hyperLendData, wethBalance, idleUSDC] = await Promise.all([
        this.contract.getHyperLendData().catch(() => null),
        this.contract.getWethBalance().catch(() => BigInt(0)),
        this.contract.getIdleUSDC().catch(() => BigInt(0)),
      ]);

      const healthFactor = hyperLendData
        ? Number(hyperLendData.healthFactor) / 1e18
        : 0;
      const totalCollateral = hyperLendData
        ? Number(hyperLendData.totalCollateral) / 1e6
        : Number(idleUSDC) / 1e6;
      const totalDebt = hyperLendData
        ? Number(hyperLendData.totalDebt) / 1e18
        : 0;

      // Update metrics for monitoring
      this.lastMetrics = {
        fundingRate: `${(fundingRate * 100).toFixed(4)}%`,
        fundingAPY: `${fundingAPY.toFixed(1)}%`,
        borrowAPY: `${borrowAPY.toFixed(1)}%`,
        netCarryAPY: `${netCarryAPY.toFixed(1)}%`,
        healthFactor: healthFactor.toFixed(2),
        collateral: `$${totalCollateral.toFixed(2)}`,
        debt: `$${(totalDebt * markPrice).toFixed(2)}`,
        spotSize: this.currentSpotSize.toFixed(4),
        perpSize: this.currentPerpSize.toFixed(4),
        isPositionOpen: this.isPositionOpen ? 'Yes' : 'No',
      };

      this.logger.debug(
        `[${this.name}] Funding: ${(fundingRate * 100).toFixed(4)}%/8h (${fundingAPY.toFixed(1)}% APY) | ` +
          `Borrow: ${borrowAPY.toFixed(1)}% | Net: ${netCarryAPY.toFixed(1)}% | ` +
          `HF: ${healthFactor.toFixed(2)} | Collateral: $${totalCollateral.toFixed(2)}`,
      );

      // Decision logic
      if (!this.isPositionOpen) {
        return await this.handleNoPosition(
          fundingRate,
          netCarryAPY,
          markPrice,
          totalCollateral,
          baseResult,
        );
      } else {
        return await this.handleExistingPosition(
          fundingRate,
          netCarryAPY,
          markPrice,
          healthFactor,
          totalDebt,
          baseResult,
        );
      }
    } catch (error) {
      this.logger.error(`[${this.name}] Error: ${error.message}`);
      return {
        ...baseResult,
        reason: `Error: ${error.message}`,
        error: error.message,
      };
    }
  }

  async getMetrics(): Promise<Record<string, number | string>> {
    return this.lastMetrics;
  }

  async emergencyExit(): Promise<StrategyExecutionResult> {
    this.logger.warn(`[${this.name}] 🚨 EMERGENCY EXIT`);
    try {
      const tx = await this.contract.emergencyWithdrawAll();
      await tx.wait();
      this.isPositionOpen = false;
      this.currentSpotSize = 0;
      this.currentPerpSize = 0;
      return {
        strategyName: this.name,
        executed: true,
        action: 'EMERGENCY_EXIT',
        reason: 'Emergency exit complete',
        txHash: tx.hash,
      };
    } catch (error) {
      return {
        strategyName: this.name,
        executed: false,
        action: 'EMERGENCY_EXIT_FAILED',
        reason: `Failed: ${error.message}`,
        error: error.message,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // DECISION LOGIC
  // ═══════════════════════════════════════════════════════════

  private async handleNoPosition(
    fundingRate: number,
    netCarryAPY: number,
    markPrice: number,
    availableCollateral: number,
    baseResult: StrategyExecutionResult,
  ): Promise<StrategyExecutionResult> {
    const { fundingParams, riskParams, positionParams } = this.config;

    // Check if funding is attractive enough
    if (fundingRate < fundingParams.minFundingRateThreshold) {
      return {
        ...baseResult,
        action: 'WAIT',
        reason: `Funding ${(fundingRate * 100).toFixed(4)}% < threshold ${(fundingParams.minFundingRateThreshold * 100).toFixed(4)}%`,
      };
    }

    // Check if net carry is profitable
    if (netCarryAPY < fundingParams.minAnnualizedAPY) {
      return {
        ...baseResult,
        action: 'WAIT',
        reason: `Net carry ${netCarryAPY.toFixed(1)}% APY < minimum ${fundingParams.minAnnualizedAPY}%`,
      };
    }

    // Check if we have collateral
    if (availableCollateral < 10) {
      return {
        ...baseResult,
        action: 'WAIT',
        reason: `Insufficient collateral: $${availableCollateral.toFixed(2)}`,
      };
    }

    // Calculate optimal leverage
    const optimalLeverage = this.calculateOptimalLeverage(
      riskParams.targetHealthFactor,
    );
    const leverage = Math.min(optimalLeverage, riskParams.maxLeverage);

    // Calculate position size
    const positionSizeUSD = Math.min(
      availableCollateral * leverage,
      positionParams.maxPositionSizeUSD,
    );
    const positionSizeETH = positionSizeUSD / markPrice;

    this.logger.log(
      `[${this.name}] 🚀 OPENING DELTA-NEUTRAL:\n` +
        `   💰 Collateral: $${availableCollateral.toFixed(2)}\n` +
        `   📊 Leverage: ${leverage.toFixed(2)}x\n` +
        `   📈 Spot: ${positionSizeETH.toFixed(4)} ETH\n` +
        `   📉 Perp: ${positionSizeETH.toFixed(4)} ETH\n` +
        `   💵 Net APY: ${netCarryAPY.toFixed(1)}%`,
    );

    // Execute
    const txHash = await this.openDeltaNeutralPosition(
      availableCollateral,
      positionSizeETH,
      markPrice,
    );

    this.isPositionOpen = true;
    this.currentSpotSize = positionSizeETH;
    this.currentPerpSize = positionSizeETH;

    return {
      ...baseResult,
      executed: true,
      action: 'OPEN_DELTA_NEUTRAL',
      reason: `Opened ${leverage.toFixed(1)}x: ${positionSizeETH.toFixed(4)} ETH @ ${netCarryAPY.toFixed(1)}% APY`,
      txHash,
    };
  }

  private async handleExistingPosition(
    fundingRate: number,
    netCarryAPY: number,
    markPrice: number,
    healthFactor: number,
    currentDebt: number,
    baseResult: StrategyExecutionResult,
  ): Promise<StrategyExecutionResult> {
    const { fundingParams, riskParams, positionParams } = this.config;

    // Get perp PnL for rescue decisions
    const perpEquity = Number(await this.contract.getPerpEquity()) / 1e6;
    const perpPnL = this.calculatePerpPnL(perpEquity);

    // 1. EMERGENCY: Health factor critical - try rescue first, then deleverage
    if (healthFactor > 0 && healthFactor < riskParams.emergencyHealthFactor) {
      this.logger.warn(
        `[${this.name}] ⚠️ EMERGENCY: HF ${healthFactor.toFixed(2)} < ${riskParams.emergencyHealthFactor}!`,
      );

      // Check if perp is profitable enough to rescue
      if (perpPnL > 0) {
        this.logger.log(
          `[${this.name}] 🚑 Attempting rescue from perp profits: $${perpPnL.toFixed(2)}`,
        );
        const result = await this.rescueHyperLendFromPerpProfits(
          markPrice,
          perpPnL,
          healthFactor,
        );
        if (result.success) {
          return {
            ...baseResult,
            executed: true,
            action: 'RESCUE_AND_RELEVERAGE',
            reason: `HF ${healthFactor.toFixed(2)} rescued with $${perpPnL.toFixed(2)} perp profit`,
            txHash: result.txHash,
          };
        }
      }

      // Rescue failed or not possible - emergency deleverage
      const txHash = await this.emergencyDeleverage();
      return {
        ...baseResult,
        executed: true,
        action: 'EMERGENCY_DELEVERAGE',
        reason: `HF ${healthFactor.toFixed(2)} critical - rescue failed, deleveraged`,
        txHash,
      };
    }

    // 2. WARNING: Health factor low - try partial rescue
    if (healthFactor > 0 && healthFactor < riskParams.minHealthFactor) {
      this.logger.warn(
        `[${this.name}] ⚠️ HF ${healthFactor.toFixed(2)} < ${riskParams.minHealthFactor}`,
      );

      // Check if perp is profitable enough to rescue
      if (perpPnL > 0) {
        this.logger.log(
          `[${this.name}] 🔧 Attempting partial rescue from perp profits: $${perpPnL.toFixed(2)}`,
        );
        const result = await this.rescueHyperLendFromPerpProfits(
          markPrice,
          perpPnL,
          healthFactor,
        );
        if (result.success) {
          return {
            ...baseResult,
            executed: true,
            action: 'PARTIAL_RESCUE',
            reason: `HF ${healthFactor.toFixed(2)} improved with $${result.amountUsed?.toFixed(2)} from perp`,
            txHash: result.txHash,
          };
        }
      }

      // Rescue failed - reduce leverage
      const txHash = await this.reduceLeverage();
      return {
        ...baseResult,
        executed: true,
        action: 'REDUCE_LEVERAGE',
        reason: `HF ${healthFactor.toFixed(2)} low - reduced`,
        txHash,
      };
    }

    // 3. Funding flipped negative
    if (fundingRate < fundingParams.fundingFlipThreshold) {
      this.logger.log(
        `[${this.name}] 📉 Funding negative: ${(fundingRate * 100).toFixed(4)}%`,
      );
      const txHash = await this.closePosition('Funding negative');
      return {
        ...baseResult,
        executed: true,
        action: 'CLOSE_POSITION',
        reason: `Funding ${(fundingRate * 100).toFixed(4)}% negative`,
        txHash,
      };
    }

    // 4. Net carry unprofitable
    if (netCarryAPY < 0) {
      this.logger.log(
        `[${this.name}] 📉 Net carry negative: ${netCarryAPY.toFixed(1)}%`,
      );
      const txHash = await this.closePosition('Net carry negative');
      return {
        ...baseResult,
        executed: true,
        action: 'CLOSE_POSITION',
        reason: `Net carry ${netCarryAPY.toFixed(1)}% negative`,
        txHash,
      };
    }

    // 5. Check perp margin health
    const minPerpMargin = this.currentPerpSize * markPrice * 0.05; // 5% margin minimum
    if (perpEquity > 0 && perpEquity < minPerpMargin) {
      this.logger.warn(
        `[${this.name}] ⚠️ Perp margin low: $${perpEquity.toFixed(2)} < $${minPerpMargin.toFixed(2)}`,
      );

      // Try to rescue from HyperLend if HF allows
      const result = await this.rescuePerpFromHyperLend(
        markPrice,
        perpEquity,
        minPerpMargin,
      );
      if (result.success) {
        return {
          ...baseResult,
          executed: true,
          action: 'RESCUE_PERP_MARGIN',
          reason: `Perp margin rescued with $${result.amountUsed?.toFixed(2)} from HyperLend`,
          txHash: result.txHash,
        };
      }

      // Cannot rescue - close position to prevent liquidation
      const txHash = await this.closePosition('Perp margin critical');
      return {
        ...baseResult,
        executed: true,
        action: 'CLOSE_POSITION',
        reason: `Perp margin $${perpEquity.toFixed(2)} critical - closed`,
        txHash,
      };
    }

    // 6. Delta drift check
    if (this.currentSpotSize > 0) {
      const deltaDrift =
        (Math.abs(this.currentSpotSize - this.currentPerpSize) /
          this.currentSpotSize) *
        100;
      if (deltaDrift > positionParams.maxDeltaDriftPercent) {
        const now = Date.now();
        if (
          now - this.lastRebalanceTime >
          positionParams.rebalanceCooldownSeconds * 1000
        ) {
          const txHash = await this.rebalanceDelta(markPrice);
          this.lastRebalanceTime = now;
          return {
            ...baseResult,
            executed: true,
            action: 'REBALANCE_DELTA',
            reason: `Delta drift ${deltaDrift.toFixed(1)}%`,
            txHash,
          };
        }
      }
    }

    // 7. All good - HOLD
    const currentLeverage =
      healthFactor > 0 ? this.calculateCurrentLeverage(healthFactor) : 0;
    return {
      ...baseResult,
      action: 'HOLD',
      reason: `HF: ${healthFactor.toFixed(2)} | Lev: ${currentLeverage.toFixed(1)}x | APY: ${netCarryAPY.toFixed(1)}%`,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // EXECUTION
  // ═══════════════════════════════════════════════════════════

  private async openDeltaNeutralPosition(
    collateral: number,
    sizeETH: number,
    price: number,
  ): Promise<string> {
    // 1. Deposit collateral
    const idleUSDC = Number(await this.contract.getIdleUSDC()) / 1e6;
    if (idleUSDC > 0) {
      const tx1 = await this.contract.depositCollateral(
        ethers.parseUnits(idleUSDC.toString(), 6),
      );
      await tx1.wait();
    }

    // 2. Borrow ETH
    const borrowAmount = ethers.parseEther(sizeETH.toString());
    const tx2 = await this.contract.borrow(
      this.config.wethAddress,
      borrowAmount,
    );
    await tx2.wait();

    // 3. Short perp: place order at mark price to act as maker
    const perpSize = BigInt(Math.round(sizeETH * 1e8));
    const limitPrice = BigInt(Math.round(price * 1e8));
    const tx3 = await this.contract.placePerpOrder(
      false, // isLong=false (short)
      perpSize,
      limitPrice, // Exact mark price
      false, // reduceOnly=false
    );
    await tx3.wait();

    return tx3.hash;
  }

  private async closePosition(reason: string): Promise<string> {
    this.logger.log(`[${this.name}] Closing: ${reason}`);

    const tx1 = await this.contract.closeAllPerpPositions();
    await tx1.wait();

    const wethBalance = await this.contract.getWethBalance();
    if (wethBalance > 0) {
      const tx2 = await this.contract.repay(
        this.config.wethAddress,
        wethBalance,
      );
      await tx2.wait();
    }

    this.isPositionOpen = false;
    this.currentSpotSize = 0;
    this.currentPerpSize = 0;

    return tx1.hash;
  }

  private async emergencyDeleverage(): Promise<string> {
    const tx = await this.contract.closeAllPerpPositions();
    await tx.wait();

    this.currentPerpSize = 0;
    this.currentSpotSize = 0;
    this.isPositionOpen = false;

    return tx.hash;
  }

  private async reduceLeverage(): Promise<string> {
    // Close 50% of position
    return this.emergencyDeleverage();
  }

  // ═══════════════════════════════════════════════════════════
  // CROSS-POSITION RESCUE LOGIC
  // ═══════════════════════════════════════════════════════════

  /**
   * Calculate perp PnL based on current equity vs initial margin
   */
  private calculatePerpPnL(currentEquity: number): number {
    // Estimate initial margin as perpSize * price / leverage
    // For simplicity, track this separately or estimate from position value
    const markPrice =
      typeof this.lastMetrics.markPrice === 'number'
        ? this.lastMetrics.markPrice
        : 0;
    const estimatedInitialMargin = this.currentPerpSize * markPrice;
    return currentEquity - estimatedInitialMargin;
  }

  /**
   * Rescue HyperLend by taking profits from perp position
   *
   * Flow:
   * 1. Calculate how much collateral we need to restore HF
   * 2. Calculate how much perp to close to realize that profit
   * 3. Close partial perp, move profit to HyperLend
   * 4. Re-open perp position to maintain delta neutrality
   */
  private async rescueHyperLendFromPerpProfits(
    markPrice: number,
    perpPnL: number,
    currentHF: number,
  ): Promise<{ success: boolean; txHash?: string; amountUsed?: number }> {
    try {
      const { riskParams } = this.config;

      // Calculate how much collateral we need to restore target HF
      const [hyperLendData] = await Promise.all([
        this.contract.getHyperLendData(),
      ]);

      const totalCollateral = Number(hyperLendData.totalCollateral) / 1e6;
      const totalDebt = Number(hyperLendData.totalDebt) / 1e18;
      const debtValueUSD = totalDebt * markPrice;

      // Target HF formula: HF = (Collateral * LiqThreshold) / Debt
      // Solving for required collateral: Collateral = (HF * Debt) / LiqThreshold
      const liqThreshold = 0.8; // Typical value, should be from contract
      const requiredCollateral =
        (riskParams.targetHealthFactor * debtValueUSD) / liqThreshold;
      const collateralDeficit = Math.max(
        0,
        requiredCollateral - totalCollateral,
      );

      if (collateralDeficit <= 0) {
        this.logger.log(`[${this.name}] No rescue needed, HF will recover`);
        return { success: true, amountUsed: 0 };
      }

      // Check if perp profit covers the deficit
      const amountToUse = Math.min(perpPnL * 0.9, collateralDeficit); // Use 90% of profit max

      if (amountToUse < 10) {
        // Minimum $10 to make it worthwhile
        this.logger.log(
          `[${this.name}] Perp profit too small for rescue: $${amountToUse.toFixed(2)}`,
        );
        return { success: false };
      }

      // Calculate how much perp to close
      // PnL per unit = (currentPrice - entryPrice) * direction
      // For shorts: PnL = (entryPrice - currentPrice) * size
      // We need to close enough to realize `amountToUse` in profit
      const positions = await this.contract.getPerpPositions();
      let perpPosition: any = null;
      for (const pos of positions) {
        if (Number(pos.coin) === this.config.assetId && Number(pos.szi) !== 0) {
          perpPosition = pos;
          break;
        }
      }

      if (!perpPosition) {
        this.logger.warn(`[${this.name}] No perp position found for rescue`);
        return { success: false };
      }

      const isLong = Number(perpPosition.szi) > 0;
      const perpSize = Math.abs(Number(perpPosition.szi)) / 1e8;
      const entryPrice = Number(perpPosition.entryPx) / 1e8;
      const unrealizedPnL = Number(perpPosition.unrealizedPnl) / 1e6;

      if (unrealizedPnL <= 0) {
        this.logger.log(
          `[${this.name}] Perp position not profitable: $${unrealizedPnL.toFixed(2)}`,
        );
        return { success: false };
      }

      // Calculate size to close to realize the needed profit
      const pnlPerUnit = Math.abs(unrealizedPnL / perpSize);
      const sizeToClose = Math.min(perpSize, amountToUse / pnlPerUnit);

      this.logger.log(
        `[${this.name}] 🚑 RESCUE PLAN:\n` +
          `   💰 Collateral deficit: $${collateralDeficit.toFixed(2)}\n` +
          `   📈 Perp PnL available: $${unrealizedPnL.toFixed(2)}\n` +
          `   🔧 Closing ${sizeToClose.toFixed(4)} of ${perpSize.toFixed(4)} perp\n` +
          `   💵 Expected rescue: $${amountToUse.toFixed(2)}`,
      );

      // Execute rescue and releverage
      const closeSize = BigInt(Math.round(sizeToClose * 1e8));
      const closePrice = BigInt(
        Math.round(markPrice * (isLong ? 0.98 : 1.02) * 1e8),
      );
      const depositAmount = ethers.parseUnits(amountToUse.toFixed(6), 6);
      const reopenSize = closeSize; // Re-open same size to maintain delta neutral
      const reopenPrice = BigInt(
        Math.round(markPrice * (isLong ? 1.02 : 0.98) * 1e8),
      );

      const tx = await this.contract.rescueAndReleverage(
        closeSize,
        closePrice,
        depositAmount,
        reopenSize,
        reopenPrice,
        isLong, // Re-open in same direction
      );
      await tx.wait();

      this.logger.log(`[${this.name}] ✅ Rescue complete: ${tx.hash}`);

      return { success: true, txHash: tx.hash, amountUsed: amountToUse };
    } catch (error) {
      this.logger.error(`[${this.name}] Rescue failed: ${error.message}`);
      return { success: false };
    }
  }

  /**
   * Rescue perp margin by withdrawing from HyperLend (if HF allows)
   */
  private async rescuePerpFromHyperLend(
    markPrice: number,
    perpEquity: number,
    minPerpMargin: number,
  ): Promise<{ success: boolean; txHash?: string; amountUsed?: number }> {
    try {
      const [hyperLendData] = await Promise.all([
        this.contract.getHyperLendData(),
      ]);

      const healthFactor = Number(hyperLendData.healthFactor) / 1e18;
      const availableBorrows = Number(hyperLendData.availableBorrows) / 1e6;

      // Only rescue if HF is healthy enough
      if (healthFactor < 2.0) {
        this.logger.log(
          `[${this.name}] HF ${healthFactor.toFixed(2)} too low to withdraw for perp rescue`,
        );
        return { success: false };
      }

      // Calculate how much we can safely withdraw
      // Keep HF above 1.5 after withdrawal
      const { riskParams } = this.config;
      const totalCollateral = Number(hyperLendData.totalCollateral) / 1e6;
      const totalDebt = Number(hyperLendData.totalDebt) / 1e18;
      const debtValueUSD = totalDebt * markPrice;

      const liqThreshold = 0.8;
      const minCollateral =
        (riskParams.minHealthFactor * debtValueUSD) / liqThreshold;
      const withdrawable = Math.max(0, totalCollateral - minCollateral);

      const marginDeficit = minPerpMargin - perpEquity;
      const amountToWithdraw = Math.min(withdrawable, marginDeficit);

      if (amountToWithdraw < 10) {
        this.logger.log(
          `[${this.name}] Cannot withdraw enough for perp rescue: $${amountToWithdraw.toFixed(2)}`,
        );
        return { success: false };
      }

      this.logger.log(
        `[${this.name}] 🚑 PERP RESCUE:\n` +
          `   📉 Perp margin deficit: $${marginDeficit.toFixed(2)}\n` +
          `   💰 Withdrawable from HyperLend: $${withdrawable.toFixed(2)}\n` +
          `   💵 Rescuing: $${amountToWithdraw.toFixed(2)}`,
      );

      const tx = await this.contract.rescuePerpFromHyperLend(
        ethers.parseUnits(amountToWithdraw.toFixed(6), 6),
      );
      await tx.wait();

      return { success: true, txHash: tx.hash, amountUsed: amountToWithdraw };
    } catch (error) {
      this.logger.error(`[${this.name}] Perp rescue failed: ${error.message}`);
      return { success: false };
    }
  }

  private async rebalanceDelta(price: number): Promise<string> {
    const delta = this.currentSpotSize - this.currentPerpSize;

    if (Math.abs(delta) < 0.001) return '';

    const perpSize = BigInt(Math.round(Math.abs(delta) * 1e8));
    const isLong = delta < 0;
    const limitPrice = BigInt(Math.round(price * (isLong ? 1.02 : 0.98) * 1e8));

    const tx = await this.contract.placePerpOrder(
      isLong,
      perpSize,
      limitPrice,
      !isLong,
    );
    await tx.wait();

    this.currentPerpSize = this.currentSpotSize;
    return tx.hash;
  }

  // ═══════════════════════════════════════════════════════════
  // CALCULATIONS
  // ═══════════════════════════════════════════════════════════

  private calculateOptimalLeverage(targetHF: number): number {
    const liqThreshold = 0.8;
    return 1 + liqThreshold / targetHF;
  }

  private calculateCurrentLeverage(healthFactor: number): number {
    const liqThreshold = 0.8;
    return 1 + liqThreshold / healthFactor;
  }
}

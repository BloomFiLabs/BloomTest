import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ISpotExchangeAdapter } from '../../ports/ISpotExchangeAdapter';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';
import { SpotExchangeError } from '../../ports/ISpotExchangeAdapter';

/**
 * PerpSpotBalanceManager - Manages automatic transfers between perp and spot accounts
 * 
 * CRITICAL: This service automatically transfers funds between perp margin and spot accounts
 * within the same exchange to optimize position sizing for perp-spot opportunities.
 */
@Injectable()
export class PerpSpotBalanceManager {
  private readonly logger = new Logger(PerpSpotBalanceManager.name);
  
  // Configuration
  private readonly MIN_TRANSFER_AMOUNT = 10; // Minimum $10 to avoid dust
  private readonly REBALANCE_THRESHOLD = 0.1; // 10% improvement required
  private readonly SETTLEMENT_DELAY_MS = 3000; // 3 seconds for transfer settlement

  /**
   * Ensure optimal balance distribution for perp-spot opportunity
   * 
   * Calculates optimal distribution: spotBalance ≈ perpBalance * leverage
   * Transfers funds if current distribution is suboptimal and improvement is meaningful
   * 
   * @param exchange Exchange type
   * @param perpAdapter Perp exchange adapter
   * @param spotAdapter Spot exchange adapter
   * @param targetPositionSize Target position size in USD
   * @param leverage Leverage to use for perp position
   * @returns Result indicating if rebalancing occurred
   */
  async ensureOptimalBalanceDistribution(
    exchange: ExchangeType,
    perpAdapter: IPerpExchangeAdapter,
    spotAdapter: ISpotExchangeAdapter,
    targetPositionSize: number,
    leverage: number,
  ): Promise<Result<boolean, DomainException>> {
    try {
      // Get current balances
      const [perpBalance, spotBalance] = await Promise.all([
        perpAdapter.getBalance(),
        spotAdapter.getSpotBalance('USDC').catch(() => spotAdapter.getSpotBalance('USDT').catch(() => 0)),
      ]);

      this.logger.debug(
        `Balance check for ${exchange}: perp=$${perpBalance.toFixed(2)}, spot=$${spotBalance.toFixed(2)}, ` +
        `target=$${targetPositionSize.toFixed(2)}, leverage=${leverage}x`
      );

      // Check if rebalancing is needed
      const rebalanceCheck = this.shouldRebalance(perpBalance, spotBalance, targetPositionSize, leverage);
      
      if (!rebalanceCheck.shouldRebalance) {
        return Result.success(false);
      }

      // Execute transfer
      const transferAmount = rebalanceCheck.transferAmount!;
      const toPerp = rebalanceCheck.toPerp!;

      this.logger.log(
        `🔄 Rebalancing ${exchange}: Transferring $${transferAmount.toFixed(2)} ` +
        `${toPerp ? 'spot → perp' : 'perp → spot'} to optimize position sizing`
      );

      try {
        const txHash = await spotAdapter.transferInternal(transferAmount, toPerp);
        
        // Wait for settlement
        await new Promise(resolve => setTimeout(resolve, this.SETTLEMENT_DELAY_MS));

        // Verify balances after transfer
        const [newPerpBalance, newSpotBalance] = await Promise.all([
          perpAdapter.getBalance(),
          spotAdapter.getSpotBalance('USDC').catch(() => spotAdapter.getSpotBalance('USDT').catch(() => 0)),
        ]);

        this.logger.log(
          `✅ Rebalancing complete: perp=$${newPerpBalance.toFixed(2)}, spot=$${newSpotBalance.toFixed(2)}`
        );

        return Result.success(true);
      } catch (error: any) {
        this.logger.warn(
          `Transfer failed (continuing with original balances): ${error.message}`
        );
        // Return success=false but don't throw - graceful fallback
        return Result.success(false);
      }
    } catch (error: any) {
      this.logger.error(`Failed to ensure optimal balance distribution: ${error.message}`);
      return Result.failure(
        new DomainException(
          `Failed to ensure optimal balance distribution: ${error.message}`,
          'BALANCE_REBALANCE_FAILED',
        ),
      );
    }
  }

  /**
   * Calculate optimal balance distribution
   * 
   * For position size P with leverage L:
   * - Perp margin needed: P / L
   * - Spot capital needed: P (1:1)
   * - Optimal: spotBalance ≈ perpBalance * L (allows equal position sizing)
   */
  calculateOptimalDistribution(
    perpBalance: number,
    spotBalance: number,
    targetPositionSize: number,
    leverage: number,
  ): { optimalPerpBalance: number; optimalSpotBalance: number } {
    // Total available capital
    const totalCapital = perpBalance + spotBalance;

    // For equal position sizing:
    // - Perp can use: perpBalance * leverage
    // - Spot can use: spotBalance (1:1)
    // - We want: perpBalance * leverage ≈ spotBalance
    // - So: spotBalance = perpBalance * leverage
    // - And: totalCapital = perpBalance + spotBalance = perpBalance + perpBalance * leverage
    // - Therefore: perpBalance = totalCapital / (1 + leverage)
    // - And: spotBalance = totalCapital * leverage / (1 + leverage)

    const optimalPerpBalance = totalCapital / (1 + leverage);
    const optimalSpotBalance = totalCapital * leverage / (1 + leverage);

    return { optimalPerpBalance, optimalSpotBalance };
  }

  /**
   * Determine if rebalancing is needed
   * 
   * Only rebalance if:
   * 1. Current distribution is suboptimal (10%+ difference)
   * 2. Improvement is meaningful (10%+ larger position possible)
   * 3. Transfer amount is above minimum ($10)
   * 
   * @returns { shouldRebalance, transferAmount?, toPerp? }
   */
  shouldRebalance(
    perpBalance: number,
    spotBalance: number,
    targetPositionSize: number,
    leverage: number,
  ): { shouldRebalance: boolean; transferAmount?: number; toPerp?: boolean } {
    // Calculate optimal distribution
    const { optimalPerpBalance, optimalSpotBalance } = this.calculateOptimalDistribution(
      perpBalance,
      spotBalance,
      targetPositionSize,
      leverage,
    );

    // Calculate current position capacity
    const currentPerpCapacity = perpBalance * leverage;
    const currentSpotCapacity = spotBalance;
    const currentMaxPosition = Math.min(currentPerpCapacity, currentSpotCapacity);

    // Calculate optimal position capacity
    const optimalPerpCapacity = optimalPerpBalance * leverage;
    const optimalSpotCapacity = optimalSpotBalance;
    const optimalMaxPosition = Math.min(optimalPerpCapacity, optimalSpotCapacity);

    // Check if improvement is meaningful (10%+)
    const improvement = (optimalMaxPosition - currentMaxPosition) / currentMaxPosition;
    if (improvement < this.REBALANCE_THRESHOLD) {
      return { shouldRebalance: false };
    }

    // Determine transfer direction and amount
    const perpDeficit = optimalPerpBalance - perpBalance;
    const spotDeficit = optimalSpotBalance - spotBalance;

    if (perpDeficit > 0 && spotBalance >= perpDeficit) {
      // Need to transfer spot → perp
      const transferAmount = Math.min(perpDeficit, spotBalance * 0.9); // Use 90% to avoid rounding issues
      if (transferAmount >= this.MIN_TRANSFER_AMOUNT) {
        return {
          shouldRebalance: true,
          transferAmount,
          toPerp: true,
        };
      }
    } else if (spotDeficit > 0 && perpBalance >= spotDeficit) {
      // Need to transfer perp → spot
      const transferAmount = Math.min(spotDeficit, perpBalance * 0.9); // Use 90% to avoid rounding issues
      if (transferAmount >= this.MIN_TRANSFER_AMOUNT) {
        return {
          shouldRebalance: true,
          transferAmount,
          toPerp: false,
        };
      }
    }

    return { shouldRebalance: false };
  }
}






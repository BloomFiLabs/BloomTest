import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from './FundingRateAggregator';

export interface BalanceInfo {
  exchange: ExchangeType;
  balance: number;
  targetBalance: number;
  excess: number; // Positive = has excess, negative = has deficit
  adapter: IPerpExchangeAdapter;
}

export interface RebalancePlan {
  exchangesWithExcess: BalanceInfo[];
  exchangesWithDeficit: BalanceInfo[];
  totalExcess: number;
  totalDeficit: number;
  targetBalance: number;
  canRebalance: boolean;
  activeExchanges: Set<ExchangeType>; // Exchanges with opportunities
  inactiveExchanges: Set<ExchangeType>; // Exchanges without opportunities
}

export interface RebalanceResult {
  success: boolean;
  transfersExecuted: number;
  totalTransferred: number;
  errors: string[];
  details: Array<{
    from: ExchangeType;
    to: ExchangeType;
    amount: number;
    success: boolean;
    txHash?: string;
    error?: string;
  }>;
}

/**
 * ExchangeBalanceRebalancer - Rebalances capital across exchanges
 *
 * Ensures all exchanges have similar balances by:
 * 1. Getting balances from all exchanges
 * 2. Calculating target balance (average)
 * 3. Identifying exchanges with excess funds
 * 4. Identifying exchanges with deficit funds
 * 5. Transferring funds from excess to deficit exchanges
 */
@Injectable()
export class ExchangeBalanceRebalancer {
  private readonly logger = new Logger(ExchangeBalanceRebalancer.name);

  // Configuration
  private readonly MIN_BALANCE_THRESHOLD: number; // Minimum balance to keep on each exchange
  private readonly REBALANCE_THRESHOLD_PERCENT: number; // Only rebalance if difference > X%
  private readonly MIN_TRANSFER_AMOUNT: number; // Minimum amount to transfer (to avoid dust)
  private readonly CENTRAL_WALLET_ADDRESS: string | undefined;

  constructor(private readonly configService: ConfigService) {
    // Load configuration
    this.MIN_BALANCE_THRESHOLD = parseFloat(
      this.configService.get<string>('REBALANCE_MIN_BALANCE') || '10',
    );
    this.REBALANCE_THRESHOLD_PERCENT = parseFloat(
      this.configService.get<string>('REBALANCE_THRESHOLD_PERCENT') || '10',
    );
    this.MIN_TRANSFER_AMOUNT = parseFloat(
      this.configService.get<string>('REBALANCE_MIN_TRANSFER') || '5',
    );

    // Get central wallet address for external transfers
    // Try to get from Hyperliquid adapter's wallet (if available)
    // Or use a configured address
    this.CENTRAL_WALLET_ADDRESS =
      this.configService.get<string>('CENTRAL_WALLET_ADDRESS') ||
      this.configService.get<string>('WALLET_ADDRESS') ||
      undefined;

    this.logger.log(
      `ExchangeBalanceRebalancer initialized: ` +
        `Min balance: $${this.MIN_BALANCE_THRESHOLD}, ` +
        `Threshold: ${this.REBALANCE_THRESHOLD_PERCENT}%, ` +
        `Min transfer: $${this.MIN_TRANSFER_AMOUNT}`,
    );
  }

  /**
   * Get balances from all exchanges
   */
  async getExchangeBalances(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<Map<ExchangeType, number>> {
    const balances = new Map<ExchangeType, number>();

    this.logger.log('💰 Fetching balances from all exchanges...');

    for (const [exchangeType, adapter] of adapters) {
      try {
        // Clear cache before fetching balance to ensure fresh data
        // Hyperliquid adapter has a clearBalanceCache method
        if (
          'clearBalanceCache' in adapter &&
          typeof (adapter as any).clearBalanceCache === 'function'
        ) {
          (adapter as any).clearBalanceCache();
        }

        const balance = await adapter.getBalance();
        balances.set(exchangeType, balance);
        this.logger.debug(`   ${exchangeType}: $${balance.toFixed(2)}`);

        // Small delay to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error: any) {
        this.logger.warn(
          `Failed to get balance from ${exchangeType}: ${error.message}`,
        );
        balances.set(exchangeType, 0);
      }
    }

    return balances;
  }

  /**
   * Calculate rebalance plan based on opportunities
   * Prioritizes moving funds from inactive exchanges (no opportunities) to active exchanges (with opportunities)
   */
  calculateRebalancePlan(
    balances: Map<ExchangeType, number>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    opportunities: ArbitrageOpportunity[] = [],
  ): RebalancePlan {
    const balanceInfos: BalanceInfo[] = [];
    const validBalances: number[] = [];

    // Convert balances to BalanceInfo objects
    for (const [exchangeType, balance] of balances) {
      if (balance >= 0) {
        validBalances.push(balance);
        balanceInfos.push({
          exchange: exchangeType,
          balance,
          targetBalance: 0, // Will be calculated
          excess: 0, // Will be calculated
          adapter: adapters.get(exchangeType)!,
        });
      }
    }

    if (validBalances.length === 0) {
      return {
        exchangesWithExcess: [],
        exchangesWithDeficit: [],
        totalExcess: 0,
        totalDeficit: 0,
        targetBalance: 0,
        canRebalance: false,
        activeExchanges: new Set(),
        inactiveExchanges: new Set(),
      };
    }

    // Determine which exchanges are active (have opportunities) vs inactive
    const activeExchanges = new Set<ExchangeType>();
    for (const opp of opportunities) {
      activeExchanges.add(opp.longExchange);
      if (opp.shortExchange) {
        activeExchanges.add(opp.shortExchange);
      }
    }

    // All exchanges that are not in activeExchanges are inactive
    const inactiveExchanges = new Set<ExchangeType>();
    for (const exchangeType of balances.keys()) {
      if (!activeExchanges.has(exchangeType)) {
        inactiveExchanges.add(exchangeType);
      }
    }

    // Calculate target balance
    // Strategy:
    // 1. If we have active exchanges, calculate target based on active exchanges only
    // 2. Inactive exchanges should have minimal balance (just enough for fees)
    // 3. Active exchanges should share the remaining capital equally

    let targetBalance: number;
    let activeBalances: number[] = [];
    let totalActiveBalance = 0;

    if (activeExchanges.size > 0) {
      // Calculate target based on active exchanges
      for (const info of balanceInfos) {
        if (activeExchanges.has(info.exchange)) {
          activeBalances.push(info.balance);
          totalActiveBalance += info.balance;
        }
      }

      // Add balances from inactive exchanges to the pool
      let totalInactiveBalance = 0;
      for (const info of balanceInfos) {
        if (inactiveExchanges.has(info.exchange)) {
          totalInactiveBalance += info.balance;
        }
      }

      // Target balance for active exchanges = (total active + total inactive) / number of active exchanges
      // This ensures we move funds from inactive to active
      const totalAvailableBalance = totalActiveBalance + totalInactiveBalance;
      targetBalance =
        activeExchanges.size > 0
          ? totalAvailableBalance / activeExchanges.size
          : totalAvailableBalance / validBalances.length;

      this.logger.log(
        `Active exchanges: ${Array.from(activeExchanges).join(', ')} (target: $${targetBalance.toFixed(2)} each)`,
      );
      if (inactiveExchanges.size > 0) {
        this.logger.log(
          `Inactive exchanges: ${Array.from(inactiveExchanges).join(', ')} (will withdraw excess)`,
        );
      }
    } else {
      // No opportunities - use simple average
      const totalBalance = validBalances.reduce((sum, b) => sum + b, 0);
      targetBalance = totalBalance / validBalances.length;
      this.logger.log(
        `No active opportunities - using average balance: $${targetBalance.toFixed(2)}`,
      );
    }

    // Calculate excess/deficit for each exchange
    // For inactive exchanges: excess = balance - MIN_BALANCE_THRESHOLD (withdraw everything above minimum)
    // For active exchanges: excess/deficit based on target balance
    for (const info of balanceInfos) {
      if (inactiveExchanges.has(info.exchange)) {
        // Inactive exchanges: keep only minimum balance, rest is excess
        info.targetBalance = this.MIN_BALANCE_THRESHOLD;
        info.excess = Math.max(0, info.balance - this.MIN_BALANCE_THRESHOLD);
      } else {
        // Active exchanges: use calculated target
        info.targetBalance = targetBalance;
        info.excess = info.balance - targetBalance;
      }
    }

    // Separate exchanges with excess and deficit
    const exchangesWithExcess = balanceInfos.filter(
      (info) => info.excess > this.MIN_TRANSFER_AMOUNT,
    );
    const exchangesWithDeficit = balanceInfos.filter(
      (info) => info.excess < -this.MIN_TRANSFER_AMOUNT,
    );

    // Calculate totals
    const totalExcess = exchangesWithExcess.reduce(
      (sum, info) => sum + info.excess,
      0,
    );
    const totalDeficit = Math.abs(
      exchangesWithDeficit.reduce((sum, info) => sum + info.excess, 0),
    );

    // Check if rebalancing is needed
    // Always rebalance if:
    // 1. There are inactive exchanges with excess (move funds to active exchanges)
    // 2. OR there are active exchanges with imbalance above threshold
    const hasInactiveExcess = exchangesWithExcess.some((info) =>
      inactiveExchanges.has(info.exchange),
    );
    const hasActiveDeficit = exchangesWithDeficit.some((info) =>
      activeExchanges.has(info.exchange),
    );

    // Check threshold for active exchange rebalancing
    const maxBalance = Math.max(...validBalances);
    const minBalance = Math.min(...validBalances);
    const balanceDifference = maxBalance - minBalance;
    const differencePercent =
      targetBalance > 0 ? (balanceDifference / targetBalance) * 100 : 0;

    // Always rebalance if inactive exchanges have excess to move to active exchanges
    // OR if active exchanges have imbalance above threshold
    const canRebalance =
      exchangesWithExcess.length > 0 &&
      exchangesWithDeficit.length > 0 &&
      (hasInactiveExcess ||
        differencePercent >= this.REBALANCE_THRESHOLD_PERCENT);

    return {
      exchangesWithExcess,
      exchangesWithDeficit,
      totalExcess,
      totalDeficit,
      targetBalance,
      canRebalance,
      activeExchanges,
      inactiveExchanges,
    };
  }

  /**
   * Execute rebalancing plan
   */
  async executeRebalance(plan: RebalancePlan): Promise<RebalanceResult> {
    const result: RebalanceResult = {
      success: true,
      transfersExecuted: 0,
      totalTransferred: 0,
      errors: [],
      details: [],
    };

    if (!plan.canRebalance) {
      this.logger.log(
        '⏸️  Rebalancing not needed - balances are within threshold',
      );
      return result;
    }

    this.logger.log(
      `🔄 Starting rebalance: ${plan.exchangesWithExcess.length} exchanges with excess, ` +
        `${plan.exchangesWithDeficit.length} exchanges with deficit`,
    );
    this.logger.log(`   Target balance: $${plan.targetBalance.toFixed(2)}`);
    this.logger.log(`   Total excess: $${plan.totalExcess.toFixed(2)}`);
    this.logger.log(`   Total deficit: $${plan.totalDeficit.toFixed(2)}`);

    // Match excess exchanges with deficit exchanges
    // Prioritize: inactive exchanges with excess -> active exchanges with deficit
    // Then: active exchanges with excess -> active exchanges with deficit
    const excessQueue = [...plan.exchangesWithExcess].sort((a, b) => {
      // First sort by inactive vs active (inactive first)
      const aIsInactive = plan.inactiveExchanges.has(a.exchange);
      const bIsInactive = plan.inactiveExchanges.has(b.exchange);
      if (aIsInactive !== bIsInactive) {
        return aIsInactive ? -1 : 1; // Inactive first
      }
      // Then by excess amount (highest first)
      return b.excess - a.excess;
    });

    const deficitQueue = [...plan.exchangesWithDeficit].sort((a, b) => {
      // Prioritize active exchanges with deficit
      const aIsActive = plan.activeExchanges.has(a.exchange);
      const bIsActive = plan.activeExchanges.has(b.exchange);
      if (aIsActive !== bIsActive) {
        return aIsActive ? -1 : 1; // Active first
      }
      // Then by deficit amount (largest deficit first)
      return a.excess - b.excess; // More negative = larger deficit
    });

    // Execute transfers
    let excessIndex = 0;
    let deficitIndex = 0;

    while (
      excessIndex < excessQueue.length &&
      deficitIndex < deficitQueue.length
    ) {
      const excessExchange = excessQueue[excessIndex];
      const deficitExchange = deficitQueue[deficitIndex];

      // Calculate transfer amount
      const availableExcess = excessExchange.excess;
      const neededDeficit = Math.abs(deficitExchange.excess);
      const transferAmount = Math.min(availableExcess, neededDeficit);

      // Skip if amount is too small
      if (transferAmount < this.MIN_TRANSFER_AMOUNT) {
        if (transferAmount === availableExcess) {
          excessIndex++;
        } else {
          deficitIndex++;
        }
        continue;
      }

      // Execute transfer
      try {
        this.logger.log(
          `📤 Transferring $${transferAmount.toFixed(2)} from ${excessExchange.exchange} to ${deficitExchange.exchange}...`,
        );

        const txHash = await this.transferBetweenExchanges(
          excessExchange.exchange,
          deficitExchange.exchange,
          transferAmount,
          excessExchange.adapter,
          deficitExchange.adapter,
        );

        result.transfersExecuted++;
        result.totalTransferred += transferAmount;
        result.details.push({
          from: excessExchange.exchange,
          to: deficitExchange.exchange,
          amount: transferAmount,
          success: true,
          txHash,
        });

        // Update remaining excess/deficit
        excessExchange.excess -= transferAmount;
        deficitExchange.excess += transferAmount;

        // Move to next exchange if this one is done
        if (excessExchange.excess < this.MIN_TRANSFER_AMOUNT) {
          excessIndex++;
        }
        if (Math.abs(deficitExchange.excess) < this.MIN_TRANSFER_AMOUNT) {
          deficitIndex++;
        }

        // Delay between transfers to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error: any) {
        const errorMsg = `Failed to transfer $${transferAmount.toFixed(2)} from ${excessExchange.exchange} to ${deficitExchange.exchange}: ${error.message}`;
        this.logger.error(errorMsg);
        result.errors.push(errorMsg);
        result.details.push({
          from: excessExchange.exchange,
          to: deficitExchange.exchange,
          amount: transferAmount,
          success: false,
          error: error.message,
        });

        // Try next pair
        excessIndex++;
        deficitIndex++;
      }
    }

    if (result.errors.length > 0) {
      result.success = false;
    }

    this.logger.log(
      `✅ Rebalance complete: ${result.transfersExecuted} transfers, ` +
        `$${result.totalTransferred.toFixed(2)} total transferred`,
    );

    return result;
  }

  /**
   * Transfer funds between two exchanges
   * Uses external withdrawal/deposit via a central wallet
   *
   * Note: This requires:
   * 1. CENTRAL_WALLET_ADDRESS to be configured in environment variables
   * 2. External withdrawal/deposit APIs to be supported by the exchanges
   *
   * If external APIs are not available, manual intervention may be required
   */
  async transferBetweenExchanges(
    fromExchange: ExchangeType,
    toExchange: ExchangeType,
    amount: number,
    fromAdapterOrMap:
      | IPerpExchangeAdapter
      | Map<ExchangeType, IPerpExchangeAdapter>,
    toAdapter?: IPerpExchangeAdapter,
  ): Promise<string> {
    // Handle both Map and individual adapters for backward compatibility
    let fromAdapter: IPerpExchangeAdapter;
    let toAdapterResolved: IPerpExchangeAdapter;

    if (fromAdapterOrMap instanceof Map) {
      fromAdapter = fromAdapterOrMap.get(fromExchange)!;
      toAdapterResolved = fromAdapterOrMap.get(toExchange)!;
      if (!fromAdapter || !toAdapterResolved) {
        throw new Error(
          `Adapters not found for ${fromExchange} or ${toExchange}`,
        );
      }
    } else {
      fromAdapter = fromAdapterOrMap;
      toAdapterResolved = toAdapter!;
      if (!toAdapterResolved) {
        throw new Error(
          'toAdapter is required when fromAdapterOrMap is not a Map',
        );
      }
    }
    if (!this.CENTRAL_WALLET_ADDRESS) {
      throw new Error(
        'CENTRAL_WALLET_ADDRESS not configured. Cannot execute external transfers. ' +
          'Please set CENTRAL_WALLET_ADDRESS in environment variables. ' +
          'This should be the wallet address that can receive funds from exchanges and send to exchanges.',
      );
    }

    // Step 1: Check pool availability for Lighter (fast withdraw has limited pool)
    if (fromExchange === ExchangeType.LIGHTER) {
      // Check if the adapter has the getFastWithdrawPoolAvailability method
      if (
        typeof (fromAdapter as any).getFastWithdrawPoolAvailability ===
        'function'
      ) {
        try {
          const poolAvailable = await (
            fromAdapter as any
          ).getFastWithdrawPoolAvailability();
          if (poolAvailable !== null && poolAvailable < amount) {
            throw new Error(
              `Lighter fast withdraw pool has insufficient funds. ` +
                `Requested: $${amount.toFixed(2)}, Available: $${poolAvailable.toFixed(2)}. ` +
                `The fast withdraw pool is shared across all users and may refill later. ` +
                `Skipping this transfer.`,
            );
          }
          if (poolAvailable !== null) {
            this.logger.log(
              `   ℹ️ Lighter fast withdraw pool has $${poolAvailable.toFixed(2)} available`,
            );
          }
        } catch (poolCheckError: any) {
          // If it's an insufficient funds error, rethrow it
          if (poolCheckError.message.includes('insufficient funds')) {
            throw poolCheckError;
          }
          // Otherwise just log the warning and continue
          this.logger.warn(
            `   ⚠️ Could not check Lighter pool availability: ${poolCheckError.message}`,
          );
        }
      }
    }

    // Step 2: Withdraw from source exchange to central wallet
    this.logger.log(
      `📤 Step 2: Withdrawing $${amount.toFixed(2)} from ${fromExchange} to central wallet ${this.CENTRAL_WALLET_ADDRESS}...`,
    );
    let withdrawTxHash: string;
    try {
      withdrawTxHash = await fromAdapter.withdrawExternal(
        amount,
        'USDC', // Use USDC for withdrawals
        this.CENTRAL_WALLET_ADDRESS,
      );
      this.logger.log(`✅ Withdrawal successful: ${withdrawTxHash}`);
    } catch (withdrawError: any) {
      throw new Error(
        `Failed to withdraw from ${fromExchange}: ${withdrawError.message}. ` +
          `External withdrawals may not be supported via API for this exchange. ` +
          `Please check exchange documentation or use manual transfer.`,
      );
    }

    // Wait a bit for withdrawal to settle (if on-chain)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 3: Deposit from central wallet to destination exchange
    // Note: External deposits may not be supported via API for all exchanges
    this.logger.log(
      `📥 Step 3: Depositing $${amount.toFixed(2)} from central wallet to ${toExchange}...`,
    );
    try {
      const depositTxHash = await toAdapterResolved.depositExternal(
        amount,
        'USDC', // Use USDC for deposits
        this.CENTRAL_WALLET_ADDRESS,
      );
      this.logger.log(
        `✅ Deposit successful: ${depositTxHash || withdrawTxHash}`,
      );
      return depositTxHash || withdrawTxHash;
    } catch (depositError: any) {
      // If deposit fails, the withdrawal already happened
      // This is a partial failure - funds are in central wallet but not deposited
      const errorMsg =
        `Deposit to ${toExchange} failed after successful withdrawal from ${fromExchange}. ` +
        `Funds ($${amount.toFixed(2)}) are in central wallet (${this.CENTRAL_WALLET_ADDRESS}) but not yet deposited. ` +
        `Error: ${depositError.message}. ` +
        `External deposits may not be supported via API for ${toExchange}. ` +
        `Manual deposit may be required.`;

      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Main rebalance method - gets balances, calculates plan based on opportunities, and executes
   *
   * @param adapters Map of exchange adapters
   * @param opportunities List of arbitrage opportunities (used to determine which exchanges are active)
   */
  async rebalance(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    opportunities: ArbitrageOpportunity[] = [],
  ): Promise<RebalanceResult> {
    this.logger.log('🔄 Starting exchange balance rebalancing...');

    // Step 1: Get balances
    const balances = await this.getExchangeBalances(adapters);

    // Step 2: Calculate plan based on opportunities
    const plan = this.calculateRebalancePlan(balances, adapters, opportunities);

    // Step 3: Log plan
    this.logPlan(plan);

    // Step 4: Execute plan
    return await this.executeRebalance(plan);
  }

  /**
   * Log rebalance plan for debugging
   */
  private logPlan(plan: RebalancePlan): void {
    this.logger.log('\n📊 Rebalance Plan:');
    this.logger.log(
      `   Target balance (active exchanges): $${plan.targetBalance.toFixed(2)}`,
    );

    if (plan.activeExchanges.size > 0) {
      this.logger.log(
        `   Active exchanges (with opportunities): ${Array.from(plan.activeExchanges).join(', ')}`,
      );
    }

    if (plan.inactiveExchanges.size > 0) {
      this.logger.log(
        `   Inactive exchanges (no opportunities): ${Array.from(plan.inactiveExchanges).join(', ')}`,
      );
      this.logger.log(
        `   → Will withdraw excess from inactive exchanges to fund active ones`,
      );
    }

    if (plan.exchangesWithExcess.length > 0) {
      this.logger.log(`   Exchanges with excess:`);
      for (const info of plan.exchangesWithExcess) {
        const status = plan.inactiveExchanges.has(info.exchange)
          ? '(inactive - will withdraw)'
          : '(active)';
        this.logger.log(
          `      ${info.exchange}: $${info.balance.toFixed(2)} (excess: $${info.excess.toFixed(2)}) ${status}`,
        );
      }
    }

    if (plan.exchangesWithDeficit.length > 0) {
      this.logger.log(`   Exchanges with deficit:`);
      for (const info of plan.exchangesWithDeficit) {
        this.logger.log(
          `      ${info.exchange}: $${info.balance.toFixed(2)} (deficit: $${Math.abs(info.excess).toFixed(2)})`,
        );
      }
    }

    if (!plan.canRebalance) {
      this.logger.log(
        '   ⏸️  Rebalancing not needed - balances are within threshold',
      );
    }
  }
}

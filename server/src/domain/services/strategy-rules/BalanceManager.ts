import {
  Injectable,
  Logger,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IBalanceManager } from './IBalanceManager';
import { ExchangeBalanceRebalancer } from '../ExchangeBalanceRebalancer';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { Result } from '../../common/Result';
import {
  DomainException,
  ExchangeException,
  ValidationException,
} from '../../exceptions/DomainException';
import type { ProfitTracker } from '../../../infrastructure/services/ProfitTracker';

/**
 * Balance manager for funding arbitrage strategy
 * Handles wallet balance checking, deposits, and rebalancing
 */
@Injectable()
export class BalanceManager implements IBalanceManager {
  private readonly logger = new Logger(BalanceManager.name);

  // ProfitTracker for excluding accrued profits from deployable capital
  private profitTracker?: ProfitTracker;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly balanceRebalancer?: ExchangeBalanceRebalancer,
    private readonly config: StrategyConfig = StrategyConfig.withDefaults(),
  ) {}

  /**
   * Set the ProfitTracker instance
   * Called by the module after both services are instantiated (to avoid circular dependency)
   */
  setProfitTracker(profitTracker: ProfitTracker): void {
    this.profitTracker = profitTracker;
    this.logger.log(
      'ProfitTracker set - profits will be excluded from deployable capital',
    );
  }

  /**
   * Get deployable capital for a specific exchange
   * This excludes accrued profits to ensure we don't use profit funds for new positions
   *
   * @param adapter The exchange adapter
   * @param exchangeType The exchange type
   * @returns Deployable capital (balance - accrued profits)
   */
  async getDeployableCapital(
    adapter: IPerpExchangeAdapter,
    exchangeType: ExchangeType,
  ): Promise<number> {
    // Start with total equity (total account value)
    // Then we'll subtract margin used and accrued profits
    const totalEquity = await adapter.getEquity();

    if (this.profitTracker) {
      try {
        const deployable =
          await this.profitTracker.getDeployableCapital(exchangeType);
        // Use the minimum of actual equity and deployable capital
        // This handles cases where ProfitTracker hasn't synced deployedCapital yet
        const result =
          deployable > 0 ? Math.min(totalEquity, deployable) : totalEquity;
        this.logger.debug(
          `Deployable capital for ${exchangeType}: $${result.toFixed(2)} ` +
            `(equity: $${totalEquity.toFixed(2)}, profit-adjusted: $${deployable.toFixed(2)})`,
        );
        return result;
      } catch (error: any) {
        this.logger.debug(
          `Failed to get deployable capital from ProfitTracker: ${error.message}, using full equity`,
        );
      }
    }

    // If ProfitTracker not available, use full equity
    return totalEquity;
  }

  /**
   * Get deployable balances for multiple exchanges
   * Returns a map of exchange -> deployable capital
   */
  async getDeployableBalances(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<Map<ExchangeType, number>> {
    const balances = new Map<ExchangeType, number>();

    for (const [exchangeType, adapter] of adapters) {
      try {
        const deployable = await this.getDeployableCapital(
          adapter,
          exchangeType,
        );
        balances.set(exchangeType, deployable);
      } catch (error: any) {
        this.logger.debug(
          `Failed to get deployable capital for ${exchangeType}: ${error.message}`,
        );
        balances.set(exchangeType, 0);
      }
    }

    return balances;
  }

  async getWalletUsdcBalance(): Promise<Result<number, DomainException>> {
    try {
      // Get Arbitrum RPC URL (USDC deposits go through Arbitrum)
      const rpcUrl =
        this.configService.get<string>('ARBITRUM_RPC_URL') ||
        this.configService.get<string>('ARB_RPC_URL') ||
        'https://arb1.arbitrum.io/rpc'; // Public Arbitrum RPC fallback
      const privateKey = this.configService.get<string>('PRIVATE_KEY');
      const walletAddress =
        this.configService.get<string>('WALLET_ADDRESS') ||
        this.configService.get<string>('CENTRAL_WALLET_ADDRESS');

      if (!privateKey && !walletAddress) {
        this.logger.debug(
          'No PRIVATE_KEY or WALLET_ADDRESS configured, skipping wallet balance check',
        );
        return Result.success(0);
      }

      // USDC address on Arbitrum (matches deposit logic)
      const usdcAddress = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

      // ERC20 ABI (minimal)
      const erc20Abi = [
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ];

      // Initialize provider
      const provider = new JsonRpcProvider(rpcUrl);

      // Get wallet address
      let address: string;
      if (walletAddress) {
        address = walletAddress;
        this.logger.debug(`Using WALLET_ADDRESS from config: ${address}`);
      } else if (privateKey) {
        const normalizedKey = privateKey.startsWith('0x')
          ? privateKey
          : `0x${privateKey}`;
        const wallet = new Wallet(normalizedKey);
        address = wallet.address;
        this.logger.debug(`Derived address from PRIVATE_KEY: ${address}`);
      } else {
        return Result.success(0);
      }

      this.logger.log(
        `🔍 Checking USDC balance on Arbitrum for address: ${address} ` +
          `(USDC contract: ${usdcAddress})`,
      );

      // Check USDC balance
      const usdcContract = new Contract(usdcAddress, erc20Abi, provider);
      const balance = await usdcContract.balanceOf(address);
      const decimals = await usdcContract.decimals();
      const balanceUsd = parseFloat(formatUnits(balance, decimals));

      this.logger.log(
        `💰 USDC balance on Arbitrum for ${address}: $${balanceUsd.toFixed(2)} USDC`,
      );

      return Result.success(balanceUsd);
    } catch (error: any) {
      this.logger.debug(
        `Failed to get wallet USDC balance on Arbitrum: ${error.message}`,
      );
      return Result.failure(
        new DomainException(
          `Failed to get wallet USDC balance: ${error.message}`,
          'WALLET_BALANCE_ERROR',
          { error: error.message },
        ),
      );
    }
  }

  async checkAndDepositWalletFunds(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    uniqueExchanges: Set<ExchangeType>,
  ): Promise<Result<void, DomainException>> {
    try {
      const walletBalanceResult = await this.getWalletUsdcBalance();
      if (walletBalanceResult.isFailure) {
        this.logger.debug(
          `Failed to get wallet balance: ${walletBalanceResult.error.message}`,
        );
        return Result.failure(walletBalanceResult.error);
      }
      const walletBalance = walletBalanceResult.value;
      if (walletBalance <= 0) {
        this.logger.debug('No USDC in wallet, skipping deposit');
        return Result.success(undefined);
      }

      this.logger.log(
        `💰 Found $${walletBalance.toFixed(2)} USDC in wallet, checking if deposits are needed...`,
      );

      // Get current balances on exchanges for logging
      const exchangeBalances = new Map<ExchangeType, number>();
      for (const exchange of uniqueExchanges) {
        const adapter = adapters.get(exchange);
        if (adapter) {
          try {
            const balance = await adapter.getBalance();
            exchangeBalances.set(exchange, balance);
          } catch (error: any) {
            this.logger.debug(
              `Failed to get balance for ${exchange}: ${error.message}`,
            );
            exchangeBalances.set(exchange, 0);
          }
        }
      }

      // Log current balances
      this.logger.log('Current exchange balances:');
      for (const [exchange, balance] of exchangeBalances) {
        this.logger.log(`  ${exchange}: $${balance.toFixed(2)}`);
      }

      // Distribute wallet funds equally to all exchanges (scalable approach)
      const exchangesToDeposit = Array.from(uniqueExchanges);
      if (exchangesToDeposit.length === 0) {
        this.logger.debug('No exchanges available for deposit');
        return Result.success(undefined);
      }

      // Distribute wallet funds equally to all exchanges
      let remainingWalletBalance = walletBalance;
      const amountPerExchange = walletBalance / exchangesToDeposit.length;

      this.logger.log(
        `📊 Distributing $${walletBalance.toFixed(2)} equally to ${exchangesToDeposit.length} exchange(s): ` +
          `$${amountPerExchange.toFixed(2)} per exchange`,
      );

      for (const exchange of exchangesToDeposit) {
        if (remainingWalletBalance <= 0) {
          break;
        }

        const adapter = adapters.get(exchange);
        if (!adapter) continue;

        const depositAmount = Math.min(
          amountPerExchange,
          remainingWalletBalance,
        );
        if (depositAmount < 5) {
          // Minimum deposit is usually $5
          this.logger.debug(
            `Skipping deposit to ${exchange}: amount too small ($${depositAmount.toFixed(2)})`,
          );
          continue;
        }

        try {
          this.logger.log(
            `📥 Depositing $${depositAmount.toFixed(2)} from wallet to ${exchange}...`,
          );
          await adapter.depositExternal(depositAmount, 'USDC');
          this.logger.log(
            `✅ Successfully deposited $${depositAmount.toFixed(2)} to ${exchange}`,
          );
          remainingWalletBalance -= depositAmount;
          // Wait a bit between deposits to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error: any) {
          // Check if it's a 404 error (endpoint doesn't exist) - Aster may require on-chain deposits
          if (
            error.message?.includes('404') ||
            error.message?.includes('on-chain')
          ) {
            this.logger.warn(
              `⚠️ ${exchange} deposits may require on-chain transactions. ` +
                `Skipping deposit to ${exchange}. Funds remain in wallet. ` +
                `Error: ${error.message}`,
            );
            // Don't subtract from remaining balance - funds stay in wallet
            continue;
          }
          this.logger.warn(
            `Failed to deposit $${depositAmount.toFixed(2)} to ${exchange}: ${error.message}`,
          );
          // Don't subtract on error - funds remain in wallet for retry
        }
      }
    } catch (error: any) {
      this.logger.debug(
        `Error checking/depositing wallet funds: ${error.message}`,
      );
      return Result.failure(
        new DomainException(
          `Error checking/depositing wallet funds: ${error.message}`,
          'WALLET_DEPOSIT_ERROR',
          { error: error.message },
        ),
      );
    }

    // Return success even if some deposits failed (errors are logged)
    return Result.success(undefined);
  }

  async attemptRebalanceForOpportunity(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    requiredCollateral: number,
    longBalance: number,
    shortBalance: number,
  ): Promise<Result<boolean, DomainException>> {
    if (!this.balanceRebalancer) {
      this.logger.warn(
        'ExchangeBalanceRebalancer not available, cannot rebalance',
      );
      return Result.failure(
        new DomainException(
          'ExchangeBalanceRebalancer not available',
          'REBALANCE_UNAVAILABLE',
        ),
      );
    }

    const longExchange = opportunity.longExchange;
    const shortExchange = opportunity.shortExchange;
    const longAdapter = adapters.get(longExchange);
    if (!shortExchange) {
      return Result.failure(
        new ValidationException(
          'shortExchange is required',
          'MISSING_SHORT_EXCHANGE',
        ),
      );
    }
    const shortAdapter = adapters.get(shortExchange);

    if (!longAdapter || !shortAdapter) {
      const missingAdapter = !longAdapter ? longExchange : shortExchange;
      return Result.failure(
        new ExchangeException(
          `Adapter not found for ${missingAdapter}`,
          missingAdapter,
        ),
      );
    }

    this.logger.debug(
      `Rebalancing for ${opportunity.symbol}: Need $${requiredCollateral.toFixed(2)} on both exchanges`,
    );

    // Get all exchange balances to identify unused exchanges
    const allBalances =
      await this.balanceRebalancer.getExchangeBalances(adapters);
    const unusedExchanges: ExchangeType[] = [];

    for (const [exchange, balance] of allBalances) {
      if (
        exchange !== longExchange &&
        exchange !== shortExchange &&
        balance > 0
      ) {
        unusedExchanges.push(exchange);
        this.logger.debug(
          `   Found unused exchange ${exchange} with $${balance.toFixed(2)}`,
        );
      }
    }

    // Calculate deficits
    const longDeficit = Math.max(0, requiredCollateral - longBalance);
    const shortDeficit = Math.max(0, requiredCollateral - shortBalance);
    const totalDeficit = longDeficit + shortDeficit;

    if (totalDeficit === 0) {
      this.logger.debug(
        'No rebalancing needed - both exchanges have sufficient balance',
      );
      return Result.success(true);
    }

    // Track remaining needs for Strategy 3 (wallet deposit fallback)
    let remainingLongNeeded = longDeficit;
    let remainingShortNeeded = shortDeficit;

    // Strategy 1: Withdraw from unused exchanges and distribute to needed exchanges
    let totalAvailableFromUnused = 0;
    for (const exchange of unusedExchanges) {
      const balance = allBalances.get(exchange) ?? 0;
      totalAvailableFromUnused += balance;
    }

    if (totalAvailableFromUnused > 0 && totalDeficit > 0) {
      this.logger.debug(
        `Rebalancing: $${totalAvailableFromUnused.toFixed(2)} available from unused exchanges, ` +
          `need $${totalDeficit.toFixed(2)}`,
      );

      // Distribute unused funds proportionally to deficits
      const longShare = totalDeficit > 0 ? longDeficit / totalDeficit : 0;
      const shortShare = totalDeficit > 0 ? shortDeficit / totalDeficit : 0;
      const longNeeded = Math.min(
        longDeficit,
        totalAvailableFromUnused * longShare,
      );
      const shortNeeded = Math.min(
        shortDeficit,
        totalAvailableFromUnused * shortShare,
      );

      // Transfer from unused exchanges to needed exchanges
      // Update remaining needs (already declared above)
      remainingLongNeeded = longNeeded;
      remainingShortNeeded = shortNeeded;

      for (const unusedExchange of unusedExchanges) {
        if (remainingLongNeeded <= 0 && remainingShortNeeded <= 0) break;

        let unusedBalance = allBalances.get(unusedExchange) ?? 0;
        if (unusedBalance <= 0) continue;

        const unusedAdapter = adapters.get(unusedExchange);
        if (!unusedAdapter) continue;

        // Transfer to long exchange if needed
        if (remainingLongNeeded > 0 && unusedBalance > 0) {
          const transferAmount = Math.min(remainingLongNeeded, unusedBalance);
          try {
            this.logger.debug(
              `Transferring $${transferAmount.toFixed(2)} from ${unusedExchange} to ${longExchange}`,
            );
            const txHash =
              await this.balanceRebalancer.transferBetweenExchanges(
                unusedExchange,
                longExchange,
                transferAmount,
                adapters.get(unusedExchange)!,
                adapters.get(longExchange),
              );
            const success = !!txHash;
            if (success) {
              remainingLongNeeded -= transferAmount;
              unusedBalance -= transferAmount;
            }
          } catch (error: any) {
            this.logger.debug(
              `Failed to transfer from ${unusedExchange} to ${longExchange}: ${error.message}`,
            );
          }
        }

        // Transfer to short exchange if needed
        if (remainingShortNeeded > 0 && unusedBalance > 0) {
          const transferAmount = Math.min(remainingShortNeeded, unusedBalance);
          try {
            this.logger.debug(
              `Transferring $${transferAmount.toFixed(2)} from ${unusedExchange} to ${shortExchange}`,
            );
            const txHash =
              await this.balanceRebalancer.transferBetweenExchanges(
                unusedExchange,
                shortExchange,
                transferAmount,
                adapters.get(unusedExchange)!,
                adapters.get(shortExchange),
              );
            const success = !!txHash;
            if (success) {
              remainingShortNeeded -= transferAmount;
            }
          } catch (error: any) {
            this.logger.debug(
              `Failed to transfer from ${unusedExchange} to ${shortExchange}: ${error.message}`,
            );
          }
        }
      }

      // Check if we've met the requirements after rebalancing
      if (remainingLongNeeded <= 0 && remainingShortNeeded <= 0) {
        this.logger.debug('Rebalancing successful via unused exchanges');
        return Result.success(true);
      }
    }

    // Strategy 2: Withdraw from one exchange and deposit to the other if one has excess
    const longExcess = Math.max(0, longBalance - requiredCollateral);
    const shortExcess = Math.max(0, shortBalance - requiredCollateral);

    if (longExcess > 0 && shortDeficit > 0) {
      const transferAmount = Math.min(longExcess, shortDeficit);
      try {
        this.logger.debug(
          `Transferring $${transferAmount.toFixed(2)} from ${longExchange} to ${shortExchange}`,
        );
        const txHash = await this.balanceRebalancer.transferBetweenExchanges(
          longExchange,
          shortExchange,
          transferAmount,
          adapters.get(longExchange)!,
          adapters.get(shortExchange),
        );
        const success = !!txHash;
        if (success) {
          this.logger.debug(
            'Rebalancing successful via exchange-to-exchange transfer',
          );
          return Result.success(true);
        }
      } catch (error: any) {
        this.logger.debug(
          `Failed to transfer from ${longExchange} to ${shortExchange}: ${error.message}`,
        );
      }
    }

    if (shortExcess > 0 && longDeficit > 0) {
      const transferAmount = Math.min(shortExcess, longDeficit);
      try {
        this.logger.debug(
          `Transferring $${transferAmount.toFixed(2)} from ${shortExchange} to ${longExchange}`,
        );
        const txHash = await this.balanceRebalancer.transferBetweenExchanges(
          shortExchange,
          longExchange,
          transferAmount,
          adapters.get(shortExchange)!,
          adapters.get(longExchange),
        );
        const success = !!txHash;
        if (success) {
          this.logger.debug(
            'Rebalancing successful via exchange-to-exchange transfer',
          );
          return Result.success(true);
        }
      } catch (error: any) {
        this.logger.debug(
          `Failed to transfer from ${shortExchange} to ${longExchange}: ${error.message}`,
        );
      }
    }

    // Strategy 3: Check wallet and deposit if needed (fallback)
    try {
      const walletBalanceResult = await this.getWalletUsdcBalance();
      if (walletBalanceResult.isFailure) {
        this.logger.debug(
          `Failed to get wallet balance: ${walletBalanceResult.error.message}`,
        );
      } else {
        const walletBalance = walletBalanceResult.value;
        if (walletBalance > 0) {
          const totalRemainingDeficit = Math.max(
            remainingLongNeeded,
            remainingShortNeeded,
          );
          if (
            totalRemainingDeficit > 0 &&
            walletBalance >= totalRemainingDeficit
          ) {
            this.logger.debug(
              `Depositing $${totalRemainingDeficit.toFixed(2)} from wallet to cover remaining deficit`,
            );

            if (remainingLongNeeded > 0) {
              await longAdapter.depositExternal(remainingLongNeeded, 'USDC');
            }
            if (remainingShortNeeded > 0) {
              await shortAdapter.depositExternal(remainingShortNeeded, 'USDC');
            }

            return Result.success(true);
          }
        }
      }
    } catch (error: any) {
      this.logger.debug(`Failed to deposit from wallet: ${error.message}`);
    }

    this.logger.warn(
      `Rebalancing failed for ${opportunity.symbol}: ` +
        `Long deficit: $${longDeficit.toFixed(2)}, Short deficit: $${shortDeficit.toFixed(2)}`,
    );
    return Result.failure(
      new DomainException(
        `Rebalancing failed - insufficient funds. Long deficit: $${longDeficit.toFixed(2)}, Short deficit: $${shortDeficit.toFixed(2)}`,
        'REBALANCE_FAILED',
        { longDeficit, shortDeficit, requiredCollateral },
      ),
    );
  }
}

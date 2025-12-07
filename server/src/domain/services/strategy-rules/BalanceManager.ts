import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IBalanceManager } from './IBalanceManager';
import { ExchangeBalanceRebalancer } from '../ExchangeBalanceRebalancer';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';

/**
 * Balance manager for funding arbitrage strategy
 * Handles wallet balance checking, deposits, and rebalancing
 */
@Injectable()
export class BalanceManager implements IBalanceManager {
  private readonly logger = new Logger(BalanceManager.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly balanceRebalancer?: ExchangeBalanceRebalancer,
    private readonly config: StrategyConfig = new StrategyConfig(),
  ) {}

  async getWalletUsdcBalance(): Promise<number> {
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
        return 0;
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
        return 0;
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

      return balanceUsd;
    } catch (error: any) {
      this.logger.debug(
        `Failed to get wallet USDC balance on Arbitrum: ${error.message}`,
      );
      return 0;
    }
  }

  async checkAndDepositWalletFunds(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    uniqueExchanges: Set<ExchangeType>,
  ): Promise<void> {
    try {
      const walletBalance = await this.getWalletUsdcBalance();
      if (walletBalance <= 0) {
        this.logger.debug('No USDC in wallet, skipping deposit');
        return;
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
        return;
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

        const depositAmount = Math.min(amountPerExchange, remainingWalletBalance);
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
    }
  }

  async attemptRebalanceForOpportunity(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    requiredCollateral: number,
    longBalance: number,
    shortBalance: number,
  ): Promise<boolean> {
    if (!this.balanceRebalancer) {
      this.logger.warn(
        'ExchangeBalanceRebalancer not available, cannot rebalance',
      );
      return false;
    }

    const longExchange = opportunity.longExchange;
    const shortExchange = opportunity.shortExchange;
    const longAdapter = adapters.get(longExchange);
    const shortAdapter = adapters.get(shortExchange);

    if (!longAdapter || !shortAdapter) {
      return false;
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
      return true;
    }

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
      let remainingLongNeeded = longNeeded;
      let remainingShortNeeded = shortNeeded;

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
            const success = await this.balanceRebalancer.transferBetweenExchanges(
              unusedExchange,
              longExchange,
              transferAmount,
              adapters,
            );
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
            const success = await this.balanceRebalancer.transferBetweenExchanges(
              unusedExchange,
              shortExchange,
              transferAmount,
              adapters,
            );
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
        return true;
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
        const success = await this.balanceRebalancer.transferBetweenExchanges(
          longExchange,
          shortExchange,
          transferAmount,
          adapters,
        );
        if (success) {
          this.logger.debug('Rebalancing successful via exchange-to-exchange transfer');
          return true;
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
        const success = await this.balanceRebalancer.transferBetweenExchanges(
          shortExchange,
          longExchange,
          transferAmount,
          adapters,
        );
        if (success) {
          this.logger.debug('Rebalancing successful via exchange-to-exchange transfer');
          return true;
        }
      } catch (error: any) {
        this.logger.debug(
          `Failed to transfer from ${shortExchange} to ${longExchange}: ${error.message}`,
        );
      }
    }

    // Strategy 3: Check wallet and deposit if needed (fallback)
    try {
      const walletBalance = await this.getWalletUsdcBalance();
      if (walletBalance > 0) {
        const totalRemainingDeficit = Math.max(remainingLongNeeded, remainingShortNeeded);
        if (totalRemainingDeficit > 0 && walletBalance >= totalRemainingDeficit) {
          this.logger.debug(
            `Depositing $${totalRemainingDeficit.toFixed(2)} from wallet to cover remaining deficit`,
          );
          
          if (remainingLongNeeded > 0) {
            await longAdapter.depositExternal(remainingLongNeeded, 'USDC');
          }
          if (remainingShortNeeded > 0) {
            await shortAdapter.depositExternal(remainingShortNeeded, 'USDC');
          }
          
          return true;
        }
      }
    } catch (error: any) {
      this.logger.debug(`Failed to deposit from wallet: ${error.message}`);
    }

    this.logger.warn(
      `Rebalancing failed for ${opportunity.symbol}: ` +
        `Long deficit: $${longDeficit.toFixed(2)}, Short deficit: $${shortDeficit.toFixed(2)}`,
    );
    return false;
  }
}


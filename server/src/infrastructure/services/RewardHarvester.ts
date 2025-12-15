import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, Interval } from '@nestjs/schedule';
import { Contract, Wallet, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';
import { ProfitTracker } from './ProfitTracker';
import { DiagnosticsService } from './DiagnosticsService';

/**
 * Result of a single exchange harvest
 */
interface ExchangeHarvestResult {
  exchange: ExchangeType;
  success: boolean;
  amountWithdrawn: number;
  error?: string;
}

/**
 * Result of a full harvest operation
 */
export interface HarvestResult {
  success: boolean;
  totalProfitsFound: number;
  totalWithdrawn: number;
  totalSentToVault: number;
  byExchange: ExchangeHarvestResult[];
  errors: string[];
  timestamp: Date;
}

/**
 * Harvest history entry
 */
export interface HarvestHistoryEntry {
  timestamp: Date;
  totalAmount: number;
  byExchange: Map<ExchangeType, number>;
  success: boolean;
}

/**
 * RewardHarvester - Harvests accumulated profits and sends them to the vault
 * 
 * Responsibilities:
 * 1. Run every 24 hours (configurable via HARVEST_INTERVAL_HOURS)
 * 2. Calculate accumulated profits using ProfitTracker
 * 3. Withdraw profits from each exchange
 * 4. Send USDC to KeeperStrategyManager contract
 * 5. Track harvest history for diagnostics
 */
@Injectable()
export class RewardHarvester implements OnModuleInit {
  private readonly logger = new Logger(RewardHarvester.name);
  
  private wallet: Wallet | null = null;
  private provider: JsonRpcProvider | null = null;
  private strategyContract: Contract | null = null;
  private usdcContract: Contract | null = null;
  
  // Harvest history (last 30 entries)
  private readonly harvestHistory: HarvestHistoryEntry[] = [];
  private readonly MAX_HISTORY = 30;
  
  // Last harvest info
  private lastHarvestResult: HarvestResult | null = null;

  // Contract ABI for strategy
  private readonly STRATEGY_ABI = [
    'function getIdleBalance() external view returns (uint256)',
    'function deployedCapital() external view returns (uint256)',
    'function lastReportedNAV() external view returns (uint256)',
  ];

  // ERC20 ABI for USDC transfers
  private readonly ERC20_ABI = [
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function balanceOf(address account) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
  ];

  // Configuration
  private readonly strategyAddress: string;
  private readonly usdcAddress: string;
  private readonly rpcUrl: string;
  private readonly minHarvestAmountUsd: number;
  private readonly harvestIntervalHours: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(forwardRef(() => PerpKeeperService))
    private readonly keeperService?: PerpKeeperService,
    @Optional() private readonly profitTracker?: ProfitTracker,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
  ) {
    this.strategyAddress = this.configService.get<string>('KEEPER_STRATEGY_ADDRESS', '');
    this.usdcAddress = this.configService.get<string>(
      'USDC_ADDRESS',
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum native USDC
    );
    this.rpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc');
    this.minHarvestAmountUsd = this.configService.get<number>('MIN_HARVEST_AMOUNT_USD', 10);
    this.harvestIntervalHours = this.configService.get<number>('HARVEST_INTERVAL_HOURS', 24);
  }

  async onModuleInit() {
    if (!this.strategyAddress) {
      this.logger.warn('KEEPER_STRATEGY_ADDRESS not configured, RewardHarvester disabled');
      return;
    }

    await this.initialize();
  }

  /**
   * Initialize wallet and contracts
   */
  private async initialize(): Promise<void> {
    const privateKey = this.configService.get<string>('KEEPER_PRIVATE_KEY');
    
    if (!privateKey) {
      this.logger.warn('KEEPER_PRIVATE_KEY not configured, cannot send rewards');
      return;
    }

    try {
      this.provider = new JsonRpcProvider(this.rpcUrl);
      this.wallet = new Wallet(privateKey, this.provider);
      this.strategyContract = new Contract(this.strategyAddress, this.STRATEGY_ABI, this.provider);
      this.usdcContract = new Contract(this.usdcAddress, this.ERC20_ABI, this.wallet);

      this.logger.log(
        `RewardHarvester initialized - Strategy: ${this.strategyAddress}, ` +
        `Keeper: ${this.wallet.address}, Min harvest: $${this.minHarvestAmountUsd}`,
      );
      
      // Initial diagnostics update
      await this.updateDiagnostics();
    } catch (error: any) {
      this.logger.error(`Failed to initialize RewardHarvester: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGNOSTICS UPDATE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update diagnostics service with current rewards data
   * Runs every 5 minutes to keep diagnostics fresh
   */
  @Interval(300000) // Every 5 minutes
  async updateDiagnostics(): Promise<void> {
    if (!this.diagnosticsService || !this.profitTracker) {
      return;
    }

    try {
      const profitSummary = await this.profitTracker.getProfitSummary();
      
      this.diagnosticsService.updateRewardsData({
        accruedProfits: profitSummary.totalAccruedProfit,
        lastHarvestTime: this.profitTracker.getLastHarvestTimestamp(),
        lastHarvestAmount: this.lastHarvestResult?.totalSentToVault || 0,
        nextHarvestIn: this.getTimeUntilNextHarvestFormatted(),
        totalHarvested: this.profitTracker.getTotalHarvestedAllTime(),
      });
    } catch (error: any) {
      this.logger.debug(`Failed to update diagnostics: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HARVEST CRON JOB
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Harvest rewards every 24 hours at midnight UTC
   */
  @Cron('0 0 * * *') // Midnight UTC daily
  async harvestRewards(): Promise<HarvestResult> {
    this.logger.log('═══════════════════════════════════════════════════════════════');
    this.logger.log('🌾 Starting scheduled reward harvest...');
    this.logger.log('═══════════════════════════════════════════════════════════════');

    return this.executeHarvest();
  }

  /**
   * Force an immediate harvest (bypasses schedule)
   */
  async forceHarvest(): Promise<HarvestResult> {
    this.logger.log('🌾 Force harvesting rewards...');
    return this.executeHarvest();
  }

  /**
   * Execute the harvest operation
   */
  private async executeHarvest(): Promise<HarvestResult> {
    const result: HarvestResult = {
      success: false,
      totalProfitsFound: 0,
      totalWithdrawn: 0,
      totalSentToVault: 0,
      byExchange: [],
      errors: [],
      timestamp: new Date(),
    };

    try {
      // Step 1: Calculate total profits
      if (!this.profitTracker) {
        result.errors.push('ProfitTracker not available');
        this.logger.warn('ProfitTracker not available, cannot calculate profits');
        return result;
      }

      const profitSummary = await this.profitTracker.getProfitSummary();
      result.totalProfitsFound = profitSummary.totalAccruedProfit;

      this.logger.log(`📊 Profit Summary:`);
      this.logger.log(`   Total Balance: $${profitSummary.totalBalance.toFixed(2)}`);
      this.logger.log(`   Deployed Capital: $${profitSummary.totalDeployedCapital.toFixed(2)}`);
      this.logger.log(`   Accrued Profits: $${profitSummary.totalAccruedProfit.toFixed(2)}`);

      // Check minimum threshold
      if (result.totalProfitsFound < this.minHarvestAmountUsd) {
        this.logger.log(
          `⏳ Profits ($${result.totalProfitsFound.toFixed(2)}) below minimum threshold ` +
          `($${this.minHarvestAmountUsd.toFixed(2)}). Skipping harvest.`,
        );
        result.success = true; // Not an error, just nothing to harvest
        this.lastHarvestResult = result;
        return result;
      }

      // Step 2: Withdraw profits from each exchange
      for (const [exchangeType, profitInfo] of profitSummary.byExchange) {
        if (profitInfo.accruedProfit < 1) {
          // Skip exchanges with less than $1 profit
          continue;
        }

        const exchangeResult = await this.withdrawFromExchange(
          exchangeType,
          profitInfo.accruedProfit,
        );
        result.byExchange.push(exchangeResult);

        if (exchangeResult.success) {
          result.totalWithdrawn += exchangeResult.amountWithdrawn;
        } else if (exchangeResult.error) {
          result.errors.push(`${exchangeType}: ${exchangeResult.error}`);
        }
      }

      // Step 3: Wait for funds to arrive on Arbitrum
      if (result.totalWithdrawn > 0) {
        this.logger.log(`⏳ Waiting for funds to arrive on Arbitrum...`);
        await this.waitForFundsToArrive(result.totalWithdrawn);
      }

      // Step 4: Send USDC to strategy contract
      if (result.totalWithdrawn > 0) {
        const sendResult = await this.sendToStrategy(result.totalWithdrawn);
        if (sendResult.success) {
          result.totalSentToVault = sendResult.amount;
          result.success = true;
          
          // Record harvest in ProfitTracker
          this.profitTracker.recordHarvest(result.totalSentToVault);
          
          this.logger.log(
            `✅ Harvest complete! Sent $${result.totalSentToVault.toFixed(2)} to vault.`,
          );
        } else {
          result.errors.push(`Failed to send to strategy: ${sendResult.error}`);
        }
      } else {
        result.success = true; // Nothing withdrawn, but no errors
        this.logger.log('ℹ️ No funds withdrawn from exchanges.');
      }

      // Record in history
      this.recordHarvestHistory(result);
      
    } catch (error: any) {
      result.errors.push(`Harvest failed: ${error.message}`);
      this.logger.error(`Harvest failed: ${error.message}`);
      
      // Record error in diagnostics
      if (this.diagnosticsService) {
        this.diagnosticsService.recordError({
          type: 'HARVEST_FAILED',
          message: error.message,
          timestamp: new Date(),
        });
      }
    }

    this.lastHarvestResult = result;
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WITHDRAWAL FROM EXCHANGES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Withdraw profits from a specific exchange
   */
  private async withdrawFromExchange(
    exchangeType: ExchangeType,
    amount: number,
  ): Promise<ExchangeHarvestResult> {
    const result: ExchangeHarvestResult = {
      exchange: exchangeType,
      success: false,
      amountWithdrawn: 0,
    };

    try {
      if (!this.keeperService) {
        throw new Error('KeeperService not available');
      }

      if (!this.wallet) {
        throw new Error('Wallet not initialized');
      }

      const adapter = this.keeperService.getExchangeAdapter(exchangeType);
      if (!adapter) {
        throw new Error(`Adapter not available for ${exchangeType}`);
      }

      // Check if adapter supports external withdrawals
      if (typeof (adapter as any).withdrawExternal !== 'function') {
        throw new Error(`${exchangeType} adapter does not support external withdrawals`);
      }

      this.logger.log(`📤 Withdrawing $${amount.toFixed(2)} from ${exchangeType}...`);

      // Withdraw to keeper's Arbitrum wallet
      const txHash = await (adapter as any).withdrawExternal(
        amount,
        'USDC',
        this.wallet.address,
      );

      result.success = true;
      result.amountWithdrawn = amount;
      
      this.logger.log(`✅ Withdrawal from ${exchangeType} successful: ${txHash}`);
      
    } catch (error: any) {
      result.error = error.message;
      this.logger.warn(`Failed to withdraw from ${exchangeType}: ${error.message}`);
    }

    return result;
  }

  /**
   * Wait for withdrawn funds to arrive on Arbitrum
   */
  private async waitForFundsToArrive(expectedAmount: number): Promise<void> {
    if (!this.usdcContract || !this.wallet) {
      return;
    }

    const maxWaitTime = 10 * 60 * 1000; // 10 minutes
    const checkInterval = 15 * 1000; // 15 seconds
    const startTime = Date.now();
    
    // Get initial balance
    const initialBalance = await this.usdcContract.balanceOf(this.wallet.address);
    const initialBalanceUsdc = Number(formatUnits(initialBalance, 6));
    
    this.logger.log(`Initial keeper balance: $${initialBalanceUsdc.toFixed(2)}`);
    
    // Wait for balance to increase
    while (Date.now() - startTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      
      const currentBalance = await this.usdcContract.balanceOf(this.wallet.address);
      const currentBalanceUsdc = Number(formatUnits(currentBalance, 6));
      const increase = currentBalanceUsdc - initialBalanceUsdc;
      
      this.logger.debug(
        `Balance check: $${currentBalanceUsdc.toFixed(2)} (increase: $${increase.toFixed(2)})`,
      );
      
      // Accept if we received at least 80% of expected (accounting for fees)
      if (increase >= expectedAmount * 0.8) {
        this.logger.log(
          `✅ Funds arrived: $${increase.toFixed(2)} (expected: $${expectedAmount.toFixed(2)})`,
        );
        return;
      }
    }
    
    this.logger.warn(
      `⚠️ Timeout waiting for funds. Expected: $${expectedAmount.toFixed(2)}`,
    );
  }

  /**
   * Send USDC to the strategy contract
   */
  private async sendToStrategy(amount: number): Promise<{ success: boolean; amount: number; error?: string }> {
    if (!this.usdcContract || !this.wallet || !this.strategyAddress) {
      return { success: false, amount: 0, error: 'Not initialized' };
    }

    try {
      // Get current keeper balance
      const balance = await this.usdcContract.balanceOf(this.wallet.address);
      const balanceUsdc = Number(formatUnits(balance, 6));
      
      // Send the lesser of available balance or expected amount
      const amountToSend = Math.min(amount, balanceUsdc);
      
      if (amountToSend < 1) {
        return { success: false, amount: 0, error: 'Insufficient balance to send' };
      }

      const amountWei = parseUnits(amountToSend.toFixed(6), 6);

      this.logger.log(`📤 Sending $${amountToSend.toFixed(2)} USDC to strategy contract...`);

      const tx = await this.usdcContract.transfer(this.strategyAddress, amountWei);
      const receipt = await tx.wait();

      this.logger.log(`✅ Transfer successful in block ${receipt.blockNumber}`);
      
      return { success: true, amount: amountToSend };
      
    } catch (error: any) {
      return { success: false, amount: 0, error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HISTORY & DIAGNOSTICS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record harvest in history
   */
  private recordHarvestHistory(result: HarvestResult): void {
    const byExchange = new Map<ExchangeType, number>();
    for (const er of result.byExchange) {
      if (er.success) {
        byExchange.set(er.exchange, er.amountWithdrawn);
      }
    }

    this.harvestHistory.push({
      timestamp: result.timestamp,
      totalAmount: result.totalSentToVault,
      byExchange,
      success: result.success,
    });

    // Keep only last N entries
    while (this.harvestHistory.length > this.MAX_HISTORY) {
      this.harvestHistory.shift();
    }
  }

  /**
   * Get last harvest result
   */
  getLastHarvestResult(): HarvestResult | null {
    return this.lastHarvestResult;
  }

  /**
   * Get harvest history
   */
  getHarvestHistory(): HarvestHistoryEntry[] {
    return [...this.harvestHistory];
  }

  /**
   * Get time until next scheduled harvest
   */
  getTimeUntilNextHarvest(): number {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setUTCHours(24, 0, 0, 0); // Next midnight UTC
    
    return nextMidnight.getTime() - now.getTime();
  }

  /**
   * Get time until next harvest in human readable format
   */
  getTimeUntilNextHarvestFormatted(): string {
    const ms = this.getTimeUntilNextHarvest();
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }

  /**
   * Check if harvester is configured and ready
   */
  isConfigured(): boolean {
    return this.wallet !== null && this.strategyContract !== null;
  }

  /**
   * Get diagnostic info for the /keeper/diagnostics endpoint
   */
  getDiagnosticInfo(): {
    accruedProfits: number;
    lastHarvestTime: Date | null;
    lastHarvestAmount: number;
    nextHarvestIn: string;
    totalHarvested: number;
  } {
    return {
      accruedProfits: this.lastHarvestResult?.totalProfitsFound || 0,
      lastHarvestTime: this.profitTracker?.getLastHarvestTimestamp() || null,
      lastHarvestAmount: this.lastHarvestResult?.totalSentToVault || 0,
      nextHarvestIn: this.getTimeUntilNextHarvestFormatted(),
      totalHarvested: this.profitTracker?.getTotalHarvestedAllTime() || 0,
    };
  }
}


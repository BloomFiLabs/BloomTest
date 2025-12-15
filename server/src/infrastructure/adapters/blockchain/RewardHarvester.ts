import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Contract, Wallet, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../../domain/ports/IPerpExchangeAdapter';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { RealFundingPaymentsService, CombinedFundingSummary } from '../../services/RealFundingPaymentsService';
import { HyperliquidExchangeAdapter } from '../hyperliquid/HyperliquidExchangeAdapter';
import { DiagnosticsService } from '../../services/DiagnosticsService';

/**
 * Harvest result tracking
 */
export interface HarvestResult {
  success: boolean;
  totalHarvested: number;
  byExchange: Map<ExchangeType, number>;
  sentToContract: number;
  timestamp: Date;
  error?: string;
}

/**
 * Harvest history entry
 */
interface HarvestHistoryEntry {
  timestamp: Date;
  totalHarvested: number;
  sentToContract: number;
  success: boolean;
}

/**
 * RewardHarvester - Sends accumulated profits back to the vault
 * 
 * Responsibilities:
 * 1. Calculate realized profits from funding payments
 * 2. Withdraw profits from exchanges (keeping operational buffer)
 * 3. Send USDC to KeeperStrategyManager contract on Arbitrum
 * 4. Run every 24 hours automatically
 */
@Injectable()
export class RewardHarvester implements OnModuleInit {
  private readonly logger = new Logger(RewardHarvester.name);
  
  private wallet: Wallet | null = null;
  private provider: JsonRpcProvider | null = null;
  private strategyContract: Contract | null = null;
  private usdcContract: Contract | null = null;
  
  // Last harvest tracking
  private lastHarvestTime: Date | null = null;
  private lastHarvestAmount: number = 0;
  
  // Harvest history (last 30 entries)
  private readonly harvestHistory: HarvestHistoryEntry[] = [];
  private readonly MAX_HISTORY = 30;
  
  // Configuration
  private readonly strategyAddress: string;
  private readonly usdcAddress: string;
  private readonly rpcUrl: string;
  
  // Operational buffer - keep this much on each exchange for operations
  private readonly OPERATIONAL_BUFFER_PER_EXCHANGE = 50; // $50 buffer per exchange
  
  // Minimum harvest amount - don't bother if less than this
  private readonly MIN_HARVEST_AMOUNT = 10; // $10 minimum
  
  // Contract ABI for USDC transfers
  private readonly ERC20_ABI = [
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function balanceOf(address account) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
  ];

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly fundingService?: RealFundingPaymentsService,
    @Optional() @Inject(forwardRef(() => HyperliquidExchangeAdapter)) 
    private readonly hyperliquidAdapter?: HyperliquidExchangeAdapter,
    @Optional() @Inject(forwardRef(() => PerpKeeperService))
    private readonly perpKeeperService?: PerpKeeperService,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
  ) {
    this.strategyAddress = this.configService.get<string>('KEEPER_STRATEGY_ADDRESS', '');
    this.usdcAddress = this.configService.get<string>(
      'USDC_ADDRESS',
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum native USDC
    );
    this.rpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc');
  }

  async onModuleInit() {
    if (!this.strategyAddress) {
      this.logger.warn('KEEPER_STRATEGY_ADDRESS not configured, reward harvester disabled');
      return;
    }

    await this.initialize();
  }

  /**
   * Initialize wallet and contract connections
   */
  private async initialize(): Promise<void> {
    const privateKey = this.configService.get<string>('KEEPER_PRIVATE_KEY') || 
                       this.configService.get<string>('PRIVATE_KEY');
    
    if (!privateKey) {
      this.logger.warn('KEEPER_PRIVATE_KEY/PRIVATE_KEY not configured, cannot harvest rewards');
      return;
    }

    try {
      this.provider = new JsonRpcProvider(this.rpcUrl);
      this.wallet = new Wallet(privateKey, this.provider);
      this.usdcContract = new Contract(this.usdcAddress, this.ERC20_ABI, this.wallet);

      this.logger.log(`RewardHarvester initialized - sending to ${this.strategyAddress}`);
    } catch (error: any) {
      this.logger.error(`Failed to initialize RewardHarvester: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULED HARVEST (Every 24 hours at midnight UTC)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Daily reward harvest - runs every 24 hours at midnight UTC
   */
  @Cron('0 0 * * *') // Every day at 00:00 UTC
  async harvestRewardsScheduled(): Promise<void> {
    this.logger.log('🌾 Starting scheduled reward harvest...');
    
    try {
      const result = await this.harvestAndSendRewards();
      
      if (result.success && result.sentToContract > 0) {
        this.logger.log(
          `✅ Harvest complete: $${result.sentToContract.toFixed(2)} sent to vault contract`,
        );
      } else if (result.success) {
        this.logger.log('✅ Harvest complete: No rewards to send (below minimum or insufficient profits)');
      } else {
        this.logger.warn(`⚠️ Harvest failed: ${result.error}`);
      }
    } catch (error: any) {
      this.logger.error(`❌ Harvest error: ${error.message}`);
      this.recordDiagnosticError('HARVEST_FAILED', error.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN HARVEST LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Main harvest function - calculates profits, withdraws from exchanges, sends to contract
   */
  async harvestAndSendRewards(): Promise<HarvestResult> {
    const result: HarvestResult = {
      success: false,
      totalHarvested: 0,
      byExchange: new Map(),
      sentToContract: 0,
      timestamp: new Date(),
    };

    if (!this.wallet || !this.usdcContract) {
      result.error = 'RewardHarvester not initialized';
      return result;
    }

    if (!this.strategyAddress) {
      result.error = 'No strategy address configured';
      return result;
    }

    try {
      // 1. Calculate available profits
      const profitsAvailable = await this.calculateHarvestableAmount();
      
      this.logger.log(`📊 Harvestable profits: $${profitsAvailable.total.toFixed(2)}`);
      
      if (profitsAvailable.total < this.MIN_HARVEST_AMOUNT) {
        this.logger.log(
          `⏭️ Skipping harvest: $${profitsAvailable.total.toFixed(2)} below minimum ($${this.MIN_HARVEST_AMOUNT})`,
        );
        result.success = true;
        return result;
      }

      // 2. Withdraw from exchanges
      let totalWithdrawn = 0;
      
      for (const [exchange, amount] of profitsAvailable.byExchange) {
        if (amount <= 0) continue;
        
        const withdrawn = await this.withdrawFromExchange(exchange, amount);
        if (withdrawn > 0) {
          totalWithdrawn += withdrawn;
          result.byExchange.set(exchange, withdrawn);
        }
      }

      result.totalHarvested = totalWithdrawn;
      
      if (totalWithdrawn < this.MIN_HARVEST_AMOUNT) {
        this.logger.log(
          `⏭️ Insufficient withdrawn: $${totalWithdrawn.toFixed(2)} below minimum`,
        );
        result.success = true;
        return result;
      }

      // 3. Wait for funds to arrive on Arbitrum
      await this.waitForFundsOnArbitrum(totalWithdrawn);

      // 4. Send to strategy contract
      const sent = await this.sendToStrategyContract(totalWithdrawn);
      result.sentToContract = sent;
      
      if (sent > 0) {
        this.lastHarvestTime = new Date();
        this.lastHarvestAmount = sent;
        
        // Record in history
        this.harvestHistory.push({
          timestamp: new Date(),
          totalHarvested: totalWithdrawn,
          sentToContract: sent,
          success: true,
        });
        if (this.harvestHistory.length > this.MAX_HISTORY) {
          this.harvestHistory.shift();
        }
        
        result.success = true;
        this.logger.log(`✅ Sent $${sent.toFixed(2)} to strategy contract at ${this.strategyAddress}`);
      } else {
        result.error = 'Failed to send funds to strategy contract';
      }

      return result;
    } catch (error: any) {
      result.error = error.message;
      this.recordDiagnosticError('HARVEST_ERROR', error.message);
      return result;
    }
  }

  /**
   * Calculate harvestable amount across all exchanges
   * Returns amount above operational buffer that can be harvested
   */
  async calculateHarvestableAmount(): Promise<{ total: number; byExchange: Map<ExchangeType, number> }> {
    const byExchange = new Map<ExchangeType, number>();
    let total = 0;

    const exchanges = [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER];

    for (const exchangeType of exchanges) {
      try {
        const adapter = await this.getAdapterForExchange(exchangeType);
        if (!adapter) continue;

        const balance = await adapter.getBalance();
        const positions = await adapter.getPositions();
        
        // Calculate margin used by positions
        const marginUsed = positions.reduce((sum, pos) => {
          return sum + (pos.marginUsed ?? (pos.getPositionValue() / 2)); // Assume 2x leverage if not specified
        }, 0);

        // Harvestable = balance - margin - operational buffer
        const harvestable = Math.max(0, balance - marginUsed - this.OPERATIONAL_BUFFER_PER_EXCHANGE);
        
        byExchange.set(exchangeType, harvestable);
        total += harvestable;

        this.logger.debug(
          `${exchangeType}: Balance=$${balance.toFixed(2)}, Margin=$${marginUsed.toFixed(2)}, ` +
          `Harvestable=$${harvestable.toFixed(2)}`,
        );
      } catch (error: any) {
        this.logger.warn(`Failed to calculate harvestable for ${exchangeType}: ${error.message}`);
      }
    }

    return { total, byExchange };
  }

  /**
   * Get adapter for a specific exchange
   */
  private async getAdapterForExchange(exchangeType: ExchangeType): Promise<IPerpExchangeAdapter | null> {
    if (this.perpKeeperService) {
      try {
        const adapter = this.perpKeeperService.getExchangeAdapter(exchangeType);
        if (adapter) return adapter;
      } catch {
        // getExchangeAdapter throws if not found
      }
    }
    
    if (exchangeType === ExchangeType.HYPERLIQUID && this.hyperliquidAdapter) {
      return this.hyperliquidAdapter;
    }
    
    return null;
  }

  /**
   * Withdraw USDC from an exchange to Arbitrum
   */
  private async withdrawFromExchange(exchangeType: ExchangeType, maxAmount: number): Promise<number> {
    const adapter = await this.getAdapterForExchange(exchangeType);
    if (!adapter) {
      this.logger.warn(`No adapter for ${exchangeType}, cannot withdraw`);
      return 0;
    }
    
    try {
      const keeperAddress = this.wallet?.address;
      if (!keeperAddress) {
        this.logger.warn('No keeper address available for withdrawal');
        return 0;
      }

      // Use the smaller of maxAmount or available balance
      const availableBalance = await adapter.getBalance();
      const withdrawAmount = Math.min(maxAmount, availableBalance - this.OPERATIONAL_BUFFER_PER_EXCHANGE);
      
      if (withdrawAmount <= 1) {
        return 0;
      }
      
      this.logger.log(`📤 Withdrawing $${withdrawAmount.toFixed(2)} from ${exchangeType}...`);
      
      // Different exchanges have different withdrawal methods
      if (exchangeType === ExchangeType.HYPERLIQUID && this.hyperliquidAdapter) {
        await this.hyperliquidAdapter.withdrawExternal(withdrawAmount, 'USDC', keeperAddress);
      } else if ('withdrawExternal' in adapter) {
        await (adapter as any).withdrawExternal(withdrawAmount, 'USDC', keeperAddress);
      } else {
        this.logger.warn(`${exchangeType} does not support external withdrawals`);
        return 0;
      }
      
      return withdrawAmount;
    } catch (error: any) {
      this.logger.error(`Failed to withdraw from ${exchangeType}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Wait for funds to arrive on Arbitrum
   */
  private async waitForFundsOnArbitrum(expectedAmount: number): Promise<void> {
    if (!this.wallet || !this.usdcContract) return;

    const startBalance = await this.getKeeperUsdcBalance();
    const targetBalance = startBalance + parseUnits(expectedAmount.toFixed(6), 6);
    
    const maxWait = 300000; // 5 minutes
    const startTime = Date.now();
    
    this.logger.log(`⏳ Waiting for funds on Arbitrum (expecting ~$${expectedAmount.toFixed(2)})...`);
    
    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 15000)); // Check every 15 seconds
      
      const currentBalance = await this.getKeeperUsdcBalance();
      if (currentBalance >= targetBalance * 95n / 100n) { // 95% threshold
        const received = Number(formatUnits(currentBalance - startBalance, 6));
        this.logger.log(`✅ Received $${received.toFixed(2)} on Arbitrum`);
        return;
      }
      
      this.logger.debug(`Waiting for funds... (${Math.floor((Date.now() - startTime) / 1000)}s)`);
    }
    
    this.logger.warn('⚠️ Timeout waiting for funds, proceeding with available balance');
  }

  /**
   * Get keeper wallet USDC balance on Arbitrum
   */
  private async getKeeperUsdcBalance(): Promise<bigint> {
    if (!this.usdcContract || !this.wallet) return 0n;
    
    try {
      return await this.usdcContract.balanceOf(this.wallet.address);
    } catch {
      return 0n;
    }
  }

  /**
   * Send USDC to the KeeperStrategyManager contract
   */
  private async sendToStrategyContract(amount: number): Promise<number> {
    if (!this.wallet || !this.usdcContract) {
      this.logger.warn('Wallet or USDC contract not initialized');
      return 0;
    }

    try {
      const balance = await this.getKeeperUsdcBalance();
      const amountToSend = parseUnits(amount.toFixed(6), 6);
      
      // Use the smaller of requested amount or available balance
      const actualAmount = amountToSend > balance ? balance : amountToSend;
      
      if (actualAmount <= 0n) {
        this.logger.warn('No USDC available to send');
        return 0;
      }

      this.logger.log(`💸 Sending $${formatUnits(actualAmount, 6)} to strategy contract...`);
      
      const tx = await this.usdcContract.transfer(this.strategyAddress, actualAmount);
      this.logger.debug(`Transfer tx: ${tx.hash}`);
      
      const receipt = await tx.wait();
      this.logger.log(`✅ Transfer confirmed in block ${receipt.blockNumber}`);
      
      return Number(formatUnits(actualAmount, 6));
    } catch (error: any) {
      this.logger.error(`Failed to send to strategy contract: ${error.message}`);
      this.recordDiagnosticError('TRANSFER_FAILED', error.message);
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGNOSTICS INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  private recordDiagnosticError(type: string, message: string): void {
    if (this.diagnosticsService) {
      this.diagnosticsService.recordError({
        type,
        message,
        timestamp: new Date(),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC GETTERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get last harvest info
   */
  getLastHarvest(): { time: Date | null; amount: number } {
    return {
      time: this.lastHarvestTime,
      amount: this.lastHarvestAmount,
    };
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
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(0, 0, 0, 0);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    
    return tomorrow.getTime() - now.getTime();
  }

  /**
   * Force an immediate harvest (for testing/manual triggering)
   */
  async forceHarvest(): Promise<HarvestResult> {
    this.logger.log('🌾 Force harvesting rewards...');
    return this.harvestAndSendRewards();
  }

  /**
   * Check if harvest is enabled (all required config present)
   */
  isEnabled(): boolean {
    return !!(this.wallet && this.strategyAddress && this.usdcContract);
  }

  /**
   * Get current harvestable amount without actually harvesting
   */
  async getHarvestableAmount(): Promise<number> {
    const result = await this.calculateHarvestableAmount();
    return result.total;
  }
}

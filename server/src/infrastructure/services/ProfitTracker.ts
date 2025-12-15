import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Contract, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';

/**
 * Profit tracking result for an exchange
 */
export interface ExchangeProfitInfo {
  exchange: ExchangeType;
  currentBalance: number;
  deployedCapital: number;
  accruedProfit: number;
  deployableCapital: number;
}

/**
 * Overall profit summary
 */
export interface ProfitSummary {
  totalBalance: number;
  totalDeployedCapital: number;
  totalAccruedProfit: number;
  byExchange: Map<ExchangeType, ExchangeProfitInfo>;
  lastSyncTimestamp: Date | null;
  lastHarvestTimestamp: Date | null;
  totalHarvestedAllTime: number;
}

/**
 * ProfitTracker - Tracks deployed capital and calculates per-exchange profits
 * 
 * Responsibilities:
 * 1. Sync deployedCapital from KeeperStrategyManager contract
 * 2. Calculate per-exchange deployed capital proportionally
 * 3. Provide deployable capital (excluding accrued profits) for position sizing
 * 4. Track harvest history
 */
@Injectable()
export class ProfitTracker implements OnModuleInit {
  private readonly logger = new Logger(ProfitTracker.name);
  
  private provider: JsonRpcProvider | null = null;
  private contract: Contract | null = null;
  
  // Deployed capital from contract (in USDC with 6 decimals)
  private deployedCapital: bigint = 0n;
  
  // Last sync timestamp
  private lastSyncTimestamp: Date | null = null;
  
  // Last harvest timestamp
  private lastHarvestTimestamp: Date | null = null;
  
  // Total harvested all time (for diagnostics)
  private totalHarvestedAllTime: number = 0;
  
  // Cache of exchange balances (refreshed on sync)
  private exchangeBalances: Map<ExchangeType, number> = new Map();

  // Contract ABI for reading deployed capital
  private readonly CONTRACT_ABI = [
    'function deployedCapital() external view returns (uint256)',
    'function lastReportedNAV() external view returns (uint256)',
    'function getStrategySummary() external view returns (uint256 deployedCapital, uint256 lastReportedNAV, uint256 pendingWithdrawals, uint256 idleBalance, int256 pnl)',
  ];

  private readonly strategyAddress: string;
  private readonly rpcUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(forwardRef(() => PerpKeeperService))
    private readonly keeperService?: PerpKeeperService,
  ) {
    this.strategyAddress = this.configService.get<string>('KEEPER_STRATEGY_ADDRESS', '');
    this.rpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc');
  }

  async onModuleInit() {
    if (!this.strategyAddress) {
      this.logger.warn('KEEPER_STRATEGY_ADDRESS not configured, ProfitTracker running in standalone mode');
      return;
    }

    await this.initialize();
    await this.syncFromContract();
  }

  /**
   * Initialize provider and contract
   */
  private async initialize(): Promise<void> {
    try {
      this.provider = new JsonRpcProvider(this.rpcUrl);
      this.contract = new Contract(this.strategyAddress, this.CONTRACT_ABI, this.provider);
      this.logger.log(`ProfitTracker initialized for ${this.strategyAddress}`);
    } catch (error: any) {
      this.logger.error(`Failed to initialize ProfitTracker: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC FROM CONTRACT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync deployedCapital from contract
   * Called on startup and every hour
   */
  @Interval(3600000) // Every hour
  async syncFromContract(): Promise<void> {
    if (!this.contract) {
      this.logger.debug('Contract not initialized, skipping sync');
      return;
    }

    try {
      // Get deployed capital from contract
      const [deployedCapital, lastReportedNAV, pendingWithdrawals, idleBalance, pnl] = 
        await this.contract.getStrategySummary();
      
      this.deployedCapital = deployedCapital;
      this.lastSyncTimestamp = new Date();

      this.logger.log(
        `Synced from contract: deployedCapital=${formatUnits(deployedCapital, 6)} USDC, ` +
        `NAV=${formatUnits(lastReportedNAV, 6)} USDC, PnL=${formatUnits(pnl, 6)} USDC`,
      );

      // Also refresh exchange balances
      await this.refreshExchangeBalances();
    } catch (error: any) {
      this.logger.warn(`Failed to sync from contract: ${error.message}`);
    }
  }

  /**
   * Refresh exchange balances
   */
  private async refreshExchangeBalances(): Promise<void> {
    if (!this.keeperService) {
      return;
    }

    const exchanges = [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER];
    
    for (const exchangeType of exchanges) {
      try {
        const balance = await this.keeperService.getBalance(exchangeType);
        this.exchangeBalances.set(exchangeType, balance);
      } catch (error: any) {
        this.logger.debug(`Failed to get balance for ${exchangeType}: ${error.message}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROFIT CALCULATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get total balance across all exchanges
   */
  async getTotalBalance(): Promise<number> {
    await this.refreshExchangeBalances();
    
    let total = 0;
    for (const balance of this.exchangeBalances.values()) {
      total += balance;
    }
    return total;
  }

  /**
   * Get deployed capital as number (USDC)
   */
  getDeployedCapitalAmount(): number {
    return Number(formatUnits(this.deployedCapital, 6));
  }

  /**
   * Calculate total accrued profits across all exchanges
   * Profits = TotalExchangeBalance - DeployedCapital
   */
  async getTotalProfits(): Promise<number> {
    const totalBalance = await this.getTotalBalance();
    const deployedCapital = this.getDeployedCapitalAmount();
    
    // Profits can't be negative (if balance < deployed, we have losses, not profits)
    return Math.max(0, totalBalance - deployedCapital);
  }

  /**
   * Get accrued profits for a specific exchange
   * Distributed proportionally based on current balance
   */
  async getAccruedProfits(exchangeType: ExchangeType): Promise<number> {
    const totalProfits = await this.getTotalProfits();
    
    if (totalProfits <= 0) {
      return 0;
    }

    const totalBalance = await this.getTotalBalance();
    if (totalBalance <= 0) {
      return 0;
    }

    // Get this exchange's balance
    const exchangeBalance = this.exchangeBalances.get(exchangeType) || 0;
    if (exchangeBalance <= 0) {
      return 0;
    }

    // Distribute profits proportionally based on balance
    const proportion = exchangeBalance / totalBalance;
    return totalProfits * proportion;
  }

  /**
   * Get deployable capital for a specific exchange
   * This is the amount that can be used for position sizing (excludes profits)
   */
  async getDeployableCapital(exchangeType: ExchangeType): Promise<number> {
    // Refresh balance for this exchange
    if (this.keeperService) {
      try {
        const balance = await this.keeperService.getBalance(exchangeType);
        this.exchangeBalances.set(exchangeType, balance);
      } catch (error: any) {
        this.logger.debug(`Failed to refresh balance for ${exchangeType}: ${error.message}`);
      }
    }

    const exchangeBalance = this.exchangeBalances.get(exchangeType) || 0;
    const accruedProfits = await this.getAccruedProfits(exchangeType);
    
    // Deployable = Balance - Accrued Profits
    return Math.max(0, exchangeBalance - accruedProfits);
  }

  /**
   * Get profit info for a specific exchange
   */
  async getExchangeProfitInfo(exchangeType: ExchangeType): Promise<ExchangeProfitInfo> {
    const totalBalance = await this.getTotalBalance();
    const deployedCapitalTotal = this.getDeployedCapitalAmount();
    
    // Get this exchange's balance
    const currentBalance = this.exchangeBalances.get(exchangeType) || 0;
    
    // Calculate per-exchange deployed capital (proportional)
    const proportion = totalBalance > 0 ? currentBalance / totalBalance : 0;
    const deployedCapital = deployedCapitalTotal * proportion;
    
    // Calculate profits and deployable
    const accruedProfit = Math.max(0, currentBalance - deployedCapital);
    const deployableCapital = currentBalance - accruedProfit;

    return {
      exchange: exchangeType,
      currentBalance,
      deployedCapital,
      accruedProfit,
      deployableCapital,
    };
  }

  /**
   * Get full profit summary
   */
  async getProfitSummary(): Promise<ProfitSummary> {
    await this.refreshExchangeBalances();
    
    const totalBalance = await this.getTotalBalance();
    const totalDeployedCapital = this.getDeployedCapitalAmount();
    const totalAccruedProfit = await this.getTotalProfits();
    
    const byExchange = new Map<ExchangeType, ExchangeProfitInfo>();
    
    for (const exchangeType of [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER]) {
      const info = await this.getExchangeProfitInfo(exchangeType);
      byExchange.set(exchangeType, info);
    }

    return {
      totalBalance,
      totalDeployedCapital,
      totalAccruedProfit,
      byExchange,
      lastSyncTimestamp: this.lastSyncTimestamp,
      lastHarvestTimestamp: this.lastHarvestTimestamp,
      totalHarvestedAllTime: this.totalHarvestedAllTime,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HARVEST TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a successful harvest
   * Called by RewardHarvester after sending profits to vault
   */
  recordHarvest(amount: number): void {
    this.lastHarvestTimestamp = new Date();
    this.totalHarvestedAllTime += amount;
    
    this.logger.log(
      `Recorded harvest: $${amount.toFixed(2)} (total harvested: $${this.totalHarvestedAllTime.toFixed(2)})`,
    );
  }

  /**
   * Get last harvest timestamp
   */
  getLastHarvestTimestamp(): Date | null {
    return this.lastHarvestTimestamp;
  }

  /**
   * Get total harvested all time
   */
  getTotalHarvestedAllTime(): number {
    return this.totalHarvestedAllTime;
  }

  /**
   * Get time since last harvest in hours
   */
  getHoursSinceLastHarvest(): number | null {
    if (!this.lastHarvestTimestamp) {
      return null;
    }
    
    const now = Date.now();
    const lastHarvest = this.lastHarvestTimestamp.getTime();
    return (now - lastHarvest) / (1000 * 60 * 60);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC GETTERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if contract is configured and connected
   */
  isConfigured(): boolean {
    return this.contract !== null;
  }

  /**
   * Get last sync timestamp
   */
  getLastSyncTimestamp(): Date | null {
    return this.lastSyncTimestamp;
  }

  /**
   * Force a sync from contract
   */
  async forceSync(): Promise<void> {
    await this.syncFromContract();
  }
}


import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  Contract,
  Wallet,
  JsonRpcProvider,
  formatUnits,
  parseUnits,
} from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { BloomGraphAdapter } from '../graph/BloomGraphAdapter';
import { NAVReporter } from './NAVReporter';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  OrderSide,
  OrderType,
  PerpOrderRequest,
} from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter } from '../../../domain/ports/IPerpExchangeAdapter';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { HyperliquidExchangeAdapter } from '../hyperliquid/HyperliquidExchangeAdapter';

/**
 * Delta-neutral position pair for unwinding
 */
interface DeltaNeutralPair {
  symbol: string;
  longPosition: PerpPosition;
  shortPosition: PerpPosition;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  combinedPnl: number;
  totalValue: number;
  // The smaller of the two sides (determines max we can reduce while staying delta-neutral)
  maxDeltaNeutralSize: number;
}

/**
 * Result of reducing a position
 */
interface PositionReductionResult {
  success: boolean;
  reducedSize: number;
  freedValue: number;
  error?: string;
}

/**
 * WithdrawalFulfiller - Handles withdrawal requests via direct transfers from the keeper wallet.
 *
 * Responsibilities:
 * 1. Query pending withdrawal requests from Bloom Subgraph.
 * 2. Calculate daily share price at 23:30 UTC.
 * 3. Coordinate position unwinding if liquidity is insufficient.
 * 4. Transfer USDC directly to users' wallets.
 */
@Injectable()
export class WithdrawalFulfiller implements OnModuleInit {
  private readonly logger = new Logger(WithdrawalFulfiller.name);

  private wallet: Wallet | null = null;
  private provider: JsonRpcProvider | null = null;
  private contract: Contract | null = null;

  // Contract ABI for fulfillment and capital management
  private readonly CONTRACT_ABI = [
    'function fulfillWithdrawal(uint256 requestId) external',
    'function fulfillWithdrawalBatch(uint256[] calldata requestIds) external',
    'function getWithdrawalRequest(uint256 requestId) external view returns (tuple(uint256 id, uint256 amount, uint256 requestedAt, uint256 deadline, bool fulfilled, bool cancelled))',
    'function withdrawToKeeper(uint256 amount) external',
    'function getIdleBalance() external view returns (uint256)',
    'function pendingWithdrawals() external view returns (uint256)',
  ];

  // USDC contract ABI for transfers
  private readonly ERC20_ABI = [
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function balanceOf(address account) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
  ];

  private readonly strategyAddress: string;
  private readonly usdcAddress: string;
  private readonly rpcUrl: string;
  private readonly vaultAddress: string;

  // Vault contract ABI for getting total supply
  private readonly VAULT_ABI = [
    'function totalSupply() external view returns (uint256)',
  ];

  private vaultContract: Contract | null = null;
  private readonly processedLogPath = path.join(
    process.cwd(),
    'processed_withdrawals.json',
  );

  constructor(
    private readonly configService: ConfigService,
    private readonly bloomGraphAdapter: BloomGraphAdapter,
    @Optional()
    @Inject(forwardRef(() => NAVReporter))
    private readonly navReporter?: NAVReporter,
    @Optional()
    @Inject(forwardRef(() => HyperliquidExchangeAdapter))
    private readonly hyperliquidAdapter?: HyperliquidExchangeAdapter,
    @Optional()
    @Inject(forwardRef(() => PerpKeeperService))
    private readonly perpKeeperService?: PerpKeeperService,
  ) {
    this.strategyAddress = this.configService.get<string>(
      'KEEPER_STRATEGY_ADDRESS',
      '',
    );
    this.vaultAddress = this.configService.get<string>(
      'BLOOM_VAULT_ADDRESS',
      '',
    );
    this.usdcAddress = this.configService.get<string>(
      'USDC_ADDRESS',
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    ); // Arbitrum native USDC
    this.rpcUrl = this.configService.get<string>(
      'ARBITRUM_RPC_URL',
      'https://arb1.arbitrum.io/rpc',
    );
  }

  async onModuleInit() {
    if (!this.strategyAddress) {
      this.logger.warn(
        'KEEPER_STRATEGY_ADDRESS not configured, withdrawal fulfiller disabled',
      );
      return;
    }

    await this.initialize();
  }

  /**
   * Initialize wallet and contract connections
   */
  private async initialize(): Promise<void> {
    const privateKey =
      this.configService.get<string>('KEEPER_PRIVATE_KEY') ||
      this.configService.get<string>('PRIVATE_KEY');

    if (!privateKey) {
      this.logger.warn(
        'KEEPER_PRIVATE_KEY/PRIVATE_KEY not configured, cannot fulfill withdrawals',
      );
      return;
    }

    try {
      this.provider = new JsonRpcProvider(this.rpcUrl);
      this.wallet = new Wallet(privateKey, this.provider);
      this.contract = new Contract(
        this.strategyAddress,
        this.CONTRACT_ABI,
        this.wallet,
      );

      // Initialize vault contract if address is configured
      if (this.vaultAddress) {
        this.vaultContract = new Contract(
          this.vaultAddress,
          this.VAULT_ABI,
          this.wallet,
        );
      }

      this.logger.log(
        `WithdrawalFulfiller initialized (Daily Direct Transfer Mode)`,
      );
      this.logger.log(
        `Vault address: ${this.vaultAddress || 'not configured'}`,
      );
      this.logger.log(`Keeper address: ${this.wallet.address}`);
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Get list of processed withdrawal IDs from local log
   */
  private getProcessedIds(): string[] {
    if (!fs.existsSync(this.processedLogPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.processedLogPath, 'utf8'));
    } catch (error) {
      this.logger.error(`Failed to read processed log: ${error.message}`);
      return [];
    }
  }

  /**
   * Mark a withdrawal ID as processed in the local log
   */
  private markIdAsProcessed(id: string): void {
    try {
      const ids = this.getProcessedIds();
      if (!ids.includes(id)) {
        ids.push(id);
        fs.writeFileSync(this.processedLogPath, JSON.stringify(ids, null, 2));
      }
    } catch (error) {
      this.logger.error(`Failed to mark ID as processed: ${error.message}`);
    }
  }

  /**
   * Daily withdrawal processing at 23:30 UTC
   */
  @Cron('30 23 * * *')
  async processDailyWithdrawals(): Promise<void> {
    this.logger.log('Starting daily withdrawal processing (23:30 UTC)...');

    try {
      // 0. Safety: Check Native Gas Balance (ETH/ARB)
      const nativeBalance = await this.provider!.getBalance(
        this.wallet!.address,
      );
      if (nativeBalance < parseUnits('0.005', 18)) {
        this.logger.error(
          `CRITICAL: Insufficient native gas balance (${formatUnits(nativeBalance, 18)}). Minimum 0.005 required.`,
        );
        return;
      }

      // 1. Fetch pending requests from subgraph
      const allRequests = await this.bloomGraphAdapter.getPendingWithdrawals();
      const processedIds = this.getProcessedIds();

      // Filter out already processed requests
      const pendingRequests = allRequests.filter(
        (req) => !processedIds.includes(req.id),
      );

      if (pendingRequests.length === 0) {
        this.logger.log('No NEW pending withdrawal requests found.');
        return;
      }

      this.logger.log(`Found ${pendingRequests.length} NEW pending requests.`);

      // 2. Calculate share price (NAV / TotalSupply)
      const sharePrice = await this.calculateSharePrice();
      this.logger.log(`Current share price: ${sharePrice.toFixed(6)} USDC`);

      // 3. Calculate total USDC needed
      let totalUsdcNeeded = 0n;
      const requestsWithAmount = pendingRequests.map((req) => {
        // Assume sharesEscrow is 18 decimals, sharePrice is USDC per share
        const shares = parseUnits(req.sharesEscrow, 18);
        const amountUsdc =
          (BigInt(shares) * BigInt(Math.floor(sharePrice * 1000000))) /
          10n ** 18n;
        totalUsdcNeeded += amountUsdc;
        return { ...req, amountUsdc };
      });

      this.logger.log(
        `Total USDC needed: ${formatUnits(totalUsdcNeeded, 6)} USDC`,
      );

      // 4. Check wallet balance and unwind if needed
      let currentBalance = await this.getKeeperUsdcBalance();
      if (currentBalance < totalUsdcNeeded) {
        const shortfall = totalUsdcNeeded - currentBalance;
        this.logger.log(
          `Shortfall of ${formatUnits(shortfall, 6)} USDC. Unwinding positions...`,
        );
        await this.unwindPositionsForWithdrawal(shortfall);
        currentBalance = await this.getKeeperUsdcBalance();
      }

      if (currentBalance < totalUsdcNeeded) {
        this.logger.error(
          `Still insufficient funds after unwinding. Have: ${formatUnits(currentBalance, 6)}, Need: ${formatUnits(totalUsdcNeeded, 6)}`,
        );
      }

      // 5. Transfer USDC directly to owners
      for (const req of requestsWithAmount) {
        if (currentBalance < req.amountUsdc) {
          this.logger.error(
            `Insufficient balance to fulfill request ${req.id} for ${req.owner}`,
          );
          continue;
        }

        this.logger.log(
          `Transferring ${formatUnits(req.amountUsdc, 6)} USDC to ${req.owner}...`,
        );
        try {
          const usdc = new Contract(
            this.usdcAddress,
            this.ERC20_ABI,
            this.wallet!,
          );
          const tx = await usdc.transfer(req.owner, req.amountUsdc);
          this.logger.log(`Transfer sent for ${req.id}. Hash: ${tx.hash}`);

          // Mark as processed BEFORE wait to ensure we don't double-spend on crash during wait
          this.markIdAsProcessed(req.id);

          await tx.wait();
          this.logger.log(`✅ Successfully fulfilled request ${req.id}`);
          currentBalance -= req.amountUsdc;
        } catch (error: any) {
          this.logger.error(
            `Failed to transfer to ${req.owner} for request ${req.id}: ${error.message}`,
          );
        }
      }

      this.logger.log('Daily withdrawal processing complete.');
    } catch (error: any) {
      this.logger.error(
        `Error in daily withdrawal processing: ${error.message}`,
      );
    }
  }

  /**
   * Calculate share price = Total NAV / Total Supply
   */
  private async calculateSharePrice(): Promise<number> {
    if (!this.navReporter || !this.vaultContract) {
      this.logger.warn('NAVReporter or VaultContract not available');
      return 1.0; // Fallback
    }

    try {
      const navCalc = await this.navReporter.calculateNAV();
      const totalSupply: bigint = await this.vaultContract.totalSupply();

      if (totalSupply === 0n) return 1.0;

      // NAV is 6 decimals (USDC), TotalSupply is 18 decimals (Shares)
      // SharePrice = (NAV * 10^18) / TotalSupply
      const price =
        (BigInt(navCalc.totalEquity) * 10n ** 18n) / BigInt(totalSupply);
      return Number(formatUnits(price, 6));
    } catch (error: any) {
      this.logger.error(`Failed to calculate share price: ${error.message}`);
      return 1.0;
    }
  }

  /**
   * Unwind positions to free up USDC for withdrawal
   */
  private async unwindPositionsForWithdrawal(
    amountNeeded: bigint,
  ): Promise<bigint> {
    let totalFreed = 0n;
    const amountNeededNum = Number(formatUnits(amountNeeded, 6));

    this.logger.log(`\n${'═'.repeat(60)}`);
    this.logger.log(
      `🔄 DELTA-NEUTRAL UNWINDING: Need $${amountNeededNum.toFixed(2)} USDC`,
    );
    this.logger.log(`${'═'.repeat(60)}\n`);

    const allPositions = await this.getAllPositionsFromAllExchanges();

    if (allPositions.length === 0) {
      this.logger.log('No positions found across any exchange');
      return totalFreed;
    }

    const positionsBySymbol = this.groupPositionsBySymbol(allPositions);
    const deltaNeutralPairs = this.identifyDeltaNeutralPairs(positionsBySymbol);

    deltaNeutralPairs.sort((a, b) => a.combinedPnl - b.combinedPnl);

    const exchangesWithFreedCapital = new Set<ExchangeType>();
    let freedFromClosing = 0;
    const remainingNeeded = () => amountNeededNum - freedFromClosing;

    for (const pair of deltaNeutralPairs) {
      if (freedFromClosing >= amountNeededNum) break;

      const reductionNeeded = remainingNeeded();
      const avgPrice = pair.longPosition.markPrice;
      const sizeToReduce = Math.min(
        reductionNeeded / (2 * avgPrice),
        pair.maxDeltaNeutralSize,
      );

      try {
        const reduceResults = await Promise.allSettled([
          this.reducePosition(
            pair.longPosition,
            pair.longExchange,
            sizeToReduce,
          ),
          this.reducePosition(
            pair.shortPosition,
            pair.shortExchange,
            sizeToReduce,
          ),
        ]);

        for (let i = 0; i < reduceResults.length; i++) {
          const result = reduceResults[i];
          const exchange = i === 0 ? pair.longExchange : pair.shortExchange;
          if (result.status === 'fulfilled' && result.value.success) {
            exchangesWithFreedCapital.add(exchange);
            freedFromClosing += result.value.freedValue;
          }
        }
      } catch (pairError: any) {
        this.logger.warn(
          `Failed to reduce pair ${pair.symbol}: ${pairError.message}`,
        );
      }
    }

    // Handle unpaired positions if still short
    const unpairedPositions = this.getUnpairedPositions(
      allPositions,
      deltaNeutralPairs,
    );
    if (unpairedPositions.length > 0 && freedFromClosing < amountNeededNum) {
      unpairedPositions.sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);
      for (const position of unpairedPositions) {
        if (freedFromClosing >= amountNeededNum) break;
        const reductionNeeded = remainingNeeded();
        const sizeToReduce = Math.min(
          reductionNeeded / position.markPrice,
          Math.abs(position.size),
        );
        try {
          const result = await this.reducePosition(
            position,
            position.exchangeType,
            sizeToReduce,
          );
          if (result.success) {
            freedFromClosing += result.freedValue;
            exchangesWithFreedCapital.add(position.exchangeType);
          }
        } catch (closeError: any) {
          this.logger.warn(
            `Failed to reduce unpaired position: ${closeError.message}`,
          );
        }
      }
    }

    // Withdraw freed capital
    for (const exchangeType of exchangesWithFreedCapital) {
      try {
        const withdrawn = await this.withdrawFromExchange(
          exchangeType,
          amountNeededNum - Number(formatUnits(totalFreed, 6)),
        );
        if (withdrawn > 0) {
          totalFreed += parseUnits(withdrawn.toFixed(6), 6);
        }
      } catch (withdrawError: any) {
        this.logger.warn(
          `Failed to withdraw from ${exchangeType}: ${withdrawError.message}`,
        );
      }
    }

    return totalFreed;
  }

  private async getAllPositionsFromAllExchanges(): Promise<PerpPosition[]> {
    const allPositions: PerpPosition[] = [];
    if (this.perpKeeperService) {
      try {
        const positions = await this.perpKeeperService.getAllPositions();
        allPositions.push(...positions);
        return allPositions;
      } catch (error: any) {
        this.logger.warn(`PerpKeeperService failed: ${error.message}`);
      }
    }
    return allPositions;
  }

  private groupPositionsBySymbol(
    positions: PerpPosition[],
  ): Map<string, PerpPosition[]> {
    const grouped = new Map<string, PerpPosition[]>();
    for (const position of positions) {
      const symbol = position.symbol;
      if (!grouped.has(symbol)) {
        grouped.set(symbol, []);
      }
      grouped.get(symbol)!.push(position);
    }
    return grouped;
  }

  private identifyDeltaNeutralPairs(
    positionsBySymbol: Map<string, PerpPosition[]>,
  ): DeltaNeutralPair[] {
    const pairs: DeltaNeutralPair[] = [];
    for (const [symbol, positions] of positionsBySymbol) {
      const longs = positions.filter((p) => p.side === OrderSide.LONG);
      const shorts = positions.filter((p) => p.side === OrderSide.SHORT);
      for (const longPos of longs) {
        for (const shortPos of shorts) {
          if (longPos.exchangeType !== shortPos.exchangeType) {
            const longSize = Math.abs(longPos.size);
            const shortSize = Math.abs(shortPos.size);
            pairs.push({
              symbol,
              longPosition: longPos,
              shortPosition: shortPos,
              longExchange: longPos.exchangeType,
              shortExchange: shortPos.exchangeType,
              combinedPnl: longPos.unrealizedPnl + shortPos.unrealizedPnl,
              totalValue: (longSize + shortSize) * longPos.markPrice,
              maxDeltaNeutralSize: Math.min(longSize, shortSize),
            });
          }
        }
      }
    }
    return pairs;
  }

  private getUnpairedPositions(
    allPositions: PerpPosition[],
    pairs: DeltaNeutralPair[],
  ): PerpPosition[] {
    const pairedIds = new Set<string>();
    for (const pair of pairs) {
      pairedIds.add(`${pair.longExchange}-${pair.symbol}-LONG`);
      pairedIds.add(`${pair.shortExchange}-${pair.symbol}-SHORT`);
    }
    return allPositions.filter(
      (pos) => !pairedIds.has(`${pos.exchangeType}-${pos.symbol}-${pos.side}`),
    );
  }

  private async reducePosition(
    position: PerpPosition,
    exchangeType: ExchangeType,
    sizeToReduce: number,
  ): Promise<PositionReductionResult> {
    const adapter = await this.getAdapterForExchange(exchangeType);
    if (!adapter || sizeToReduce <= 0) {
      return { success: false, reducedSize: 0, freedValue: 0 };
    }
    const actualReduction = Math.min(sizeToReduce, Math.abs(position.size));
    const reduceSide =
      position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
    try {
      const order = new PerpOrderRequest(
        position.symbol,
        reduceSide,
        OrderType.MARKET,
        actualReduction,
        undefined,
        undefined,
        true,
      );
      await adapter.placeOrder(order);
      return {
        success: true,
        reducedSize: actualReduction,
        freedValue: actualReduction * position.markPrice,
      };
    } catch (error: any) {
      return {
        success: false,
        reducedSize: 0,
        freedValue: 0,
        error: error.message,
      };
    }
  }

  private async getAdapterForExchange(
    exchangeType: ExchangeType,
  ): Promise<IPerpExchangeAdapter | null> {
    if (this.perpKeeperService) {
      try {
        return this.perpKeeperService.getExchangeAdapter(exchangeType);
      } catch (e) {}
    }
    return null;
  }

  private async withdrawFromExchange(
    exchangeType: ExchangeType,
    maxAmount: number,
  ): Promise<number> {
    const adapter = await this.getAdapterForExchange(exchangeType);
    if (!adapter) return 0;
    try {
      const balance = await adapter.getBalance();
      const withdrawAmount = Math.min(balance - 1, maxAmount);
      if (withdrawAmount <= 0) return 0;

      if (
        exchangeType === ExchangeType.HYPERLIQUID &&
        this.hyperliquidAdapter
      ) {
        await this.hyperliquidAdapter.withdrawExternal(
          withdrawAmount,
          'USDC',
          this.wallet!.address,
        );
      } else if ('withdrawExternal' in adapter) {
        await (adapter as any).withdrawExternal(
          withdrawAmount,
          'USDC',
          this.wallet!.address,
        );
      }

      // Wait for arrival
      const startBalance = await this.getKeeperUsdcBalance();
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        const current = await this.getKeeperUsdcBalance();
        if (current > startBalance)
          return Number(formatUnits(current - startBalance, 6));
      }
    } catch (e) {}
    return 0;
  }

  private async getKeeperUsdcBalance(): Promise<bigint> {
    if (!this.wallet || !this.provider) throw new Error('Not initialized');
    const usdc = new Contract(this.usdcAddress, this.ERC20_ABI, this.provider);
    return await usdc.balanceOf(this.wallet.address);
  }

  getKeeperAddress(): string | null {
    return this.wallet?.address || null;
  }
}

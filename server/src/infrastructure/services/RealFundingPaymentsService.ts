import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ethers } from 'ethers';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

/**
 * Funding payment from an exchange
 */
export interface FundingPayment {
  exchange: ExchangeType;
  symbol: string;
  amount: number; // USD (positive = received, negative = paid)
  fundingRate: number;
  positionSize: number;
  timestamp: Date;
}

/**
 * Win rate metrics
 */
export interface WinRateMetrics {
  totalPayments: number;
  winningPayments: number;
  losingPayments: number;
  winRate: number; // Percentage (0-100)
  profitFactor: number; // Gross profit / Gross loss (>1 is profitable)
  averageWin: number; // Average size of winning payments
  averageLoss: number; // Average size of losing payments
  largestWin: number;
  largestLoss: number;
  winLossRatio: number; // Average win / Average loss
  expectancy: number; // Expected value per trade
}

/**
 * Symbol performance metrics
 */
export interface SymbolPerformance {
  symbol: string;
  totalFunding: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  exchange: ExchangeType;
}

/**
 * Funding summary for an exchange
 */
export interface ExchangeFundingSummary {
  exchange: ExchangeType;
  totalReceived: number;
  totalPaid: number;
  netFunding: number;
  paymentCount: number;
  winRate: number;
  bySymbol: Map<string, number>;
}

/**
 * Combined funding summary across all exchanges
 */
export interface CombinedFundingSummary {
  totalReceived: number;
  totalPaid: number;
  netFunding: number;
  dailyAverage: number;
  annualized: number;
  realAPY: number; // Based on capital deployed
  breakEvenHours: number | null; // Hours until costs are covered
  winRateMetrics: WinRateMetrics;
  topSymbols: SymbolPerformance[];
  bottomSymbols: SymbolPerformance[];
  exchanges: Map<ExchangeType, ExchangeFundingSummary>;
  lastUpdated: Date;
}

// Browser-like headers to avoid CloudFlare blocking
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * RealFundingPaymentsService - Fetches actual funding payments from all exchanges
 *
 * This service fetches real funding payment history (not just rates) to calculate
 * true realized APY based on actual payments received/paid.
 */
@Injectable()
export class RealFundingPaymentsService implements OnModuleInit {
  private readonly logger = new Logger(RealFundingPaymentsService.name);

  // Cached funding data
  private fundingPayments: FundingPayment[] = [];
  private lastFetchTime: Date | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Trading costs for break-even calculation
  private totalTradingCosts: number = 0;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    // Initial fetch on startup (background, don't block)
    this.fetchAllFundingPayments(30).catch((err) => {
      this.logger.warn(
        `Failed to fetch initial funding payments: ${err.message}`,
      );
    });
  }

  /**
   * Record trading costs (for break-even calculation)
   */
  recordTradingCosts(amount: number): void {
    this.totalTradingCosts += amount;
  }

  /**
   * Get total trading costs recorded
   */
  getTotalTradingCosts(): number {
    return this.totalTradingCosts;
  }

  /**
   * Fetch all funding payments from all exchanges
   */
  async fetchAllFundingPayments(days: number = 30): Promise<FundingPayment[]> {
    const now = Date.now();

    // Use cache if fresh
    if (
      this.lastFetchTime &&
      now - this.lastFetchTime.getTime() < this.CACHE_TTL_MS
    ) {
      return this.fundingPayments;
    }

    const allPayments: FundingPayment[] = [];

    // Fetch from all exchanges in parallel
    const [hyperliquidPayments, lighterPayments] =
      await Promise.all([
        this.fetchHyperliquidPayments(days).catch((err) => {
          this.logger.warn(
            `Failed to fetch Hyperliquid payments: ${err.message}`,
          );
          return [];
        }),
        /* DISABLED ASTER
        this.fetchAsterPayments(days).catch((err) => {
          this.logger.warn(`Failed to fetch Aster payments: ${err.message}`);
          return [];
        }),
        */
        this.fetchLighterPayments(days).catch((err) => {
          this.logger.warn(`Failed to fetch Lighter payments: ${err.message}`);
          return [];
        }),
      ]);

    const asterPayments: FundingPayment[] = []; // DISABLED

    allPayments.push(
      ...hyperliquidPayments,
      ...asterPayments,
      ...lighterPayments,
    );

    // Update cache
    this.fundingPayments = allPayments;
    this.lastFetchTime = new Date();

    this.logger.log(
      `Fetched ${allPayments.length} funding payments: ` +
        `Hyperliquid=${hyperliquidPayments.length}, ` +
        `Aster=${asterPayments.length}, ` +
        `Lighter=${lighterPayments.length}`,
    );

    return allPayments;
  }

  /**
   * Calculate win rate metrics from payments
   */
  calculateWinRateMetrics(payments: FundingPayment[]): WinRateMetrics {
    if (payments.length === 0) {
      return {
        totalPayments: 0,
        winningPayments: 0,
        losingPayments: 0,
        winRate: 0,
        profitFactor: 0,
        averageWin: 0,
        averageLoss: 0,
        largestWin: 0,
        largestLoss: 0,
        winLossRatio: 0,
        expectancy: 0,
      };
    }

    const wins = payments.filter((p) => p.amount > 0);
    const losses = payments.filter((p) => p.amount < 0);

    const totalWins = wins.reduce((sum, p) => sum + p.amount, 0);
    const totalLosses = Math.abs(losses.reduce((sum, p) => sum + p.amount, 0));

    const winRate = (wins.length / payments.length) * 100;
    const profitFactor =
      totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

    const averageWin = wins.length > 0 ? totalWins / wins.length : 0;
    const averageLoss = losses.length > 0 ? totalLosses / losses.length : 0;

    const largestWin =
      wins.length > 0 ? Math.max(...wins.map((p) => p.amount)) : 0;
    const largestLoss =
      losses.length > 0
        ? Math.abs(Math.min(...losses.map((p) => p.amount)))
        : 0;

    const winLossRatio =
      averageLoss > 0
        ? averageWin / averageLoss
        : averageWin > 0
          ? Infinity
          : 0;

    // Expectancy = (Win% × Avg Win) - (Loss% × Avg Loss)
    const winPct = wins.length / payments.length;
    const lossPct = losses.length / payments.length;
    const expectancy = winPct * averageWin - lossPct * averageLoss;

    return {
      totalPayments: payments.length,
      winningPayments: wins.length,
      losingPayments: losses.length,
      winRate,
      profitFactor,
      averageWin,
      averageLoss,
      largestWin,
      largestLoss,
      winLossRatio,
      expectancy,
    };
  }

  /**
   * Calculate symbol performance
   */
  calculateSymbolPerformance(payments: FundingPayment[]): SymbolPerformance[] {
    const symbolMap = new Map<
      string,
      {
        total: number;
        wins: number;
        losses: number;
        exchange: ExchangeType;
      }
    >();

    for (const payment of payments) {
      const key = `${payment.symbol}:${payment.exchange}`;
      const existing = symbolMap.get(key) || {
        total: 0,
        wins: 0,
        losses: 0,
        exchange: payment.exchange,
      };

      existing.total += payment.amount;
      if (payment.amount > 0) {
        existing.wins++;
      } else if (payment.amount < 0) {
        existing.losses++;
      }

      symbolMap.set(key, existing);
    }

    const performances: SymbolPerformance[] = [];
    for (const [key, data] of symbolMap) {
      const [symbol] = key.split(':');
      const totalPayments = data.wins + data.losses;
      performances.push({
        symbol,
        totalFunding: data.total,
        winCount: data.wins,
        lossCount: data.losses,
        winRate: totalPayments > 0 ? (data.wins / totalPayments) * 100 : 0,
        exchange: data.exchange,
      });
    }

    return performances;
  }

  /**
   * Get combined funding summary with real APY calculation
   */
  async getCombinedSummary(
    days: number = 30,
    capitalDeployed: number = 0,
  ): Promise<CombinedFundingSummary> {
    const payments = await this.fetchAllFundingPayments(days);

    // Initialize exchange summaries
    const exchanges = new Map<ExchangeType, ExchangeFundingSummary>();
    for (const exchange of [
      ExchangeType.HYPERLIQUID,
      ExchangeType.ASTER,
      ExchangeType.LIGHTER,
    ]) {
      exchanges.set(exchange, {
        exchange,
        totalReceived: 0,
        totalPaid: 0,
        netFunding: 0,
        paymentCount: 0,
        winRate: 0,
        bySymbol: new Map(),
      });
    }

    // Track wins/losses per exchange
    const exchangeWins = new Map<ExchangeType, number>();
    const exchangeLosses = new Map<ExchangeType, number>();

    // Aggregate payments
    let totalReceived = 0;
    let totalPaid = 0;

    for (const payment of payments) {
      const summary = exchanges.get(payment.exchange);
      if (!summary) continue;

      if (payment.amount > 0) {
        summary.totalReceived += payment.amount;
        totalReceived += payment.amount;
        exchangeWins.set(
          payment.exchange,
          (exchangeWins.get(payment.exchange) || 0) + 1,
        );
      } else if (payment.amount < 0) {
        summary.totalPaid += Math.abs(payment.amount);
        totalPaid += Math.abs(payment.amount);
        exchangeLosses.set(
          payment.exchange,
          (exchangeLosses.get(payment.exchange) || 0) + 1,
        );
      }

      summary.paymentCount++;
      const currentSymbolTotal = summary.bySymbol.get(payment.symbol) || 0;
      summary.bySymbol.set(payment.symbol, currentSymbolTotal + payment.amount);
    }

    // Calculate net funding and win rate for each exchange
    for (const [exchange, summary] of exchanges) {
      summary.netFunding = summary.totalReceived - summary.totalPaid;
      const wins = exchangeWins.get(exchange) || 0;
      summary.winRate =
        summary.paymentCount > 0 ? (wins / summary.paymentCount) * 100 : 0;
    }

    const netFunding = totalReceived - totalPaid;
    const dailyAverage = days > 0 ? netFunding / days : 0;
    const annualized = dailyAverage * 365;

    // Calculate real APY
    let realAPY = 0;
    if (capitalDeployed > 0) {
      realAPY = (annualized / capitalDeployed) * 100;
    }

    // Calculate break-even hours
    let breakEvenHours: number | null = null;
    if (this.totalTradingCosts > 0 && dailyAverage > 0) {
      const hoursToBreakEven = (this.totalTradingCosts / dailyAverage) * 24;
      breakEvenHours = hoursToBreakEven;
    } else if (this.totalTradingCosts > 0 && dailyAverage <= 0) {
      breakEvenHours = Infinity; // Never breaks even
    }

    // Calculate win rate metrics
    const winRateMetrics = this.calculateWinRateMetrics(payments);

    // Calculate symbol performance
    const symbolPerformance = this.calculateSymbolPerformance(payments);

    // Sort by total funding
    symbolPerformance.sort((a, b) => b.totalFunding - a.totalFunding);
    const topSymbols = symbolPerformance.slice(0, 5);
    const bottomSymbols = symbolPerformance.slice(-5).reverse();

    return {
      totalReceived,
      totalPaid,
      netFunding,
      dailyAverage,
      annualized,
      realAPY,
      breakEvenHours,
      winRateMetrics,
      topSymbols,
      bottomSymbols,
      exchanges,
      lastUpdated: new Date(),
    };
  }

  /**
   * Fetch Hyperliquid funding payments
   */
  private async fetchHyperliquidPayments(
    days: number,
  ): Promise<FundingPayment[]> {
    const privateKey =
      this.configService.get<string>('PRIVATE_KEY') ||
      this.configService.get<string>('HYPERLIQUID_PRIVATE_KEY');

    if (!privateKey) {
      this.logger.debug('No Hyperliquid private key configured');
      return [];
    }

    const normalizedKey = privateKey.startsWith('0x')
      ? privateKey
      : `0x${privateKey}`;
    const wallet = new ethers.Wallet(normalizedKey);
    const address = wallet.address;

    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;

    try {
      const response = await axios.post(
        'https://api.hyperliquid.xyz/info',
        {
          type: 'userFunding',
          user: address,
          startTime,
          endTime: now,
        },
        {
          headers: BROWSER_HEADERS,
          timeout: 30000,
        },
      );

      const data = response.data;
      if (!Array.isArray(data)) return [];

      const payments: FundingPayment[] = [];
      for (const entry of data) {
        if (entry.delta?.type === 'funding') {
          payments.push({
            exchange: ExchangeType.HYPERLIQUID,
            symbol: entry.delta.coin || 'UNKNOWN',
            amount: parseFloat(entry.delta.usdc || '0'),
            fundingRate: parseFloat(entry.delta.fundingRate || '0'),
            positionSize: Math.abs(parseFloat(entry.delta.szi || '0')),
            timestamp: new Date(entry.time),
          });
        }
      }

      return payments;
    } catch (error: any) {
      this.logger.error(`Hyperliquid funding fetch error: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch Aster funding payments
   */
  private async fetchAsterPayments(days: number): Promise<FundingPayment[]> {
    const userAddress = this.configService.get<string>('ASTER_USER');
    const signerAddress = this.configService.get<string>('ASTER_SIGNER');
    const privateKey = this.configService.get<string>('ASTER_PRIVATE_KEY');

    if (!userAddress || !signerAddress || !privateKey) {
      this.logger.debug('Aster credentials not configured');
      return [];
    }

    const baseUrl =
      this.configService.get<string>('ASTER_BASE_URL') ||
      'https://fapi.asterdex.com';
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;

    try {
      const normalizedKey = privateKey.startsWith('0x')
        ? privateKey
        : `0x${privateKey}`;
      const wallet = new ethers.Wallet(normalizedKey);

      const params: Record<string, any> = {
        incomeType: 'FUNDING_FEE',
        startTime,
        endTime: now,
        limit: 1000,
        timestamp: Date.now(),
        recvWindow: 60000,
      };

      // Create Ethereum signature
      const trimmedParams: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) {
        trimmedParams[key] = String(value);
      }

      const jsonStr = JSON.stringify(
        trimmedParams,
        Object.keys(trimmedParams).sort(),
      );
      const nonce = Math.floor(Date.now() * 1000);

      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const encoded = abiCoder.encode(
        ['string', 'address', 'address', 'uint256'],
        [jsonStr, userAddress, signerAddress, nonce],
      );
      const keccakHash = ethers.keccak256(encoded);
      const hashBytes = ethers.getBytes(keccakHash);

      const prefix = '\x19Ethereum Signed Message:\n';
      const lengthStr = hashBytes.length.toString();
      const message = ethers.concat([
        ethers.toUtf8Bytes(prefix),
        ethers.toUtf8Bytes(lengthStr),
        hashBytes,
      ]);

      const messageHash = ethers.keccak256(message);
      const signature = wallet.signingKey.sign(ethers.getBytes(messageHash));
      const signatureHex = ethers.Signature.from({
        r: signature.r,
        s: signature.s,
        v: signature.v,
      }).serialized;

      const signedParams = {
        ...params,
        nonce,
        user: userAddress,
        signer: signerAddress,
        signature: signatureHex,
      };

      const response = await axios.get(`${baseUrl}/fapi/v3/income`, {
        params: signedParams,
        headers: BROWSER_HEADERS,
        timeout: 30000,
      });

      const data = response.data;
      if (!Array.isArray(data)) return [];

      const payments: FundingPayment[] = data.map((entry: any) => ({
        exchange: ExchangeType.ASTER,
        symbol: entry.symbol || 'UNKNOWN',
        amount: parseFloat(entry.income || '0'),
        fundingRate: 0, // Not provided in income endpoint
        positionSize: 0,
        timestamp: new Date(entry.time),
      }));

      return payments;
    } catch (error: any) {
      this.logger.error(`Aster funding fetch error: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch Lighter funding payments
   */
  private async fetchLighterPayments(days: number): Promise<FundingPayment[]> {
    const accountIndex = parseInt(
      this.configService.get<string>('LIGHTER_ACCOUNT_INDEX') || '0',
    );
    const apiKey = this.configService.get<string>('LIGHTER_API_KEY');
    const apiKeyIndex = parseInt(
      this.configService.get<string>('LIGHTER_API_KEY_INDEX') || '1',
    );
    const baseUrl =
      this.configService.get<string>('LIGHTER_API_BASE_URL') ||
      'https://mainnet.zklighter.elliot.ai';

    if (!apiKey || accountIndex === 0) {
      this.logger.debug('Lighter credentials not configured');
      return [];
    }

    try {
      // Import SignerClient dynamically
      const { SignerClient } = await import('@reservoir0x/lighter-ts-sdk');

      let normalizedKey = apiKey;
      if (normalizedKey.startsWith('0x')) {
        normalizedKey = normalizedKey.slice(2);
      }

      const signerClient = new SignerClient({
        url: baseUrl,
        privateKey: normalizedKey,
        accountIndex,
        apiKeyIndex,
      });

      await signerClient.initialize();
      await signerClient.ensureWasmClient();

      const authToken = await signerClient.createAuthTokenWithExpiry(600);

      const response = await axios.get(`${baseUrl}/api/v1/positionFunding`, {
        params: {
          account_index: accountIndex,
          limit: 100,
          auth: authToken,
        },
        headers: { accept: 'application/json' },
        timeout: 30000,
      });

      const data = response.data;
      let fundingData: any[] = [];
      if (data.position_fundings) fundingData = data.position_fundings;
      else if (Array.isArray(data)) fundingData = data;

      // Get market symbols
      const marketsRes = await axios.get(
        'https://explorer.elliot.ai/api/markets',
        { timeout: 10000 },
      );
      const symbolMap = new Map<number, string>();
      if (Array.isArray(marketsRes.data)) {
        for (const m of marketsRes.data) {
          symbolMap.set(m.market_index, m.symbol);
        }
      }

      // Filter to last N days
      const now = Date.now();
      const cutoff = now - days * 24 * 60 * 60 * 1000;

      const payments: FundingPayment[] = [];
      for (const entry of fundingData) {
        const timestamp = (entry.timestamp || 0) * 1000;
        if (timestamp < cutoff) continue;

        const marketId = entry.market_id || 0;
        const symbol = symbolMap.get(marketId) || `Market-${marketId}`;

        payments.push({
          exchange: ExchangeType.LIGHTER,
          symbol,
          amount: parseFloat(entry.change || '0'),
          fundingRate: parseFloat(entry.rate || '0'),
          positionSize: parseFloat(entry.position_size || '0'),
          timestamp: new Date(timestamp),
        });
      }

      return payments;
    } catch (error: any) {
      this.logger.error(`Lighter funding fetch error: ${error.message}`);
      return [];
    }
  }

  /**
   * Format break-even time for display
   */
  formatBreakEvenTime(hours: number | null): string {
    if (hours === null) return 'N/A';
    if (!isFinite(hours)) return '∞ (never)';
    if (hours <= 0) return '✅ Already profitable';

    if (hours < 1) {
      return `${(hours * 60).toFixed(0)} minutes`;
    } else if (hours < 24) {
      return `${hours.toFixed(1)} hours`;
    } else {
      const days = hours / 24;
      return `${days.toFixed(1)} days (${hours.toFixed(0)}h)`;
    }
  }

  /**
   * Format win rate status emoji
   */
  private getWinRateEmoji(winRate: number): string {
    if (winRate >= 70) return '🔥';
    if (winRate >= 55) return '✅';
    if (winRate >= 45) return '⚠️';
    return '❌';
  }

  /**
   * Format profit factor status
   */
  private getProfitFactorStatus(pf: number): string {
    if (pf >= 2.0) return '🔥 Excellent';
    if (pf >= 1.5) return '✅ Good';
    if (pf >= 1.0) return '⚠️ Break-even';
    return '❌ Losing';
  }

  /**
   * Log funding summary
   */
  async logFundingSummary(
    days: number = 30,
    capitalDeployed: number = 0,
  ): Promise<void> {
    const summary = await this.getCombinedSummary(days, capitalDeployed);
    const wr = summary.winRateMetrics;

    this.logger.log('');
    this.logger.log('═'.repeat(70));
    this.logger.log('  💰 REAL FUNDING PAYMENTS SUMMARY');
    this.logger.log('═'.repeat(70));
    this.logger.log('');

    // Win Rate Section
    this.logger.log('📊 WIN RATE ANALYSIS');
    this.logger.log('-'.repeat(70));
    this.logger.log(
      `  ${this.getWinRateEmoji(wr.winRate)} Win Rate:        ${wr.winRate.toFixed(1)}% (${wr.winningPayments}W / ${wr.losingPayments}L)`,
    );
    this.logger.log(
      `  📈 Profit Factor:   ${wr.profitFactor === Infinity ? '∞' : wr.profitFactor.toFixed(2)} ${this.getProfitFactorStatus(wr.profitFactor)}`,
    );
    this.logger.log(`  💵 Average Win:     +$${wr.averageWin.toFixed(4)}`);
    this.logger.log(`  💸 Average Loss:    -$${wr.averageLoss.toFixed(4)}`);
    this.logger.log(
      `  🎯 Win/Loss Ratio:  ${wr.winLossRatio === Infinity ? '∞' : wr.winLossRatio.toFixed(2)}x`,
    );
    this.logger.log(
      `  📊 Expectancy:      ${wr.expectancy >= 0 ? '+' : ''}$${wr.expectancy.toFixed(4)} per payment`,
    );
    this.logger.log(`  🏆 Largest Win:     +$${wr.largestWin.toFixed(4)}`);
    this.logger.log(`  💀 Largest Loss:    -$${wr.largestLoss.toFixed(4)}`);
    this.logger.log('');

    // Top/Bottom Symbols
    if (summary.topSymbols.length > 0) {
      this.logger.log('🏆 TOP PERFORMERS');
      this.logger.log('-'.repeat(70));
      for (const sym of summary.topSymbols) {
        const sign = sym.totalFunding >= 0 ? '+' : '';
        this.logger.log(
          `  ${sym.symbol.padEnd(12)} (${sym.exchange}): ${sign}$${sym.totalFunding.toFixed(4)} | WR: ${sym.winRate.toFixed(0)}%`,
        );
      }
      this.logger.log('');
    }

    if (
      summary.bottomSymbols.length > 0 &&
      summary.bottomSymbols[0].totalFunding < 0
    ) {
      this.logger.log('💀 WORST PERFORMERS');
      this.logger.log('-'.repeat(70));
      for (const sym of summary.bottomSymbols) {
        if (sym.totalFunding >= 0) continue;
        const sign = sym.totalFunding >= 0 ? '+' : '';
        this.logger.log(
          `  ${sym.symbol.padEnd(12)} (${sym.exchange}): ${sign}$${sym.totalFunding.toFixed(4)} | WR: ${sym.winRate.toFixed(0)}%`,
        );
      }
      this.logger.log('');
    }

    // By exchange
    this.logger.log('🏦 BY EXCHANGE');
    this.logger.log('-'.repeat(70));
    for (const [exchange, data] of summary.exchanges) {
      if (data.paymentCount === 0) continue;

      const sign = data.netFunding >= 0 ? '+' : '';
      this.logger.log(`  ${exchange}:`);
      this.logger.log(
        `     Payments: ${data.paymentCount} | Win Rate: ${data.winRate.toFixed(1)}%`,
      );
      this.logger.log(`     Net: ${sign}$${data.netFunding.toFixed(4)}`);
    }

    this.logger.log('');
    this.logger.log('═'.repeat(70));
    this.logger.log('  TOTALS');
    this.logger.log('═'.repeat(70));

    const netSign = summary.netFunding >= 0 ? '+' : '';
    this.logger.log(
      `  Total (${days} days):     ${netSign}$${summary.netFunding.toFixed(4)}`,
    );
    this.logger.log(
      `  Daily Average:       ${netSign}$${summary.dailyAverage.toFixed(4)}`,
    );
    this.logger.log(
      `  Annualized:          ${netSign}$${summary.annualized.toFixed(2)}`,
    );

    if (capitalDeployed > 0) {
      this.logger.log(`  Real APY:            ${summary.realAPY.toFixed(2)}%`);
    }

    this.logger.log('');
    this.logger.log(
      `  ⏱️  Break-Even Time:  ${this.formatBreakEvenTime(summary.breakEvenHours)}`,
    );
    this.logger.log(
      `  💸 Trading Costs:    $${this.totalTradingCosts.toFixed(4)}`,
    );

    this.logger.log('');
    this.logger.log('═'.repeat(70));
  }
}

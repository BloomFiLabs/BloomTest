/**
 * Synthetix Perps v3 Funding Rates Adapter
 * Fetches historical funding rate data from Synthetix subgraph
 */

import axios, { AxiosInstance } from 'axios';

export interface SynthetixConfig {
  apiKey?: string;
  subgraphId?: string;
}

export interface FundingRateUpdate {
  timestamp: Date;
  marketKey: string;
  fundingRateRaw: string; // Raw BigInt as string from subgraph
  fundingRatePerInterval: number; // Normalized rate per interval (8h)
  annualizedFundingAPR: number; // Annualized rate as percentage
  fundingAmount?: string; // Total funding paid/received
}

export interface MarketInfo {
  marketKey: string;
  asset: string;
  trades?: string;
  volume?: string;
}

export interface FundingStatistics {
  avgFundingAPR: number;
  minFundingAPR: number;
  maxFundingAPR: number;
  totalUpdates: number;
  p50FundingAPR: number;
  p75FundingAPR: number;
  p90FundingAPR: number;
}

// Synthetix market key to human-readable mapping
const MARKET_KEY_MAP: Record<string, string> = {
  '0x7345544800000000000000000000000000000000000000000000000000000000': 'sETH',
  '0x7342544300000000000000000000000000000000000000000000000000000000': 'sBTC',
  '0x734c494e4b000000000000000000000000000000000000000000000000000000': 'sLINK',
  '0x73534f4c00000000000000000000000000000000000000000000000000000000': 'sSOL',
  '0x734d415449430000000000000000000000000000000000000000000000000000': 'sMATIC',
  '0x7341564158000000000000000000000000000000000000000000000000000000': 'sAVAX',
  '0x73424e4200000000000000000000000000000000000000000000000000000000': 'sBNB',
};

// Reverse mapping
const SYMBOL_TO_MARKET_KEY = Object.fromEntries(
  Object.entries(MARKET_KEY_MAP).map(([key, symbol]) => [symbol, key])
);

export class SynthetixFundingRatesAdapter {
  private client: AxiosInstance;
  private apiKey?: string;
  private subgraphUrl: string;

  // Synthetix funding rates are typically updated every 8 hours
  private readonly FUNDING_INTERVAL_HOURS = 8;
  private readonly INTERVALS_PER_DAY = 24 / this.FUNDING_INTERVAL_HOURS;
  private readonly INTERVALS_PER_YEAR = this.INTERVALS_PER_DAY * 365;
  
  // Synthetix uses 18 decimal precision for funding rates
  private readonly FUNDING_RATE_DECIMALS = 18;
  private readonly FUNDING_RATE_DIVISOR = Math.pow(10, this.FUNDING_RATE_DECIMALS);

  constructor(config: SynthetixConfig = {}) {
    this.apiKey = config.apiKey;
    const subgraphId = config.subgraphId || '82hQpNuzNB5i5xcFKhk6ZiKcacTWvPeovAkxrKsm8dfM';
    this.subgraphUrl = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;
    
    this.client = axios.create({
      baseURL: this.subgraphUrl,
      timeout: 30000,
    });
  }

  /**
   * Query The Graph subgraph with authentication
   */
  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await axios.post(
        this.subgraphUrl,
        {
          query,
          variables,
        },
        { 
          headers,
          timeout: 30000,
        }
      );

      if (response.data.errors) {
        const errorMessages = response.data.errors.map((e: any) => e.message).join(', ');
        throw new Error(`GraphQL errors: ${errorMessages}`);
      }

      return response.data.data;
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;
        throw new Error(`Synthetix subgraph query failed (${status}): ${JSON.stringify(errorData)}`);
      }
      throw new Error(`Synthetix subgraph query failed: ${error.message}`);
    }
  }

  /**
   * Convert market key from bytes32 to symbol
   */
  private marketKeyToSymbol(marketKeyBytes: string): string {
    const symbol = MARKET_KEY_MAP[marketKeyBytes];
    if (symbol) {
      return symbol;
    }
    
    // Fallback: try to decode as ASCII
    try {
      const hex = marketKeyBytes.replace('0x', '');
      const decoded = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '');
      return decoded || marketKeyBytes.slice(0, 10);
    } catch {
      return marketKeyBytes.slice(0, 10);
    }
  }

  /**
   * Convert symbol to market key bytes32
   */
  private symbolToMarketKey(symbol: string): string {
    return SYMBOL_TO_MARKET_KEY[symbol] || symbol;
  }

  /**
   * Parse funding rate from raw string (18 decimals) to normalized values
   */
  private parseFundingRate(rawRate: string): {
    perInterval: number;
    annualized: number;
  } {
    const rate = parseFloat(rawRate) / this.FUNDING_RATE_DIVISOR;
    
    return {
      perInterval: rate,
      annualized: rate * this.INTERVALS_PER_YEAR * 100, // Convert to percentage
    };
  }

  /**
   * Fetch available futures markets from Synthetix
   */
  async fetchAvailableMarkets(): Promise<MarketInfo[]> {
    const query = `
      query GetFuturesMarkets {
        futuresMarkets(first: 100, orderBy: asset) {
          id
          asset
          marketKey
        }
      }
    `;

    const data = await this.query<{
      futuresMarkets: Array<{
        id: string;
        asset: string;
        marketKey: string;
      }>;
    }>(query);

    return data.futuresMarkets.map(m => ({
      marketKey: this.marketKeyToSymbol(m.marketKey),
      asset: m.asset,
    }));
  }

  /**
   * Fetch historical funding rate updates for a specific market
   * Returns normalized funding rates with timestamps
   */
  async fetchFundingHistory(
    marketSymbol: string,
    startDate: Date,
    endDate: Date
  ): Promise<FundingRateUpdate[]> {
    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    const endTimestamp = Math.floor(endDate.getTime() / 1000);
    const marketKeyBytes = this.symbolToMarketKey(marketSymbol);

    console.log(`📡 Fetching Synthetix funding rate history for ${marketSymbol}...`);
    console.log(`   Window: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);
    console.log(`   Market Key: ${marketKeyBytes}`);

    let allUpdates: FundingRateUpdate[] = [];
    let lastTimestamp = startTimestamp;
    let hasMore = true;
    let page = 0;
    const maxPages = 10; // Limit to prevent infinite loops

    while (hasMore && page < maxPages) {
      const query = `
        query GetFundingRateUpdates(
          $marketKey: String!,
          $startTimestamp: String!,
          $endTimestamp: String!
        ) {
          fundingRateUpdates(
            where: {
              market_: { marketKey: $marketKey },
              timestamp_gt: $startTimestamp,
              timestamp_lte: $endTimestamp
            }
            orderBy: timestamp
            orderDirection: asc
            first: 1000
          ) {
            id
            timestamp
            market {
              marketKey
              asset
            }
            fundingRate
            funding
          }
        }
      `;

      const variables = {
        marketKey: marketKeyBytes,
        startTimestamp: lastTimestamp.toString(),
        endTimestamp: endTimestamp.toString(),
      };

      const data = await this.query<{
        fundingRateUpdates: Array<{
          id: string;
          timestamp: string;
          market: {
            marketKey: string;
            asset: string;
          };
          fundingRate: string;
          funding: string;
        }>;
      }>(query, variables);

      if (!data.fundingRateUpdates || data.fundingRateUpdates.length === 0) {
        hasMore = false;
      } else {
        const updates = data.fundingRateUpdates.map(u => {
          const rates = this.parseFundingRate(u.fundingRate);
          return {
            timestamp: new Date(parseInt(u.timestamp) * 1000),
            marketKey: this.marketKeyToSymbol(u.market.marketKey),
            fundingRateRaw: u.fundingRate,
            fundingRatePerInterval: rates.perInterval,
            annualizedFundingAPR: rates.annualized,
            fundingAmount: u.funding,
          };
        });

        allUpdates = allUpdates.concat(updates);
        
        lastTimestamp = parseInt(data.fundingRateUpdates[data.fundingRateUpdates.length - 1].timestamp);
        page++;
        
        if (data.fundingRateUpdates.length < 1000) {
          hasMore = false;
        }
      }
    }

    console.log(`   ✅ Found ${allUpdates.length} funding rate updates`);
    
    return allUpdates;
  }

  /**
   * Calculate statistics for a set of funding rate updates
   */
  calculateStatistics(updates: FundingRateUpdate[]): FundingStatistics {
    if (updates.length === 0) {
      return {
        avgFundingAPR: 0,
        minFundingAPR: 0,
        maxFundingAPR: 0,
        totalUpdates: 0,
        p50FundingAPR: 0,
        p75FundingAPR: 0,
        p90FundingAPR: 0,
      };
    }

    const aprs = updates.map(u => u.annualizedFundingAPR).sort((a, b) => a - b);
    
    const percentile = (arr: number[], p: number) => {
      const idx = Math.floor(p * (arr.length - 1));
      return arr[idx] || 0;
    };

    const avg = aprs.reduce((sum, x) => sum + x, 0) / aprs.length;

    return {
      avgFundingAPR: avg,
      minFundingAPR: aprs[0],
      maxFundingAPR: aprs[aprs.length - 1],
      totalUpdates: updates.length,
      p50FundingAPR: percentile(aprs, 0.5),
      p75FundingAPR: percentile(aprs, 0.75),
      p90FundingAPR: percentile(aprs, 0.9),
    };
  }

  /**
   * Get average funding APR for a market over a time period
   */
  async getAverageFundingAPR(
    marketSymbol: string,
    startDate: Date,
    endDate: Date
  ): Promise<number> {
    const updates = await this.fetchFundingHistory(marketSymbol, startDate, endDate);
    
    if (updates.length === 0) {
      return 0;
    }

    const stats = this.calculateStatistics(updates);
    return stats.avgFundingAPR;
  }
}


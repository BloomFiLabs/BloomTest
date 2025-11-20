/**
 * Data adapter for The Graph Protocol
 * Queries subgraphs to fetch DEX data (Uniswap, Curve, etc.)
 */

import { DataAdapter, OHLCVData, TradeEvent } from './DataAdapter';
import { Price, Amount, FundingRate, IV } from '../../../domain/value-objects';
import axios, { AxiosInstance } from 'axios';

export interface HourlyPoolData extends OHLCVData {
  feesUSD: number;
  tvlUSD: number;
}

export interface TheGraphConfig {
  subgraphUrl: string;
  apiKey?: string; // Optional: API key for The Graph Gateway
  poolAddress?: string; // Optional: specific pool address
  token0Symbol?: string; // e.g., 'ETH'
  token1Symbol?: string; // e.g., 'USDC'
  token0Address?: string; // Token contract address
  token1Address?: string; // Token contract address
}

/**
 * The Graph Data Adapter
 * Fetches OHLCV data from DEX subgraphs (Uniswap V3, Curve, etc.)
 */
export class TheGraphDataAdapter implements DataAdapter {
  private client: AxiosInstance;
  private config: TheGraphConfig;
  private poolCache: Map<string, string> = new Map();

  constructor(config: TheGraphConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.subgraphUrl,
      timeout: 30000,
    });
  }

  /**
   * Query The Graph subgraph
   * Uses Bearer token authentication in Authorization header
   */
  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add Bearer token authentication if API key is provided
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      const response = await axios.post(
        this.config.subgraphUrl,
        {
          query,
          variables,
        },
        { 
          headers,
          // Add timeout and better error handling
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
        // HTTP error response
        const status = error.response.status;
        const errorData = error.response.data;
        throw new Error(`The Graph query failed (${status}): ${JSON.stringify(errorData)}`);
      }
      throw new Error(`The Graph query failed: ${error.message}`);
    }
  }

  /**
   * Find pool address from token symbols, names, or addresses
   * Supports both V3 and V4 query formats
   * Can search by:
   * - Token addresses (most reliable)
   * - Token symbols (e.g., "WETH", "USDC")
   * - Token names (e.g., "Wrapped Ether", "USD Coin")
   */
  private async findPoolAddress(): Promise<string> {
    const cacheKey = `${this.config.token0Symbol}-${this.config.token1Symbol}`;
    if (this.poolCache.has(cacheKey)) {
      return this.poolCache.get(cacheKey)!;
    }

    if (this.config.poolAddress) {
      return this.config.poolAddress;
    }

    // Method 1: Search by token addresses (most reliable)
    if (this.config.token0Address && this.config.token1Address) {
      return this.findPoolByAddresses();
    }

    // Method 2: Search by token symbols
    if (this.config.token0Symbol && this.config.token1Symbol) {
      return this.findPoolBySymbols();
    }

    throw new Error(
      'Must provide poolAddress, token addresses, or token symbols. ' +
      'For V4, provide token0Address/token1Address or token0Symbol/token1Symbol.'
    );
  }

  /**
   * Find pool by token addresses
   */
  private async findPoolByAddresses(): Promise<string> {
    const cacheKey = `${this.config.token0Symbol}-${this.config.token1Symbol}`;
    
    const v4Query = `
      query FindPoolByAddresses($token0: String!, $token1: String!) {
        pools(
          where: {
            token0: $token0,
            token1: $token1
          }
          orderBy: totalValueLockedUSD
          orderDirection: desc
          first: 1
        ) {
          id
          token0 { symbol id }
          token1 { symbol id }
          totalValueLockedUSD
        }
      }
    `;

    const variables = {
      token0: this.config.token0Address!.toLowerCase(),
      token1: this.config.token1Address!.toLowerCase(),
    };

    try {
      const v4Data = await this.query<{
        pools: Array<{
          id: string;
          token0?: { symbol?: string; id?: string };
          token1?: { symbol?: string; id?: string };
        }>;
      }>(v4Query, variables);

      if (v4Data.pools && v4Data.pools.length > 0) {
        const pool = v4Data.pools[0];
        console.log(`Found pool: ${pool.id}`);
        console.log(`  ${pool.token0?.symbol || 'N/A'}/${pool.token1?.symbol || 'N/A'}`);
        this.poolCache.set(cacheKey, pool.id);
        return pool.id;
      }
    } catch (error: any) {
      console.warn('Pool search by addresses failed:', error.message);
    }

    throw new Error(
      `No pool found for ${this.config.token0Symbol}/${this.config.token1Symbol} ` +
      `using addresses ${this.config.token0Address}/${this.config.token1Address}`
    );
  }

  /**
   * Find pool by token symbols
   */
  private async findPoolBySymbols(): Promise<string> {
    const cacheKey = `${this.config.token0Symbol}-${this.config.token1Symbol}`;
    
    // V4 query - search pools where token symbols match
    const v4Query = `
      query FindPoolBySymbols {
        pools(
          orderBy: totalValueLockedUSD
          orderDirection: desc
          first: 100
        ) {
          id
          token0 { symbol id name }
          token1 { symbol id name }
          totalValueLockedUSD
        }
      }
    `;

    try {
      const v4Data = await this.query<{
        pools: Array<{
          id: string;
          token0?: { symbol?: string; name?: string; id?: string };
          token1?: { symbol?: string; name?: string; id?: string };
        }>;
      }>(v4Query);

      if (v4Data.pools && v4Data.pools.length > 0) {
        // Filter pools by symbol (case-insensitive)
        const token0SymbolUpper = this.config.token0Symbol!.toUpperCase();
        const token1SymbolUpper = this.config.token1Symbol!.toUpperCase();

        const matchingPools = v4Data.pools.filter((pool) => {
          const t0Symbol = pool.token0?.symbol?.toUpperCase() || '';
          const t1Symbol = pool.token1?.symbol?.toUpperCase() || '';
          const t0Name = pool.token0?.name?.toUpperCase() || '';
          const t1Name = pool.token1?.name?.toUpperCase() || '';

          // Match in either direction (token0/token1 or token1/token0)
          const match1 =
            (t0Symbol === token0SymbolUpper || t0Name.includes(token0SymbolUpper)) &&
            (t1Symbol === token1SymbolUpper || t1Name.includes(token1SymbolUpper));
          const match2 =
            (t0Symbol === token1SymbolUpper || t0Name.includes(token1SymbolUpper)) &&
            (t1Symbol === token0SymbolUpper || t1Name.includes(token0SymbolUpper));

          return match1 || match2;
        });

        if (matchingPools.length > 0) {
          const pool = matchingPools[0];
          console.log(`Found pool by symbols: ${pool.id}`);
          console.log(`  ${pool.token0?.symbol || 'N/A'}/${pool.token1?.symbol || 'N/A'}`);
          this.poolCache.set(cacheKey, pool.id);
          return pool.id;
        }
      }
    } catch (error: any) {
      console.warn('Pool search by symbols failed:', error.message);
    }

    throw new Error(
      `No pool found for ${this.config.token0Symbol}/${this.config.token1Symbol}. ` +
      `Try providing token addresses instead, or check available pools with: npx tsx examples/find-eth-usdc-pool.ts`
    );
  }

  /**
   * Fetch price from The Graph
   */
  async fetchPrice(asset: string, timestamp: Date): Promise<Price> {
    const data = await this.fetchOHLCV(asset, timestamp, timestamp);
    if (data.length === 0) {
      throw new Error(`No price data found for ${asset} at ${timestamp.toISOString()}`);
    }
    return data[0].close;
  }

  /**
   * Fetch OHLCV data from The Graph
   * Supports both Uniswap V3 and V4 poolDayData formats
   */
  /**
   * Cache for fees data
   */
  private feesCache: Map<string, { feesUSD: number; tvlUSD: number; date: Date }> = new Map();
  
  /**
   * Cache for pool fee tier
   */
  private feeTierCache: Map<string, number> = new Map();

  /**
   * Fetch pool fee tier from The Graph
   * Returns fee tier as decimal (e.g., 0.003 = 0.3%)
   */
  async fetchPoolFeeTier(asset: string): Promise<number> {
    const poolAddress = await this.findPoolAddress();
    const cacheKey = `${asset}-${poolAddress}`;
    
    if (this.feeTierCache.has(cacheKey)) {
      return this.feeTierCache.get(cacheKey)!;
    }

    // V4 query format
    const v4Query = `
      query GetPoolFeeTier($poolId: String!) {
        pool(id: $poolId) {
          feeTier
        }
      }
    `;

    // V3 query format
    const v3Query = `
      query GetPoolFeeTierV3($poolId: String!) {
        pool(id: $poolId) {
          feeTier
        }
      }
    `;

    const variables = {
      poolId: poolAddress.toLowerCase(),
    };

    try {
      // Try V4 first
      const v4Data = await this.query<{
        pool: {
          feeTier?: number;
        } | null;
      }>(v4Query, variables);

      if (v4Data.pool?.feeTier !== undefined) {
        // Fee tier is typically stored as integer (e.g., 3000 = 0.3%)
        // Convert to decimal: divide by 1,000,000
        const feeTier = v4Data.pool.feeTier / 1_000_000;
        this.feeTierCache.set(cacheKey, feeTier);
        return feeTier;
      }

      // Try V3 format
      const v3Data = await this.query<{
        pool: {
          feeTier?: number;
        } | null;
      }>(v3Query, variables);

      if (v3Data.pool?.feeTier !== undefined) {
        const feeTier = v3Data.pool.feeTier / 1_000_000;
        this.feeTierCache.set(cacheKey, feeTier);
        return feeTier;
      }
    } catch (error: any) {
      console.warn(`Could not fetch fee tier for ${asset}:`, error.message);
    }

    // Default to 0.3% (most common Uniswap V3 fee tier)
    const defaultFeeTier = 0.003;
    this.feeTierCache.set(cacheKey, defaultFeeTier);
    return defaultFeeTier;
  }

  /**
   * Fetch Hourly OHLCV data from The Graph
   * Uses poolHourDatas entity
   */
  async fetchHourlyOHLCV(asset: string, startDate: Date, endDate: Date): Promise<HourlyPoolData[]> {
    // Handle Stablecoins: Return constant $1.0 price to support Delta Neutral strategies
    if (['USDC', 'USDT', 'DAI', 'USD'].includes(asset.toUpperCase())) {
      return this.generateStablecoinData(startDate, endDate);
    }

    const poolAddress = await this.findPoolAddress();

    // V3 query format for Hourly data
    const v3Query = `
      query PoolHourDataV3(
        $poolId: String!,
        $startTimestamp: Int!,
        $endTimestamp: Int!
      ) {
        poolHourDatas(
          where: {
            pool: $poolId,
            periodStartUnix_gte: $startTimestamp,
            periodStartUnix_lte: $endTimestamp
          }
          orderBy: periodStartUnix
          orderDirection: asc
          first: 1000
        ) {
          periodStartUnix
          open
          high
          low
          close
          volumeUSD
          token0Price
          token1Price
          tvlUSD
          feesUSD
        }
      }
    `;

    // We need to paginate because a year of hourly data is ~8760 records, limit is 1000
    let allHourlyData: HourlyPoolData[] = [];
    let currentStart = Math.floor(startDate.getTime() / 1000);
    const finalEnd = Math.floor(endDate.getTime() / 1000);
    let hasMore = true;

    while (hasMore && currentStart < finalEnd) {
      const variables = {
        poolId: poolAddress.toLowerCase(),
        startTimestamp: currentStart,
        endTimestamp: finalEnd,
      };

      try {
        const v3Data = await this.query<{
          poolHourDatas: Array<{
            periodStartUnix: number;
            open: string;
            high: string;
            low: string;
            close: string;
            volumeUSD: string;
            token0Price: string;
            token1Price: string;
            tvlUSD: string;
            feesUSD: string;
          }>;
        }>(v3Query, variables);

        if (!v3Data.poolHourDatas || v3Data.poolHourDatas.length === 0) {
          hasMore = false;
          continue;
        }

        const convertedBatch = this.convertV3PoolHourData(v3Data.poolHourDatas);
        allHourlyData = allHourlyData.concat(convertedBatch);

        if (v3Data.poolHourDatas.length < 1000) {
          hasMore = false;
        } else {
          // Update start time for next page (last timestamp + 1)
          currentStart = v3Data.poolHourDatas[v3Data.poolHourDatas.length - 1].periodStartUnix + 1;
        }
      } catch (error: any) {
        console.warn('Failed to fetch hourly data batch:', error.message);
        hasMore = false;
      }
    }

    return allHourlyData;
  }

  /**
   * Generate mock hourly data for stablecoins
   */
  private generateStablecoinData(startDate: Date, endDate: Date): HourlyPoolData[] {
    const data: HourlyPoolData[] = [];
    let currentDate = new Date(startDate);
    currentDate.setMinutes(0, 0, 0); // Align to hour
    
    const endTimestamp = endDate.getTime();
    
    while (currentDate.getTime() <= endTimestamp) {
        data.push({
            timestamp: new Date(currentDate),
            open: Price.create(1.0),
            high: Price.create(1.0),
            low: Price.create(1.0),
            close: Price.create(1.0),
            volume: Amount.zero(),
            feesUSD: 0,
            tvlUSD: 1000000000 // Arbitrary large TVL
        });
        currentDate = new Date(currentDate.getTime() + 3600 * 1000); // Add 1 hour
    }
    return data;
  }

  /**
   * Convert V3 poolHourData to OHLCV format
   * Note: poolHourDatas may not have open/high/low/close fields, so we use token0Price/token1Price
   */
  private convertV3PoolHourData(
    poolHourData: Array<{
      periodStartUnix: number;
      open?: string;
      high?: string;
      low?: string;
      close?: string;
      volumeUSD: string;
      token0Price: string;
      token1Price: string;
      tvlUSD: string;
      feesUSD: string;
    }>
  ): HourlyPoolData[] {
    const useToken0Price = this.shouldUseToken0Price();
    
    return poolHourData.map((hourData) => {
      // Use token0Price or token1Price if open/high/low/close are missing or suspiciously small
      let priceValue: number;
      
      if (hourData.close && parseFloat(hourData.close) > 100) {
        // close > 100 means it's likely ETH price (not USDT price)
        priceValue = parseFloat(hourData.close);
      } else if (hourData.open && parseFloat(hourData.open) > 100) {
        priceValue = parseFloat(hourData.open);
      } else {
        // Fallback to token price (use token1Price for ETH/USDT since token1=ETH)
        priceValue = useToken0Price
          ? parseFloat(hourData.token0Price)
          : parseFloat(hourData.token1Price);
      }
      
      // If we have high/low and they're reasonable (> 100), use them; otherwise estimate from price
      const high = hourData.high && parseFloat(hourData.high) > 100
        ? parseFloat(hourData.high)
        : priceValue * 1.01; // Estimate ±1% range
      const low = hourData.low && parseFloat(hourData.low) > 100
        ? parseFloat(hourData.low)
        : priceValue * 0.99;
      const open = hourData.open && parseFloat(hourData.open) > 100
        ? parseFloat(hourData.open)
        : priceValue;
      const close = priceValue;
      
      return {
        timestamp: new Date(hourData.periodStartUnix * 1000),
        open: Price.create(open),
        high: Price.create(high),
        low: Price.create(low),
        close: Price.create(close),
        volume: Amount.create(parseFloat(hourData.volumeUSD || '0')),
        feesUSD: parseFloat(hourData.feesUSD || '0'),
        tvlUSD: parseFloat(hourData.tvlUSD || '0'),
      };
    });
  }

  /**
   * Fetch daily fees and TVL for APR calculation
   * Supports both V3 and V4 query formats
   */
  async fetchDailyFees(asset: string, startDate: Date, endDate: Date): Promise<Array<{ date: Date; feesUSD: number; tvlUSD: number }>> {
    const poolAddress = await this.findPoolAddress();
    const cacheKey = `${asset}-${startDate.getTime()}-${endDate.getTime()}`;
    
    if (this.feesCache.has(cacheKey)) {
      const cached = this.feesCache.get(cacheKey)!;
      return [{ date: cached.date, feesUSD: cached.feesUSD, tvlUSD: cached.tvlUSD }];
    }

    // Try V4 query first (poolDayData nested under pool)
    const v4Query = `
      query PoolFeesV4(
        $poolId: String!,
        $startTimestamp: Int!,
        $endTimestamp: Int!
      ) {
        pool(id: $poolId) {
          poolDayData(
            where: {
              date_gte: $startTimestamp,
              date_lte: $endTimestamp
            }
            orderBy: date
            orderDirection: asc
            first: 1000
          ) {
            date
            feesUSD
            tvlUSD
          }
        }
      }
    `;

    // V3 query format (poolDayDatas at root level)
    const v3Query = `
      query PoolFeesV3(
        $poolId: String!,
        $startTimestamp: Int!,
        $endTimestamp: Int!
      ) {
        poolDayDatas(
          where: {
            pool: $poolId,
            date_gte: $startTimestamp,
            date_lte: $endTimestamp
          }
          orderBy: date
          orderDirection: asc
          first: 1000
        ) {
          date
          feesUSD
          tvlUSD
        }
      }
    `;

    const variables = {
      poolId: poolAddress.toLowerCase(),
      startTimestamp: Math.floor(startDate.getTime() / 1000),
      endTimestamp: Math.floor(endDate.getTime() / 1000),
    };

    // Try V4 first
    try {
      const v4Data = await this.query<{
        pool: {
          poolDayData: Array<{
            date: number;
            feesUSD: string;
            tvlUSD: string;
          }>;
        } | null;
      }>(v4Query, variables);

      if (v4Data.pool && v4Data.pool.poolDayData && v4Data.pool.poolDayData.length > 0) {
        return v4Data.pool.poolDayData.map(day => ({
          date: new Date(day.date * 1000),
          feesUSD: parseFloat(day.feesUSD || '0'),
          tvlUSD: parseFloat(day.tvlUSD || '0'),
        }));
      }
    } catch (error) {
      // Fall through to V3
    }

    // Try V3 format
    try {
      const v3Data = await this.query<{
        poolDayDatas: Array<{
          date: number;
          feesUSD: string;
          tvlUSD: string;
        }>;
      }>(v3Query, variables);

      if (v3Data.poolDayDatas && v3Data.poolDayDatas.length > 0) {
        return v3Data.poolDayDatas.map(day => ({
          date: new Date(day.date * 1000),
          feesUSD: parseFloat(day.feesUSD || '0'),
          tvlUSD: parseFloat(day.tvlUSD || '0'),
        }));
      }
    } catch (error) {
      console.warn('Failed to fetch fees data:', error);
    }

    return [];
  }

  /**
   * Calculate actual APR from real fee data
   */
  async calculateActualAPR(asset: string, startDate: Date, endDate: Date): Promise<number> {
    const feesData = await this.fetchDailyFees(asset, startDate, endDate);
    
    if (feesData.length === 0) {
      return 0;
    }

    // Calculate total fees and average TVL
    let totalFees = 0;
    let totalTVL = 0;
    
    feesData.forEach(day => {
      totalFees += day.feesUSD;
      totalTVL += day.tvlUSD;
    });

    const avgTVL = totalTVL / feesData.length;
    if (avgTVL === 0) return 0;

    // Calculate daily fee rate
    const dailyFeeRate = totalFees / (avgTVL * feesData.length);
    
    // Annualize: daily rate * 365
    const apr = dailyFeeRate * 365 * 100; // Convert to percentage
    
    return apr;
  }

  async fetchOHLCV(asset: string, startDate: Date, endDate: Date): Promise<OHLCVData[]> {
    const poolAddress = await this.findPoolAddress();

    // Try V4 query first (poolDayData nested under pool)
    const v4Query = `
      query PoolDayDataV4(
        $poolId: String!,
        $startTimestamp: Int!,
        $endTimestamp: Int!
      ) {
        pool(id: $poolId) {
          poolDayData(
            where: {
              date_gte: $startTimestamp,
              date_lte: $endTimestamp
            }
            orderBy: date
            orderDirection: asc
            first: 1000
          ) {
            date
            token0Price
            token1Price
            tvlUSD
            volumeToken0
            volumeToken1
            volumeUSD
            feesUSD
            liquidity
          }
        }
      }
    `;

    const variables = {
      poolId: poolAddress.toLowerCase(),
      startTimestamp: Math.floor(startDate.getTime() / 1000),
      endTimestamp: Math.floor(endDate.getTime() / 1000),
    };

    try {
      const v4Data = await this.query<{
        pool: {
          poolDayData: Array<{
            date: number;
            token0Price: string;
            token1Price: string;
            tvlUSD: string;
            volumeToken0: string;
            volumeToken1: string;
            volumeUSD: string;
            feesUSD: string;
            liquidity: string;
          }>;
        } | null;
      }>(v4Query, variables);

      if (v4Data.pool && v4Data.pool.poolDayData && v4Data.pool.poolDayData.length > 0) {
        return this.convertV4PoolDayData(v4Data.pool.poolDayData);
      }
    } catch (error) {
      // Fall back to V3 query if V4 fails
      console.warn('V4 query failed, trying V3 format:', error);
    }

    // Fallback to V3 query format
    const v3Query = `
      query PoolDayDataV3(
        $poolId: String!,
        $startTimestamp: Int!,
        $endTimestamp: Int!
      ) {
        poolDayDatas(
          where: {
            pool: $poolId,
            date_gte: $startTimestamp,
            date_lte: $endTimestamp
          }
          orderBy: date
          orderDirection: asc
        ) {
          date
          open
          high
          low
          close
          volumeUSD
          token0Price
          token1Price
        }
      }
    `;

    const v3Data = await this.query<{
      poolDayDatas: Array<{
        date: number;
        open: string;
        high: string;
        low: string;
        close: string;
        volumeUSD: string;
        token0Price: string;
        token1Price: string;
      }>;
    }>(v3Query, variables);

    if (!v3Data.poolDayDatas || v3Data.poolDayDatas.length === 0) {
      return [];
    }

    return this.convertV3PoolDayData(v3Data.poolDayDatas);
  }

  /**
   * Convert V4 poolDayData to OHLCV format
   * V4 doesn't have open/high/low/close, so we derive from token prices
   */
  private convertV4PoolDayData(
    poolDayData: Array<{
      date: number;
      token0Price: string;
      token1Price: string;
      volumeUSD: string;
      feesUSD?: string;
      tvlUSD?: string;
    }>
  ): OHLCVData[] {
    const useToken0Price = this.shouldUseToken0Price();

    return poolDayData.map((dayData, index) => {
      const price = useToken0Price
        ? parseFloat(dayData.token0Price)
        : parseFloat(dayData.token1Price);

      // For V4, we don't have OHLC, so we use the price for all
      // In a real scenario, you might want to aggregate from swaps
      const open = price;
      const high = price * 1.02; // Estimate ±2% range
      const low = price * 0.98;
      const close = price;

      return {
        timestamp: new Date(dayData.date * 1000),
        open: Price.create(open),
        high: Price.create(high),
        low: Price.create(low),
        close: Price.create(close),
        volume: Amount.create(parseFloat(dayData.volumeUSD)),
      };
    });
  }

  /**
   * Convert V3 poolDayData to OHLCV format
   */
  private convertV3PoolDayData(
    poolDayData: Array<{
      date: number;
      open: string;
      high: string;
      low: string;
      close: string;
      volumeUSD: string;
      token0Price: string;
      token1Price: string;
    }>
  ): OHLCVData[] {
    const useToken0Price = this.shouldUseToken0Price();

    return poolDayData.map((dayData) => {
      return {
        timestamp: new Date(dayData.date * 1000),
        open: Price.create(parseFloat(dayData.open)),
        high: Price.create(parseFloat(dayData.high)),
        low: Price.create(parseFloat(dayData.low)),
        close: Price.create(parseFloat(dayData.close)),
        volume: Amount.create(parseFloat(dayData.volumeUSD)),
      };
    });
  }

  /**
   * Determine which token price to use
   * For ETH/USDT: token0=USDT, token1=ETH, so we want token1Price (ETH in USDT)
   * For ETH/USDC: token0=WETH, token1=USDC, so we want token0Price (WETH in USDC) OR token1Price inverted
   * Strategy: Use token1Price if token1 is a stablecoin (USDC/USDT), otherwise use token0Price
   */
  private shouldUseToken0Price(): boolean {
    const stablecoins = ['USDC', 'USDT', 'DAI', 'FRAX'];
    const token1IsStable = this.config.token1Symbol && stablecoins.includes(this.config.token1Symbol.toUpperCase());
    
    // If token1 is a stablecoin, we want token1Price (base asset priced in stablecoin)
    // Otherwise, use token0Price
    return !token1IsStable;
  }

  /**
   * Fetch funding rate (not available from DEX subgraphs)
   */
  async fetchFundingRate(_asset: string, _timestamp: Date): Promise<FundingRate | null> {
    // DEX subgraphs don't have funding rate data
    // Would need to query perp protocol subgraphs separately
    return null;
  }

  /**
   * Fetch IV (not directly available, but can be calculated)
   */
  async fetchIV(_asset: string, _timestamp: Date): Promise<IV | null> {
    // IV not directly available from DEX subgraphs
    // Would need to calculate from price data or query options protocol
    return null;
  }

  /**
   * Fetch volume
   */
  async fetchVolume(asset: string, timestamp: Date): Promise<Amount> {
    const data = await this.fetchOHLCV(asset, timestamp, timestamp);
    if (data.length === 0) {
      return Amount.zero();
    }
    return data[0].volume;
  }

  /**
   * Fetch individual trade events (swaps) from The Graph
   * If individual swaps aren't available, simulates trades from daily volume
   */
  async fetchTradeEvents(asset: string, startDate: Date, endDate: Date): Promise<TradeEvent[]> {
    const poolAddress = await this.findPoolAddress();
    const events: TradeEvent[] = [];

    // Try to fetch individual swaps first (V3 format) with pagination
    const swapsQuery = `
      query Swaps(
        $poolId: String!,
        $startTimestamp: Int!,
        $endTimestamp: Int!,
        $first: Int!,
        $skip: Int!
      ) {
        swaps(
          where: {
            pool: $poolId,
            timestamp_gte: $startTimestamp,
            timestamp_lte: $endTimestamp
          }
          orderBy: timestamp
          orderDirection: asc
          first: $first
          skip: $skip
        ) {
          id
          timestamp
          amount0
          amount1
          amountUSD
          sqrtPriceX96
          tick
        }
      }
    `;

    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    const endTimestamp = Math.floor(endDate.getTime() / 1000);

    try {
      // Paginate: fetch 1000 swaps at a time (max allowed by The Graph)
      const pageSize = 1000;
      let skip = 0;
      let hasMore = true;
      let totalFetched = 0;
      const maxSwaps = 100000; // Limit total swaps to avoid memory issues

      while (hasMore && totalFetched < maxSwaps) {
        const variables = {
          poolId: poolAddress.toLowerCase(),
          startTimestamp,
          endTimestamp,
          first: pageSize,
          skip,
        };

        const swapsData = await this.query<{
          swaps: Array<{
            id: string;
            timestamp: string;
            amount0: string;
            amount1: string;
            amountUSD: string;
            sqrtPriceX96: string;
            tick: number;
          }>;
        }>(swapsQuery, variables);

        if (swapsData.swaps && swapsData.swaps.length > 0) {
          for (const swap of swapsData.swaps) {
            let priceValue = 0;
            
            // ALWAYS use tick for Uniswap V3 price calculation
            // The tick is the native price representation and is most accurate
            if (swap.tick !== undefined && swap.tick !== null) {
              // price = 1.0001^tick
              priceValue = Math.pow(1.0001, swap.tick);
            } else {
              // Fallback: use amounts with decimal adjustment
              // For ETH/USDC: token0=WETH (18 decimals), token1=USDC (6 decimals)
              const amount0 = parseFloat(swap.amount0);
              const amount1 = parseFloat(swap.amount1);
              
              if (amount0 !== 0 && amount1 !== 0) {
                // Adjust for decimals: USDC has 6, WETH has 18
                // price = (USDC_amount / 10^6) / (WETH_amount / 10^18)
                //       = (USDC_amount * 10^12) / WETH_amount
                const decimalAdjustment = Math.pow(10, 12); // 18 - 6 = 12
                priceValue = Math.abs((amount1 * decimalAdjustment) / amount0);
              } else {
                continue; // Skip if we can't calculate price
              }
            }

            // Validate price is in reasonable range for ETH/USDC ($100 - $100,000)
            if (isNaN(priceValue) || priceValue <= 100 || priceValue >= 100000) {
              continue; // Skip invalid or unrealistic prices
            }

            events.push({
              timestamp: new Date(parseInt(swap.timestamp) * 1000),
              price: Price.create(priceValue),
              volume: Amount.create(parseFloat(swap.amountUSD) || 0),
              type: 'swap',
            });
          }

          totalFetched += swapsData.swaps.length;
          hasMore = swapsData.swaps.length === pageSize;
          skip += pageSize;
        } else {
          hasMore = false;
        }
      }

      if (events.length > 0) {
        console.log(`   ✅ Fetched ${events.length} real swaps (limited to ${maxSwaps} for performance)`);
        return events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      }
    } catch (error) {
      // Fall back to simulating trades from volume
      console.warn('Could not fetch individual swaps, simulating from volume:', (error as Error).message);
    }

    // Fallback: Simulate trades from daily volume data
    // Limit to reasonable number of events to avoid memory issues
    console.log(`   ⚠️  Simulating trades from daily OHLCV data...`);
    const dailyData = await this.fetchOHLCV(asset, startDate, endDate);
    
    if (!dailyData || dailyData.length === 0) {
      console.warn(`   ❌ No OHLCV data available for ${asset}`);
      return [];
    }
    
    // Simulate trades: use hourly intervals instead of per-trade to reduce memory
    const HOUR_MS = 60 * 60 * 1000;
    let currentDate = new Date(startDate);
    currentDate.setMinutes(0, 0, 0);
    
    let validEvents = 0;
    let skippedEvents = 0;
    
    while (currentDate <= endDate) {
      const dayKey = Math.floor(currentDate.getTime() / (24 * 60 * 60 * 1000));
      const dayData = dailyData.find(d => Math.floor(d.timestamp.getTime() / (24 * 60 * 60 * 1000)) === dayKey);
      
      if (dayData && dayData.close && !isNaN(dayData.close.value) && dayData.close.value > 0) {
        // Double-check price validity
        if (dayData.close.value < 0.01 || dayData.close.value > 1000000) {
          skippedEvents++;
          currentDate = new Date(currentDate.getTime() + HOUR_MS);
          continue; // Skip unrealistic prices
        }
        
        // Use close price for the hour (simpler and less memory-intensive)
        events.push({
          timestamp: new Date(currentDate),
          price: dayData.close,
          volume: dayData.volume,
          type: 'simulated',
        });
        validEvents++;
      } else {
        skippedEvents++;
      }
      
      currentDate = new Date(currentDate.getTime() + HOUR_MS);
    }
    
    console.log(`   ✅ Simulated ${validEvents} hourly events (skipped ${skippedEvents} invalid)`);
    
    if (events.length === 0) {
      console.warn(`   ❌ No valid simulated events created for ${asset}`);
    }

    return events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}

/**
 * Pre-configured adapters for common protocols
 */
export class UniswapV4Adapter extends TheGraphDataAdapter {
  constructor(config: Omit<TheGraphConfig, 'subgraphUrl'> & { apiKey?: string; useUrlAuth?: boolean }) {
    const subgraphId = 'HNCFA9TyBqpo5qpe6QreQABAA1kV8g46mhkCcicu6v2R';
    
    // The Graph supports TWO authentication methods:
    // Method 1: URL method - API key in URL path
    // Method 2: Header method - API key in Authorization header (Bearer token)
    // Try URL method first if API key is provided, fallback to header method
    
    let endpoint: string;
    let apiKeyForHeader: string | undefined;
    
    if (config.apiKey && config.useUrlAuth !== false) {
      // Method 1: URL method - https://gateway.thegraph.com/api/{API_KEY}/subgraphs/id/{SUBGRAPH_ID}
      endpoint = `https://gateway.thegraph.com/api/${config.apiKey}/subgraphs/id/${subgraphId}`;
      // Don't send API key in header when using URL method
      apiKeyForHeader = undefined;
    } else if (config.apiKey) {
      // Method 2: Header method - API key in Authorization header
      endpoint = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;
      apiKeyForHeader = config.apiKey;
    } else {
      // No API key - use public endpoint
      endpoint = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;
      apiKeyForHeader = undefined;
    }

    super({
      ...config,
      subgraphUrl: endpoint,
      apiKey: apiKeyForHeader, // Will be used in Authorization header if provided
    });
  }
}

export class UniswapV3Adapter extends TheGraphDataAdapter {
  constructor(config: Omit<TheGraphConfig, 'subgraphUrl'> & { apiKey?: string; useUrlAuth?: boolean }) {
    const subgraphId = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
    
    let endpoint: string;
    let apiKeyForHeader: string | undefined;
    
    if (config.apiKey && config.useUrlAuth !== false) {
      // URL method - API key in URL path
      endpoint = `https://gateway.thegraph.com/api/${config.apiKey}/subgraphs/id/${subgraphId}`;
      apiKeyForHeader = undefined;
    } else if (config.apiKey) {
      // Header method - API key in Authorization header
      endpoint = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;
      apiKeyForHeader = config.apiKey;
    } else {
      // No API key - use public endpoint
      endpoint = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;
      apiKeyForHeader = undefined;
    }

    super({
      ...config,
      subgraphUrl: endpoint,
      apiKey: apiKeyForHeader,
    });
  }
}

export class UniswapV2Adapter extends TheGraphDataAdapter {
  constructor(config: Omit<TheGraphConfig, 'subgraphUrl'>) {
    super({
      ...config,
      subgraphUrl: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2-ethereum',
    });
  }
}

export class CurveAdapter extends TheGraphDataAdapter {
  constructor(config: Omit<TheGraphConfig, 'subgraphUrl'>) {
    super({
      ...config,
      subgraphUrl: 'https://api.thegraph.com/subgraphs/name/curvefi/curve-v1-ethereum',
    });
  }
}


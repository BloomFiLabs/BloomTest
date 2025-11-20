/**
 * Aave v3 Data Adapter
 * Fetches historical lending/borrowing rates and incentive APRs from Aave v3 subgraph
 */

import axios, { AxiosInstance } from 'axios';

export interface AaveV3Config {
  apiKey?: string;
  reserveAddresses?: Array<{ symbol: string; address: string }>;
}

export interface ReserveRateData {
  date: Date;
  supplyAPR: number;
  borrowAPR: number;
  incentiveAPR: number;
}

export interface Reserve {
  symbol: string;
  address: string;
  name: string;
  decimals: number;
}

// Base network reserve addresses for common assets
// Note: The provided subgraph is for Aave v3 on Base, not Ethereum mainnet
const BASE_RESERVES: Array<{ symbol: string; address: string }> = [
  { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' },
  { symbol: 'cbBTC', address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' },
];

export class AaveV3Adapter {
  private client: AxiosInstance;
  private apiKey?: string;
  private subgraphUrl: string;
  private reserveAddresses: Array<{ symbol: string; address: string }>;

  constructor(config: AaveV3Config = {}) {
    this.apiKey = config.apiKey;
    // Use the user-provided Aave v3 subgraph (Gateway)
    this.subgraphUrl = 'https://gateway.thegraph.com/api/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF';
    this.reserveAddresses = config.reserveAddresses || BASE_RESERVES;
    
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

      // Only add auth header if using the Gateway (decentralized network)
      // Hosted service (api.thegraph.com) does not require/support Bearer tokens in the same way
      if (this.apiKey && this.subgraphUrl.includes('gateway.thegraph.com')) {
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
        throw new Error(`Aave subgraph query failed (${status}): ${JSON.stringify(errorData)}`);
      }
      throw new Error(`Aave subgraph query failed: ${error.message}`);
    }
  }

  /**
   * Convert Aave ray format (1e27) to percentage APR
   * Aave stores rates as annual rates in ray format
   * Formula: rate / 1e27 * 100
   */
  private rayToAPR(rayRate: string): number {
    const RAY = 1e27;
    const rate = parseFloat(rayRate);
    return (rate / RAY) * 100;
  }

  /**
   * Fetch available reserves from Aave v3
   */
  async fetchCurrentReserves(): Promise<Reserve[]> {
    const query = `
      query GetReserves {
        reserves(first: 100, orderBy: totalLiquidity, orderDirection: desc) {
          id
          symbol
          name
          decimals
          underlyingAsset
          isActive
        }
      }
    `;

    const data = await this.query<{
      reserves: Array<{
        id: string;
        symbol: string;
        name: string;
        decimals: number;
        underlyingAsset: string;
        isActive: boolean;
      }>;
    }>(query);

    return data.reserves
      .filter(r => r.isActive)
      .map(r => ({
        symbol: r.symbol,
        address: r.underlyingAsset.toLowerCase(),
        name: r.name,
        decimals: r.decimals,
      }));
  }

  /**
   * Fetch historical reserve rates for a specific asset
   * Returns daily supply APR, borrow APR, and incentive APR
   */
  async fetchReserveRatesHistory(
    assetAddress: string,
    startDate: Date,
    endDate: Date
  ): Promise<ReserveRateData[]> {
    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    const endTimestamp = Math.floor(endDate.getTime() / 1000);
    const assetAddressLower = assetAddress.toLowerCase();

    console.log(`📡 Fetching Aave v3 rate history for ${assetAddress}...`);
    console.log(`   Window: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);

    // Strategy: Sample one rate per day to cover long periods efficiently
    // Instead of fetching ALL events (high-frequency pools have 1000s/day),
    // we fetch the first event of each day
    const totalDays = Math.ceil((endTimestamp - startTimestamp) / 86400);
    const dailyRates = new Map<string, {
      timestamp: number;
      liquidityRate: string;
      variableBorrowRate: string;
      stableBorrowRate: string;
    }>();

    console.log(`   Sampling rates for ${totalDays} days...`);
    
    // Fetch in batches of 30 days to avoid timeouts
    const batchDays = 30;
    const numBatches = Math.ceil(totalDays / batchDays);
    
    for (let batch = 0; batch < numBatches; batch++) {
      const batchStart = startTimestamp + (batch * batchDays * 86400);
      const batchEnd = Math.min(batchStart + (batchDays * 86400), endTimestamp);
      
      const query = `
        query GetReserveRatesHistory(
          $reserveAddress: String!,
          $batchStart: Int!,
          $batchEnd: Int!
        ) {
          reserveParamsHistoryItems(
            where: {
              reserve_: { underlyingAsset: $reserveAddress },
              timestamp_gte: $batchStart,
              timestamp_lte: $batchEnd
            }
            orderBy: timestamp
            orderDirection: asc
            first: 1000
          ) {
            timestamp
            liquidityRate
            variableBorrowRate
            stableBorrowRate
          }
        }
      `;

      const variables = {
        reserveAddress: assetAddressLower,
        batchStart,
        batchEnd,
      };

      const data = await this.query<{
        reserveParamsHistoryItems: Array<{
          timestamp: number;
          liquidityRate: string;
          variableBorrowRate: string;
          stableBorrowRate: string;
        }>;
      }>(query, variables);

      if (data.reserveParamsHistoryItems && data.reserveParamsHistoryItems.length > 0) {
        // Group by day and take first rate of each day
        for (const item of data.reserveParamsHistoryItems) {
          const date = new Date(item.timestamp * 1000);
          const dateKey = date.toISOString().split('T')[0];
          
          if (!dailyRates.has(dateKey)) {
            dailyRates.set(dateKey, item);
          }
        }
      }
    }

    if (dailyRates.size === 0) {
      console.warn(`   ⚠️  No rate history found for ${assetAddress}`);
      return [];
    }

    console.log(`   ✅ Found rates for ${dailyRates.size} days`);

    // Now fetch incentive data (if available)
    const incentivesQuery = `
      query GetIncentives(
        $reserveAddress: String!,
        $startTimestamp: Int!,
        $endTimestamp: Int!
      ) {
        reserves(where: { underlyingAsset: $reserveAddress }) {
          id
          symbol
          aIncentivesLastUpdateTimestamp
          vIncentivesLastUpdateTimestamp
          aTokenIncentivesIndex
          vTokenIncentivesIndex
        }
      }
    `;

    let baseIncentiveAPR = 0;
    try {
      const incentiveData = await this.query<{
        reserves: Array<{
          id: string;
          symbol: string;
          aIncentivesLastUpdateTimestamp?: number;
          vIncentivesLastUpdateTimestamp?: number;
          aTokenIncentivesIndex?: string;
          vTokenIncentivesIndex?: string;
        }>;
      }>(incentivesQuery, { reserveAddress: assetAddressLower, startTimestamp, endTimestamp });

      // For now, use a simplified incentive model
      // In production, you'd compute this from emission rates and token prices
      if (incentiveData.reserves && incentiveData.reserves.length > 0) {
        const reserve = incentiveData.reserves[0];
        // Placeholder: check if incentives are active
        if (reserve.aTokenIncentivesIndex && parseFloat(reserve.aTokenIncentivesIndex) > 0) {
          baseIncentiveAPR = 2; // Assume 2% base incentive if active
        }
      }
    } catch (error) {
      console.warn(`   ⚠️  Could not fetch incentive data, using 0%`);
    }

    // Convert to final format
    const result: ReserveRateData[] = [];
    
    for (const [dateKey, item] of dailyRates.entries()) {
      const supplyAPR = this.rayToAPR(item.liquidityRate);
      const borrowAPR = this.rayToAPR(item.variableBorrowRate);

      result.push({
        date: new Date(dateKey),
        supplyAPR,
        borrowAPR,
        incentiveAPR: baseIncentiveAPR,
      });
    }
    
    result.sort((a, b) => a.date.getTime() - b.date.getTime());
    
    return result;
  }

  /**
   * Get reserve address by symbol
   */
  getReserveAddress(symbol: string): string | undefined {
    const reserve = this.reserveAddresses.find(r => r.symbol.toUpperCase() === symbol.toUpperCase());
    return reserve?.address;
  }

  /**
   * Add custom reserve address
   */
  addReserve(symbol: string, address: string): void {
    this.reserveAddresses.push({ symbol, address });
  }

  /**
   * Get statistics for a rate series
   */
  getRateStatistics(rates: ReserveRateData[]): {
    supplyAPR: { min: number; max: number; avg: number; p50: number; p75: number; p90: number };
    borrowAPR: { min: number; max: number; avg: number; p50: number; p75: number; p90: number };
    incentiveAPR: { min: number; max: number; avg: number };
  } {
    const supplyRates = rates.map(r => r.supplyAPR).sort((a, b) => a - b);
    const borrowRates = rates.map(r => r.borrowAPR).sort((a, b) => a - b);
    const incentiveRates = rates.map(r => r.incentiveAPR);

    const percentile = (arr: number[], p: number) => {
      const idx = Math.floor(p * (arr.length - 1));
      return arr[idx] || 0;
    };

    const avg = (arr: number[]) => arr.reduce((sum, x) => sum + x, 0) / arr.length;

    return {
      supplyAPR: {
        min: supplyRates[0] || 0,
        max: supplyRates[supplyRates.length - 1] || 0,
        avg: avg(supplyRates),
        p50: percentile(supplyRates, 0.5),
        p75: percentile(supplyRates, 0.75),
        p90: percentile(supplyRates, 0.9),
      },
      borrowAPR: {
        min: borrowRates[0] || 0,
        max: borrowRates[borrowRates.length - 1] || 0,
        avg: avg(borrowRates),
        p50: percentile(borrowRates, 0.5),
        p75: percentile(borrowRates, 0.75),
        p90: percentile(borrowRates, 0.9),
      },
      incentiveAPR: {
        min: Math.min(...incentiveRates),
        max: Math.max(...incentiveRates),
        avg: avg(incentiveRates),
      },
    };
  }
}


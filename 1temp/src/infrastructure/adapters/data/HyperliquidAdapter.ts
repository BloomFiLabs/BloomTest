import axios from 'axios';
import { DataAdapter, OHLCVData } from './DataAdapter';
import { Price, Amount, FundingRate, IV } from '../../../domain/value-objects';

const API_URL = 'https://api.hyperliquid.xyz/info';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class HyperliquidAdapter implements DataAdapter {
  private symbol: string;
  private fundingRateCache: Map<number, FundingRate> = new Map(); // Cache by day timestamp
  private fundingHistoryCache: Array<{ timestamp: Date, rate: number }> | null = null;

  constructor(symbol: string = 'ETH') {
    this.symbol = symbol;
  }

  /**
   * Pre-fetch and cache funding history for a date range (daily granularity)
   * Call this once at the start of backtest instead of per-event
   * Uses daily rates to reduce API calls significantly
   */
  async preloadFundingHistory(asset: string, startDate: Date, endDate: Date): Promise<void> {
    try {
      // Fetch funding history for the entire range
      const history = await this.fetchFundingHistory(asset, startDate, endDate);
      this.fundingHistoryCache = history;
      
      // Build cache map by day (not hour) - use daily average rate
      const dailyRates = new Map<number, number[]>();
      
      for (const entry of history) {
        // Round to start of day
        const dayTimestamp = Math.floor(entry.timestamp.getTime() / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
        
        if (!dailyRates.has(dayTimestamp)) {
          dailyRates.set(dayTimestamp, []);
        }
        dailyRates.get(dayTimestamp)!.push(entry.rate);
      }
      
      // Calculate daily average rates and cache them
      for (const [dayTimestamp, rates] of dailyRates.entries()) {
        const avgRate = rates.reduce((sum, r) => sum + r, 0) / rates.length;
        this.fundingRateCache.set(dayTimestamp, FundingRate.create(avgRate));
      }
      
      console.log(`   ✅ Cached ${this.fundingRateCache.size} daily funding rates`);
    } catch (error) {
      console.warn(`Failed to preload Hyperliquid funding history: ${error}`);
    }
  }

  async fetchPrice(asset: string, timestamp: Date): Promise<Price> {
    // For simplicity in this implementation, we fetch the candle for the timestamp
    const candles = await this.fetchOHLCV(asset, timestamp, timestamp);
    if (candles.length === 0) throw new Error(`No price for ${asset} at ${timestamp}`);
    return candles[0].close;
  }

  async fetchOHLCV(asset: string, startDate: Date, endDate: Date): Promise<OHLCVData[]> {
    try {
      const response = await axios.post(API_URL, {
        type: 'candleSnapshot',
        req: {
          coin: asset,
          interval: '1h',
          startTime: startDate.getTime(),
          endTime: endDate.getTime(),
        },
      });

      const candles = response.data;
      if (!Array.isArray(candles)) return [];

      return candles.map((c: any) => ({
        timestamp: new Date(c.t),
        open: Price.create(parseFloat(c.o)),
        high: Price.create(parseFloat(c.h)),
        low: Price.create(parseFloat(c.l)),
        close: Price.create(parseFloat(c.c)),
        volume: Amount.create(parseFloat(c.v)),
      }));
    } catch (error: any) {
      if (error.response?.status === 429) {
        console.warn(`   ⚠️  Hyperliquid API Rate Limit (429). Retrying in 5s...`);
        await sleep(5000);
        // Retry once
        try {
          const retryResponse = await axios.post(API_URL, {
            type: 'candleSnapshot',
            req: {
              coin: asset,
              interval: '1h',
              startTime: startDate.getTime(),
              endTime: endDate.getTime(),
            },
          });
          const candles = retryResponse.data;
          if (!Array.isArray(candles)) return [];
          return candles.map((c: any) => ({
            timestamp: new Date(c.t),
            open: Price.create(parseFloat(c.o)),
            high: Price.create(parseFloat(c.h)),
            low: Price.create(parseFloat(c.l)),
            close: Price.create(parseFloat(c.c)),
            volume: Amount.create(parseFloat(c.v)),
          }));
        } catch (retryError) {
           console.warn(`   ❌  Retry failed.`);
           return [];
        }
      }
      throw error;
    }
  }

  async fetchFundingRate(asset: string, timestamp: Date): Promise<FundingRate | null> {
    // Check cache first (by day - not hour)
    const dayTimestamp = Math.floor(timestamp.getTime() / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
    if (this.fundingRateCache.has(dayTimestamp)) {
      return this.fundingRateCache.get(dayTimestamp)!;
    }

    // If we have pre-loaded history but cache miss, find closest day's rate
    if (this.fundingHistoryCache && this.fundingHistoryCache.length > 0) {
      // Find the closest entry to this timestamp
      const closest = this.fundingHistoryCache.reduce((prev, curr) => {
        return Math.abs(curr.timestamp.getTime() - timestamp.getTime()) < Math.abs(prev.timestamp.getTime() - timestamp.getTime())
          ? curr
          : prev;
      });
      
      // Use the day of the closest entry
      const closestDayTimestamp = Math.floor(closest.timestamp.getTime() / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
      const rate = FundingRate.create(closest.rate);
      this.fundingRateCache.set(closestDayTimestamp, rate);
      return rate;
    }

    // Fallback: fetch from API (only if cache miss) - use daily window
    const dayStart = Math.floor(timestamp.getTime() / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
    const dayEnd = dayStart + (24 * 60 * 60 * 1000);

    try {
      const response = await axios.post(API_URL, {
        type: 'fundingHistory',
        coin: asset,
        startTime: dayStart,
        endTime: dayEnd,
      });

      const history = response.data;
      if (!Array.isArray(history) || history.length === 0) return null;

      // Calculate average rate for the day
      const rates = history.map((h: any) => parseFloat(h.fundingRate));
      const avgRate = rates.reduce((sum: number, r: number) => sum + r, 0) / rates.length;
      
      const rate = FundingRate.create(avgRate);
      this.fundingRateCache.set(dayTimestamp, rate);
      return rate;
    } catch (error: any) {
      if (error.response?.status === 429) {
        console.warn(`   ⚠️  Hyperliquid API Rate Limit (429) on funding fetch.`);
        return null;
      }
      return null;
    }
  }

  async fetchFundingHistory(asset: string, startDate: Date, endDate: Date): Promise<Array<{ timestamp: Date, rate: number }>> {
    try {
      const response = await axios.post(API_URL, {
        type: 'fundingHistory',
        coin: asset,
        startTime: startDate.getTime(),
        endTime: endDate.getTime(),
      });
      
      const history = response.data.map((f: any) => ({
        timestamp: new Date(f.time),
        rate: parseFloat(f.fundingRate)
      }));
      
      console.log(`   ✅ Fetched ${history.length} funding rate entries`);
      return history;
    } catch (error: any) {
      if (error.response?.status === 429) {
        console.warn(`   ⚠️  Hyperliquid API Rate Limit (429) on history fetch. Retrying with exponential backoff...`);
        // Exponential backoff: wait 10 seconds, then retry
        await sleep(10000);
        try {
          const retryResponse = await axios.post(API_URL, {
            type: 'fundingHistory',
            coin: asset,
            startTime: startDate.getTime(),
            endTime: endDate.getTime(),
          });
          const history = retryResponse.data.map((f: any) => ({
            timestamp: new Date(f.time),
            rate: parseFloat(f.fundingRate)
          }));
          console.log(`   ✅ Fetched ${history.length} funding rate entries (after retry)`);
          return history;
        } catch (retryError) {
          console.warn(`   ❌ Retry failed. Using empty history.`);
          return [];
        }
      }
      console.warn(`   ⚠️  Failed to fetch funding history: ${(error as Error).message}`);
      return [];
    }
  }

  async fetchIV(asset: string, timestamp: Date): Promise<IV | null> {
    return null;
  }

  async fetchVolume(asset: string, timestamp: Date): Promise<Amount> {
    const candles = await this.fetchOHLCV(asset, timestamp, timestamp);
    return candles.length > 0 ? candles[0].volume : Amount.zero();
  }
}

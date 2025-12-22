import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiClient } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import { LighterWebSocketProvider } from './LighterWebSocketProvider';
import {
  IFundingDataProvider,
  FundingRateData,
  FundingDataRequest,
} from '../../../domain/ports/IFundingDataProvider';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import { RateLimiterService, RateLimitPriority } from '../../../infrastructure/services/RateLimiterService';

interface LighterFundingRate {
  market_id: number;
  exchange: string;
  symbol: string;
  rate: number;
}

interface LighterFundingRatesResponse {
  code: number;
  funding_rates: LighterFundingRate[];
}

/**
 * LighterFundingDataProvider - Fetches funding rate data from Lighter Protocol
 *
 * Uses the funding-rates endpoint to fetch all rates at once and caches them
 */
@Injectable()
export class LighterFundingDataProvider
  implements OnModuleInit, IFundingDataProvider
{
  private readonly logger = new Logger(LighterFundingDataProvider.name);
  private readonly apiClient: ApiClient;
  private readonly baseUrl: string;

  // Cache for funding rates (key: market_id, value: rate)
  private fundingRatesCache: Map<number, number> = new Map();
  private lastCacheUpdate: number = 0;
  private readonly CACHE_TTL = 10000; // 10 second cache (funding rates update hourly, but we want fresh data for performance metrics)

  // Rate limiter weights (matching LighterExchangeAdapter)
  private readonly WEIGHT_INFO = 1; // Light read operations

  constructor(
    private readonly configService: ConfigService,
    private readonly rateLimiter: RateLimiterService,
    @Optional() private readonly wsProvider?: LighterWebSocketProvider,
  ) {
    this.baseUrl =
      this.configService.get<string>('LIGHTER_API_BASE_URL') ||
      'https://mainnet.zklighter.elliot.ai';
    this.apiClient = new ApiClient({ host: this.baseUrl });
  }

  /**
   * Helper method to wrap API calls with rate limiting
   */
  private async callApi<T>(weight: number, fn: () => Promise<T>, priority: RateLimitPriority = RateLimitPriority.NORMAL): Promise<T> {
    await this.rateLimiter.acquire(ExchangeType.LIGHTER, weight, priority);
    return await fn();
  }

  /**
   * Initialize and fetch funding rates on module init
   */
  async onModuleInit() {
    await this.refreshFundingRates();
  }

  /**
   * Fetch all funding rates from Lighter API and cache them
   */
  async refreshFundingRates(): Promise<void> {
    const maxRetries = 5;
    const baseDelay = 3000;
    const maxDelay = 60000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        const fundingUrl = `${this.baseUrl}/api/v1/funding-rates`;
        const response = await this.callApi(this.WEIGHT_INFO, () => axios.get<LighterFundingRatesResponse>(
          fundingUrl,
          {
            timeout: 10000,
          },
        ));

        if (
          response.data?.code === 200 &&
          Array.isArray(response.data.funding_rates)
        ) {
          // Clear old cache
          this.fundingRatesCache.clear();

          // Populate cache with all funding rates
          for (const rate of response.data.funding_rates) {
            // Lighter API returns daily funding rates (24h), convert to hourly for consistency
            // Most other exchanges (Hyperliquid, etc.) provide hourly rates
            const hourlyRate = rate.rate / 24;
            this.fundingRatesCache.set(rate.market_id, hourlyRate);
          }

          this.lastCacheUpdate = Date.now();
          // Only log when initially caching or if size changes significantly
          return; // Success
        } else {
          this.logger.warn(
            'Lighter funding-rates API returned unexpected format',
          );
          break;
        }
      } catch (error: any) {
        const statusCode = error?.response?.status;
        const isRateLimit = statusCode === 429;
        
        if (isRateLimit && attempt < maxRetries - 1) {
          // Only log at debug level during retries
          this.logger.debug(
            `Rate limited (429) refreshing Lighter funding rates (attempt ${attempt + 1}/${maxRetries})...`,
          );
          continue;
        }
        
        // Only log error on final failure
        if (attempt === maxRetries - 1) {
          this.logger.error(
            `Failed to refresh Lighter funding rates after ${maxRetries} attempts: ${error.message}`,
          );
        }
        break;
      }
    }
  }

  /**
   * Ensure cache is fresh (refresh if needed)
   */
  private async ensureCacheFresh(forceRefresh: boolean = false): Promise<void> {
    const now = Date.now();
    if (
      forceRefresh ||
      this.fundingRatesCache.size === 0 ||
      now - this.lastCacheUpdate > this.CACHE_TTL
    ) {
      await this.refreshFundingRates();
    }
  }

  /**
   * Get current funding rate for a market
   * Uses cached funding rates from the funding-rates API endpoint
   * @param marketIndex Market index (e.g., 0 for ETH/USDC)
   * @param forceRefresh If true, force refresh the cache before returning
   * @returns Funding rate as decimal (e.g., 0.0001 = 0.01%)
   */
  async getCurrentFundingRate(
    marketIndex: number,
    forceRefresh: boolean = false,
  ): Promise<number> {
    await this.ensureCacheFresh(forceRefresh);

    const rate = this.fundingRatesCache.get(marketIndex);
    if (rate !== undefined) {
      return rate;
    }

    // If not in cache, return 0 (market might not exist or have no funding rate)
    return 0;
  }

  /**
   * Get predicted next funding rate
   * @param marketIndex Market index
   * @returns Predicted funding rate as decimal
   */
  async getPredictedFundingRate(marketIndex: number): Promise<number> {
    try {
      // Use current funding rate as prediction (Lighter may not provide prediction)
      return await this.getCurrentFundingRate(marketIndex);
    } catch (error: any) {
      this.logger.error(
        `Failed to get predicted funding rate for market ${marketIndex}: ${error.message}`,
      );
      throw new Error(
        `Failed to get Lighter predicted funding rate: ${error.message}`,
      );
    }
  }

  /**
   * Get open interest for a market
   * @param marketIndex Market index
   * @returns Open interest in USD
   */
  async getOpenInterest(marketIndex: number): Promise<number> {
    // 1. Try WebSocket provider first (zero cost, real-time)
    if (this.wsProvider) {
      const wsOi = this.wsProvider.getOpenInterest(marketIndex);
      if (wsOi !== undefined && wsOi > 0) {
        return wsOi;
      }
    }

    // 2. Fall back to REST API
    try {
      const orderBookUrl = `${this.baseUrl}/api/v1/orderBookDetails`;
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(orderBookUrl, {
        timeout: 10000,
        params: { market_id: marketIndex },
      }));

      this.logger.log(
        `  📥 Response: code=${response.data?.code}, has order_book_details=${!!response.data?.order_book_details?.length}`,
      );

      // Validate response structure
      if (response.data?.code !== 200) {
        const errorMsg = `Invalid response code: ${response.data?.code}. Response: ${JSON.stringify(response.data)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }

      if (
        !response.data?.order_book_details ||
        response.data.order_book_details.length === 0
      ) {
        const errorMsg = `No order_book_details in response. Response: ${JSON.stringify(response.data)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }

      const orderBookDetail = response.data.order_book_details[0];

      // Validate market_id matches
      if (orderBookDetail.market_id !== marketIndex) {
        const errorMsg = `Market ID mismatch: expected ${marketIndex}, got ${orderBookDetail.market_id}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }

      // Extract and parse values
      const openInterestRaw = orderBookDetail.open_interest;
      const markPriceRaw = orderBookDetail.last_trade_price;

      // Validate raw values exist
      if (openInterestRaw === undefined || openInterestRaw === null) {
        const errorMsg = `open_interest field missing or null. Response: ${JSON.stringify(orderBookDetail)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }

      if (markPriceRaw === undefined || markPriceRaw === null) {
        const errorMsg = `last_trade_price field missing or null. Response: ${JSON.stringify(orderBookDetail)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }

      // Parse values
      const openInterest =
        typeof openInterestRaw === 'string'
          ? parseFloat(openInterestRaw)
          : openInterestRaw || 0;
      const markPrice =
        typeof markPriceRaw === 'string'
          ? parseFloat(markPriceRaw)
          : markPriceRaw || 0;

      this.logger.log(
        `  📊 Parsed values: Raw OI=${openInterestRaw}, Parsed OI=${openInterest}, Raw Price=${markPriceRaw}, Parsed Price=${markPrice}`,
      );

      // Validate parsed values
      if (isNaN(openInterest)) {
        const errorMsg = `Failed to parse open_interest: "${openInterestRaw}" is not a valid number`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }

      if (isNaN(markPrice) || markPrice <= 0) {
        const errorMsg = `Invalid mark price: "${markPriceRaw}" parsed to ${markPrice} (must be > 0)`;
        this.logger.debug(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }

      // open_interest is in base token units, multiply by mark price for USD value
      // Note: OI can be 0 (valid case), so we allow it
      const oiUsd = openInterest * markPrice;

      if (isNaN(oiUsd) || oiUsd < 0) {
        const errorMsg = `Invalid calculated OI USD: ${oiUsd} (OI=${openInterest}, Price=${markPrice})`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }

      this.logger.log(
        `  ✅ SUCCESS: Returned $${oiUsd.toLocaleString()} (OI: ${openInterest}, Price: ${markPrice})`,
      );
      return oiUsd;
      } catch (error: any) {
        // If it's already our error, re-throw it
        if (error.message && error.message.includes('Lighter OI API error')) {
          throw error;
        }

        // Otherwise, wrap it with context
        const errorMsg = error.response
          ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
          : error.message || 'Unknown error';

        // Only log error on final failure (this method doesn't have retry logic, so log immediately)
        this.logger.error(
          `  ❌ ERROR: Failed to get Lighter OI for market ${marketIndex}: ${errorMsg}`,
        );
        this.logger.error(`  📄 Full error: ${error.stack || error}`);

        throw new Error(
          `Lighter OI API error for market ${marketIndex}: ${errorMsg}`,
        );
      }
  }

  /**
   * Get both open interest and mark price together from orderBookDetails API
   * This is more efficient than calling them separately
   * @param marketIndex Market index
   * @returns Object with openInterest (USD) and markPrice
   */
  async getOpenInterestAndMarkPrice(
    marketIndex: number,
  ): Promise<{ openInterest: number; markPrice: number }> {
    // 1. Try WebSocket provider first (zero cost, real-time)
    if (this.wsProvider) {
      const wsOi = this.wsProvider.getOpenInterest(marketIndex);
      const wsMarkPrice = this.wsProvider.getMarkPrice(marketIndex);
      
      if (wsOi !== undefined && wsMarkPrice !== undefined && wsOi > 0 && wsMarkPrice > 0) {
        return { openInterest: wsOi, markPrice: wsMarkPrice };
      }
    }

    // 2. Fall back to REST API
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const orderBookUrl = `${this.baseUrl}/api/v1/orderBookDetails`;
        const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(orderBookUrl, {
          timeout: 10000,
          params: { market_id: marketIndex },
        }));

        // Validate response structure
        if (response.data?.code !== 200) {
          const errorMsg = `Invalid response code: ${response.data?.code}. Response: ${JSON.stringify(response.data)}`;
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.error(`  ❌ ERROR: ${errorMsg}`);
          }
          throw new Error(
            `Lighter API error for market ${marketIndex}: ${errorMsg}`,
          );
        }

        if (
          !response.data?.order_book_details ||
          response.data.order_book_details.length === 0
        ) {
          const errorMsg = `No order_book_details in response. Response: ${JSON.stringify(response.data)}`;
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.error(`  ❌ ERROR: ${errorMsg}`);
          }
          throw new Error(
            `Lighter API error for market ${marketIndex}: ${errorMsg}`,
          );
        }

        const orderBookDetail = response.data.order_book_details[0];

        // Validate market_id matches
        if (orderBookDetail.market_id !== marketIndex) {
          const errorMsg = `Market ID mismatch: expected ${marketIndex}, got ${orderBookDetail.market_id}`;
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.error(`  ❌ ERROR: ${errorMsg}`);
          }
          throw new Error(
            `Lighter API error for market ${marketIndex}: ${errorMsg}`,
          );
        }

        // Extract and parse values
        const openInterestRaw = orderBookDetail.open_interest;
        const markPriceRaw = orderBookDetail.last_trade_price;

        // Validate raw values exist
        if (openInterestRaw === undefined || openInterestRaw === null) {
          const errorMsg = `open_interest field missing or null. Response: ${JSON.stringify(orderBookDetail)}`;
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.error(`  ❌ ERROR: ${errorMsg}`);
          }
          throw new Error(
            `Lighter API error for market ${marketIndex}: ${errorMsg}`,
          );
        }

        if (markPriceRaw === undefined || markPriceRaw === null) {
          const errorMsg = `last_trade_price field missing or null. Response: ${JSON.stringify(orderBookDetail)}`;
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.error(`  ❌ ERROR: ${errorMsg}`);
          }
          throw new Error(
            `Lighter API error for market ${marketIndex}: ${errorMsg}`,
          );
        }

        // Parse values
        const openInterest =
          typeof openInterestRaw === 'string'
            ? parseFloat(openInterestRaw)
            : openInterestRaw || 0;
        const markPrice =
          typeof markPriceRaw === 'string'
            ? parseFloat(markPriceRaw)
            : markPriceRaw || 0;

        // Validate parsed values
        if (isNaN(openInterest)) {
          const errorMsg = `Failed to parse open_interest: "${openInterestRaw}" is not a valid number`;
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.error(`  ❌ ERROR: ${errorMsg}`);
          }
          throw new Error(
            `Lighter API error for market ${marketIndex}: ${errorMsg}`,
          );
        }

        if (isNaN(markPrice) || markPrice <= 0) {
          const errorMsg = `Invalid mark price: "${markPriceRaw}" parsed to ${markPrice} (must be > 0)`;
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.debug(`  ❌ ERROR: ${errorMsg}`);
          }
          throw new Error(
            `Lighter API error for market ${marketIndex}: ${errorMsg}`,
          );
        }

        // open_interest is in base token units, multiply by mark price for USD value
        const oiUsd = openInterest * markPrice;

        if (isNaN(oiUsd) || oiUsd < 0) {
          const errorMsg = `Invalid calculated OI USD: ${oiUsd} (OI=${openInterest}, Price=${markPrice})`;
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.error(`  ❌ ERROR: ${errorMsg}`);
          }
          throw new Error(
            `Lighter API error for market ${marketIndex}: ${errorMsg}`,
          );
        }

        return { openInterest: oiUsd, markPrice };
      } catch (error: any) {
        // Check if it's a rate limit error (429)
        const statusCode = error.response?.status;
        const errorMsg = error.response
          ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
          : error.message || 'Unknown error';

        const isRateLimit =
          statusCode === 429 ||
          errorMsg.includes('Too Many Requests') ||
          errorMsg.includes('429') ||
          errorMsg.includes('rate limit');

        if (isRateLimit && attempt < maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s
          const backoffMs = Math.pow(2, attempt) * 1000;
          this.logger.debug(
            `OI/price fetch rate limited for market ${marketIndex} (attempt ${attempt + 1}/${maxRetries}). ` +
              `Retrying in ${backoffMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        // If it's already our error, re-throw it
        if (error.message && error.message.includes('Lighter API error')) {
          // Only log on final attempt
          if (attempt === maxRetries - 1) {
            this.logger.error(
              `  ❌ ERROR: Failed to get Lighter OI and mark price for market ${marketIndex}: ${error.message}`,
            );
            this.logger.error(`  📄 Full error: ${error.stack || error}`);
          }
          throw error;
        }

        // Only log ERROR level on final attempt
        if (attempt === maxRetries - 1) {
          this.logger.error(
            `  ❌ ERROR: Failed to get Lighter OI and mark price for market ${marketIndex} after ${maxRetries} attempts: ${errorMsg}`,
          );
          this.logger.error(`  📄 Full error: ${error.stack || error}`);
        }

        lastError = new Error(
          `Lighter API error for market ${marketIndex}: ${errorMsg}`,
        );
        throw lastError;
      }
    }

    throw (
      lastError ||
      new Error(
        `Lighter API error for market ${marketIndex}: Max retries exceeded`,
      )
    );
  }

  /**
   * Get mark price for a market
   * Tries multiple methods: orderBookDetails API, order book SDK, funding rates API, or market data SDK
   * @param marketIndex Market index
   * @returns Mark price
   */
  async getMarkPrice(marketIndex: number): Promise<number> {
    const errors: string[] = [];

    // Method 0: Try orderBookDetails API first (same as getOpenInterest, most reliable)
    try {
      const orderBookUrl = `${this.baseUrl}/api/v1/orderBookDetails`;
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(orderBookUrl, {
        timeout: 10000,
        params: { market_id: marketIndex },
      }));

      if (
        response.data?.code === 200 &&
        response.data?.order_book_details?.length > 0
      ) {
        const detail = response.data.order_book_details[0];
        if (
          detail.last_trade_price !== undefined &&
          detail.last_trade_price !== null
        ) {
          const markPrice =
            typeof detail.last_trade_price === 'string'
              ? parseFloat(detail.last_trade_price)
              : detail.last_trade_price;

          if (!isNaN(markPrice) && markPrice > 0) {
            this.logger.debug(
              `Got mark price from orderBookDetails API for market ${marketIndex}: ${markPrice}`,
            );
            return markPrice;
          } else {
            errors.push(
              `orderBookDetails: Invalid last_trade_price value: ${detail.last_trade_price}`,
            );
          }
        } else {
          errors.push(`orderBookDetails: No last_trade_price in response`);
        }
      } else {
        errors.push(
          `orderBookDetails: Invalid response (code=${response.data?.code}, hasDetails=${!!response.data?.order_book_details?.length})`,
        );
      }
    } catch (error: any) {
      const errorMsg = error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      errors.push(`orderBookDetails API: ${errorMsg}`);
    }

    // Method 1: Try order book SDK (most accurate if available)
    try {
      const orderBook = await (
        this.apiClient as any
      ).order?.getOrderBookDetails({ marketIndex: marketIndex } as any);

      if (orderBook?.bestBid?.price && orderBook?.bestAsk?.price) {
        const midPrice =
          (parseFloat(orderBook.bestBid.price) +
            parseFloat(orderBook.bestAsk.price)) /
          2;
        if (!isNaN(midPrice) && midPrice > 0) {
          this.logger.debug(
            `Got mark price from OrderBook SDK for market ${marketIndex}: ${midPrice}`,
          );
          return midPrice;
        } else {
          errors.push(
            `OrderBook SDK: Invalid midPrice calculated: ${midPrice} (bid=${orderBook.bestBid.price}, ask=${orderBook.bestAsk.price})`,
          );
        }
      } else {
        errors.push(
          `OrderBook SDK: Missing bestBid/bestAsk (hasBestBid=${!!orderBook?.bestBid?.price}, hasBestAsk=${!!orderBook?.bestAsk?.price})`,
        );
        if (orderBook) {
          this.logger.debug(
            `OrderBook SDK response structure: ${JSON.stringify(orderBook).substring(0, 200)}`,
          );
        }
      }
    } catch (error: any) {
      errors.push(`OrderBook SDK: ${error.message || String(error)}`);
    }

    // Method 2: Try funding rates API (may include mark price)
    try {
      const fundingUrl = `${this.baseUrl}/api/v1/funding-rates`;
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(fundingUrl, {
        timeout: 10000,
        params: { market_index: marketIndex },
      }));

      if (
        response.data &&
        Array.isArray(response.data) &&
        response.data.length > 0
      ) {
        const latest = response.data[0];
        if (latest.mark_price) {
          const markPrice = parseFloat(latest.mark_price);
          if (!isNaN(markPrice) && markPrice > 0) {
            this.logger.debug(
              `Got mark price from funding-rates API for market ${marketIndex}: ${markPrice}`,
            );
            return markPrice;
          } else {
            errors.push(
              `Funding Rates: Invalid mark_price value: ${latest.mark_price}`,
            );
          }
        } else if (latest.price) {
          const price = parseFloat(latest.price);
          if (!isNaN(price) && price > 0) {
            this.logger.debug(
              `Got mark price from funding-rates API (price field) for market ${marketIndex}: ${price}`,
            );
            return price;
          } else {
            errors.push(`Funding Rates: Invalid price value: ${latest.price}`);
          }
        } else {
          errors.push(
            `Funding Rates: No mark_price or price in response. Response keys: ${Object.keys(latest).join(', ')}`,
          );
        }
      } else {
        errors.push(
          `Funding Rates: Empty or invalid response (isArray=${Array.isArray(response.data)}, length=${response.data?.length || 0})`,
        );
      }
    } catch (error: any) {
      const errorMsg = error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      errors.push(`Funding Rates API: ${errorMsg}`);
    }

    // Method 3: Try market data SDK as last resort
    try {
      const marketData = await (this.apiClient as any).market?.getMarketData({
        marketIndex,
      });
      if (marketData?.markPrice) {
        const markPrice = parseFloat(marketData.markPrice);
        if (!isNaN(markPrice) && markPrice > 0) {
          this.logger.debug(
            `Got mark price from Market Data SDK for market ${marketIndex}: ${markPrice}`,
          );
          return markPrice;
        } else {
          errors.push(
            `Market Data SDK: Invalid markPrice value: ${marketData.markPrice}`,
          );
        }
      } else if (marketData?.price) {
        const price = parseFloat(marketData.price);
        if (!isNaN(price) && price > 0) {
          this.logger.debug(
            `Got mark price from Market Data SDK (price field) for market ${marketIndex}: ${price}`,
          );
          return price;
        } else {
          errors.push(
            `Market Data SDK: Invalid price value: ${marketData.price}`,
          );
        }
      } else {
        errors.push(
          `Market Data SDK: No markPrice or price in response. Response keys: ${marketData ? Object.keys(marketData).join(', ') : 'null'}`,
        );
      }
    } catch (error: any) {
      errors.push(`Market Data SDK: ${error.message || String(error)}`);
    }

    // If all methods fail, throw error with detailed information
    const errorDetails = errors.join('; ');
    this.logger.error(
      `Failed to get Lighter mark price for market ${marketIndex}. All methods failed:`,
    );
    errors.forEach((err, idx) => {
      this.logger.error(`  Method ${idx}: ${err}`);
    });
    throw new Error(
      `Failed to get Lighter mark price for market ${marketIndex}: All methods failed. Details: ${errorDetails}`,
    );
  }

  /**
   * Convert symbol to market index
   * This is a simplified version - in production, you'd query available markets
   */
  async getMarketIndex(symbol: string): Promise<number> {
    const symbolToMarketIndex: Record<string, number> = {
      ETH: 0,
      BTC: 1,
      // Add more mappings as needed
    };

    const baseSymbol = symbol
      .replace('USDC', '')
      .replace('USDT', '')
      .replace('-PERP', '');
    return symbolToMarketIndex[baseSymbol] ?? 0; // Default to 0 (ETH/USDC)
  }

  /**
   * Get all available markets from Lighter
   * Uses the Explorer API: https://explorer.elliot.ai/api/markets
   * @returns Array of objects with marketIndex and symbol
   */
  async getAvailableMarkets(): Promise<
    Array<{ marketIndex: number; symbol: string }>
  > {
    try {
      // Use the Explorer API to get all markets
      // Based on: https://apidocs.lighter.xyz/reference/get_markets
      const explorerUrl = 'https://explorer.elliot.ai/api/markets';

      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(explorerUrl, {
        timeout: 10000,
      }));

      if (!response.data || !Array.isArray(response.data)) {
        this.logger.warn('Lighter Explorer API returned invalid data format');
        // Fallback: try orderBooks API
        return await this.getAvailableMarketsFallback();
      }

      // Map markets to our format
      // The API returns: [{"symbol":"JUP","market_index":26},{"symbol":"ADA","market_index":39},...]
      const markets = response.data.map((market: any) => {
        // API uses "market_index" (with underscore)
        const marketIndex =
          market.market_index ?? market.marketIndex ?? market.index ?? 0;
        const symbol =
          market.symbol ||
          market.baseAsset ||
          market.name ||
          `MARKET_${marketIndex}`;

        // Normalize symbol (remove USDC/USDT suffixes, already normalized from API)
        const normalizedSymbol = symbol
          .replace('USDC', '')
          .replace('USDT', '')
          .replace('-PERP', '')
          .replace('PERP', '')
          .toUpperCase();

        return {
          marketIndex: Number(marketIndex),
          symbol: normalizedSymbol,
        };
      });

      this.logger.debug(
        `Found ${markets.length} available markets on Lighter via Explorer API`,
      );
      return markets;
    } catch (error: any) {
      this.logger.warn(
        `Failed to get markets from Lighter Explorer API: ${error.message}`,
      );
      // Fallback: try orderBooks API
      return await this.getAvailableMarketsFallback();
    }
  }

  /**
   * Fallback method to get markets using orderBooks API
   */
  private async getAvailableMarketsFallback(): Promise<
    Array<{ marketIndex: number; symbol: string }>
  > {
    try {
      const orderBooks = await (this.apiClient as any).order?.getOrderBooks();

      if (!orderBooks || !Array.isArray(orderBooks)) {
        this.logger.warn('Lighter orderBooks API also failed');
        // Final fallback: return known markets
        return [
          { marketIndex: 0, symbol: 'ETH' },
          { marketIndex: 1, symbol: 'BTC' },
        ];
      }

      // Map order books to market indices and symbols
      const markets = orderBooks.map((book: any, index: number) => {
        const symbol = book.symbol || book.baseAsset || `MARKET_${index}`;
        return {
          marketIndex: index,
          symbol: symbol
            .replace('USDC', '')
            .replace('USDT', '')
            .replace('-PERP', '')
            .toUpperCase(),
        };
      });

      this.logger.debug(
        `Found ${markets.length} available markets on Lighter via orderBooks API`,
      );
      return markets;
    } catch (error: any) {
      this.logger.warn(
        `Failed to get markets from Lighter orderBooks API: ${error.message}`,
      );
      // Final fallback
      return [
        { marketIndex: 0, symbol: 'ETH' },
        { marketIndex: 1, symbol: 'BTC' },
      ];
    }
  }

  /**
   * Get 24-hour trading volume in USD for a market
   * Uses the orderBookDetails API which includes daily_quote_token_volume
   * @param marketIndex Market index
   * @returns 24h volume in USD
   */
  async get24hVolume(marketIndex: number): Promise<number> {
    try {
      // First try WebSocket provider if available (cached data)
      if (this.wsProvider) {
        const wsVolume = this.wsProvider.get24hVolume(marketIndex);
        if (wsVolume !== undefined && wsVolume > 0) {
          return wsVolume;
        }
      }

      // Fall back to REST API - orderBookDetails endpoint has volume
      const orderBookUrl = `${this.baseUrl}/api/v1/orderBookDetails`;
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(orderBookUrl, {
        timeout: 10000,
        params: { market_id: marketIndex },
      }));

      if (
        response.data?.code !== 200 ||
        !response.data?.order_book_details?.length
      ) {
        this.logger.warn(
          `No volume data available for Lighter market ${marketIndex}`,
        );
        return 0;
      }

      const orderBookDetail = response.data.order_book_details[0];

      // daily_quote_token_volume is already in USD (quote token = USDC)
      const volume = parseFloat(
        orderBookDetail.daily_quote_token_volume || '0',
      );

      if (isNaN(volume) || volume < 0) {
        this.logger.warn(
          `Invalid volume data for Lighter market ${marketIndex}: ${orderBookDetail.daily_quote_token_volume}`,
        );
        return 0;
      }

      return volume;
    } catch (error: any) {
      // Only log at debug level - this is a non-critical read operation
      // Errors are already logged by getOpenInterestAndMarkPrice if called together
      this.logger.debug(
        `Failed to get 24h volume for Lighter market ${marketIndex}: ${error.message}`,
      );
      return 0;
    }
  }

  // ============= IFundingDataProvider Implementation =============

  getExchangeType(): ExchangeType {
    return ExchangeType.LIGHTER;
  }

  /**
   * Get all funding data for a symbol in a single optimized call
   * Fetches current rate, predicted rate, mark price, OI, and volume together
   */
  async getFundingData(
    request: FundingDataRequest,
  ): Promise<FundingRateData | null> {
    const marketIndex = request.marketIndex;

    if (marketIndex === undefined) {
      this.logger.debug(
        `No market index for ${request.normalizedSymbol} on Lighter`,
      );
      return null;
    }

    try {
      // Fetch funding rate and OI/price in parallel
      const [currentRate, oiAndPrice, volume] = await Promise.all([
        this.getCurrentFundingRate(marketIndex),
        this.getOpenInterestAndMarkPrice(marketIndex).catch(() => null),
        this.get24hVolume(marketIndex).catch(() => undefined),
      ]);

      // If OI/price fetch failed, return null silently
      if (!oiAndPrice) {
        return null;
      }

      return {
        exchange: ExchangeType.LIGHTER,
        symbol: request.normalizedSymbol,
        currentRate,
        predictedRate: currentRate, // Lighter doesn't provide predicted rate
        markPrice: oiAndPrice.markPrice,
        openInterest: oiAndPrice.openInterest,
        volume24h: volume,
        timestamp: new Date(),
      };
    } catch (error: any) {
      // Silently fail for individual symbols - this is expected for some assets
      return null;
    }
  }

  supportsSymbol(normalizedSymbol: string): boolean {
    return true; // We'll rely on the symbol mapping to determine support
  }

  getExchangeSymbol(normalizedSymbol: string): number | undefined {
    // This would need to be populated from getAvailableMarkets()
    // For now, return undefined and let the aggregator handle the mapping
    return undefined;
  }
}

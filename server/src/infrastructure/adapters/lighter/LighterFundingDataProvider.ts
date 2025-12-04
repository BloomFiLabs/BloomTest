import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiClient } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import { LighterWebSocketProvider } from './LighterWebSocketProvider';

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
export class LighterFundingDataProvider implements OnModuleInit {
  private readonly logger = new Logger(LighterFundingDataProvider.name);
  private readonly apiClient: ApiClient;
  private readonly baseUrl: string;
  
  // Cache for funding rates (key: market_id, value: rate)
  private fundingRatesCache: Map<number, number> = new Map();
  private lastCacheUpdate: number = 0;
  private readonly CACHE_TTL = 60000; // 1 minute cache (funding rates update hourly)

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly wsProvider?: LighterWebSocketProvider,
  ) {
    this.baseUrl = this.configService.get<string>('LIGHTER_API_BASE_URL') || 'https://mainnet.zklighter.elliot.ai';
    this.apiClient = new ApiClient({ host: this.baseUrl });
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
    try {
      const fundingUrl = `${this.baseUrl}/api/v1/funding-rates`;
      
      const response = await axios.get<LighterFundingRatesResponse>(fundingUrl, {
        timeout: 10000,
      });

      if (response.data?.code === 200 && Array.isArray(response.data.funding_rates)) {
        // Clear old cache
        this.fundingRatesCache.clear();
        
        // Populate cache with all funding rates
        for (const rate of response.data.funding_rates) {
          this.fundingRatesCache.set(rate.market_id, rate.rate);
        }
        
        this.lastCacheUpdate = Date.now();
        this.logger.log(`Cached ${this.fundingRatesCache.size} Lighter funding rates`);
      } else {
        this.logger.warn('Lighter funding-rates API returned unexpected format');
      }
    } catch (error: any) {
      this.logger.error(`Failed to refresh Lighter funding rates: ${error.message}`);
      // Don't throw - allow using stale cache if available
    }
  }

  /**
   * Ensure cache is fresh (refresh if needed)
   */
  private async ensureCacheFresh(): Promise<void> {
    const now = Date.now();
    if (this.fundingRatesCache.size === 0 || (now - this.lastCacheUpdate) > this.CACHE_TTL) {
      await this.refreshFundingRates();
    }
  }

  /**
   * Get current funding rate for a market
   * Uses cached funding rates from the funding-rates API endpoint
   * @param marketIndex Market index (e.g., 0 for ETH/USDC)
   * @returns Funding rate as decimal (e.g., 0.0001 = 0.01%)
   */
  async getCurrentFundingRate(marketIndex: number): Promise<number> {
    await this.ensureCacheFresh();
    
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
      this.logger.error(`Failed to get predicted funding rate for market ${marketIndex}: ${error.message}`);
      throw new Error(`Failed to get Lighter predicted funding rate: ${error.message}`);
    }
  }

  /**
   * Get open interest for a market
   * @param marketIndex Market index
   * @returns Open interest in USD
   */
  async getOpenInterest(marketIndex: number): Promise<number> {
    this.logger.log(`🔍 LIGHTER OI CALL: getOpenInterest(${marketIndex}) - Starting...`);
    
    // Use orderBookDetails API endpoint (REST API)
    this.logger.log(`  🌐 Calling orderBookDetails API for market_id=${marketIndex}...`);
    
    try {
      const orderBookUrl = `${this.baseUrl}/api/v1/orderBookDetails`;
      const response = await axios.get(orderBookUrl, {
        timeout: 10000,
        params: { market_id: marketIndex },
      });
      
      this.logger.log(`  📥 Response: code=${response.data?.code}, has order_book_details=${!!response.data?.order_book_details?.length}`);
        
      // Validate response structure
      if (response.data?.code !== 200) {
        const errorMsg = `Invalid response code: ${response.data?.code}. Response: ${JSON.stringify(response.data)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
        }
        
      if (!response.data?.order_book_details || response.data.order_book_details.length === 0) {
        const errorMsg = `No order_book_details in response. Response: ${JSON.stringify(response.data)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      const orderBookDetail = response.data.order_book_details[0];
      
      // Validate market_id matches
      if (orderBookDetail.market_id !== marketIndex) {
        const errorMsg = `Market ID mismatch: expected ${marketIndex}, got ${orderBookDetail.market_id}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
      }

      // Extract and parse values
      const openInterestRaw = orderBookDetail.open_interest;
      const markPriceRaw = orderBookDetail.last_trade_price;
      
      // Validate raw values exist
      if (openInterestRaw === undefined || openInterestRaw === null) {
        const errorMsg = `open_interest field missing or null. Response: ${JSON.stringify(orderBookDetail)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      if (markPriceRaw === undefined || markPriceRaw === null) {
        const errorMsg = `last_trade_price field missing or null. Response: ${JSON.stringify(orderBookDetail)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      // Parse values
      const openInterest = typeof openInterestRaw === 'string' ? parseFloat(openInterestRaw) : (openInterestRaw || 0);
      const markPrice = typeof markPriceRaw === 'string' ? parseFloat(markPriceRaw) : (markPriceRaw || 0);
      
      this.logger.log(`  📊 Parsed values: Raw OI=${openInterestRaw}, Parsed OI=${openInterest}, Raw Price=${markPriceRaw}, Parsed Price=${markPrice}`);
      
      // Validate parsed values
      if (isNaN(openInterest)) {
        const errorMsg = `Failed to parse open_interest: "${openInterestRaw}" is not a valid number`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      if (isNaN(markPrice) || markPrice <= 0) {
        const errorMsg = `Invalid mark price: "${markPriceRaw}" parsed to ${markPrice} (must be > 0)`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      // open_interest is in base token units, multiply by mark price for USD value
      // Note: OI can be 0 (valid case), so we allow it
            const oiUsd = openInterest * markPrice;
            
      if (isNaN(oiUsd) || oiUsd < 0) {
        const errorMsg = `Invalid calculated OI USD: ${oiUsd} (OI=${openInterest}, Price=${markPrice})`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      this.logger.log(`  ✅ SUCCESS: Returned $${oiUsd.toLocaleString()} (OI: ${openInterest}, Price: ${markPrice})`);
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
      
      this.logger.error(`  ❌ ERROR: Failed to get Lighter OI for market ${marketIndex}: ${errorMsg}`);
      this.logger.error(`  📄 Full error: ${error.stack || error}`);
      
      throw new Error(`Lighter OI API error for market ${marketIndex}: ${errorMsg}`);
    }
  }

  /**
   * Get both open interest and mark price together from orderBookDetails API
   * This is more efficient than calling them separately
   * @param marketIndex Market index
   * @returns Object with openInterest (USD) and markPrice
   */
  async getOpenInterestAndMarkPrice(marketIndex: number): Promise<{ openInterest: number; markPrice: number }> {
    this.logger.log(`🔍 LIGHTER: getOpenInterestAndMarkPrice(${marketIndex}) - Starting...`);
    
    try {
      const orderBookUrl = `${this.baseUrl}/api/v1/orderBookDetails`;
      const response = await axios.get(orderBookUrl, {
            timeout: 10000,
        params: { market_id: marketIndex },
      });
      
      // Validate response structure
      if (response.data?.code !== 200) {
        const errorMsg = `Invalid response code: ${response.data?.code}. Response: ${JSON.stringify(response.data)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      if (!response.data?.order_book_details || response.data.order_book_details.length === 0) {
        const errorMsg = `No order_book_details in response. Response: ${JSON.stringify(response.data)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      const orderBookDetail = response.data.order_book_details[0];
      
      // Validate market_id matches
      if (orderBookDetail.market_id !== marketIndex) {
        const errorMsg = `Market ID mismatch: expected ${marketIndex}, got ${orderBookDetail.market_id}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      // Extract and parse values
      const openInterestRaw = orderBookDetail.open_interest;
      const markPriceRaw = orderBookDetail.last_trade_price;
      
      // Validate raw values exist
      if (openInterestRaw === undefined || openInterestRaw === null) {
        const errorMsg = `open_interest field missing or null. Response: ${JSON.stringify(orderBookDetail)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      if (markPriceRaw === undefined || markPriceRaw === null) {
        const errorMsg = `last_trade_price field missing or null. Response: ${JSON.stringify(orderBookDetail)}`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      // Parse values
      const openInterest = typeof openInterestRaw === 'string' ? parseFloat(openInterestRaw) : (openInterestRaw || 0);
      const markPrice = typeof markPriceRaw === 'string' ? parseFloat(markPriceRaw) : (markPriceRaw || 0);
      
      // Validate parsed values
      if (isNaN(openInterest)) {
        const errorMsg = `Failed to parse open_interest: "${openInterestRaw}" is not a valid number`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      if (isNaN(markPrice) || markPrice <= 0) {
        const errorMsg = `Invalid mark price: "${markPriceRaw}" parsed to ${markPrice} (must be > 0)`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      // open_interest is in base token units, multiply by mark price for USD value
              const oiUsd = openInterest * markPrice;
              
      if (isNaN(oiUsd) || oiUsd < 0) {
        const errorMsg = `Invalid calculated OI USD: ${oiUsd} (OI=${openInterest}, Price=${markPrice})`;
        this.logger.error(`  ❌ ERROR: ${errorMsg}`);
        throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
      }
      
      this.logger.log(`  ✅ SUCCESS: OI=$${oiUsd.toLocaleString()}, MarkPrice=$${markPrice.toFixed(2)}`);
      return { openInterest: oiUsd, markPrice };
      
    } catch (error: any) {
      // If it's already our error, re-throw it
      if (error.message && error.message.includes('Lighter API error')) {
        throw error;
      }
      
      // Otherwise, wrap it with context
      const errorMsg = error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message || 'Unknown error';
      
      this.logger.error(`  ❌ ERROR: Failed to get Lighter OI and mark price for market ${marketIndex}: ${errorMsg}`);
      this.logger.error(`  📄 Full error: ${error.stack || error}`);
      
      throw new Error(`Lighter API error for market ${marketIndex}: ${errorMsg}`);
    }
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
      const response = await axios.get(orderBookUrl, {
        timeout: 10000,
        params: { market_id: marketIndex },
      });
      
      if (response.data?.code === 200 && response.data?.order_book_details?.length > 0) {
        const detail = response.data.order_book_details[0];
        if (detail.last_trade_price !== undefined && detail.last_trade_price !== null) {
          const markPrice = typeof detail.last_trade_price === 'string' 
            ? parseFloat(detail.last_trade_price) 
            : detail.last_trade_price;
          
          if (!isNaN(markPrice) && markPrice > 0) {
            this.logger.debug(`Got mark price from orderBookDetails API for market ${marketIndex}: ${markPrice}`);
            return markPrice;
          } else {
            errors.push(`orderBookDetails: Invalid last_trade_price value: ${detail.last_trade_price}`);
          }
        } else {
          errors.push(`orderBookDetails: No last_trade_price in response`);
        }
      } else {
        errors.push(`orderBookDetails: Invalid response (code=${response.data?.code}, hasDetails=${!!response.data?.order_book_details?.length})`);
      }
    } catch (error: any) {
      const errorMsg = error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      errors.push(`orderBookDetails API: ${errorMsg}`);
    }

    // Method 1: Try order book SDK (most accurate if available)
    try {
      const orderBook = await (this.apiClient as any).order?.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
      
      if (orderBook?.bestBid?.price && orderBook?.bestAsk?.price) {
        const midPrice = (parseFloat(orderBook.bestBid.price) + parseFloat(orderBook.bestAsk.price)) / 2;
        if (!isNaN(midPrice) && midPrice > 0) {
          this.logger.debug(`Got mark price from OrderBook SDK for market ${marketIndex}: ${midPrice}`);
        return midPrice;
        } else {
          errors.push(`OrderBook SDK: Invalid midPrice calculated: ${midPrice} (bid=${orderBook.bestBid.price}, ask=${orderBook.bestAsk.price})`);
        }
      } else {
        errors.push(`OrderBook SDK: Missing bestBid/bestAsk (hasBestBid=${!!orderBook?.bestBid?.price}, hasBestAsk=${!!orderBook?.bestAsk?.price})`);
        if (orderBook) {
          this.logger.debug(`OrderBook SDK response structure: ${JSON.stringify(orderBook).substring(0, 200)}`);
        }
      }
    } catch (error: any) {
      errors.push(`OrderBook SDK: ${error.message || String(error)}`);
    }

    // Method 2: Try funding rates API (may include mark price)
    try {
      const fundingUrl = `${this.baseUrl}/api/v1/funding-rates`;
      const response = await axios.get(fundingUrl, {
        timeout: 10000,
        params: { market_index: marketIndex },
      });

      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        const latest = response.data[0];
        if (latest.mark_price) {
          const markPrice = parseFloat(latest.mark_price);
          if (!isNaN(markPrice) && markPrice > 0) {
            this.logger.debug(`Got mark price from funding-rates API for market ${marketIndex}: ${markPrice}`);
            return markPrice;
          } else {
            errors.push(`Funding Rates: Invalid mark_price value: ${latest.mark_price}`);
          }
        } else if (latest.price) {
          const price = parseFloat(latest.price);
          if (!isNaN(price) && price > 0) {
            this.logger.debug(`Got mark price from funding-rates API (price field) for market ${marketIndex}: ${price}`);
            return price;
          } else {
            errors.push(`Funding Rates: Invalid price value: ${latest.price}`);
        }
        } else {
          errors.push(`Funding Rates: No mark_price or price in response. Response keys: ${Object.keys(latest).join(', ')}`);
        }
      } else {
        errors.push(`Funding Rates: Empty or invalid response (isArray=${Array.isArray(response.data)}, length=${response.data?.length || 0})`);
      }
    } catch (error: any) {
      const errorMsg = error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      errors.push(`Funding Rates API: ${errorMsg}`);
    }

    // Method 3: Try market data SDK as last resort
    try {
      const marketData = await (this.apiClient as any).market?.getMarketData({ marketIndex });
      if (marketData?.markPrice) {
        const markPrice = parseFloat(marketData.markPrice);
        if (!isNaN(markPrice) && markPrice > 0) {
          this.logger.debug(`Got mark price from Market Data SDK for market ${marketIndex}: ${markPrice}`);
          return markPrice;
        } else {
          errors.push(`Market Data SDK: Invalid markPrice value: ${marketData.markPrice}`);
        }
      } else if (marketData?.price) {
        const price = parseFloat(marketData.price);
        if (!isNaN(price) && price > 0) {
          this.logger.debug(`Got mark price from Market Data SDK (price field) for market ${marketIndex}: ${price}`);
          return price;
        } else {
          errors.push(`Market Data SDK: Invalid price value: ${marketData.price}`);
        }
      } else {
        errors.push(`Market Data SDK: No markPrice or price in response. Response keys: ${marketData ? Object.keys(marketData).join(', ') : 'null'}`);
      }
    } catch (error: any) {
      errors.push(`Market Data SDK: ${error.message || String(error)}`);
    }

    // If all methods fail, throw error with detailed information
    const errorDetails = errors.join('; ');
    this.logger.error(`Failed to get Lighter mark price for market ${marketIndex}. All methods failed:`);
    errors.forEach((err, idx) => {
      this.logger.error(`  Method ${idx}: ${err}`);
    });
    throw new Error(`Failed to get Lighter mark price for market ${marketIndex}: All methods failed. Details: ${errorDetails}`);
  }

  /**
   * Convert symbol to market index
   * This is a simplified version - in production, you'd query available markets
   */
  async getMarketIndex(symbol: string): Promise<number> {
    const symbolToMarketIndex: Record<string, number> = {
      'ETH': 0,
      'BTC': 1,
      // Add more mappings as needed
    };

    const baseSymbol = symbol.replace('USDC', '').replace('USDT', '').replace('-PERP', '');
    return symbolToMarketIndex[baseSymbol] ?? 0; // Default to 0 (ETH/USDC)
  }

  /**
   * Get all available markets from Lighter
   * Uses the Explorer API: https://explorer.elliot.ai/api/markets
   * @returns Array of objects with marketIndex and symbol
   */
  async getAvailableMarkets(): Promise<Array<{ marketIndex: number; symbol: string }>> {
    try {
      // Use the Explorer API to get all markets
      // Based on: https://apidocs.lighter.xyz/reference/get_markets
      const explorerUrl = 'https://explorer.elliot.ai/api/markets';
      
      const response = await axios.get(explorerUrl, {
        timeout: 10000,
      });

      if (!response.data || !Array.isArray(response.data)) {
        this.logger.warn('Lighter Explorer API returned invalid data format');
        // Fallback: try orderBooks API
        return await this.getAvailableMarketsFallback();
      }

      // Map markets to our format
      // The API returns: [{"symbol":"JUP","market_index":26},{"symbol":"ADA","market_index":39},...]
      const markets = response.data.map((market: any) => {
        // API uses "market_index" (with underscore)
        const marketIndex = market.market_index ?? market.marketIndex ?? market.index ?? 0;
        const symbol = market.symbol || market.baseAsset || market.name || `MARKET_${marketIndex}`;
        
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

      this.logger.debug(`Found ${markets.length} available markets on Lighter via Explorer API`);
      return markets;
    } catch (error: any) {
      this.logger.warn(`Failed to get markets from Lighter Explorer API: ${error.message}`);
      // Fallback: try orderBooks API
      return await this.getAvailableMarketsFallback();
    }
  }

  /**
   * Fallback method to get markets using orderBooks API
   */
  private async getAvailableMarketsFallback(): Promise<Array<{ marketIndex: number; symbol: string }>> {
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
          symbol: symbol.replace('USDC', '').replace('USDT', '').replace('-PERP', '').toUpperCase(),
        };
      });

      this.logger.debug(`Found ${markets.length} available markets on Lighter via orderBooks API`);
      return markets;
    } catch (error: any) {
      this.logger.warn(`Failed to get markets from Lighter orderBooks API: ${error.message}`);
      // Final fallback
      return [
        { marketIndex: 0, symbol: 'ETH' },
        { marketIndex: 1, symbol: 'BTC' },
      ];
    }
  }
}


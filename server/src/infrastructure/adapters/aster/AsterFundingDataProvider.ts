import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * AsterFundingDataProvider - Fetches funding rate data from Aster DEX
 * 
 * Note: Aster DEX API structure may vary - this is a basic implementation
 * that may need adjustment based on actual API endpoints
 */
@Injectable()
export class AsterFundingDataProvider {
  private readonly logger = new Logger(AsterFundingDataProvider.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    // Remove trailing slash if present (causes 403 errors)
    let baseUrl = this.configService.get<string>('ASTER_BASE_URL') || 'https://fapi.asterdex.com';
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
    });
  }

  /**
   * Get current funding rate for a symbol
   * @param symbol Trading symbol (e.g., 'ETHUSDT', 'BNBUSDT')
   * @returns Funding rate as decimal (e.g., 0.0001 = 0.01%)
   */
  async getCurrentFundingRate(symbol: string): Promise<number> {
    try {
      // Aster DEX funding rate endpoint (adjust based on actual API)
      const response = await this.client.get('/fapi/v1/premiumIndex', {
        params: { symbol },
      });

      // Aster may return funding rate in different format - adjust as needed
      const fundingRate = parseFloat(response.data.lastFundingRate || response.data.fundingRate || '0');
      
      return fundingRate;
    } catch (error: any) {
      this.logger.error(`Failed to get funding rate for ${symbol}: ${error.message}`);
      throw new Error(`Failed to get Aster funding rate: ${error.message}`);
    }
  }

  /**
   * Get predicted next funding rate
   * @param symbol Trading symbol
   * @returns Predicted funding rate as decimal
   */
  async getPredictedFundingRate(symbol: string): Promise<number> {
    try {
      // Use current funding rate as prediction (Aster may not provide prediction)
      return await this.getCurrentFundingRate(symbol);
    } catch (error: any) {
      this.logger.error(`Failed to get predicted funding rate for ${symbol}: ${error.message}`);
      throw new Error(`Failed to get Aster predicted funding rate: ${error.message}`);
    }
  }

  /**
   * Get open interest for a symbol
   * @param symbol Trading symbol
   * @returns Open interest in USD
   */
  async getOpenInterest(symbol: string): Promise<number> {
    try {
      const response = await this.client.get('/fapi/v1/openInterest', {
        params: { symbol },
      });

      // Validate response structure
      if (!response.data) {
        throw new Error(`Aster OI API error for ${symbol}: Empty response`);
      }

      const openInterestRaw = response.data.openInterest;
      const markPriceRaw = response.data.markPrice;

      // Validate openInterest exists
      if (openInterestRaw === undefined || openInterestRaw === null) {
        throw new Error(`Aster OI API error for ${symbol}: openInterest field missing. Response: ${JSON.stringify(response.data)}`);
      }

      const openInterest = parseFloat(openInterestRaw);
      if (isNaN(openInterest)) {
        throw new Error(`Aster OI API error for ${symbol}: Failed to parse openInterest "${openInterestRaw}" as number`);
      }

      // Get mark price (from response or fallback)
      let markPrice: number;
      if (markPriceRaw !== undefined && markPriceRaw !== null) {
        markPrice = parseFloat(markPriceRaw);
        if (isNaN(markPrice) || markPrice <= 0) {
          this.logger.warn(`Aster OI: Invalid markPrice in response (${markPriceRaw}), fetching separately...`);
          markPrice = await this.getMarkPrice(symbol);
        }
      } else {
        markPrice = await this.getMarkPrice(symbol);
      }

      if (isNaN(markPrice) || markPrice <= 0) {
        throw new Error(`Aster OI API error for ${symbol}: Invalid mark price: ${markPrice}`);
      }
      
      const oiUsd = openInterest * markPrice;
      
      if (isNaN(oiUsd) || oiUsd < 0) {
        throw new Error(`Aster OI API error for ${symbol}: Invalid calculated OI USD: ${oiUsd} (OI=${openInterest}, Price=${markPrice})`);
      }
      
      return oiUsd; // Convert to USD value
    } catch (error: any) {
      // If it's already our error, re-throw it
      if (error.message && error.message.includes('Aster OI API error')) {
        this.logger.error(`Aster OI error for ${symbol}: ${error.message}`);
        throw error;
      }
      
      // Otherwise, wrap it with context
      const errorMsg = error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message || 'Unknown error';
      
      this.logger.error(`Aster OI API error for ${symbol}: ${errorMsg}`);
      if (error.stack) {
        this.logger.error(`Full error: ${error.stack}`);
      }
      
      throw new Error(`Aster OI API error for ${symbol}: ${errorMsg}`);
    }
  }

  /**
   * Get mark price for a symbol
   * @param symbol Trading symbol
   * @returns Mark price
   */
  async getMarkPrice(symbol: string): Promise<number> {
    try {
      const response = await this.client.get('/fapi/v1/ticker/price', {
        params: { symbol },
      });

      return parseFloat(response.data.price);
    } catch (error: any) {
      this.logger.error(`Failed to get mark price for ${symbol}: ${error.message}`);
      throw new Error(`Failed to get Aster mark price: ${error.message}`);
    }
  }

  /**
   * Get all available trading symbols from Aster
   * @returns Array of symbol strings (e.g., ['ETHUSDT', 'BTCUSDT'])
   */
  async getAvailableSymbols(): Promise<string[]> {
    try {
      const response = await this.client.get('/fapi/v1/exchangeInfo');
      
      if (!response.data || !response.data.symbols) {
        this.logger.warn('Aster exchangeInfo returned no symbols');
        return [];
      }

      // Filter for perpetual contracts (contractType: PERPETUAL)
      const symbols = response.data.symbols
        .filter((s: any) => s.contractType === 'PERPETUAL' && s.status === 'TRADING')
        .map((s: any) => s.symbol);

      this.logger.debug(`Found ${symbols.length} available perpetual symbols on Aster`);
      return symbols;
    } catch (error: any) {
      this.logger.error(`Failed to get available symbols from Aster: ${error.message}`);
      // Return empty array instead of throwing to allow system to continue
      return [];
    }
  }
}


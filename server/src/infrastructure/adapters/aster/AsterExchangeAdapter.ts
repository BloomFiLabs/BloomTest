import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import * as crypto from 'crypto';
import {
  ExchangeConfig,
  ExchangeType,
} from '../../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import {
  IPerpExchangeAdapter,
  ExchangeError,
  FundingPayment,
} from '../../../domain/ports/IPerpExchangeAdapter';
import { DiagnosticsService } from '../../services/DiagnosticsService';
import { MarketQualityFilter } from '../../../domain/services/MarketQualityFilter';

/**
 * AsterExchangeAdapter - Implements IPerpExchangeAdapter for Aster DEX
 *
 * Based on the existing open-perp-position.ts script logic
 */
@Injectable()
export class AsterExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(AsterExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly client: AxiosInstance;
  private readonly wallet: ethers.Wallet | null;
  private readonly apiKey: string | undefined;
  private readonly apiSecret: string | undefined;
  private symbolPrecisionCache: Map<string, number> = new Map(); // Cache quantity precision per symbol
  private symbolStepSizeCache: Map<string, number> = new Map(); // Cache stepSize per symbol
  private symbolPricePrecisionCache: Map<string, number> = new Map(); // Cache price precision per symbol
  private symbolTickSizeCache: Map<string, number> = new Map(); // Cache tickSize per symbol

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly marketQualityFilter?: MarketQualityFilter,
  ) {
    // Load configuration from environment
    // Remove trailing slash if present (causes 403 errors)
    let baseUrl =
      this.configService.get<string>('ASTER_BASE_URL') ||
      'https://fapi.asterdex.com';
    baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    const user = this.configService.get<string>('ASTER_USER');
    const signer = this.configService.get<string>('ASTER_SIGNER');
    const privateKey = this.configService.get<string>('ASTER_PRIVATE_KEY');
    const apiKey = this.configService.get<string>('ASTER_API_KEY');
    const apiSecret = this.configService.get<string>('ASTER_API_SECRET');
    const recvWindow = this.configService.get<number>('ASTER_RECV_WINDOW');

    // For trading: need user, signer, privateKey (signature-based)
    // For read-only: can use API key/secret if provided
    if (!user || !signer || !privateKey) {
      if (!apiKey || !apiSecret) {
        throw new Error(
          'Aster exchange requires either (ASTER_USER, ASTER_SIGNER, ASTER_PRIVATE_KEY) for trading OR (ASTER_API_KEY, ASTER_API_SECRET) for read-only access',
        );
      }
      // Read-only mode with API keys
      this.logger.warn(
        'Aster adapter in read-only mode (API keys only - trading disabled)',
      );
    }

    // Store API keys for read-only endpoints
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    // Normalize private key (if provided)
    let normalizedPrivateKey: string | undefined;
    if (privateKey) {
      normalizedPrivateKey = privateKey.startsWith('0x')
        ? privateKey
        : `0x${privateKey}`;
      this.wallet = new ethers.Wallet(normalizedPrivateKey);
    } else {
      this.wallet = null;
      normalizedPrivateKey = undefined;
    }

    this.config = new ExchangeConfig(
      ExchangeType.ASTER,
      baseUrl,
      apiKey,
      apiSecret,
      normalizedPrivateKey,
      user,
      signer,
      undefined,
      undefined,
      recvWindow,
    );

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: this.config.getTimeout(),
    });

    // Add retry interceptor for 429 errors
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const config = error.config;
        if (!config || error.response?.status !== 429) {
          return Promise.reject(error);
        }

        // Retry with exponential backoff
        config.retryCount = config.retryCount || 0;
        const maxRetries = 5;
        if (config.retryCount >= maxRetries) {
          return Promise.reject(error);
        }

        config.retryCount += 1;
        const delay = Math.min(3000 * Math.pow(2, config.retryCount - 1), 60000);
        this.logger.debug(
          `Aster API rate limited (429). Retrying in ${delay}ms (attempt ${config.retryCount}/${maxRetries})...`,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.client(config);
      },
    );

    if (user) {
      // Removed adapter initialization log - only execution logs shown
    } else if (apiKey) {
      // Removed adapter initialization log - only execution logs shown
    }
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return ExchangeType.ASTER;
  }

  /**
   * Record an error to diagnostics service and market quality filter
   */
  private recordError(
    type: string,
    message: string,
    symbol?: string,
    context?: Record<string, any>,
  ): void {
    if (this.diagnosticsService) {
      this.diagnosticsService.recordError({
        type,
        message,
        exchange: ExchangeType.ASTER,
        symbol,
        timestamp: new Date(),
        context,
      });
    }

    // Record to market quality filter for automatic blacklisting
    if (this.marketQualityFilter && symbol) {
      const failureType = MarketQualityFilter.parseFailureType(message);
      this.marketQualityFilter.recordFailure({
        symbol,
        exchange: ExchangeType.ASTER,
        failureType,
        message,
        timestamp: new Date(),
        context,
      });
    }
  }

  /**
   * Record a successful order fill
   */
  private recordSuccess(symbol: string): void {
    if (this.marketQualityFilter) {
      this.marketQualityFilter.recordSuccess(symbol, ExchangeType.ASTER);
    }
  }

  /**
   * Trim and convert all values in dictionary to strings (matching Python _trim_dict)
   */
  private trimDict(myDict: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(myDict)) {
      if (value === null || value === undefined) {
        continue;
      }

      if (Array.isArray(value)) {
        const newValue = value.map((item) => {
          if (typeof item === 'object' && item !== null) {
            return JSON.stringify(this.trimDict(item));
          }
          return String(item);
        });
        result[key] = JSON.stringify(newValue);
      } else if (typeof value === 'object') {
        result[key] = JSON.stringify(this.trimDict(value));
      } else {
        result[key] = String(value);
      }
    }

    return result;
  }

  /**
   * Create HMAC signature for API key/secret authentication (read-only endpoints)
   * Based on Aster API docs: HMAC SHA256 of query string + request body
   * For GET requests, only query string is used
   */
  private signParamsWithApiKey(
    params: Record<string, any>,
  ): Record<string, any> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API key and secret required for HMAC authentication');
    }

    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    );

    // Aster API requires timestamp in milliseconds
    cleanParams.timestamp = Date.now(); // Milliseconds
    cleanParams.recvWindow =
      cleanParams.recvWindow ?? this.config.recvWindow ?? 50000;

    // Create query string for HMAC signing
    // IMPORTANT:
    // 1. Signature must be calculated WITHOUT the signature parameter itself
    // 2. Parameters must be sorted alphabetically
    // 3. For GET requests, only query string is signed (no request body)
    // 4. Values should NOT be URL encoded in the signature string
    // 5. After calculating signature, it must be added as the LAST parameter
    const queryString = Object.keys(cleanParams)
      .sort()
      .map((key) => `${key}=${cleanParams[key]}`) // No URL encoding
      .join('&');

    // Create HMAC SHA256 signature
    // Aster docs: "Use your secretKey to create an HMAC SHA256 signature of this query string"
    // "Include the signature in your request, either in the query string or request body."
    // "Ensure the signature is the last parameter in your query string or request body."
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');

    // Return params with signature added (signature will be appended as last param in query string)
    return {
      ...cleanParams,
      signature, // This will be added as the last parameter when building the query string
    };
  }

  /**
   * Create Ethereum signature for Aster DEX API (trading endpoints)
   */
  private signParams(
    params: Record<string, any>,
    nonce: number,
  ): Record<string, any> {
    if (!this.wallet) {
      throw new Error(
        'Wallet required for Ethereum signature authentication. Provide ASTER_USER, ASTER_SIGNER, and ASTER_PRIVATE_KEY for trading.',
      );
    }

    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    );

    cleanParams.recvWindow =
      cleanParams.recvWindow ?? this.config.recvWindow ?? 50000;
    cleanParams.timestamp = Math.floor(Date.now());

    const trimmedParams = this.trimDict(cleanParams);
    const jsonStr = JSON.stringify(
      trimmedParams,
      Object.keys(trimmedParams).sort(),
    );

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ['string', 'address', 'address', 'uint256'],
      [jsonStr, this.config.userAddress!, this.config.signerAddress!, nonce],
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
    const signature = this.wallet.signingKey.sign(ethers.getBytes(messageHash));

    const signatureHex = ethers.Signature.from({
      r: signature.r,
      s: signature.s,
      v: signature.v,
    }).serialized;

    return {
      ...cleanParams,
      nonce,
      user: this.config.userAddress,
      signer: this.config.signerAddress,
      signature: signatureHex,
    };
  }

  /**
   * Get max leverage for a symbol from exchange info
   */
  async getMaxLeverage(symbol: string): Promise<number> {
    try {
      const response = await this.client.get('/fapi/v1/exchangeInfo');
      if (response.data?.symbols) {
        const symbolInfo = response.data.symbols.find(
          (s: any) => s.symbol === symbol,
        );
        if (
          symbolInfo?.leverageBrackets &&
          symbolInfo.leverageBrackets.length > 0
        ) {
          // Get the highest leverage bracket
          const maxBracket =
            symbolInfo.leverageBrackets[symbolInfo.leverageBrackets.length - 1];
          return parseFloat(maxBracket.leverage || '1');
        }
        // Fallback: check if there's a maxLeverage field
        if (symbolInfo?.maxLeverage) {
          return parseFloat(symbolInfo.maxLeverage);
        }
      }
      // Default to 1x if we can't find it
      return 1;
    } catch (error: any) {
      this.logger.debug(
        `Failed to get max leverage for ${symbol}: ${error.message}`,
      );
      return 1; // Default to 1x
    }
  }

  /**
   * Set leverage for a symbol (required before placing orders on Aster)
   * Aster API endpoint: POST /fapi/v1/leverage
   * @param symbol Trading symbol
   * @param leverage Target leverage
   * @param isCross Whether to use cross margin (ignored for Aster, uses account default)
   * @returns True if leverage was set successfully
   */
  async setLeverage(
    symbol: string,
    leverage: number,
    isCross: boolean = true,
  ): Promise<boolean> {
    try {
      const nonce = Math.floor(Date.now() * 1000);
      const params: Record<string, any> = {
        symbol,
        leverage: Math.floor(leverage), // Leverage must be an integer
      };

      let signedParams: Record<string, any>;
      if (this.apiKey && this.apiSecret) {
        signedParams = this.signParamsWithApiKey(params);
      } else if (this.wallet) {
        signedParams = this.signParams(params, nonce);
      } else {
        throw new Error('Authentication required to set leverage');
      }

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        if (value !== null && value !== undefined) {
          formData.append(key, String(value));
        }
      }

      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['X-MBX-APIKEY'] = this.apiKey;
      }

      await this.client.post('/fapi/v1/leverage', formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...headers,
        },
      });

      this.logger.debug(`✅ Set leverage to ${leverage}x for ${symbol}`);
      return true;
    } catch (error: any) {
      // Log but don't throw - leverage might already be set correctly
      this.logger.debug(
        `Failed to set leverage for ${symbol} to ${leverage}x: ${error.message}. ` +
          `This may be okay if leverage is already set correctly.`,
      );
      return false;
    }
  }

  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    let formattedQuantity: string = request.size.toString(); // Store for error logging
    try {
      // Aster uses BUY/SELL instead of LONG/SHORT
      const asterSide = request.side === OrderSide.LONG ? 'BUY' : 'SELL';

      // Get precision and stepSize for quantity, and pricePrecision and tickSize for price
      // Fetch exchange info if not cached
      const { precision, stepSize, pricePrecision, tickSize } =
        await this.getSymbolPrecision(request.symbol);

      // Round to nearest stepSize multiple first, then format to precision
      // This ensures we comply with Aster's LOT_SIZE filter requirements
      const roundedSize = Math.round(request.size / stepSize) * stepSize;

      let quantity: string;
      if (stepSize >= 1 && precision === 0) {
        // For integer quantities, use toFixed(0) to ensure clean string format
        quantity = Math.round(roundedSize).toFixed(0);
      } else {
        quantity = roundedSize.toFixed(precision);
      }
      formattedQuantity = quantity;

      const nonce = Math.floor(Date.now() * 1000);
      const orderParams: Record<string, any> = {
        symbol: request.symbol,
        positionSide: 'BOTH', // Required parameter (from working script)
        side: asterSide,
        type: request.type === OrderType.MARKET ? 'MARKET' : 'LIMIT',
        quantity, // Always a string, formatted to match Aster's precision requirements
        recvWindow: 50000, // Required for market orders (from working script)
      };

      // For LIMIT orders, add price and timeInForce
      // For MARKET orders, do NOT include price (Aster rejects it)
      if (request.type === OrderType.LIMIT && request.price) {
        // Round to nearest tickSize multiple first, then format to pricePrecision
        // This ensures we comply with Aster's PRICE_FILTER requirements
        const roundedPrice = Math.round(request.price / tickSize) * tickSize;

        let price: string;
        if (tickSize >= 1 && pricePrecision === 0) {
          // For integer prices, use toFixed(0) to ensure clean string format
          price = Math.round(roundedPrice).toFixed(0);
        } else {
          price = roundedPrice.toFixed(pricePrecision);
        }

        orderParams.price = price;
        orderParams.timeInForce = request.timeInForce || TimeInForce.GTC;
      }

      const signedParams = this.signParams(orderParams, nonce);

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        if (value !== null && value !== undefined) {
          formData.append(key, String(value));
        }
      }

      const response = await this.client.post(
        '/fapi/v3/order',
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      const orderId =
        response.data.orderId?.toString() || response.data.orderId;
      const status = this.mapAsterOrderStatus(response.data.status);

      // Record success for market quality tracking
      this.recordSuccess(request.symbol);

      return new PerpOrderResponse(
        orderId,
        status,
        request.symbol,
        request.side,
        request.clientOrderId,
        response.data.executedQty
          ? parseFloat(response.data.executedQty)
          : undefined,
        response.data.avgPrice ? parseFloat(response.data.avgPrice) : undefined,
        response.data.msg,
        new Date(),
      );
    } catch (error: any) {
      // Enhanced error logging for debugging
      let errorDetail = error.message;
      if (error.response) {
        // Extract the actual error message from the API response
        const responseData = error.response.data;
        const apiErrorMsg =
          responseData?.msg ||
          responseData?.message ||
          responseData?.error ||
          JSON.stringify(responseData);
        errorDetail = `${error.response.status}: ${apiErrorMsg}`;

        this.logger.error(
          `Failed to place order: ${errorDetail}. ` +
            `Full response: ${JSON.stringify(responseData)}`,
        );
        // Log request parameters for debugging (without sensitive data)
        // Note: Log formatted quantity, not raw size, to match what was actually sent
        this.logger.debug(
          `Order request params: symbol=${request.symbol}, ` +
            `side=${request.side}, type=${request.type}, rawSize=${request.size}, formattedQuantity=${formattedQuantity}`,
        );
      } else {
        this.logger.error(`Failed to place order: ${error.message}`);
      }
      this.recordError('ASTER_ORDER_FAILED', errorDetail, request.symbol);
      throw new ExchangeError(
        `Failed to place order: ${errorDetail}`,
        ExchangeType.ASTER,
        error.response?.data?.code,
        error,
      );
    }
  }

  private mapAsterOrderStatus(asterStatus: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      NEW: OrderStatus.SUBMITTED,
      PARTIALLY_FILLED: OrderStatus.PARTIALLY_FILLED,
      FILLED: OrderStatus.FILLED,
      CANCELED: OrderStatus.CANCELLED,
      REJECTED: OrderStatus.REJECTED,
      EXPIRED: OrderStatus.EXPIRED,
    };
    return statusMap[asterStatus] || OrderStatus.PENDING;
  }

  /**
   * Calculate precision from a size string (stepSize or tickSize)
   * Handles scientific notation and trailing zeros correctly
   */
  private calculatePrecision(sizeStr: string): number {
    let precision = 0;
    if (sizeStr.includes('e-')) {
      // Scientific notation: "1e-8" means 8 decimal places
      const match = sizeStr.match(/e-(\d+)/);
      precision = match ? parseInt(match[1], 10) : 0;
    } else if (sizeStr.includes('.')) {
      // Regular decimal: count significant decimal places (remove trailing zeros)
      // Examples: "0.001" -> 3, "0.0010" -> 3, "0.100" -> 1, "1.0" -> 0
      const decimalPart = sizeStr.split('.')[1];
      if (decimalPart) {
        // Remove trailing zeros to get significant decimal places
        precision = decimalPart.replace(/0+$/, '').length;
      }
    }
    // If size is an integer (no decimal point), precision is 0 (already set)
    return precision;
  }

  /**
   * Get precision (decimal places) and stepSize for a symbol's quantity
   * Also gets price precision and tickSize from PRICE_FILTER
   * Fetches exchange info to get filters from LOT_SIZE and PRICE_FILTER
   * Caches results to avoid repeated API calls
   */
  private async getSymbolPrecision(symbol: string): Promise<{
    precision: number;
    stepSize: number;
    pricePrecision: number;
    tickSize: number;
  }> {
    // Check cache first
    if (
      this.symbolPrecisionCache.has(symbol) &&
      this.symbolStepSizeCache.has(symbol) &&
      this.symbolPricePrecisionCache.has(symbol) &&
      this.symbolTickSizeCache.has(symbol)
    ) {
      return {
        precision: this.symbolPrecisionCache.get(symbol)!,
        stepSize: this.symbolStepSizeCache.get(symbol)!,
        pricePrecision: this.symbolPricePrecisionCache.get(symbol)!,
        tickSize: this.symbolTickSizeCache.get(symbol)!,
      };
    }

    try {
      // Fetch exchange info to get stepSize and tickSize
      const response = await this.client.get('/fapi/v1/exchangeInfo');
      const symbolInfo = response.data.symbols?.find(
        (s: any) => s.symbol === symbol,
      );

      if (symbolInfo) {
        // Get quantity precision from LOT_SIZE filter
        const quantityFilter = symbolInfo.filters?.find(
          (f: any) => f.filterType === 'LOT_SIZE',
        );
        let precision = 4; // Default
        let stepSize = 0.0001; // Default

        if (quantityFilter?.stepSize) {
          const stepSizeStr = quantityFilter.stepSize;
          stepSize = parseFloat(stepSizeStr);
          precision = this.calculatePrecision(stepSizeStr);
        }

        // Get price precision from PRICE_FILTER
        const priceFilter = symbolInfo.filters?.find(
          (f: any) => f.filterType === 'PRICE_FILTER',
        );
        let pricePrecision = 8; // Default
        let tickSize = 0.00000001; // Default

        if (priceFilter?.tickSize) {
          const tickSizeStr = priceFilter.tickSize;
          tickSize = parseFloat(tickSizeStr);
          pricePrecision = this.calculatePrecision(tickSizeStr);
        }

        // Cache all values
        this.symbolPrecisionCache.set(symbol, precision);
        this.symbolStepSizeCache.set(symbol, stepSize);
        this.symbolPricePrecisionCache.set(symbol, pricePrecision);
        this.symbolTickSizeCache.set(symbol, tickSize);

        // Log precision only at debug level, less verbose
        this.logger.debug(
          `Symbol ${symbol}: qty precision=${precision}, price precision=${pricePrecision}`,
        );

        return { precision, stepSize, pricePrecision, tickSize };
      }
    } catch (error: any) {
      this.logger.warn(
        `Could not fetch exchange info for ${symbol}, using default precision: ${error.message}`,
      );
    }

    // Default values if we can't fetch exchange info
    const defaultPrecision = 4;
    const defaultStepSize = 0.0001;
    const defaultPricePrecision = 8;
    const defaultTickSize = 0.00000001;

    this.symbolPrecisionCache.set(symbol, defaultPrecision);
    this.symbolStepSizeCache.set(symbol, defaultStepSize);
    this.symbolPricePrecisionCache.set(symbol, defaultPricePrecision);
    this.symbolTickSizeCache.set(symbol, defaultTickSize);

    return {
      precision: defaultPrecision,
      stepSize: defaultStepSize,
      pricePrecision: defaultPricePrecision,
      tickSize: defaultTickSize,
    };
  }

  async getPosition(symbol: string): Promise<PerpPosition | null> {
    try {
      const positions = await this.getPositions();
      return positions.find((p) => p.symbol === symbol) || null;
    } catch (error: any) {
      this.logger.error(`Failed to get position: ${error.message}`);
      throw new ExchangeError(
        `Failed to get position: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async getPositions(): Promise<PerpPosition[]> {
    try {
      // Always fetch fresh positions (no caching to ensure we see latest state)
      this.logger.debug('Fetching fresh positions from Aster...');

      // Use API key authentication if available, otherwise use Ethereum signature
      let params: Record<string, any>;
      const headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        // Use HMAC-based API key authentication
        params = this.signParamsWithApiKey({});
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        // Fallback to Ethereum signature
        const nonce = Math.floor(Date.now() * 1000);
        params = this.signParams({}, nonce);
      } else {
        throw new Error('No authentication method available');
      }

      // Build query string manually to ensure signature is last parameter
      // This matches the Aster API documentation format
      const queryParams: string[] = [];
      const signatureParam: string[] = [];

      for (const [key, value] of Object.entries(params)) {
        if (key === 'signature') {
          signatureParam.push(`signature=${value}`);
        } else {
          queryParams.push(`${key}=${encodeURIComponent(String(value))}`);
        }
      }

      // Sort query params (excluding signature)
      queryParams.sort();

      // Build final query string with signature as last parameter
      const queryString =
        queryParams.join('&') +
        (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

      const response = await this.client.get(
        `/fapi/v2/positionRisk?${queryString}`,
        {
          headers,
        },
      );

      const positions: PerpPosition[] = [];
      if (Array.isArray(response.data)) {
        this.logger.debug(
          `🔍 Aster API returned ${response.data.length} position entries`,
        );

        // Log first few raw entries to see what we're getting
        const sampleEntries = response.data.slice(0, 5);
        this.logger.debug(
          `📋 Sample Aster raw position entries (first 5): ${JSON.stringify(sampleEntries, null, 2)}`,
        );

        // Count positions with non-zero amounts
        let nonZeroCount = 0;
        let zeroCount = 0;

        for (const pos of response.data) {
          const positionAmt = parseFloat(pos.positionAmt || '0');

          // Log details for positions we're filtering out
          if (positionAmt === 0) {
            zeroCount++;
            if (zeroCount <= 3) {
              this.logger.debug(
                `🚫 Filtered out Aster position: symbol="${pos.symbol}", positionAmt="${pos.positionAmt}" (parsed: ${positionAmt}), ` +
                  `markPrice="${pos.markPrice}", entryPrice="${pos.entryPrice}"`,
              );
            }
          } else {
            nonZeroCount++;
          }

          if (positionAmt !== 0) {
            const side = positionAmt > 0 ? OrderSide.LONG : OrderSide.SHORT;
            const markPrice = parseFloat(pos.markPrice || '0');
            const entryPrice = parseFloat(pos.entryPrice || '0');
            const unrealizedPnl = parseFloat(pos.unRealizedProfit || '0');

            const position = new PerpPosition(
              ExchangeType.ASTER,
              pos.symbol,
              side,
              Math.abs(positionAmt),
              entryPrice,
              markPrice,
              unrealizedPnl,
              parseFloat(pos.leverage || '1'),
              parseFloat(pos.liquidationPrice || '0') || undefined,
              parseFloat(pos.initialMargin || '0') || undefined,
              undefined,
              new Date(),
            );

            this.logger.debug(
              `📍 Aster Position: symbol="${pos.symbol}", side=${side}, size=${Math.abs(positionAmt)}, ` +
                `entryPrice=${entryPrice}, markPrice=${markPrice}, pnl=${unrealizedPnl}`,
            );

            positions.push(position);
          }
        }

        this.logger.debug(
          `📊 Aster position filtering summary: ${nonZeroCount} non-zero positions, ${zeroCount} zero positions filtered out`,
        );
      }

      this.logger.debug(
        `✅ Aster getPositions() returning ${positions.length} positions: ${positions.map((p) => `${p.symbol}(${p.side})`).join(', ')}`,
      );
      return positions;
    } catch (error: any) {
      // Handle authentication errors gracefully (401 = invalid/expired credentials)
      if (error.response?.status === 401) {
        this.logger.warn(
          'Aster API authentication failed - positions query requires valid API credentials',
        );
        return []; // Return empty array instead of throwing to allow system to continue
      }
      this.logger.error(`Failed to get positions: ${error.message}`);
      // Return empty array instead of throwing to allow system to continue
      this.logger.warn(
        'Returning empty positions due to error - Aster positions query may need valid API keys',
      );
      return [];
    }
  }

  /**
   * Modify an existing order
   * Note: Aster uses cancel and replace for order modification
   */
  async modifyOrder(
    orderId: string,
    request: PerpOrderRequest,
  ): Promise<PerpOrderResponse> {
    try {
      this.logger.debug(
        `🔄 Modifying order ${orderId} on Aster (Cancel + Place): ${request.symbol} @ ${request.price}`,
      );

      // 1. Cancel the existing order
      await this.cancelOrder(orderId, request.symbol);

      // 2. Place the new order
      return await this.placeOrder(request);
    } catch (error: any) {
      this.logger.error(`Failed to modify order ${orderId}: ${error.message}`);
      throw new ExchangeError(
        `Failed to modify order: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      if (!symbol) {
        throw new Error('Symbol is required for canceling orders on Aster');
      }

      const nonce = Math.floor(Date.now() * 1000);
      const orderParams = {
        symbol,
        orderId,
      };

      const signedParams = this.signParams(orderParams, nonce);

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        formData.append(key, String(value));
      }

      await this.client.delete('/fapi/v3/order', {
        params: Object.fromEntries(formData),
      });

      return true;
    } catch (error: any) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel order: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      const nonce = Math.floor(Date.now() * 1000);
      const orderParams = { symbol };
      const signedParams = this.signParams(orderParams, nonce);

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        formData.append(key, String(value));
      }

      const response = await this.client.delete('/fapi/v3/allOpenOrders', {
        params: Object.fromEntries(formData),
      });

      // Aster returns the number of cancelled orders
      return response.data?.count || 0;
    } catch (error: any) {
      this.logger.error(`Failed to cancel all orders: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async getOrderStatus(
    orderId: string,
    symbol?: string,
  ): Promise<PerpOrderResponse> {
    try {
      if (!symbol) {
        throw new Error('Symbol is required for getting order status on Aster');
      }

      const nonce = Math.floor(Date.now() * 1000);
      const orderParams = { symbol, orderId };
      const signedParams = this.signParams(orderParams, nonce);

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        formData.append(key, String(value));
      }

      const response = await this.client.get('/fapi/v3/order', {
        params: Object.fromEntries(formData),
      });

      const data = response.data;
      const side = data.side === 'BUY' ? OrderSide.LONG : OrderSide.SHORT;

      return new PerpOrderResponse(
        data.orderId.toString(),
        this.mapAsterOrderStatus(data.status),
        data.symbol,
        side,
        undefined,
        data.executedQty ? parseFloat(data.executedQty) : undefined,
        data.avgPrice ? parseFloat(data.avgPrice) : undefined,
        data.msg,
        new Date(data.updateTime),
      );
    } catch (error: any) {
      this.logger.error(`Failed to get order status: ${error.message}`);
      throw new ExchangeError(
        `Failed to get order status: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  // Price cache: key = symbol, value = { price: number, timestamp: number }
  private priceCache: Map<string, { price: number; timestamp: number }> =
    new Map();
  private readonly PRICE_CACHE_TTL = 10000; // 10 seconds cache

  async getMarkPrice(symbol: string): Promise<number> {
    // Check cache first
    const cached = this.priceCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.PRICE_CACHE_TTL) {
      return cached.price;
    }

    // Retry logic: up to 3 attempts with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s delays
          await new Promise((resolve) => setTimeout(resolve, delay));
          this.logger.debug(
            `Retrying mark price fetch for ${symbol} (attempt ${attempt + 1}/3)`,
          );
        }

        const response = await this.client.get('/fapi/v1/ticker/price', {
          params: { symbol },
          timeout: 10000,
        });

        const price = parseFloat(response.data.price);
        if (price > 0) {
          // Cache the result
          this.priceCache.set(symbol, { price, timestamp: Date.now() });
          return price;
        } else {
          throw new Error(`Invalid price returned: ${price}`);
        }
      } catch (error: any) {
        lastError = error;
        if (attempt === 2) {
          // Last attempt failed
          this.logger.error(
            `Failed to get mark price for ${symbol} after 3 attempts: ${error.message}. ` +
              `Status: ${error.response?.status}, Response: ${JSON.stringify(error.response?.data)}`,
          );
        }
      }
    }

    // All attempts failed
    throw new ExchangeError(
      `Failed to get mark price for ${symbol} after 3 retries: ${lastError?.message || 'unknown error'}`,
      ExchangeType.ASTER,
      undefined,
      lastError || undefined,
    );
  }

  /**
   * Get the tick size (minimum price increment) for a symbol
   */
  async getTickSize(symbol: string): Promise<number> {
    try {
      const { tickSize } = await this.getSymbolPrecision(symbol);
      return tickSize;
    } catch (error: any) {
      this.logger.debug(`Failed to get tick size for ${symbol}: ${error.message}`);
      return 0.0001; // Default fallback
    }
  }

  async getBalance(): Promise<number> {
    try {
      // Always fetch fresh balance (no caching to ensure we see latest state)
      this.logger.debug('Fetching fresh balance from Aster...');

      // Aster API requires Ethereum signature authentication (not HMAC API keys)
      // Based on official docs: https://github.com/asterdex/api-docs
      // Balance endpoint: GET /fapi/v3/balance (USER_DATA authentication type)
      // Authentication requires: user, signer, nonce, signature (Ethereum signature)
      if (!this.wallet) {
        this.logger.warn(
          'Aster balance query requires Ethereum signature authentication. Provide ASTER_USER, ASTER_SIGNER, and ASTER_PRIVATE_KEY.',
        );
        return 0;
      }

      // Generate nonce (microseconds timestamp as per docs)
      const nonce = Math.floor(Date.now() * 1000);
      // Sign empty params (balance endpoint doesn't require additional parameters)
      const params = this.signParams({}, nonce);

      // Use v3 endpoint as per official documentation
      const response = await this.client.get('/fapi/v3/balance', {
        params,
      });

      // Aster v3 returns balance in array format
      // Response structure: [{ accountAlias, asset, balance, availableBalance, ... }]
      if (Array.isArray(response.data) && response.data.length > 0) {
        const usdtBalance = response.data.find((b: any) => b.asset === 'USDT');
        if (usdtBalance) {
          const balance = parseFloat(
            usdtBalance.availableBalance || usdtBalance.balance || '0',
          );
          this.logger.debug(`Aster balance retrieved: $${balance.toFixed(2)}`);
          return balance;
        }
      }

      return 0;
    } catch (error: any) {
      // Log detailed error information for debugging
      if (error.response) {
        this.logger.error(
          `Aster balance request failed: ${error.response.status} ${error.response.statusText}. ` +
            `Response: ${JSON.stringify(error.response.data)}. ` +
            `Request params: ${JSON.stringify(error.config?.params || {})}`,
        );
      } else {
        this.logger.error(`Failed to get balance: ${error.message}`);
      }

      // Handle authentication errors gracefully (401 = invalid/expired credentials, 400 = bad request format)
      if (error.response?.status === 401) {
        this.logger.warn(
          'Aster API authentication failed - balance query requires valid API credentials',
        );
        return 0;
      }
      if (error.response?.status === 400) {
        const errorMsg = error.response?.data?.msg || '';
        if (errorMsg.includes('Signature') || errorMsg.includes('signature')) {
          this.logger.warn(
            'Aster API signature validation failed. The signature format may be incorrect. ' +
              'Possible fixes: 1) Try timestamp in milliseconds instead of seconds, ' +
              '2) Remove URL encoding from query string values, ' +
              '3) Check Aster API docs for exact signature format. ' +
              `Current timestamp format: seconds (${Math.floor(Date.now() / 1000)})`,
          );
        } else {
          this.logger.warn(
            `Aster API returned Bad Request: ${JSON.stringify(error.response?.data)}`,
          );
        }
        return 0;
      }

      // Return 0 instead of throwing to allow system to continue
      this.logger.warn(
        'Returning 0 balance due to error - Aster balance query may need valid API keys',
      );
      return 0;
    }
  }

  async getEquity(): Promise<number> {
    try {
      // Use API key authentication if available, otherwise use Ethereum signature
      let params: Record<string, any>;
      const headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        // Use HMAC-based API key authentication
        params = this.signParamsWithApiKey({});
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        // Fallback to Ethereum signature
        const nonce = Math.floor(Date.now() * 1000);
        params = this.signParams({}, nonce);
      } else {
        throw new Error('No authentication method available');
      }

      // Build query string manually to ensure signature is last parameter
      // This matches the Aster API documentation format
      const queryParams: string[] = [];
      const signatureParam: string[] = [];

      for (const [key, value] of Object.entries(params)) {
        if (key === 'signature') {
          signatureParam.push(`signature=${value}`);
        } else {
          queryParams.push(`${key}=${encodeURIComponent(String(value))}`);
        }
      }

      // Sort query params (excluding signature)
      queryParams.sort();

      // Build final query string with signature as last parameter
      const queryString =
        queryParams.join('&') +
        (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

      const response = await this.client.get(
        `/fapi/v2/account?${queryString}`,
        {
          headers,
        },
      );

      return parseFloat(response.data.totalWalletBalance || '0');
    } catch (error: any) {
      // Handle authentication errors gracefully (401 = invalid/expired credentials)
      if (error.response?.status === 401) {
        this.logger.warn(
          'Aster API authentication failed - equity query requires valid API credentials',
        );
        return 0; // Return 0 instead of throwing to allow system to continue
      }
      this.logger.error(`Failed to get equity: ${error.message}`);
      // Return 0 instead of throwing to allow system to continue
      this.logger.warn(
        'Returning 0 equity due to error - Aster equity query may need valid API keys',
      );
      return 0;
    }
  }

  /**
   * Get available margin for opening new positions
   * Aster provides availableBalance in the account response
   */
  async getAvailableMargin(): Promise<number> {
    try {
      let params: Record<string, any>;
      const headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        params = this.signParamsWithApiKey({});
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        const nonce = Math.floor(Date.now() * 1000);
        params = this.signParams({}, nonce);
      } else {
        throw new Error('No authentication method available');
      }

      const queryParams: string[] = [];
      const signatureParam: string[] = [];

      for (const [key, value] of Object.entries(params)) {
        if (key === 'signature') {
          signatureParam.push(`signature=${value}`);
        } else {
          queryParams.push(`${key}=${encodeURIComponent(String(value))}`);
        }
      }
      queryParams.sort();
      const queryString =
        queryParams.join('&') +
        (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

      const response = await this.client.get(
        `/fapi/v2/account?${queryString}`,
        {
          headers,
        },
      );

      // Aster provides availableBalance which is margin available for new positions
      const availableBalance = parseFloat(
        response.data.availableBalance || '0',
      );

      // Apply 15% safety buffer (10% maintenance + 5% execution)
      const availableMargin = availableBalance * 0.85;

      this.logger.debug(
        `Aster available margin: availableBalance=$${availableBalance.toFixed(2)}, ` +
          `withBuffer=$${Math.max(0, availableMargin).toFixed(2)}`,
      );

      return Math.max(0, availableMargin);
    } catch (error: any) {
      this.logger.warn(
        `Failed to get available margin: ${error.message}, falling back to getBalance`,
      );
      try {
        const balance = await this.getBalance();
        return balance * 0.7; // 30% buffer as fallback
      } catch {
        return 0;
      }
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.testConnection();
      return true;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<void> {
    try {
      // Test connection by fetching exchange info
      await this.client.get('/fapi/v1/exchangeInfo');
    } catch (error: any) {
      throw new ExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async transferInternal(amount: number, toPerp: boolean): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Transfer amount must be greater than 0');
      }

      // Aster API: type 1 = spot to futures, type 2 = futures to spot
      const transferType = toPerp ? 1 : 2;
      const direction = toPerp ? 'spot → futures' : 'futures → spot';
      this.logger.log(
        `Transferring $${amount.toFixed(2)} ${direction} on Aster...`,
      );

      // Use API key authentication if available
      let params: Record<string, any>;
      const headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        params = this.signParamsWithApiKey({
          asset: 'USDT', // Default to USDT for transfers
          amount: amount.toString(),
          type: transferType,
        });
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else {
        throw new Error(
          'API key and secret required for transfers. Provide ASTER_API_KEY and ASTER_API_SECRET.',
        );
      }

      // Manually build query string to ensure signature is last
      const queryParams: string[] = [];
      const signatureParam: string[] = [];
      for (const [key, value] of Object.entries(params)) {
        if (key === 'signature') {
          signatureParam.push(`${key}=${value}`);
        } else {
          queryParams.push(`${key}=${value}`);
        }
      }
      queryParams.sort(); // Sort other params
      const finalQueryString =
        queryParams.join('&') +
        (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

      const response = await this.client.post(
        `/fapi/v1/transfer?${finalQueryString}`,
        {},
        { headers },
      );

      if (response.data && response.data.tranId) {
        const tranId = response.data.tranId;
        this.logger.log(
          `✅ Transfer successful: ${direction} - Transaction ID: ${tranId}`,
        );
        return tranId.toString();
      } else {
        throw new Error(`Transfer failed: ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to transfer ${toPerp ? 'spot → futures' : 'futures → spot'}: ${error.message}`,
      );
      if (error.response) {
        this.logger.debug(
          `Aster API error response: ${JSON.stringify(error.response.data)}`,
        );
      }
      throw new ExchangeError(
        `Failed to transfer: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async depositExternal(
    amount: number,
    asset: string,
    destination?: string,
  ): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Deposit amount must be greater than 0');
      }

      // Only USDC is supported for deposits
      if (asset.toUpperCase() !== 'USDC') {
        throw new Error(`Only USDC deposits are supported. Received: ${asset}`);
      }

      this.logger.log(
        `Depositing $${amount.toFixed(2)} ${asset} to Aster via Treasury contract...`,
      );

      // Aster Treasury contract address on Arbitrum
      // Transaction: 0xd63c6bce751a8d2230bb574a6571cb160a52f992ab876ba30b21f568a7175bd5
      const ASTER_TREASURY_CONTRACT =
        '0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5';
      const USDC_CONTRACT_ADDRESS =
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // USDC on Arbitrum

      // Get Arbitrum RPC URL
      const arbitrumRpcUrl =
        this.configService.get<string>('ARBITRUM_RPC_URL') ||
        this.configService.get<string>('ARB_RPC_URL') ||
        'https://arb1.arbitrum.io/rpc'; // Public RPC fallback

      // Get private key for signing transactions
      const privateKey =
        this.configService.get<string>('PRIVATE_KEY') ||
        this.configService.get<string>('ASTER_PRIVATE_KEY');
      if (!privateKey) {
        throw new Error(
          'PRIVATE_KEY or ASTER_PRIVATE_KEY required for on-chain deposits',
        );
      }

      const normalizedPrivateKey = privateKey.startsWith('0x')
        ? privateKey
        : `0x${privateKey}`;
      const provider = new ethers.JsonRpcProvider(arbitrumRpcUrl);
      const wallet = new ethers.Wallet(normalizedPrivateKey, provider);

      this.logger.debug(
        `Aster deposit details:\n` +
          `  Treasury contract: ${ASTER_TREASURY_CONTRACT}\n` +
          `  USDC contract: ${USDC_CONTRACT_ADDRESS}\n` +
          `  Amount: ${amount} USDC\n` +
          `  Wallet: ${wallet.address}\n` +
          `  RPC: ${arbitrumRpcUrl}`,
      );

      // ERC20 ABI for USDC (approve, transfer, allowance, balanceOf, decimals)
      const erc20Abi = [
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function allowance(address owner, address spender) external view returns (uint256)',
        'function balanceOf(address account) external view returns (uint256)',
        'function decimals() external view returns (uint8)',
      ];

      // Aster Treasury contract ABI (deposit function)
      // Function signature: deposit(address currency, uint256 amount, uint256 broker)
      const treasuryAbi = [
        'function deposit(address currency, uint256 amount, uint256 broker) external',
      ];

      const usdcContract = new ethers.Contract(
        USDC_CONTRACT_ADDRESS,
        erc20Abi,
        wallet,
      );
      const treasuryContract = new ethers.Contract(
        ASTER_TREASURY_CONTRACT,
        treasuryAbi,
        wallet,
      );

      // Get USDC decimals (convert BigInt to number)
      const decimalsBigInt = await usdcContract.decimals();
      const decimals = Number(decimalsBigInt);
      const amountWei = ethers.parseUnits(amount.toFixed(decimals), decimals);

      // Check USDC balance
      const balanceWei = await usdcContract.balanceOf(wallet.address);
      const balanceFormatted = Number(ethers.formatUnits(balanceWei, decimals));

      if (balanceFormatted < amount) {
        throw new Error(
          `Insufficient USDC balance. Required: ${amount.toFixed(2)} USDC, Available: ${balanceFormatted.toFixed(2)} USDC`,
        );
      }

      // Check current allowance
      const currentAllowance = await usdcContract.allowance(
        wallet.address,
        ASTER_TREASURY_CONTRACT,
      );
      if (currentAllowance < amountWei) {
        // Approve Treasury contract to spend USDC
        this.logger.log(
          `Approving Aster Treasury to spend ${amount.toFixed(2)} USDC...`,
        );
        const approveTx = await usdcContract.approve(
          ASTER_TREASURY_CONTRACT,
          amountWei,
        );
        await approveTx.wait();
        this.logger.log(`✅ Approval confirmed: ${approveTx.hash}`);
      }

      // Call deposit function on Treasury contract
      // Parameters: currency (USDC address), amount (in wei), broker (1 = default broker)
      this.logger.log(`Calling deposit function on Aster Treasury contract...`);
      const depositTx = await treasuryContract.deposit(
        USDC_CONTRACT_ADDRESS,
        amountWei,
        1, // broker ID = 1 (default)
      );

      this.logger.log(`⏳ Deposit transaction submitted: ${depositTx.hash}`);
      const receipt = await depositTx.wait();

      if (receipt.status === 1) {
        this.logger.log(`✅ Deposit successful! Transaction: ${receipt.hash}`);
        return receipt.hash;
      } else {
        throw new Error(`Deposit transaction failed: ${receipt.hash}`);
      }
    } catch (error: any) {
      if (error instanceof ExchangeError) {
        throw error;
      }

      this.logger.error(`Failed to deposit ${asset}: ${error.message}`);
      if (error.transactionHash) {
        this.logger.debug(`Transaction hash: ${error.transactionHash}`);
      }
      throw new ExchangeError(
        `Failed to deposit: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async withdrawExternal(
    amount: number,
    asset: string,
    destination: string,
  ): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be greater than 0');
      }

      if (!destination || !destination.match(/^0x[a-fA-F0-9]{40}$/)) {
        throw new Error(
          'Invalid destination address. Must be a valid Ethereum address (0x followed by 40 hex characters)',
        );
      }

      this.logger.log(
        `Withdrawing $${amount.toFixed(2)} ${asset} to ${destination} on Aster...`,
      );

      if (
        !this.wallet ||
        !this.config.userAddress ||
        !this.config.signerAddress
      ) {
        throw new Error(
          'Wallet, user address, and signer address required for withdrawals. ' +
            'Provide ASTER_USER, ASTER_SIGNER, and ASTER_PRIVATE_KEY.',
        );
      }

      // Aster withdrawal uses EIP712 signature (not regular Ethereum message signature)
      // Endpoint: /fapi/aster/user-withdraw (uses API key + HMAC signature with PRIVATE_KEY)
      // Documentation: https://github.com/asterdex/api-docs/blob/master/aster-deposit-withdrawal.md

      // Chain ID: 42161 (Arbitrum), 56 (BSC), 1 (Ethereum)
      // Default to Arbitrum (42161) as that's where most withdrawals go
      const chainId = 42161; // Arbitrum One

      // Get withdrawal fee from API (per Aster documentation section 3)
      // Endpoint: /bapi/futures/v1/public/future/aster/estimate-withdraw-fee
      let fee: string;
      try {
        const feeResponse = await axios.get(
          'https://www.asterdex.com/bapi/futures/v1/public/future/aster/estimate-withdraw-fee',
          {
            params: {
              chainId: chainId,
              network: 'EVM',
              currency: asset.toUpperCase(),
              accountType: 'spot',
            },
            timeout: 10000,
          },
        );

        if (
          feeResponse.data?.success &&
          feeResponse.data?.data?.gasCost !== undefined
        ) {
          // gasCost is the estimated withdrawal fee in token units
          fee = feeResponse.data.data.gasCost.toString();
          this.logger.debug(`Withdrawal fee from API: ${fee} ${asset}`);
        } else {
          // Fallback to a default fee if API doesn't return expected format
          fee = '0.5'; // Match test script fallback
          this.logger.warn(`Failed to get fee from API, using default: ${fee}`);
        }
      } catch (feeError: any) {
        // Fallback to a default fee if API call fails
        fee = '0.5'; // Match test script fallback
        this.logger.warn(
          `Failed to query withdrawal fee from API: ${feeError.message}. Using default: ${fee}`,
        );
      }

      // Generate nonce (timestamp in milliseconds, then multiply by 1000 for microseconds)
      // Per Aster docs: "use the current timestamp in milliseconds and multiply '1000'"
      const nonceMs = Date.now();
      const nonceValue = nonceMs * 1000; // Convert to microseconds
      const nonceString = nonceValue.toString(); // String for request body

      // Map chainId to chain name (required for EIP712 signature)
      const chainNameMap: Record<number, string> = {
        56: 'BSC',
        42161: 'Arbitrum',
        1: 'ETH',
      };
      const destinationChain = chainNameMap[chainId] || 'Arbitrum';

      // Build EIP712 domain (per Aster documentation)
      const domain = {
        name: 'Aster',
        version: '1',
        chainId: chainId, // The chainId of the withdraw chain
        verifyingContract: '0x0000000000000000000000000000000000000000', // Fixed zero address
      };

      // Build EIP712 types (per Aster documentation)
      const types = {
        Action: [
          { name: 'type', type: 'string' },
          { name: 'destination', type: 'address' },
          { name: 'destination Chain', type: 'string' },
          { name: 'token', type: 'string' },
          { name: 'amount', type: 'string' },
          { name: 'fee', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'aster chain', type: 'string' },
        ],
      };

      // Build EIP712 message (per Aster documentation)
      // Note: nonce must be a number (not BigInt) for ethers.js signTypedData
      // ethers.js will handle the conversion to uint256 internally
      // Format amount as string with 2 decimal places (Aster API requirement)
      // Aster API rejects amounts with too many decimal places (error: "amount or fee has too many decimal places")
      // USDC/USDT typically use 2 decimal places, so format to 2 decimals
      const amountString = amount.toFixed(2);

      const message = {
        type: 'Withdraw',
        destination: destination.toLowerCase(),
        'destination Chain': destinationChain,
        token: asset.toUpperCase(),
        amount: amountString, // Format to 2 decimal places to match Aster API requirements
        fee: fee,
        nonce: nonceValue, // Use number, ethers.js will convert to uint256
        'aster chain': 'Mainnet',
      };

      // Use /fapi/aster/user-withdraw endpoint (matches web interface and EIP712 test script)
      // This endpoint uses API key + HMAC signature with PRIVATE_KEY, and includes EIP712 userSignature
      if (!this.apiKey) {
        throw new Error(
          'API key required for withdrawals. ' + 'Provide ASTER_API_KEY.',
        );
      }

      // For HMAC signature, use PRIVATE_KEY (per user requirement)
      // User explicitly stated: "PRIVATE_KEY needs to be used for this call from the .env"
      // CRITICAL: Use PRIVATE_KEY for BOTH EIP712 and HMAC signatures (no fallback)
      const privateKeyForBoth =
        this.configService.get<string>('PRIVATE_KEY') ||
        process.env.PRIVATE_KEY;
      if (!privateKeyForBoth) {
        throw new Error(
          'PRIVATE_KEY required for withdrawal signatures. ' +
            'Provide PRIVATE_KEY in .env.',
        );
      }

      // Create EIP712 wallet using PRIVATE_KEY (same key as HMAC)
      const normalizedEip712Key = privateKeyForBoth.startsWith('0x')
        ? privateKeyForBoth
        : `0x${privateKeyForBoth}`;
      const eip712Wallet = new ethers.Wallet(normalizedEip712Key);

      this.logger.debug(
        `Using PRIVATE_KEY for both EIP712 and HMAC signatures ` +
          `(wallet: ${eip712Wallet.address})`,
      );

      // Sign using EIP712 typed data
      // CRITICAL: Use the same private key as HMAC (PRIVATE_KEY || ASTER_PRIVATE_KEY)
      // This ensures both signatures match the test script behavior
      this.logger.debug(
        `EIP712 signature: domain=${JSON.stringify(domain)}, ` +
          `message=${JSON.stringify(message)}`,
      );

      const userSignature = await eip712Wallet.signTypedData(
        domain,
        types,
        message,
      );

      // Debug: Log signature details for troubleshooting
      this.logger.debug(
        `EIP712 signature generated: ${userSignature.substring(0, 20)}... ` +
          `(wallet: ${eip712Wallet.address})`,
      );

      // Remove 0x prefix if present for HMAC
      const privateKeyHex = privateKeyForBoth.replace(/^0x/, '');

      // Build parameters for HMAC signing (per Aster docs section 6)
      // Parameters: chainId, asset, amount, fee, receiver, nonce, userSignature, recvWindow, timestamp
      // Note: userSignature (EIP712) IS included in the HMAC calculation
      // Match script exactly: generate timestamp once and use it
      const timestamp = Date.now();
      const recvWindow = 60000;

      const hmacParams: Record<string, any> = {
        chainId: chainId.toString(),
        asset: asset.toUpperCase(),
        amount: amountString, // Match script: use same string as EIP712 message
        fee: fee,
        receiver: destination.toLowerCase(),
        nonce: nonceString,
        userSignature: userSignature, // EIP712 signature - included in HMAC
        recvWindow: recvWindow, // Match EIP712 test script
        timestamp: timestamp, // Match script: use variable instead of Date.now() directly
      };

      // Remove null/undefined values
      const cleanParams = Object.fromEntries(
        Object.entries(hmacParams).filter(
          ([, value]) => value !== null && value !== undefined,
        ),
      );

      // Build query string for HMAC signing (sorted alphabetically)
      // Match script exactly: use template literals (they auto-convert to strings)
      const queryString = Object.keys(cleanParams)
        .sort()
        .map((key) => `${key}=${cleanParams[key]}`) // No URL encoding, template literal auto-converts
        .join('&');

      // Create HMAC SHA256 signature using PRIVATE_KEY
      this.logger.debug(
        `HMAC signing details:\n` +
          `  Private key source: PRIVATE_KEY\n` +
          `  Private key (first 10 chars): ${privateKeyHex.substring(0, 10)}...\n` +
          `  Query string: ${queryString}\n` +
          `  Query string length: ${queryString.length}`,
      );

      const hmacSignature = crypto
        .createHmac('sha256', privateKeyHex)
        .update(queryString)
        .digest('hex');

      this.logger.debug(`HMAC signature: ${hmacSignature}`);
      this.logger.debug(
        `Full final query string: ${queryString}&signature=${hmacSignature}`,
      );

      // Build final query string: include all params + signature last
      const finalQueryString = `${queryString}&signature=${hmacSignature}`;

      this.logger.debug(
        `Withdrawal via fapi/aster/user-withdraw endpoint: ${this.config.baseUrl}/fapi/aster/user-withdraw?${finalQueryString.substring(0, 200)}...`,
      );

      // Use /fapi/aster/user-withdraw endpoint (matches web interface EIP712 flow)
      // Add retry logic for transient errors (-1000, -1001, -1007, -1016)
      const maxRetries = 3;
      const retryDelay = 2000; // 2 seconds
      let lastError: any = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await this.client.post(
            `/fapi/aster/user-withdraw?${finalQueryString}`,
            {}, // Empty body
            {
              headers: {
                'X-MBX-APIKEY': this.apiKey,
                'Content-Type': 'application/json',
              },
              timeout: 30000,
            },
          );

          // Handle response (per Aster API documentation section 6)
          // /fapi/aster/user-withdraw returns: { withdrawId, hash }
          if (response.data && response.data.withdrawId) {
            const withdrawId = response.data.withdrawId;
            const hash = response.data.hash || 'unknown';
            this.logger.log(
              `✅ Withdrawal successful - Withdrawal ID: ${withdrawId}, Hash: ${hash}`,
            );
            return withdrawId.toString();
          } else if (
            response.data &&
            (response.data.id || response.data.tranId)
          ) {
            // Fallback for other response formats
            const withdrawId = response.data.id || response.data.tranId;
            this.logger.log(
              `✅ Withdrawal successful - Withdrawal ID: ${withdrawId}`,
            );
            return withdrawId.toString();
          } else {
            throw new Error(
              `Withdrawal failed: ${JSON.stringify(response.data)}`,
            );
          }
        } catch (error: any) {
          lastError = error;
          const errorCode = error.response?.data?.code;
          const errorMsg = error.response?.data?.msg || error.message;

          // Check if it's a retryable error
          const retryableErrors = [-1000, -1001, -1007, -1016]; // UNKNOWN, DISCONNECTED, TIMEOUT, SERVICE_SHUTTING_DOWN
          const isRetryable = retryableErrors.includes(errorCode);

          // Check for specific error messages that need longer delays
          const isMultiChainLimit =
            errorMsg && errorMsg.toLowerCase().includes('multi chain limit');
          const isRateLimit =
            errorMsg &&
            (errorMsg.toLowerCase().includes('rate limit') ||
              errorMsg.toLowerCase().includes('too many'));

          // Signature mismatch is NOT retryable - it means the signature is wrong, retrying won't help
          // Only retry on transient server errors, not authentication/signature errors
          const isSignatureError =
            errorMsg &&
            (errorMsg.toLowerCase().includes('signature mismatch') ||
              errorMsg.toLowerCase().includes('signature') ||
              errorCode === -1022); // INVALID_SIGNATURE

          // Don't retry on signature errors - they indicate a code issue, not a transient server error
          if (isSignatureError) {
            this.logger.error(
              `Signature error detected - this indicates a code issue, not a transient error. ` +
                `Error: ${errorMsg}. Please check signature generation logic.`,
            );
            throw new ExchangeError(
              `Withdrawal signature mismatch: ${errorMsg}. This indicates a code issue with signature generation.`,
              ExchangeType.ASTER,
              undefined,
              error,
            );
          }

          if (isRetryable && attempt < maxRetries) {
            // Use longer delay for rate limits (30s, 60s, 90s)
            // Use shorter delay for other retryable errors (2s, 4s, 6s)
            const delay =
              isMultiChainLimit || isRateLimit
                ? 30000 * attempt // 30s, 60s, 90s for rate limits
                : retryDelay * attempt; // 2s, 4s, 6s for other errors

            // Silenced rate limit warnings - only show errors
            if (isRateLimit || isMultiChainLimit) {
              this.logger.debug(
                `Withdrawal attempt ${attempt}/${maxRetries} failed with retryable error ` +
                  `(${errorCode}: ${errorMsg}). Retrying in ${delay}ms...`,
              );
            } else {
              this.logger.warn(
                `Withdrawal attempt ${attempt}/${maxRetries} failed with retryable error ` +
                  `(${errorCode}: ${errorMsg}). Retrying in ${delay}ms...`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          } else {
            // Not retryable or max retries reached
            break;
          }
        }
      }

      // If we get here, all retries failed
      const errorCode = lastError?.response?.data?.code;
      const errorMsg = lastError?.response?.data?.msg || lastError?.message;

      // Provide helpful error messages based on error code
      let errorMessage = `Withdrawal failed after ${maxRetries} attempts`;
      if (errorCode === -1000) {
        // Check for specific error messages
        if (errorMsg && errorMsg.toLowerCase().includes('multi chain limit')) {
          errorMessage =
            'Multi-chain withdrawal rate limit reached. Aster limits withdrawals across different chains. Please wait before retrying or reduce withdrawal frequency.';
        } else if (errorMsg && errorMsg.toLowerCase().includes('rate limit')) {
          errorMessage =
            'Withdrawal rate limit reached. Please wait before retrying.';
        } else {
          errorMessage =
            'Service unavailable (UNKNOWN error). Please try again later.';
        }
      } else if (errorCode === -1001) {
        errorMessage = 'Internal error (DISCONNECTED). Please try again later.';
      } else if (errorCode === -1007) {
        errorMessage = 'Timeout waiting for response. Please try again later.';
      } else if (errorCode === -1016) {
        errorMessage = 'Service is shutting down. Please try again later.';
      } else if (errorCode === -1022) {
        errorMessage =
          'Invalid signature. Check API key and secret configuration.';
      } else if (errorCode === -1021) {
        errorMessage =
          'Timestamp outside recvWindow. Check system clock synchronization.';
      } else if (errorCode === -2015) {
        errorMessage =
          'Invalid API key, IP, or permissions. Check API key configuration.';
      } else if (errorCode === -2018) {
        errorMessage = 'Insufficient balance for withdrawal.';
      } else if (errorMsg) {
        errorMessage = `${errorMessage}: ${errorMsg} (code: ${errorCode || 'N/A'})`;
      }

      throw new Error(errorMessage);
    } catch (error: any) {
      if (error instanceof ExchangeError) {
        throw error;
      }
      this.logger.error(
        `Failed to withdraw ${asset} to ${destination}: ${error.message}`,
      );
      if (error.response) {
        this.logger.debug(
          `Aster API error response: ${JSON.stringify(error.response.data)}`,
        );
      }
      throw new ExchangeError(
        `Failed to withdraw: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Get historical funding payments for the account
   * Uses the Aster /fapi/v1/income endpoint with incomeType=FUNDING_FEE
   * @param startTime Optional start time in milliseconds (default: 7 days ago)
   * @param endTime Optional end time in milliseconds (default: now)
   * @returns Array of funding payments
   */
  async getFundingPayments(
    startTime?: number,
    endTime?: number,
  ): Promise<FundingPayment[]> {
    try {
      const now = Date.now();
      const start = startTime || now - 7 * 24 * 60 * 60 * 1000; // Default: 7 days ago
      const end = endTime || now;

      this.logger.debug(
        `Fetching funding payments from Aster ` +
          `(${new Date(start).toISOString()} to ${new Date(end).toISOString()})`,
      );

      // Try with API key authentication first (HMAC)
      if (this.apiKey && this.apiSecret) {
        const params = this.signParamsWithApiKey({
          incomeType: 'FUNDING_FEE',
          startTime: start,
          endTime: end,
          limit: 1000,
        });

        // Build query string with signature last
        const queryParams: string[] = [];
        const signatureParam: string[] = [];

        for (const [key, value] of Object.entries(params)) {
          if (key === 'signature') {
            signatureParam.push(`signature=${value}`);
          } else {
            queryParams.push(`${key}=${value}`);
          }
        }

        queryParams.sort();
        const queryString =
          queryParams.join('&') +
          (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

        try {
          const response = await this.client.get(
            `/fapi/v1/income?${queryString}`,
            {
              headers: {
                'X-MBX-APIKEY': this.apiKey,
              },
              timeout: 30000,
            },
          );

          if (Array.isArray(response.data)) {
            const payments: FundingPayment[] = [];

            for (const entry of response.data) {
              const amount = parseFloat(entry.income || '0');

              payments.push({
                exchange: ExchangeType.ASTER,
                symbol: entry.symbol || 'UNKNOWN',
                amount: amount,
                fundingRate: 0, // Not provided in income endpoint
                positionSize: 0, // Not provided in income endpoint
                timestamp: new Date(entry.time),
              });
            }

            this.logger.debug(
              `Retrieved ${payments.length} funding payments from Aster`,
            );
            return payments;
          }
        } catch (hmacError: any) {
          this.logger.debug(
            `HMAC auth failed for funding payments: ${hmacError.message}`,
          );
          // Fall through to try Ethereum signature
        }
      }

      // Try with Ethereum signature authentication
      if (this.wallet) {
        const nonce = Math.floor(Date.now() * 1000);
        const params = this.signParams(
          {
            incomeType: 'FUNDING_FEE',
            startTime: start,
            endTime: end,
            limit: 1000,
          },
          nonce,
        );

        try {
          const response = await this.client.get('/fapi/v3/income', {
            params,
            timeout: 30000,
          });

          if (Array.isArray(response.data)) {
            const payments: FundingPayment[] = [];

            for (const entry of response.data) {
              const amount = parseFloat(entry.income || '0');

              payments.push({
                exchange: ExchangeType.ASTER,
                symbol: entry.symbol || 'UNKNOWN',
                amount: amount,
                fundingRate: 0,
                positionSize: 0,
                timestamp: new Date(entry.time),
              });
            }

            this.logger.debug(
              `Retrieved ${payments.length} funding payments from Aster`,
            );
            return payments;
          }
        } catch (ethError: any) {
          this.logger.debug(
            `Ethereum signature auth failed for funding payments: ${ethError.message}`,
          );
        }
      }

      // All methods failed
      this.logger.warn(
        'Could not fetch funding payments from Aster - both auth methods failed',
      );
      return [];
    } catch (error: any) {
      this.logger.error(`Failed to get funding payments: ${error.message}`);
      // Return empty array instead of throwing to allow system to continue
      return [];
    }
  }
}

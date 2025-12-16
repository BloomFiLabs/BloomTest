import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeConfig, ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  OrderStatus,
} from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter, ExchangeError, FundingPayment } from '../../../domain/ports/IPerpExchangeAdapter';
import { AsterExchangeAdapter } from '../aster/AsterExchangeAdapter';
import { LighterExchangeAdapter } from '../lighter/LighterExchangeAdapter';
import { HyperliquidExchangeAdapter } from '../hyperliquid/HyperliquidExchangeAdapter';
import { ExtendedExchangeAdapter } from '../extended/ExtendedExchangeAdapter';

/**
 * Pending limit order awaiting price threshold
 */
interface PendingLimitOrder {
  orderId: string;
  request: PerpOrderRequest;
  status: OrderStatus;
  createdAt: Date;
  expiresAt: Date;
  fillPrice?: number;
  filledSize?: number;
  filledAt?: Date;
}

/**
 * MockExchangeAdapter - Wraps real exchange adapters for testing
 * 
 * In test mode, this adapter:
 * - Uses REAL market data (prices, order books, funding rates) from actual exchanges
 * - Tracks FAKE positions and balances internally
 * - Simulates order execution without placing real orders
 * - Calculates realistic slippage based on real order book depth
 * - LIMIT ORDERS: Only fill when price crosses the limit threshold (realistic mode)
 *   Set MOCK_INSTANT_FILL=true to fill all orders immediately (fast test mode)
 */
@Injectable()
export class MockExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(MockExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private mockBalance: number = 0;
  private mockPositions: Map<string, PerpPosition> = new Map();
  private orderCounter: number = 0;
  private readonly exchangeType: ExchangeType;
  private readonly realAdapter: IPerpExchangeAdapter; // Delegate to real adapter for market data

  // Pending limit orders queue
  private pendingOrders: Map<string, PendingLimitOrder> = new Map();
  
  // Price polling interval (ms)
  private readonly PRICE_POLL_INTERVAL = 2000; // Poll every 2 seconds
  private readonly ORDER_EXPIRY_MS = 60 * 60 * 1000; // Orders expire after 1 hour
  private pricePollingInterval: NodeJS.Timeout | null = null;
  private readonly instantFill: boolean;

  constructor(
    private readonly configService: ConfigService,
    exchangeType: ExchangeType,
    private readonly asterAdapter: AsterExchangeAdapter | null,
    private readonly lighterAdapter: LighterExchangeAdapter | null,
    private readonly hyperliquidAdapter: HyperliquidExchangeAdapter | null,
    private readonly extendedAdapter: ExtendedExchangeAdapter | null = null,
  ) {
    this.exchangeType = exchangeType;
    
    // Get the real adapter for this exchange type
    switch (exchangeType) {
      case ExchangeType.ASTER:
        if (!asterAdapter) throw new Error('Aster adapter required for mock');
        this.realAdapter = asterAdapter;
        break;
      case ExchangeType.LIGHTER:
        if (!lighterAdapter) throw new Error('Lighter adapter required for mock');
        this.realAdapter = lighterAdapter;
        break;
      case ExchangeType.HYPERLIQUID:
        if (!hyperliquidAdapter) throw new Error('Hyperliquid adapter required for mock');
        this.realAdapter = hyperliquidAdapter;
        break;
      case ExchangeType.EXTENDED:
        if (!extendedAdapter) {
          // Extended adapter is optional - use a stub that returns empty data
          this.logger.warn('Extended adapter not available - mock will return empty market data');
          this.realAdapter = {
            getBalance: async () => 0,
            getPositions: async () => [],
            getPosition: async () => null,
            placeOrder: async () => { throw new Error('Extended adapter not configured'); },
            cancelOrder: async () => { throw new Error('Extended adapter not configured'); },
            cancelAllOrders: async () => 0,
            getOpenOrders: async () => [],
            getOrderStatus: async () => ({ status: 'UNKNOWN' } as any),
            getBestBidAsk: async () => ({ bestBid: 0, bestAsk: 0 }),
            getAvailableMargin: async () => 0,
            getAccountInfo: async () => ({}),
            getFundingPayments: async () => [],
            getExchangeType: () => ExchangeType.EXTENDED,
            getConfig: () => ({ exchangeType: ExchangeType.EXTENDED } as any),
            getMarkPrice: async () => 0,
            getEquity: async () => 0,
            isReady: () => false,
            initialize: async () => {},
            dispose: async () => {},
            getMaxLeverage: async () => 1,
            setLeverage: async () => {},
          } as unknown as IPerpExchangeAdapter;
        } else {
          this.realAdapter = extendedAdapter;
        }
        break;
      default:
        throw new Error(`Unsupported exchange type: ${exchangeType}`);
    }
    
    // Initialize mock capital from env (default 5M split across exchanges)
    const mockCapital = parseFloat(
      this.configService.get<string>('MOCK_CAPITAL_USD') || '5000000'
    );
    // Split capital across 4 exchanges (Aster, Lighter, Hyperliquid, Extended)
    this.mockBalance = mockCapital / 4;
    
    // Use the real adapter's config (it has all the necessary credentials)
    this.config = this.realAdapter.getConfig();

    // Check if instant fill mode is enabled (default: false = realistic limit orders)
    this.instantFill = this.configService.get<string>('MOCK_INSTANT_FILL') === 'true';

    this.logger.log(
      `🧪 MockExchangeAdapter initialized for ${exchangeType} with mock balance: $${this.mockBalance.toFixed(2)} ` +
      `(using REAL market data from exchange)`
    );
    
    if (!this.instantFill) {
      this.logger.log(
        `📊 Limit order mode: REALISTIC (orders fill when price crosses threshold)`
      );
      // Start price polling for limit orders
      this.startPricePolling();
    } else {
      this.logger.log(`⚡ Limit order mode: INSTANT FILL (for fast testing)`);
    }
  }

  /**
   * Start polling prices to check if pending limit orders should fill
   */
  private startPricePolling(): void {
    if (this.pricePollingInterval) {
      clearInterval(this.pricePollingInterval);
    }

    this.pricePollingInterval = setInterval(async () => {
      await this.checkPendingOrders();
    }, this.PRICE_POLL_INTERVAL);
  }

  /**
   * Stop price polling (cleanup)
   */
  public stopPricePolling(): void {
    if (this.pricePollingInterval) {
      clearInterval(this.pricePollingInterval);
      this.pricePollingInterval = null;
    }
  }

  /**
   * Check all pending limit orders and fill those where price crossed threshold
   */
  private async checkPendingOrders(): Promise<void> {
    const now = new Date();

    for (const [orderId, order] of this.pendingOrders.entries()) {
      // Check expiry
      if (now > order.expiresAt) {
        order.status = OrderStatus.EXPIRED;
        this.pendingOrders.delete(orderId);
        this.logger.debug(`[MOCK] Order ${orderId} expired`);
        continue;
      }

      // Check if price crossed threshold
      try {
        const currentPrice = await this.realAdapter.getMarkPrice(order.request.symbol);
        const limitPrice = order.request.price || currentPrice;

        let shouldFill = false;

        if (order.request.side === OrderSide.LONG) {
          // Buy limit: fill when price <= limit price
          shouldFill = currentPrice <= limitPrice;
        } else {
          // Sell limit: fill when price >= limit price
          shouldFill = currentPrice >= limitPrice;
        }

        if (shouldFill) {
          this.logger.log(
            `[MOCK] 📈 Limit order ${orderId} triggered: ${order.request.symbol} ` +
            `price ${currentPrice.toFixed(2)} crossed limit ${limitPrice.toFixed(2)}`
          );
          await this.executeLimitOrderFill(order, currentPrice);
        }
      } catch (error: any) {
        this.logger.debug(`[MOCK] Error checking price for ${order.request.symbol}: ${error.message}`);
      }
    }
  }

  /**
   * Execute a limit order fill
   */
  private async executeLimitOrderFill(order: PendingLimitOrder, currentPrice: number): Promise<void> {
    const request = order.request;
    const fillPrice = request.price || currentPrice;

    // Update order status
    order.status = OrderStatus.FILLED;
    order.fillPrice = fillPrice;
    order.filledSize = request.size;
    order.filledAt = new Date();

    // Update position (same logic as market order fill)
    await this.updatePositionOnFill(request, fillPrice);

    // Remove from pending
    this.pendingOrders.delete(order.orderId);

    this.logger.log(
      `[MOCK] ✅ Limit order ${order.orderId} filled: ${request.side} ${request.size} ${request.symbol} @ $${fillPrice.toFixed(2)}`
    );
  }

  /**
   * Update position when an order fills
   */
  private async updatePositionOnFill(request: PerpOrderRequest, fillPrice: number): Promise<void> {
    const existingPosition = this.mockPositions.get(request.symbol);
    
    if (existingPosition) {
      if (request.reduceOnly) {
        // Closing position
        const closeSize = Math.min(request.size, existingPosition.size);
        const newSize = existingPosition.size - closeSize;
        
        if (newSize <= 0.001) {
          this.mockPositions.delete(request.symbol);
        } else {
          const newPosition = new PerpPosition(
            this.exchangeType,
            request.symbol,
            existingPosition.side,
            newSize,
            existingPosition.entryPrice,
            fillPrice,
            (fillPrice - existingPosition.entryPrice) * newSize * (existingPosition.side === OrderSide.LONG ? 1 : -1),
            1,
            undefined,
            undefined,
            undefined,
            new Date(),
          );
          this.mockPositions.set(request.symbol, newPosition);
        }
      } else {
        // Increasing position
        const totalSize = existingPosition.size + request.size;
        const avgEntryPrice = (existingPosition.entryPrice * existingPosition.size + fillPrice * request.size) / totalSize;
        
        const newPosition = new PerpPosition(
          this.exchangeType,
          request.symbol,
          existingPosition.side,
          totalSize,
          avgEntryPrice,
          fillPrice,
          (fillPrice - avgEntryPrice) * totalSize * (existingPosition.side === OrderSide.LONG ? 1 : -1),
          1,
          undefined,
          undefined,
          undefined,
          new Date(),
        );
        this.mockPositions.set(request.symbol, newPosition);
      }
    } else {
      // New position
      const newPosition = new PerpPosition(
        this.exchangeType,
        request.symbol,
        request.side,
        request.size,
        fillPrice,
        fillPrice,
        0,
        1,
        undefined,
        undefined,
        undefined,
        new Date(),
      );
      this.mockPositions.set(request.symbol, newPosition);
    }
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return this.exchangeType;
  }

  /**
   * Calculate realistic slippage based on REAL order book depth
   * Uses real market data to estimate slippage and market impact
   */
  private async calculateSlippageAndImpact(
    symbol: string,
    orderSize: number,
    orderValue: number,
    side: OrderSide,
    orderType: OrderType,
  ): Promise<{ slippage: number; priceImpact: number }> {
    try {
      // Get real order book data from the exchange
      let bestBid: number | undefined;
      let bestAsk: number | undefined;
      
      // Try to get best bid/ask from real adapter
      if ('getBestBidAsk' in this.realAdapter && typeof (this.realAdapter as any).getBestBidAsk === 'function') {
        const bidAsk = await (this.realAdapter as any).getBestBidAsk(symbol);
        bestBid = bidAsk.bestBid;
        bestAsk = bidAsk.bestAsk;
      }
      
      // If we have order book data, calculate slippage based on real depth
      if (bestBid && bestAsk) {
        const spread = bestAsk - bestBid;
        const midPrice = (bestBid + bestAsk) / 2;
        const spreadPercent = spread / midPrice;
        
        // Estimate available liquidity at best bid/ask
        // For simplicity, assume we can get ~1% of daily volume at best price
        // In reality, this would come from order book depth
        const markPrice = await this.realAdapter.getMarkPrice(symbol);
        const estimatedLiquidity = markPrice * orderSize * 100; // Rough estimate
        
        // Calculate slippage based on order size relative to estimated liquidity
        const liquidityRatio = orderValue / estimatedLiquidity;
        
        // Square root model: slippage increases with sqrt(order_size / liquidity)
        const baseSlippage = orderType === OrderType.MARKET 
          ? spreadPercent / 2  // Pay half the spread for market orders
          : 0.0001; // Minimal slippage for limit orders
        
        const impactSlippage = Math.sqrt(Math.min(liquidityRatio, 1)) * spreadPercent * 2;
        const slippagePercent = Math.min(baseSlippage + impactSlippage, 0.05); // Cap at 5%
        
        // Price impact: how much our trade moves the market
        const priceImpactPercent = Math.min(Math.sqrt(liquidityRatio) * spreadPercent, 0.02);
        
        return {
          slippage: slippagePercent,
          priceImpact: priceImpactPercent,
        };
      }
    } catch (error: any) {
      this.logger.debug(`Failed to get real order book for slippage calculation: ${error.message}`);
    }
    
    // Fallback: use mark price spread estimate
    const markPrice = await this.realAdapter.getMarkPrice(symbol);
    const estimatedSpread = markPrice * 0.001; // Assume 0.1% spread
    const baseSlippage = orderType === OrderType.MARKET ? 0.0005 : 0.0001;
    
    return {
      slippage: baseSlippage,
      priceImpact: 0.0002, // Small impact
    };
  }

  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    this.logger.debug(
      `[MOCK] Placing ${request.side} ${request.type} order: ${request.size} ${request.symbol}`
    );

    // Simulate order processing delay
    await new Promise(resolve => setTimeout(resolve, 50));

    const orderId = `mock-${this.exchangeType}-${++this.orderCounter}`;
    
    // Get REAL mark price from actual exchange
    const markPrice = await this.realAdapter.getMarkPrice(request.symbol);
    
    // Calculate order value for slippage calculation
    const orderValue = request.size * markPrice;
    
    // Check if we have enough balance (margin check)
    const positionValue = request.size * (request.price || markPrice);
    if (positionValue > this.mockBalance * 10 && !request.reduceOnly) {
      throw new ExchangeError(
        `Insufficient balance for order: need $${positionValue.toFixed(2)}, have $${this.mockBalance.toFixed(2)}`,
        this.exchangeType,
        'INSUFFICIENT_BALANCE',
      );
    }

    // MARKET ORDERS: Always fill immediately
    if (request.type === OrderType.MARKET) {
      return this.executeMarketOrder(request, orderId, markPrice, orderValue);
    }

    // LIMIT ORDERS: Check fill mode
    if (this.instantFill) {
      // Instant fill mode: fill immediately at limit price
      const fillPrice = request.price || markPrice;
      await this.updatePositionOnFill(request, fillPrice);
      
      return new PerpOrderResponse(
        orderId,
        OrderStatus.FILLED,
        request.symbol,
        request.side,
        request.clientOrderId,
        request.size,
        fillPrice,
        undefined,
        new Date(),
      );
    }

    // REALISTIC LIMIT ORDER: Check if it should fill immediately or go pending
    const limitPrice = request.price || markPrice;
    let shouldFillNow = false;

    if (request.side === OrderSide.LONG) {
      // Buy limit fills if current price <= limit price
      shouldFillNow = markPrice <= limitPrice;
    } else {
      // Sell limit fills if current price >= limit price
      shouldFillNow = markPrice >= limitPrice;
    }

    if (shouldFillNow) {
      // Price already favorable - fill immediately
      this.logger.log(
        `[MOCK] Limit order fills immediately: price $${markPrice.toFixed(2)} is ` +
        `${request.side === OrderSide.LONG ? '<=' : '>='} limit $${limitPrice.toFixed(2)}`
      );
      
      await this.updatePositionOnFill(request, limitPrice);
      
      return new PerpOrderResponse(
        orderId,
        OrderStatus.FILLED,
        request.symbol,
        request.side,
        request.clientOrderId,
        request.size,
        limitPrice,
        undefined,
        new Date(),
      );
    }

    // Price not favorable yet - add to pending queue
    const now = new Date();
    const pendingOrder: PendingLimitOrder = {
      orderId,
      request,
      status: OrderStatus.PENDING,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.ORDER_EXPIRY_MS),
    };

    this.pendingOrders.set(orderId, pendingOrder);

    this.logger.log(
      `[MOCK] 🕐 Limit order ${orderId} queued: ${request.side} ${request.size} ${request.symbol} ` +
      `@ $${limitPrice.toFixed(2)} (current: $${markPrice.toFixed(2)}, ` +
      `waiting for price to ${request.side === OrderSide.LONG ? 'drop' : 'rise'})`
    );

    return new PerpOrderResponse(
      orderId,
      OrderStatus.PENDING,
      request.symbol,
      request.side,
      request.clientOrderId,
      undefined, // Not filled yet
      undefined, // No fill price yet
      undefined,
      new Date(),
    );
  }

  /**
   * Execute a market order immediately
   */
  private async executeMarketOrder(
    request: PerpOrderRequest,
    orderId: string,
    markPrice: number,
    orderValue: number,
  ): Promise<PerpOrderResponse> {
    // Calculate realistic slippage and market impact using REAL order book data
    const { slippage, priceImpact } = await this.calculateSlippageAndImpact(
      request.symbol,
      request.size,
      orderValue,
      request.side,
      request.type,
    );
    
    // Apply slippage and price impact to fill price
    let fillPrice: number;
    if (request.side === OrderSide.LONG) {
      // Buying: price moves up (pay more)
      fillPrice = markPrice * (1 + slippage + priceImpact);
    } else {
      // Selling: price moves down (get less)
      fillPrice = markPrice * (1 - slippage - priceImpact);
    }
    
    // Log slippage for large orders
    if (orderValue > 100000) {
      this.logger.debug(
        `[MOCK] Large order (using REAL market data): ` +
        `slippage: ${(slippage * 100).toFixed(3)}%, ` +
        `price impact: ${(priceImpact * 100).toFixed(3)}%, ` +
        `order value: $${orderValue.toFixed(2)}, ` +
        `mark price: $${markPrice.toFixed(2)}`
      );
    }

    // Update position
    await this.updatePositionOnFill(request, fillPrice);

    return new PerpOrderResponse(
      orderId,
      OrderStatus.FILLED,
      request.symbol,
      request.side,
      request.clientOrderId,
      request.size,
      fillPrice,
      undefined,
      new Date(),
    );
  }

  async getPosition(symbol: string): Promise<PerpPosition | null> {
    const position = this.mockPositions.get(symbol);
    if (!position) return null;

    // Update mark price and unrealized PnL
    const markPrice = await this.getMarkPrice(symbol);
    const unrealizedPnl = (markPrice - position.entryPrice) * position.size * 
      (position.side === OrderSide.LONG ? 1 : -1);

    return new PerpPosition(
      position.exchangeType,
      position.symbol,
      position.side,
      position.size,
      position.entryPrice,
      markPrice,
      unrealizedPnl,
      position.leverage,
      position.liquidationPrice,
      position.marginUsed,
      position.timestamp,
      new Date(),
    );
  }

  async getPositions(): Promise<PerpPosition[]> {
    const positions: PerpPosition[] = [];
    
    for (const [symbol] of this.mockPositions.entries()) {
      const position = await this.getPosition(symbol);
      if (position) {
        positions.push(position);
      }
    }

    return positions;
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    this.logger.debug(`[MOCK] Cancelling order ${orderId}`);
    
    const pendingOrder = this.pendingOrders.get(orderId);
    if (pendingOrder) {
      pendingOrder.status = OrderStatus.CANCELLED;
      this.pendingOrders.delete(orderId);
      this.logger.log(`[MOCK] ❌ Order ${orderId} cancelled`);
      return true;
    }
    
    return true; // Order might have already filled
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    this.logger.debug(`[MOCK] Cancelling all orders for ${symbol}`);
    
    let cancelledCount = 0;
    for (const [orderId, order] of this.pendingOrders.entries()) {
      if (order.request.symbol === symbol) {
        order.status = OrderStatus.CANCELLED;
        this.pendingOrders.delete(orderId);
        cancelledCount++;
      }
    }
    
    if (cancelledCount > 0) {
      this.logger.log(`[MOCK] ❌ Cancelled ${cancelledCount} orders for ${symbol}`);
    }
    
    return cancelledCount;
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    // Check pending orders first
    const pendingOrder = this.pendingOrders.get(orderId);
    if (pendingOrder) {
      return new PerpOrderResponse(
        orderId,
        pendingOrder.status,
        pendingOrder.request.symbol,
        pendingOrder.request.side,
        pendingOrder.request.clientOrderId,
        pendingOrder.filledSize,
        pendingOrder.fillPrice,
        undefined,
        pendingOrder.filledAt || pendingOrder.createdAt,
      );
    }
    
    // If not in pending, assume it was filled
    return new PerpOrderResponse(
      orderId,
      OrderStatus.FILLED,
      symbol || 'UNKNOWN',
      OrderSide.LONG,
      undefined,
      undefined,
      undefined,
      undefined,
      new Date(),
    );
  }

  /**
   * Get all pending limit orders
   */
  getPendingOrders(): PendingLimitOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  /**
   * Get pending orders for a specific symbol
   */
  getPendingOrdersForSymbol(symbol: string): PendingLimitOrder[] {
    return Array.from(this.pendingOrders.values()).filter(
      order => order.request.symbol === symbol
    );
  }

  /**
   * Manually trigger price check (useful for testing)
   */
  async triggerPriceCheck(): Promise<void> {
    await this.checkPendingOrders();
  }

  async getMarkPrice(symbol: string): Promise<number> {
    // Use REAL mark price from actual exchange
    return await this.realAdapter.getMarkPrice(symbol);
  }

  async getBalance(): Promise<number> {
    return this.mockBalance;
  }

  async getEquity(): Promise<number> {
    let totalEquity = this.mockBalance;
    
    // Add unrealized PnL from positions
    for (const position of this.mockPositions.values()) {
      const markPrice = await this.getMarkPrice(position.symbol);
      const unrealizedPnl = (markPrice - position.entryPrice) * position.size * 
        (position.side === OrderSide.LONG ? 1 : -1);
      totalEquity += unrealizedPnl;
    }

    return totalEquity;
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async testConnection(): Promise<void> {
    // Mock connection always succeeds
    this.logger.debug(`[MOCK] Connection test successful for ${this.exchangeType}`);
  }

  async transferInternal(amount: number, toPerp: boolean): Promise<string> {
    this.logger.debug(
      `[MOCK] Transferring $${amount.toFixed(2)} ${toPerp ? 'spot → perp' : 'perp → spot'}`
    );
    return `mock-transfer-${Date.now()}`;
  }

  async depositExternal(amount: number, asset: string, destination?: string): Promise<string> {
    this.logger.debug(`[MOCK] Depositing $${amount.toFixed(2)} ${asset}`);
    this.mockBalance += amount;
    return `mock-deposit-${Date.now()}`;
  }

  async withdrawExternal(amount: number, asset: string, destination: string): Promise<string> {
    if (amount > this.mockBalance) {
      throw new ExchangeError(
        `Insufficient balance for withdrawal: need $${amount.toFixed(2)}, have $${this.mockBalance.toFixed(2)}`,
        this.exchangeType,
        'INSUFFICIENT_BALANCE',
      );
    }
    
    this.logger.debug(`[MOCK] Withdrawing $${amount.toFixed(2)} ${asset} to ${destination}`);
    this.mockBalance -= amount;
    return `mock-withdraw-${Date.now()}`;
  }

  /**
   * Set mock balance (useful for testing)
   */
  setMockBalance(balance: number): void {
    this.mockBalance = balance;
  }

  /**
   * Get best bid/ask from real exchange (if available)
   */
  async getBestBidAsk(symbol: string): Promise<{ bestBid: number; bestAsk: number }> {
    if ('getBestBidAsk' in this.realAdapter && typeof (this.realAdapter as any).getBestBidAsk === 'function') {
      return await (this.realAdapter as any).getBestBidAsk(symbol);
    }
    
    // Fallback: use mark price and estimate spread
    const markPrice = await this.realAdapter.getMarkPrice(symbol);
    const spread = markPrice * 0.001; // Assume 0.1% spread
    return {
      bestBid: markPrice - spread / 2,
      bestAsk: markPrice + spread / 2,
    };
  }

  /**
   * Get funding payments - delegates to real adapter
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPayment[]> {
    // In mock mode, return empty array (no real positions = no real funding)
    // But if you want to see real funding for testing, delegate to real adapter
    if ('getFundingPayments' in this.realAdapter && typeof (this.realAdapter as any).getFundingPayments === 'function') {
      return await this.realAdapter.getFundingPayments(startTime, endTime);
    }
    return [];
  }
}


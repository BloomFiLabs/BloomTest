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
import { IPerpExchangeAdapter, ExchangeError } from '../../../domain/ports/IPerpExchangeAdapter';
import { AsterExchangeAdapter } from '../aster/AsterExchangeAdapter';
import { LighterExchangeAdapter } from '../lighter/LighterExchangeAdapter';
import { HyperliquidExchangeAdapter } from '../hyperliquid/HyperliquidExchangeAdapter';

/**
 * MockExchangeAdapter - Wraps real exchange adapters for testing
 * 
 * In test mode, this adapter:
 * - Uses REAL market data (prices, order books, funding rates) from actual exchanges
 * - Tracks FAKE positions and balances internally
 * - Simulates order execution without placing real orders
 * - Calculates realistic slippage based on real order book depth
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

  constructor(
    private readonly configService: ConfigService,
    exchangeType: ExchangeType,
    private readonly asterAdapter: AsterExchangeAdapter,
    private readonly lighterAdapter: LighterExchangeAdapter,
    private readonly hyperliquidAdapter: HyperliquidExchangeAdapter,
  ) {
    this.exchangeType = exchangeType;
    
    // Get the real adapter for this exchange type
    switch (exchangeType) {
      case ExchangeType.ASTER:
        this.realAdapter = asterAdapter;
        break;
      case ExchangeType.LIGHTER:
        this.realAdapter = lighterAdapter;
        break;
      case ExchangeType.HYPERLIQUID:
        this.realAdapter = hyperliquidAdapter;
        break;
      default:
        throw new Error(`Unsupported exchange type: ${exchangeType}`);
    }
    
    // Initialize mock capital from env (default 5M split across exchanges)
    const mockCapital = parseFloat(
      this.configService.get<string>('MOCK_CAPITAL_USD') || '5000000'
    );
    // Split capital across 3 exchanges (Aster, Lighter, Hyperliquid)
    this.mockBalance = mockCapital / 3;
    
    // Use the real adapter's config (it has all the necessary credentials)
    this.config = this.realAdapter.getConfig();

    this.logger.log(
      `🧪 MockExchangeAdapter initialized for ${exchangeType} with mock balance: $${this.mockBalance.toFixed(2)} ` +
      `(using REAL market data from exchange)`
    );
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
      `[MOCK] Placing ${request.side} order: ${request.size} ${request.symbol} ` +
      `(${request.type})`
    );

    // Simulate order processing delay
    await new Promise(resolve => setTimeout(resolve, 50));

    const orderId = `mock-${this.exchangeType}-${++this.orderCounter}`;
    
    // Get REAL mark price from actual exchange
    const markPrice = await this.realAdapter.getMarkPrice(request.symbol);
    
    // Calculate order value for slippage calculation
    const orderValue = request.size * markPrice;
    
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
    if (request.type === OrderType.MARKET) {
      // Market orders: pay slippage + price impact based on real order book
      if (request.side === OrderSide.LONG) {
        // Buying: price moves up (pay more)
        fillPrice = markPrice * (1 + slippage + priceImpact);
      } else {
        // Selling: price moves down (get less)
        fillPrice = markPrice * (1 - slippage - priceImpact);
      }
    } else {
      // Limit orders: use requested price
      fillPrice = request.price || markPrice;
    }
    
    // Log slippage for large orders
    if (orderValue > 100000) { // Orders > $100k
      this.logger.debug(
        `[MOCK] Large order (using REAL market data): ` +
        `slippage: ${(slippage * 100).toFixed(3)}%, ` +
        `price impact: ${(priceImpact * 100).toFixed(3)}%, ` +
        `order value: $${orderValue.toFixed(2)}, ` +
        `mark price: $${markPrice.toFixed(2)}`
      );
    }

    // Calculate position value (using fill price which includes slippage)
    const positionValue = request.size * fillPrice;

    // Check if we have enough balance
    if (positionValue > this.mockBalance * 10) {
      // Require 10% margin
      throw new ExchangeError(
        `Insufficient balance for order: need $${positionValue.toFixed(2)}, have $${this.mockBalance.toFixed(2)}`,
        this.exchangeType,
        'INSUFFICIENT_BALANCE',
      );
    }

    // Update or create position
    const existingPosition = this.mockPositions.get(request.symbol);
    if (existingPosition) {
      if (request.reduceOnly) {
        // Closing position
        const closeSize = Math.min(request.size, existingPosition.size);
        const newSize = existingPosition.size - closeSize;
        
        if (newSize <= 0.001) {
          // Position fully closed
          this.mockPositions.delete(request.symbol);
        } else {
          // Partial close - update position
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
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    this.logger.debug(`[MOCK] Cancelling all orders for ${symbol}`);
    return 0;
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    // Mock orders are always filled immediately
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
}


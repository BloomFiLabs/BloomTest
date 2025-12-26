import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { OrderSide, OrderType, TimeInForce, PerpOrderRequest, OrderStatus } from '../../value-objects/PerpOrder';
import { ExecutionLockService, ActiveOrder } from '../../../infrastructure/services/ExecutionLockService';
import { DiagnosticsService } from '../../../infrastructure/services/DiagnosticsService';
import { HyperLiquidWebSocketProvider } from '../../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider } from '../../../infrastructure/adapters/lighter/LighterWebSocketProvider';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { Interval } from '@nestjs/schedule';
import { PerpPosition } from '../../entities/PerpPosition';
import { PerpKeeperOrchestrator } from '../../services/PerpKeeperOrchestrator';

/**
 * OrderGuardianService - The unified "intelligent being" for order and leg safety
 */
@Injectable()
export class OrderGuardianService implements OnModuleInit {
  private readonly logger = new Logger(OrderGuardianService.name);
  
  // Configuration
  private readonly MIN_AGE_SECONDS = 45;
  private readonly AGGRESSIVE_AGE_SECONDS = 90;
  private readonly MARKET_ORDER_AGE_SECONDS = 120;
  private readonly ZOMBIE_TIMEOUT_SECONDS = 300;
  private readonly MAX_RETRIES = 5;

  // State
  private readonly singleLegRetries: Map<string, {
    retryCount: number;
    lastRetryTime: Date;
    longExchange: ExchangeType;
    shortExchange: ExchangeType;
  }> = new Map();

  constructor(
    private readonly executionLockService: ExecutionLockService,
    private readonly keeperService: PerpKeeperService,
    private readonly orchestrator: PerpKeeperOrchestrator,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly hyperliquidWs?: HyperLiquidWebSocketProvider,
    @Optional() private readonly lighterWs?: LighterWebSocketProvider,
  ) {}

  async onModuleInit() {
    this.setupWebSocketListeners();
    this.logger.log('🛡️ OrderGuardianService initialized');
  }

  private setupWebSocketListeners() {
    if (this.hyperliquidWs) {
      this.hyperliquidWs.onOrderUpdate((update) => {
        if (update.order.status === 'filled' || update.order.status === 'canceled') {
          this.handleTerminalStatus(ExchangeType.HYPERLIQUID, update.order.coin.toUpperCase(), 
            update.order.side === 'B' ? OrderSide.LONG : OrderSide.SHORT, update.order.oid.toString(), update.order.status.toUpperCase() as any);
        }
      });
    }
    if (this.lighterWs) {
      this.lighterWs.onOrderUpdate((update) => {
        if (update.status === 'filled' || update.status === 'canceled') {
          this.handleTerminalStatus(ExchangeType.LIGHTER, `MARKET_${update.marketIndex}`, 
            update.side === 'bid' ? OrderSide.LONG : OrderSide.SHORT, update.orderId, update.status.toUpperCase() as any);
        }
      });
    }
  }

  /**
   * Main protection loop - runs every 30 seconds
   */
  @Interval(30000)
  async protect() {
    try {
      const activeOrders = this.executionLockService.getAllActiveOrders();
      if (activeOrders.length === 0) return;

      const now = Date.now();
      const executionThreads = new Map<string, ActiveOrder[]>();
      
      for (const order of activeOrders) {
        const thread = order.threadId;
        if (!executionThreads.has(thread)) executionThreads.set(thread, []);
        executionThreads.get(thread)!.push(order);
      }

      for (const [threadId, orders] of executionThreads.entries()) {
        await this.analyzeThreadHealth(threadId, orders, now);
      }

      await this.cleanupLostOrders(activeOrders, now);
    } catch (error: any) {
      this.logger.error(`Error in OrderGuardian loop: ${error.message}`);
    }
  }

  /**
   * Reactive recovery: Try to open the missing side of a single leg position
   */
  async tryOpenMissingSide(position: PerpPosition): Promise<boolean> {
    const symbol = this.normalizeSymbol(position.symbol);
    const retryKey = this.getRetryKey(symbol, position.exchangeType);
    
    let retryInfo = this.singleLegRetries.get(retryKey);
    
    // If no retry info, determine exchanges
    if (!retryInfo) {
      const comparison = await this.orchestrator.compareFundingRates(position.symbol);
      if (!comparison || comparison.rates.length < 2) return false;
      
      const otherExchanges = comparison.rates.map(r => r.exchange).filter(e => e !== position.exchangeType);
      if (otherExchanges.length === 0) return false;
      
      const missingExchange = otherExchanges.includes(ExchangeType.HYPERLIQUID) ? ExchangeType.HYPERLIQUID : otherExchanges[0];
      
      retryInfo = {
        retryCount: 0,
        lastRetryTime: new Date(),
        longExchange: position.side === OrderSide.LONG ? position.exchangeType : missingExchange,
        shortExchange: position.side === OrderSide.SHORT ? position.exchangeType : missingExchange
      };
      this.singleLegRetries.set(retryKey, retryInfo);
    }

    if (retryInfo.retryCount >= this.MAX_RETRIES) return false;

    retryInfo.retryCount++;
    retryInfo.lastRetryTime = new Date();

    const missingExchange = position.side === OrderSide.LONG ? retryInfo.shortExchange : retryInfo.longExchange;
    const missingSide = position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;

    this.logger.log(`🛠️ Reactive recovery for ${symbol}: Opening ${missingSide} on ${missingExchange} (Attempt ${retryInfo.retryCount})`);

    const adapter = this.keeperService.getExchangeAdapter(missingExchange);
    if (!adapter) return false;

    try {
      // Check for existing pending orders first
      if (typeof (adapter as any).getOpenOrders === 'function') {
        const openOrders = await (adapter as any).getOpenOrders();
        const pending = openOrders.filter((o: any) => 
          this.normalizeSymbol(o.symbol) === symbol && 
          ((missingSide === OrderSide.LONG && (o.side === 'BUY' || o.side === 'LONG' || o.side === 'B')) ||
           (missingSide === OrderSide.SHORT && (o.side === 'SELL' || o.side === 'SHORT' || o.side === 'S')))
        );

        if (pending.length > 0) {
          this.logger.debug(`⏳ Found ${pending.length} pending orders for ${symbol} on ${missingExchange}, waiting...`);
          return false;
        }
      }

      const markPrice = await adapter.getMarkPrice(position.symbol);
      const resp = await adapter.placeOrder(new PerpOrderRequest(position.symbol, missingSide, OrderType.LIMIT, Math.abs(position.size), markPrice, TimeInForce.GTC));
      
      if (resp.isSuccess() && resp.orderId) {
        this.executionLockService.registerOrderPlacing(resp.orderId, position.symbol, missingExchange, missingSide === OrderSide.LONG ? 'LONG' : 'SHORT', `recovery-${Date.now()}`, Math.abs(position.size), markPrice);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * Close a single-leg position with progressive price improvement
   */
  async closeSingleLegPosition(position: PerpPosition): Promise<void> {
    try {
      const adapter = this.keeperService.getExchangeAdapter(position.exchangeType);
      if (!adapter) return;

      const symbol = this.normalizeSymbol(position.symbol);
      this.logger.warn(`🚨 Closing single-leg position ${symbol} (${position.side}) on ${position.exchangeType}`);

      // Cancel any pending orders on OTHER exchanges for this symbol first
      const allAdapters = this.keeperService.getExchangeAdapters();
      for (const [ex, otherAdapter] of allAdapters.entries()) {
        if (ex === position.exchangeType) continue;
        if (typeof (otherAdapter as any).getOpenOrders === 'function') {
          const orders = await (otherAdapter as any).getOpenOrders().catch(() => []);
          for (const o of orders) {
            if (this.normalizeSymbol(o.symbol) === symbol) {
              await otherAdapter.cancelOrder(o.orderId, o.symbol).catch(() => {});
            }
          }
        }
      }

      const markPrice = await adapter.getMarkPrice(position.symbol);
      const closeSide = position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
      
      await adapter.placeOrder(new PerpOrderRequest(
        position.symbol, 
        closeSide, 
        OrderType.LIMIT, 
        Math.abs(position.size), 
        markPrice, 
        TimeInForce.GTC, 
        true
      ));
    } catch (error: any) {
      this.logger.error(`❌ Error closing single-leg: ${error.message}`);
    }
  }

  private getRetryKey(symbol: string, exchange: ExchangeType): string {
    for (const [key, info] of this.singleLegRetries.entries()) {
      if (key.startsWith(`${symbol}-`) && (info.longExchange === exchange || info.shortExchange === exchange)) {
        return key;
      }
    }
    return `${symbol}-${exchange}`;
  }

  private async analyzeThreadHealth(threadId: string, orders: ActiveOrder[], now: number) {
    const ageSec = (now - Math.min(...orders.map(o => o.placedAt.getTime()))) / 1000;
    if (ageSec < this.MIN_AGE_SECONDS) return;

    const terminal = orders.filter(o => ['FILLED', 'FAILED', 'CANCELLED'].includes(o.status));
    const pending = orders.filter(o => !['FILLED', 'FAILED', 'CANCELLED'].includes(o.status));

    if (terminal.some(o => o.status === 'FILLED') && pending.length > 0) {
      this.logger.warn(`🕵️ Asymmetric fill in thread ${threadId} (Age: ${ageSec.toFixed(0)}s)`);
      for (const stuck of pending) {
        await this.takeCorrectiveAction(stuck, ageSec);
      }
    }
  }

  private async takeCorrectiveAction(order: ActiveOrder, ageSec: number) {
    const adapter = this.keeperService.getExchangeAdapter(order.exchange as ExchangeType);
    if (!adapter) return;

    if (ageSec >= this.AGGRESSIVE_AGE_SECONDS && ageSec < this.MARKET_ORDER_AGE_SECONDS) {
      await this.improvePrice(adapter, order);
    } else if (ageSec >= this.MARKET_ORDER_AGE_SECONDS) {
      await this.forceMarketFill(adapter, order);
    }
  }

  private async improvePrice(adapter: IPerpExchangeAdapter, order: ActiveOrder) {
    try {
      const markPrice = await adapter.getMarkPrice(order.symbol);
      const improvedPrice = order.side === 'LONG' ? markPrice * 1.002 : markPrice * 0.998;
      if ('modifyOrder' in adapter && typeof adapter.modifyOrder === 'function') {
        await adapter.modifyOrder(order.orderId, new PerpOrderRequest(order.symbol, order.side as any, OrderType.LIMIT, order.size || 0, improvedPrice, TimeInForce.GTC));
      } else {
        await adapter.cancelOrder(order.orderId, order.symbol);
        await adapter.placeOrder(new PerpOrderRequest(order.symbol, order.side as any, OrderType.LIMIT, order.size || 0, improvedPrice, TimeInForce.GTC));
      }
    } catch (e) {}
  }

  private async forceMarketFill(adapter: IPerpExchangeAdapter, order: ActiveOrder) {
    try {
      await adapter.cancelOrder(order.orderId, order.symbol).catch(() => {});
      const resp = await adapter.placeOrder(new PerpOrderRequest(order.symbol, order.side as any, OrderType.MARKET, order.size || 0, undefined, TimeInForce.IOC, false));
      if (resp.isSuccess()) {
        this.executionLockService.forceClearOrder(order.exchange, order.symbol, order.side);
      }
    } catch (e) {}
  }

  private async cleanupLostOrders(activeOrders: ActiveOrder[], now: number) {
    for (const order of activeOrders) {
      const ageSec = (now - order.placedAt.getTime()) / 1000;
      if (ageSec > this.ZOMBIE_TIMEOUT_SECONDS) {
        const adapter = this.keeperService.getExchangeAdapter(order.exchange as ExchangeType);
        if (adapter) {
          const status = await adapter.getOrderStatus(order.orderId, order.symbol).catch(() => null);
          if (status?.status === OrderStatus.FILLED) {
            this.handleTerminalStatus(order.exchange as ExchangeType, order.symbol, order.side as any, order.orderId, 'FILLED');
            continue;
          }
          await adapter.cancelOrder(order.orderId, order.symbol).catch(() => {});
        }
        this.executionLockService.forceClearOrder(order.exchange, order.symbol, order.side);
      }
    }
  }

  private handleTerminalStatus(exchange: ExchangeType, symbol: string, side: OrderSide, orderId: string, status: 'FILLED' | 'CANCELLED') {
    this.executionLockService.updateOrderStatus(exchange, symbol, side === OrderSide.LONG ? 'LONG' : 'SHORT', status, orderId);
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/USDT|USDC|-PERP|PERP/g, '');
  }
}

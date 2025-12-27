import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { PerpPosition } from '../../entities/PerpPosition';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { OrderSide } from '../../value-objects/PerpOrder';
import { 
  IFundingDataProvider, 
  FundingDataRequest 
} from '../../ports/IFundingDataProvider';
import { 
  ExchangeFundingRate, 
  FundingRateComparison, 
  ArbitrageOpportunity, 
  ExchangeSymbolMapping 
} from '../../services/FundingRateAggregator';
import { HyperLiquidWebSocketProvider } from '../../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider } from '../../../infrastructure/adapters/lighter/LighterWebSocketProvider';
import { AsterFundingDataProvider } from '../../../infrastructure/adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../../../infrastructure/adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../../../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { Percentage } from '../../value-objects/Percentage';
import { Interval } from '@nestjs/schedule';

/**
 * UnifiedStateService - The "intelligent being" for all market and position state
 * 
 * Coalesces MarketStateService and FundingRateAggregator into a single, high-performance
 * state machine that minimizes API calls and maximizes real-time accuracy.
 */
@Injectable()
export class UnifiedStateService implements OnModuleInit {
  private readonly logger = new Logger(UnifiedStateService.name);
  
  // Adapters & Providers
  private readonly adapters: Map<ExchangeType, IPerpExchangeAdapter> = new Map();
  private readonly fundingProviders: IFundingDataProvider[] = [];
  
  // Cache State
  private readonly positions: Map<string, PerpPosition> = new Map(); // key: exchange-symbol-side
  private readonly markPrices: Map<string, Map<ExchangeType, number>> = new Map(); // symbol -> exchange -> price
  private readonly fundingRates: Map<string, Map<ExchangeType, ExchangeFundingRate>> = new Map(); // symbol -> exchange -> rate
  private readonly symbolMappings: Map<string, ExchangeSymbolMapping> = new Map();
  
  private lastPositionRefresh: number = 0;
  private lastFundingRefresh: number = 0;
  private readonly REFRESH_THRESHOLD_MS = 10000; // 10 seconds

  constructor(
    @Optional() private readonly hyperliquidWs?: HyperLiquidWebSocketProvider,
    @Optional() private readonly lighterWs?: LighterWebSocketProvider,
    @Optional() private readonly hlProvider?: HyperLiquidDataProvider,
    @Optional() private readonly lighterProvider?: LighterFundingDataProvider,
    @Optional() private readonly asterProvider?: AsterFundingDataProvider,
  ) {
    if (hlProvider) this.fundingProviders.push(hlProvider);
    if (lighterProvider) this.fundingProviders.push(lighterProvider);
    if (asterProvider) this.fundingProviders.push(asterProvider);
    
    this.loadCachedMappings();
  }

  async onModuleInit() {
    this.setupWebSocketListeners();
    this.logger.log('🌐 UnifiedStateService initialized');
    
    // Perform initial refresh after a short delay to allow adapters to initialize
    setTimeout(() => {
      this.refreshPositions().catch(e => 
        this.logger.error(`Initial position refresh failed: ${e.message}`)
      );
    }, 5000);
  }

  setAdapters(adapters: Map<ExchangeType, IPerpExchangeAdapter>) {
    for (const [type, adapter] of adapters.entries()) {
      this.adapters.set(type, adapter);
    }
  }

  private setupWebSocketListeners() {
    // WebSocket providers handle position/price updates internally via subscriptions
    if (this.hyperliquidWs) {
      this.hyperliquidWs.subscribeToPositionUpdates();
      
      // Reactive position refresh on order updates
      this.hyperliquidWs.on('order_update', (update) => {
        this.logger.log(`⚡ Hyperliquid order update received, triggering reactive position refresh`);
        this.refreshExchangePositions(ExchangeType.HYPERLIQUID);
      });

      // Reactive position refresh on position updates
      this.hyperliquidWs.on('positions_update', (positions) => {
        this.logger.log(`⚡ Hyperliquid position update received, triggering reactive position refresh`);
        this.refreshExchangePositions(ExchangeType.HYPERLIQUID);
      });
    }
    
    if (this.lighterWs) {
      this.lighterWs.subscribeToPositionUpdates();
      
      // Reactive position refresh on order updates
      this.lighterWs.on('order_update', (update) => {
        this.logger.log(`⚡ Lighter order update received, triggering reactive position refresh`);
        this.refreshExchangePositions(ExchangeType.LIGHTER);
      });

      // Reactive position refresh on position updates
      this.lighterWs.on('positions_update', (positions) => {
        this.logger.log(`⚡ Lighter position update received, triggering reactive position refresh`);
        this.refreshExchangePositions(ExchangeType.LIGHTER);
      });
    }
  }

  /**
   * Refresh positions for a single exchange
   */
  private async refreshExchangePositions(type: ExchangeType) {
    const adapter = this.adapters.get(type);
    if (!adapter) return;

    try {
      const freshPositions = await adapter.getPositions();
      
      const currentExchangeKeys = Array.from(this.positions.keys())
        .filter(key => key.startsWith(`${type}-`));
        
      const freshKeys = new Set<string>();
      
      for (const pos of freshPositions) {
        const key = this.updateCachedPosition(pos);
        if (key) freshKeys.add(key);
      }
      
      for (const oldKey of currentExchangeKeys) {
        if (!freshKeys.has(oldKey)) {
          this.logger.log(`🗑️ Reactive clearing of stale position ${oldKey}`);
          this.positions.delete(oldKey);
        }
      }
    } catch (e) {
      this.logger.error(`Error in reactive refresh for ${type}: ${e.message}`);
    }
  }

  /**
   * Force a position refresh from REST API to ensure no "blindness"
   */
  async forcePositionRefresh(): Promise<void> {
    this.logger.log('🔄 Forcing position refresh from REST APIs...');
    const now = Date.now();
    
    const promises = Array.from(this.adapters.entries()).map(async ([type, adapter]) => {
      try {
        // Clear adapter cache if it has one
        if ('clearBalanceCache' in adapter && typeof (adapter as any).clearBalanceCache === 'function') {
          (adapter as any).clearBalanceCache();
        }
        
        const freshPositions = await adapter.getPositions();
        this.logger.debug(`Fetched ${freshPositions.length} positions from ${type} via REST`);
        
        // CRITICAL: Get current cached keys for THIS exchange only
        const currentExchangeKeys = Array.from(this.positions.keys())
          .filter(key => key.startsWith(`${type}-`));
          
        const freshKeys = new Set<string>();
        
        // Update cache
        for (const pos of freshPositions) {
          const key = this.updateCachedPosition(pos);
          if (key) freshKeys.add(key);
        }
        
        // Delete any keys for this exchange that are NOT in the fresh list
        for (const oldKey of currentExchangeKeys) {
          if (!freshKeys.has(oldKey)) {
            this.logger.debug(`🗑️ Clearing stale position ${oldKey} during force refresh`);
            this.positions.delete(oldKey);
          }
        }
        
        return true;
      } catch (error: any) {
        this.logger.error(`Failed to force refresh positions for ${type}: ${error.message}`);
        return false;
      }
    });
    
    await Promise.all(promises);
    this.lastPositionRefresh = now;
  }

  /**
   * Main refresh loop - keeps REST fallback data fresh
   */
  @Interval(60000)
  async refresh() {
    const now = Date.now();
    // Use forcePositionRefresh every 5 minutes as a safety measure
    // This is the "eye opener" that prevents persistent blindness
    if (now - this.lastPositionRefresh > 300000) {
      await this.forcePositionRefresh();
    } else if (now - this.lastPositionRefresh > this.REFRESH_THRESHOLD_MS) {
      await this.refreshPositions();
    }
    
    if (now - this.lastFundingRefresh > 300000) { // 5 mins for funding
      await this.refreshFundingRates();
    }
  }

  private async refreshPositions() {
    const promises = Array.from(this.adapters.keys()).map(type => 
      this.refreshExchangePositions(type)
    );
    await Promise.all(promises);
    this.lastPositionRefresh = Date.now();
  }

  private async refreshFundingRates() {
    // Basic discovery if mappings empty
    if (this.symbolMappings.size === 0) {
      await this.discoverSymbols();
    }
    
    this.lastFundingRefresh = Date.now();
  }

  // Position API
  getAllPositions(): PerpPosition[] {
    return Array.from(this.positions.values());
  }

  getSymbolPositions(symbol: string): PerpPosition[] {
    const normalized = this.normalizeSymbol(symbol);
    return Array.from(this.positions.values()).filter(p => this.normalizeSymbol(p.symbol) === normalized);
  }

  // Market API
  getMarkPrice(symbol: string, exchange: ExchangeType): number | undefined {
    return this.markPrices.get(this.normalizeSymbol(symbol))?.get(exchange);
  }

  async getFundingComparison(symbol: string): Promise<FundingRateComparison | null> {
    const normalized = this.normalizeSymbol(symbol);
    const rates: ExchangeFundingRate[] = [];
    
    for (const provider of this.fundingProviders) {
      const type = provider.getExchangeType();
      const mapping = this.symbolMappings.get(normalized);
      if (!mapping) continue;
      
      try {
        const data = await provider.getFundingData({ 
          normalizedSymbol: normalized, 
          exchangeSymbol: this.getExchangeSymbol(normalized, type) as string 
        });
        if (data) rates.push(data);
      } catch (e) {}
    }

    if (rates.length < 2) return null;

    const sorted = [...rates].sort((a, b) => b.currentRate - a.currentRate);
    return {
      symbol: normalized,
      rates,
      highestRate: sorted[0],
      lowestRate: sorted[sorted.length - 1],
      spread: sorted[0].currentRate - sorted[sorted.length - 1].currentRate,
      timestamp: new Date()
    };
  }

  // Internal Helpers
  private updateCachedPosition(pos: PerpPosition): string {
    const key = `${pos.exchangeType}-${this.normalizeSymbol(pos.symbol)}-${pos.side}`;
    if (Math.abs(pos.size) < 0.0001) {
      this.positions.delete(key);
      return '';
    } else {
      this.positions.set(key, pos);
      return key;
    }
  }

  private updateCachedPrice(symbol: string, exchange: ExchangeType, price: number) {
    const norm = this.normalizeSymbol(symbol);
    if (!this.markPrices.has(norm)) this.markPrices.set(norm, new Map());
    this.markPrices.get(norm)!.set(exchange, price);
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/USDT|USDC|-PERP|PERP/g, '');
  }

  private getExchangeSymbol(normalized: string, exchange: ExchangeType): string | number | undefined {
    const mapping = this.symbolMappings.get(normalized);
    if (!mapping) return undefined;
    switch (exchange) {
      case ExchangeType.HYPERLIQUID: return mapping.hyperliquidSymbol;
      case ExchangeType.LIGHTER: return mapping.lighterMarketIndex;
      case ExchangeType.ASTER: return mapping.asterSymbol;
      default: return undefined;
    }
  }

  private loadCachedMappings() {
    try {
      const { CACHED_SYMBOLS } = require('../../config/cached-symbols');
      CACHED_SYMBOLS.forEach((m: any) => this.symbolMappings.set(m.normalizedSymbol, m));
    } catch (e) {}
  }

  async discoverSymbols(): Promise<string[]> {
    const [hl, lighter] = await Promise.all([
      this.hlProvider?.getAvailableAssets().catch(() => []) || [],
      this.lighterProvider?.getAvailableMarkets().catch(() => []) || []
    ]);

    // Simplified discovery
    hl.forEach(s => {
      const norm = this.normalizeSymbol(s);
      if (!this.symbolMappings.has(norm)) this.symbolMappings.set(norm, { normalizedSymbol: norm, hyperliquidSymbol: s });
      else this.symbolMappings.get(norm)!.hyperliquidSymbol = s;
    });

    // Explicitly type the lighter markets array to avoid 'never' type inference
    const lighterMarkets: Array<{ marketIndex: number; symbol: string }> = lighter;
    lighterMarkets.forEach(m => {
      const norm = this.normalizeSymbol(m.symbol);
      if (!this.symbolMappings.has(norm)) this.symbolMappings.set(norm, { normalizedSymbol: norm, lighterMarketIndex: m.marketIndex, lighterSymbol: m.symbol });
      else {
        this.symbolMappings.get(norm)!.lighterMarketIndex = m.marketIndex;
        this.symbolMappings.get(norm)!.lighterSymbol = m.symbol;
      }
    });

    return Array.from(this.symbolMappings.keys());
  }
}


import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IFundingDataProvider } from '../../../domain/strategies/FundingRateStrategy';
import axios from 'axios';
import { HyperLiquidWebSocketProvider } from './HyperLiquidWebSocketProvider';

interface HyperLiquidMeta {
  universe: {
    name: string;
    szDecimals: number;
  }[];
}

interface HyperLiquidAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
  impactPxs: string[];
}

interface HyperLiquidMetaAndAssetCtxs {
  meta: HyperLiquidMeta;
  assetCtxs: HyperLiquidAssetCtx[];
}

/**
 * HyperLiquidDataProvider - Fetches funding rate and market data from HyperLiquid API
 * 
 * Uses WebSocket for real-time funding rates (eliminates rate limits)
 * Falls back to REST API if WebSocket is unavailable
 * 
 * API Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 */
@Injectable()
export class HyperLiquidDataProvider implements IFundingDataProvider, OnModuleInit {
  private readonly logger = new Logger(HyperLiquidDataProvider.name);
  private readonly API_URL = 'https://api.hyperliquid.xyz/info';
  
  // Asset name to index mapping (populated on first call)
  private assetIndexMap: Map<string, number> = new Map();
  private lastMetaFetch: number = 0;
  private readonly META_CACHE_TTL = 60000; // 1 minute cache
  private lastRequestTime: number = 0;
  private readonly MIN_REQUEST_INTERVAL = 1000; // Minimum 1 second between requests to avoid rate limits

  constructor(
    private readonly configService: ConfigService,
    private readonly wsProvider: HyperLiquidWebSocketProvider,
  ) {}

  async onModuleInit() {
    // WebSocket subscriptions are handled by FundingRateAggregator when assets are discovered
    // This ensures we only subscribe to assets that are actually used
  }

  /**
   * Get current funding rate for an asset
   * Uses WebSocket cache if available, falls back to REST API
   * @param asset Asset symbol (e.g., 'ETH', 'BTC')
   * @returns Funding rate as decimal (e.g., 0.0001 = 0.01%)
   */
  async getCurrentFundingRate(asset: string): Promise<number> {
    // Try WebSocket first (no rate limits!)
    if (this.wsProvider.isWsConnected()) {
      const wsRate = this.wsProvider.getFundingRate(asset);
      if (wsRate !== null) {
        return wsRate;
      }
    }

    // Fallback to REST API
    const data = await this.fetchMetaAndAssetCtxs();
    const index = await this.getAssetIndex(asset, data.meta);
    
    if (index === -1) {
      throw new Error(`Asset ${asset} not found on HyperLiquid`);
    }

    const assetCtx = data.assetCtxs[index];
    const fundingRate = parseFloat(assetCtx.funding);
    
    return fundingRate;
  }

  /**
   * Get predicted next funding rate
   * HyperLiquid uses premium to predict next funding
   * Uses WebSocket cache if available, falls back to REST API
   * @param asset Asset symbol
   * @returns Predicted funding rate as decimal
   */
  async getPredictedFundingRate(asset: string): Promise<number> {
    // Try WebSocket first
    if (this.wsProvider.isWsConnected()) {
      const premium = this.wsProvider.getPremium(asset);
      if (premium !== null) {
        // Clamp to typical funding rate bounds
        const predicted = Math.max(-0.0005, Math.min(0.0005, premium));
        return predicted;
      }
    }

    // Fallback to REST API
    const data = await this.fetchMetaAndAssetCtxs();
    const index = await this.getAssetIndex(asset, data.meta);
    
    if (index === -1) {
      throw new Error(`Asset ${asset} not found on HyperLiquid`);
    }

    const assetCtx = data.assetCtxs[index];
    const premium = parseFloat(assetCtx.premium);
    
    // Clamp to typical funding rate bounds
    const predicted = Math.max(-0.0005, Math.min(0.0005, premium));
    
    return predicted;
  }

  /**
   * Get open interest for an asset
   * @param asset Asset symbol
   * @returns Open interest in USD
   */
  async getOpenInterest(asset: string): Promise<number> {
    try {
      const data = await this.fetchMetaAndAssetCtxs();
      const index = await this.getAssetIndex(asset, data.meta);
      
      if (index === -1) {
        this.logger.error(`Hyperliquid OI: Asset ${asset} not found in universe`);
        throw new Error(`Asset ${asset} not found on HyperLiquid`);
      }

      const assetCtx = data.assetCtxs[index];
      
      const openInterest = parseFloat(assetCtx.openInterest);
      const markPrice = parseFloat(assetCtx.markPx);
      
      // OI is in contracts, multiply by mark price for USD value
      const oiUsd = openInterest * markPrice;
      
      return oiUsd;
    } catch (error: any) {
      this.logger.error(`Failed to get Hyperliquid open interest for ${asset}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get mark price for an asset
   * Uses WebSocket cache if available, falls back to REST API
   * @param asset Asset symbol
   * @returns Mark price in USD
   */
  async getMarkPrice(asset: string): Promise<number> {
    // Try WebSocket first
    if (this.wsProvider.isWsConnected()) {
      const wsPrice = this.wsProvider.getMarkPrice(asset);
      if (wsPrice !== null) {
        return wsPrice;
      }
    }

    // Fallback to REST API
    const data = await this.fetchMetaAndAssetCtxs();
    const index = await this.getAssetIndex(asset, data.meta);
    
    if (index === -1) {
      throw new Error(`Asset ${asset} not found on HyperLiquid`);
    }

    const assetCtx = data.assetCtxs[index];
    return parseFloat(assetCtx.markPx);
  }

  /**
   * Get oracle price for an asset
   * @param asset Asset symbol
   * @returns Oracle price in USD
   */
  async getOraclePrice(asset: string): Promise<number> {
    const data = await this.fetchMetaAndAssetCtxs();
    const index = await this.getAssetIndex(asset, data.meta);
    
    if (index === -1) {
      throw new Error(`Asset ${asset} not found on HyperLiquid`);
    }

    const assetCtx = data.assetCtxs[index];
    return parseFloat(assetCtx.oraclePx);
  }

  /**
   * Get all available assets
   */
  async getAvailableAssets(): Promise<string[]> {
    const data = await this.fetchMetaAndAssetCtxs();
    return data.meta.universe.map(u => u.name);
  }

  /**
   * Get comprehensive market data for an asset
   */
  async getMarketData(asset: string): Promise<{
    fundingRate: number;
    predictedFunding: number;
    openInterest: number;
    markPrice: number;
    oraclePrice: number;
    volume24h: number;
    premium: number;
  }> {
    const data = await this.fetchMetaAndAssetCtxs();
    const index = await this.getAssetIndex(asset, data.meta);
    
    if (index === -1) {
      throw new Error(`Asset ${asset} not found on HyperLiquid`);
    }

    const ctx = data.assetCtxs[index];
    const markPrice = parseFloat(ctx.markPx);
    
    return {
      fundingRate: parseFloat(ctx.funding),
      predictedFunding: Math.max(-0.0005, Math.min(0.0005, parseFloat(ctx.premium))),
      openInterest: parseFloat(ctx.openInterest) * markPrice,
      markPrice,
      oraclePrice: parseFloat(ctx.oraclePx),
      volume24h: parseFloat(ctx.dayNtlVlm),
      premium: parseFloat(ctx.premium),
    };
  }

  // --- Private Methods ---

  private async fetchMetaAndAssetCtxs(retries: number = 3): Promise<HyperLiquidMetaAndAssetCtxs> {
    // Rate limiting: ensure minimum interval between requests
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();

    try {
      // Use axios matching fetch-hyperliquid-data.ts pattern
      const response = await axios.post(this.API_URL, {
        type: 'metaAndAssetCtxs',
      });

      const data = response.data;
      
      // Update asset index map
      if (Date.now() - this.lastMetaFetch > this.META_CACHE_TTL) {
        this.assetIndexMap.clear();
        data[0].universe.forEach((asset: { name: string }, index: number) => {
          this.assetIndexMap.set(asset.name.toUpperCase(), index);
        });
        this.lastMetaFetch = Date.now();
      }

      return {
        meta: data[0],
        assetCtxs: data[1],
      };
    } catch (error: any) {
      // Retry on 429 errors with exponential backoff
      if (error.response?.status === 429 && retries > 0) {
        const backoffDelay = Math.min(1000 * Math.pow(2, 3 - retries), 10000); // Max 10s
        this.logger.warn(`HyperLiquid rate limited, retrying in ${backoffDelay}ms (${retries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        return this.fetchMetaAndAssetCtxs(retries - 1);
      }

      this.logger.error(`Failed to fetch HyperLiquid data: ${error.message}`);
      if (error.response) {
        throw new Error(`HyperLiquid API error ${error.response.status}: ${error.response.statusText}`);
      }
      throw error;
    }
  }

  private async getAssetIndex(asset: string, meta: HyperLiquidMeta): Promise<number> {
    const normalizedAsset = asset.toUpperCase();
    
    // Check cache first
    if (this.assetIndexMap.has(normalizedAsset)) {
      return this.assetIndexMap.get(normalizedAsset)!;
    }

    // Search in meta
    const index = meta.universe.findIndex(
      u => u.name.toUpperCase() === normalizedAsset
    );

    if (index !== -1) {
      this.assetIndexMap.set(normalizedAsset, index);
    }

    return index;
  }
}










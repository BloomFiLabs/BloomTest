import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { PerpPosition } from '../../entities/PerpPosition';
import { OrderSide, OrderType, TimeInForce, PerpOrderRequest } from '../../value-objects/PerpOrder';
import { MarketStateService } from '../../../infrastructure/services/MarketStateService';
import type { IFundingRatePredictionService } from '../../ports/IFundingRatePredictor';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { ExecutionLockService } from '../../../infrastructure/services/ExecutionLockService';

/**
 * ProfitTakingService - Intelligent profit taking based on spread reversion
 */
@Injectable()
export class ProfitTakingService implements OnModuleInit {
  private readonly logger = new Logger(ProfitTakingService.name);

  // Configuration
  private readonly MIN_PROFIT_USD = 10;
  private readonly MIN_CLOSE_PERCENT = 0.25;
  private readonly MAX_REVERSION_HOURS = 168;

  private readonly profitTakeCooldowns: Map<string, {
    exitPriceLong: number;
    exitPriceShort: number;
    exitTime: Date;
  }> = new Map();

  constructor(
    private readonly marketStateService: MarketStateService,
    private readonly keeperService: PerpKeeperService,
    private readonly executionLockService: ExecutionLockService,
    @Optional() @Inject('IFundingRatePredictionService') 
    private readonly predictionService?: IFundingRatePredictionService,
  ) {}

  onModuleInit() {
    this.logger.log('💰 ProfitTakingService initialized');
  }

  /**
   * Profit taking loop - runs every 2 minutes
   */
  @Interval(120000)
  async checkProfitTaking(): Promise<void> {
    if (this.executionLockService.isGlobalLockHeld()) return;

    try {
      const positions = this.marketStateService.getAllPositions();
      if (positions.length < 2) return;

      const positionsBySymbol = this.groupPositionsBySymbol(positions);

      for (const [symbol, symbolPositions] of positionsBySymbol) {
        await this.analyzeProfitTaking(symbol, symbolPositions);
      }
    } catch (error: any) {
      this.logger.error(`Error in profit taking loop: ${error.message}`);
    }
  }

  private groupPositionsBySymbol(positions: PerpPosition[]): Map<string, PerpPosition[]> {
    const map = new Map<string, PerpPosition[]>();
    for (const pos of positions) {
      const sym = this.normalizeSymbol(pos.symbol);
      if (!map.has(sym)) map.set(sym, []);
      map.get(sym)!.push(pos);
    }
    return map;
  }

  private async analyzeProfitTaking(symbol: string, positions: PerpPosition[]) {
    const longPos = positions.find(p => p.side === OrderSide.LONG);
    const shortPos = positions.find(p => p.side === OrderSide.SHORT && p.exchangeType !== longPos?.exchangeType);

    if (!longPos || !shortPos) return;

    const profitUsd = longPos.unrealizedPnl + shortPos.unrealizedPnl;
    if (profitUsd <= this.MIN_PROFIT_USD) return;

    const avgValue = (Math.abs(longPos.size * (longPos.markPrice || 0)) + Math.abs(shortPos.size * (shortPos.markPrice || 0))) / 2;
    if (avgValue <= 0) return;

    let expectedReversionHours = 168;
    let currentSpreadHourly = 0.0001;

    if (this.predictionService) {
      try {
        const pred = await this.predictionService.getSpreadPrediction(symbol, longPos.exchangeType, shortPos.exchangeType);
        expectedReversionHours = pred.expectedReversionHours || 168;
        currentSpreadHourly = Math.abs(pred.currentSpread);
      } catch (e) {}
    }

    if (expectedReversionHours > this.MAX_REVERSION_HOURS) return;

    const expectedFundingPercent = currentSpreadHourly * expectedReversionHours * 100;
    const profitPercent = (profitUsd / avgValue) * 100;

    let closePercent = expectedFundingPercent > 0 ? profitPercent / (expectedFundingPercent * 2) : 1;
    closePercent = Math.max(this.MIN_CLOSE_PERCENT, Math.min(1, closePercent));

    if (closePercent >= this.MIN_CLOSE_PERCENT) {
      this.logger.log(`🎯 PROFIT TAKE: ${symbol} at ${profitPercent.toFixed(2)}% profit. Closing ${Math.round(closePercent * 100)}% of position.`);
      await this.executePartialClose(symbol, longPos, shortPos, closePercent);
    }
  }

  private async executePartialClose(symbol: string, long: PerpPosition, short: PerpPosition, percent: number) {
    const adapters = this.keeperService.getExchangeAdapters();
    const longAdapter = adapters.get(long.exchangeType);
    const shortAdapter = adapters.get(short.exchangeType);

    if (!longAdapter || !shortAdapter) return;

    const longSizeToClose = Math.abs(long.size) * percent;
    const shortSizeToClose = Math.abs(short.size) * percent;

    const longOrder = new PerpOrderRequest(long.symbol, OrderSide.SHORT, OrderType.MARKET, longSizeToClose, undefined, TimeInForce.IOC, true);
    const shortOrder = new PerpOrderRequest(short.symbol, OrderSide.LONG, OrderType.MARKET, shortSizeToClose, undefined, TimeInForce.IOC, true);

    await Promise.all([
      longAdapter.placeOrder(longOrder),
      shortAdapter.placeOrder(shortOrder)
    ]);

    // Register cooldown
    this.profitTakeCooldowns.set(symbol, {
      exitPriceLong: long.markPrice || 0,
      exitPriceShort: short.markPrice || 0,
      exitTime: new Date()
    });
  }

  isInProfitTakeCooldown(symbol: string, currentPriceLong: number, currentPriceShort: number): { inCooldown: boolean; reason?: string } {
    const cooldown = this.profitTakeCooldowns.get(symbol);
    if (!cooldown) return { inCooldown: false };

    const ageMs = Date.now() - cooldown.exitTime.getTime();
    if (ageMs > 3600000) {
      this.profitTakeCooldowns.delete(symbol);
      return { inCooldown: false };
    }

    const priceDiffLong = Math.abs(currentPriceLong - cooldown.exitPriceLong) / cooldown.exitPriceLong;
    const priceDiffShort = Math.abs(currentPriceShort - cooldown.exitPriceShort) / cooldown.exitPriceShort;
    
    // Require at least 0.5% reversion or 1 hour wait
    if (priceDiffLong < 0.005 && priceDiffShort < 0.005) {
      return { 
        inCooldown: true, 
        reason: `Profit-take cooldown: price hasn't reverted enough (${(priceDiffLong*100).toFixed(2)}%)` 
      };
    }

    return { inCooldown: false };
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/USDT|USDC|-PERP|PERP/g, '');
  }
}


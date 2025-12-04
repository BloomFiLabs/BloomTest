import { Injectable } from '@nestjs/common';
import { IMarketDataProvider } from '../../domain/ports/IMarketDataProvider';
import { Candle } from '../../domain/entities/Candle';

@Injectable()
export class SimulationMarketDataProvider implements IMarketDataProvider {
  private candles: Candle[] = [];
  private currentIndex = 0;

  loadData(candles: Candle[]) {
    this.candles = candles;
  }

  setCurrentIndex(index: number) {
    this.currentIndex = index;
  }

  async getHistory(poolAddress: string, hours: number): Promise<Candle[]> {
    const endIndex = this.currentIndex;
    const startIndex = Math.max(0, endIndex - hours); // Approx 1 candle per hour
    return this.candles.slice(startIndex, endIndex + 1);
  }

  async getLatestCandle(poolAddress: string): Promise<Candle> {
    return this.candles[this.currentIndex];
  }

  async getPoolFeeApr(poolAddress: string): Promise<number> {
    return 30.0; // Mock APR
  }

  async getPoolFeeTier(poolAddress: string): Promise<number> {
    return 0.0005; // Mock 0.05% fee tier
  }
}


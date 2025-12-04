import { Injectable } from '@nestjs/common';
import { IBlockchainAdapter } from '../../domain/ports/IBlockchainAdapter';

@Injectable()
export class SimulationBlockchainAdapter implements IBlockchainAdapter {
  private mockState = {
    totalAssets: BigInt(10000 * 1e6),
    totalPrincipal: BigInt(10000 * 1e6),
    positionRange: { lower: 2000, upper: 4000 },
    gasPriceGwei: 0.1,
  };

  setMockState(state: Partial<typeof this.mockState>) {
    this.mockState = { ...this.mockState, ...state };
  }

  getMockState() {
    return this.mockState;
  }

  async getStrategyState(strategyAddress: string): Promise<{ totalAssets: bigint; totalPrincipal: bigint }> {
    return {
      totalAssets: this.mockState.totalAssets,
      totalPrincipal: this.mockState.totalPrincipal,
    };
  }

  async getGasPriceGwei(): Promise<number> {
    return this.mockState.gasPriceGwei;
  }

  async getStrategyPositionRange(strategyAddress: string): Promise<{ lower: number; upper: number } | null> {
    return this.mockState.positionRange;
  }
}


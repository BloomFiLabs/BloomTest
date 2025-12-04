import { Injectable, Logger } from '@nestjs/common';
import { IStrategyExecutor } from '../../domain/ports/IStrategyExecutor';

@Injectable()
export class SimulationStrategyExecutor implements IStrategyExecutor {
  private readonly logger = new Logger(SimulationStrategyExecutor.name);
  
  constructor() {}

  async rebalance(strategyAddress: string, rangePct1e5?: bigint): Promise<string> {
    this.logger.log(`[SIMULATION] Rebalance Executed on ${strategyAddress}, range: ${rangePct1e5}`);
    return '0xSimTx';
  }

  async emergencyExit(strategyAddress: string): Promise<string> {
    return '0xSimExit';
  }

  async harvest(strategyAddress: string): Promise<string> {
    this.logger.log(`[SIMULATION] Harvest Executed on ${strategyAddress}`);
    return '0xSimHarvest';
  }

  async getLastHarvestAmount(strategyAddress: string): Promise<number> {
    // Simulate collecting a small amount of fees
    return 0.001 + Math.random() * 0.01; // Random amount between $0.001 and $0.011
  }
}


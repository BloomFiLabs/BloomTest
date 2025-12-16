import { Contract, Wallet, JsonRpcProvider } from 'ethers';

export interface IStrategyExecutor {
  rebalance(strategyAddress: string, rangePct1e5?: bigint): Promise<string>;
  emergencyExit(strategyAddress: string): Promise<string>;
  harvest(strategyAddress: string): Promise<string>; // Collect fees without rebalancing
  getLastHarvestAmount?(strategyAddress: string): Promise<number>; // Get amount from last harvest
}








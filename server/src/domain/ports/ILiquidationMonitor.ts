/**
 * ILiquidationMonitor Port Interface
 *
 * Defines the contract for liquidation monitoring services.
 * Follows the ports and adapters (hexagonal) architecture pattern.
 */

import { LiquidationRisk } from '../value-objects/LiquidationRisk';
import { ExchangeType } from '../value-objects/ExchangeConfig';

/**
 * Represents a paired position (both legs of an arbitrage).
 */
export interface PairedPosition {
  symbol: string;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  longRisk: LiquidationRisk;
  shortRisk: LiquidationRisk;
  openedAt: Date;
}

/**
 * Result of a liquidation check.
 */
export interface LiquidationCheckResult {
  timestamp: Date;
  positionsChecked: number;
  positionsAtRisk: number;
  emergencyClosesTriggered: number;
  positions: PairedPosition[];
  emergencyCloses: EmergencyCloseResult[];
}

/**
 * Result of an emergency close operation.
 */
export interface EmergencyCloseResult {
  symbol: string;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  triggerReason: 'LONG_AT_RISK' | 'SHORT_AT_RISK' | 'BOTH_AT_RISK';
  triggerRisk: LiquidationRisk;
  longCloseSuccess: boolean;
  shortCloseSuccess: boolean;
  longCloseError?: string;
  shortCloseError?: string;
  closedAt: Date;
}

/**
 * Configuration for the liquidation monitor.
 */
export interface LiquidationMonitorConfig {
  /**
   * Proximity threshold (0-1) to trigger emergency close.
   * Default: 0.7 (70% close to liquidation).
   */
  emergencyCloseThreshold: number;

  /**
   * Proximity threshold (0-1) to trigger warnings.
   * Default: 0.5 (50% close to liquidation).
   */
  warningThreshold: number;

  /**
   * Interval in milliseconds between liquidation checks.
   * Default: 30000 (30 seconds).
   */
  checkIntervalMs: number;

  /**
   * Whether to actually execute emergency closes (vs dry-run).
   * Default: true.
   */
  enableEmergencyClose: boolean;

  /**
   * Maximum retries for emergency close operations.
   * Default: 3.
   */
  maxCloseRetries: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_LIQUIDATION_MONITOR_CONFIG: LiquidationMonitorConfig = {
  emergencyCloseThreshold: 0.9,
  warningThreshold: 0.7,
  checkIntervalMs: 30000,
  enableEmergencyClose: true,
  maxCloseRetries: 3,
};

/**
 * Port interface for liquidation monitoring.
 */
export interface ILiquidationMonitor {
  /**
   * Run a single liquidation check across all positions.
   * @returns Result of the check including any emergency closes triggered.
   */
  checkLiquidationRisk(): Promise<LiquidationCheckResult>;

  /**
   * Get current liquidation risk for a specific symbol.
   * @param symbol Trading symbol.
   * @param longExchange Exchange holding the long leg.
   * @param shortExchange Exchange holding the short leg.
   */
  getPositionRisk(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Promise<PairedPosition | null>;

  /**
   * Get all positions currently at risk (above warning threshold).
   */
  getPositionsAtRisk(): Promise<PairedPosition[]>;

  /**
   * Manually trigger emergency close for a position.
   * @param symbol Trading symbol.
   * @param reason Reason for the emergency close.
   */
  emergencyClosePosition(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    reason: string,
  ): Promise<EmergencyCloseResult>;

  /**
   * Get the current configuration.
   */
  getConfig(): LiquidationMonitorConfig;

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<LiquidationMonitorConfig>): void;

  /**
   * Start the periodic monitoring loop.
   */
  start(): void;

  /**
   * Stop the periodic monitoring loop.
   */
  stop(): void;

  /**
   * Check if the monitor is currently running.
   */
  isRunning(): boolean;
}


import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { IPositionLossTracker } from '../../domain/ports/IPositionLossTracker';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Position entry record
 */
interface PositionEntry {
  symbol: string;
  exchange: ExchangeType;
  entryCost: number; // Transaction fees for entry
  timestamp: Date;
  positionSizeUsd: number;
}

/**
 * Position exit record
 */
interface PositionExit {
  symbol: string;
  exchange: ExchangeType;
  exitCost: number; // Transaction fees for exit
  realizedLoss: number; // Negative if loss, positive if profit
  timeHeld: number; // Hours held
  timestamp: Date;
}

/**
 * Current position tracking
 */
interface CurrentPosition {
  entry: PositionEntry;
  startTime: Date;
}

/**
 * PositionLossTracker - Tracks cumulative losses across all positions
 * 
 * Persists data to file to survive restarts.
 */
@Injectable()
export class PositionLossTracker implements IPositionLossTracker {
  private readonly logger = new Logger(PositionLossTracker.name);
  
  // In-memory storage
  private entries: PositionEntry[] = [];
  private exits: PositionExit[] = [];
  private currentPositions: Map<string, CurrentPosition> = new Map(); // key = `${symbol}_${exchange}`
  
  // File persistence
  private readonly dataDir = path.join(process.cwd(), 'data');
  private readonly entriesFile = path.join(this.dataDir, 'position_entries.json');
  private readonly exitsFile = path.join(this.dataDir, 'position_exits.json');

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {
    const testMode = this.configService.get<string>('TEST_MODE') === 'true';
    
    if (testMode) {
      // Reset loss tracker in test mode - start fresh every run
      this.reset();
      this.logger.log('🧪 TEST MODE: Reset position loss tracker');
    } else {
    this.loadFromFile();
    }
  }

  /**
   * Record a position entry
   */
  recordPositionEntry(
    symbol: string,
    exchange: ExchangeType,
    entryCost: number,
    positionSizeUsd: number,
    timestamp?: Date,
  ): void {
    const entry: PositionEntry = {
      symbol,
      exchange,
      entryCost,
      timestamp: timestamp || new Date(),
      positionSizeUsd,
    };

    this.entries.push(entry);
    
    // Track as current position
    const key = `${symbol}_${exchange}`;
    this.currentPositions.set(key, {
      entry,
      startTime: entry.timestamp,
    });

    this.saveToFile();
    this.logger.debug(`Recorded position entry: ${symbol} on ${exchange}, cost: $${entryCost.toFixed(4)}`);
  }

  /**
   * Record a position exit
   */
  recordPositionExit(
    symbol: string,
    exchange: ExchangeType,
    exitCost: number,
    realizedLoss: number, // Negative if loss, positive if profit
    timestamp?: Date,
  ): void {
    const key = `${symbol}_${exchange}`;
    const currentPos = this.currentPositions.get(key);
    
    if (!currentPos) {
      this.logger.warn(`No current position found for ${symbol} on ${exchange}, cannot calculate time held`);
      return;
    }

    const timeHeldMs = (timestamp || new Date()).getTime() - currentPos.startTime.getTime();
    const timeHeld = timeHeldMs / (1000 * 60 * 60); // Convert to hours

    const exit: PositionExit = {
      symbol,
      exchange,
      exitCost,
      realizedLoss,
      timeHeld,
      timestamp: timestamp || new Date(),
    };

    this.exits.push(exit);
    this.currentPositions.delete(key);

    this.saveToFile();
    this.logger.debug(
      `Recorded position exit: ${symbol} on ${exchange}, ` +
      `cost: $${exitCost.toFixed(4)}, loss: $${realizedLoss.toFixed(4)}, held: ${timeHeld.toFixed(2)}h`
    );
  }

  /**
   * Get cumulative loss across all positions
   * Includes entry costs, exit costs, and realized losses
   */
  getCumulativeLoss(): number {
    const totalEntryCosts = this.entries.reduce((sum, e) => sum + e.entryCost, 0);
    const totalExitCosts = this.exits.reduce((sum, e) => sum + e.exitCost, 0);
    const totalRealizedLosses = this.exits.reduce((sum, e) => sum + e.realizedLoss, 0);
    
    // Realized losses are negative if loss, positive if profit
    // So we add them (if negative, they increase cumulative loss)
    return totalEntryCosts + totalExitCosts + totalRealizedLosses;
  }

  /**
   * Get loss for current position if unprofitable
   * Returns entry cost (already incurred) plus estimated exit cost
   */
  getCurrentPositionLoss(position: PerpPosition): number {
    const key = `${position.symbol}_${position.exchangeType}`;
    const currentPos = this.currentPositions.get(key);
    
    if (!currentPos) {
      return 0; // No tracked entry for this position
    }

    // Return entry cost (already incurred)
    return currentPos.entry.entryCost;
  }

  /**
   * Calculate adjusted break-even hours for a new opportunity
   * Includes cumulative losses and new entry/exit costs
   */
  getAdjustedBreakEvenHours(
    newOpportunity: {
      hourlyReturn: number; // Expected return per hour in USD
      entryCosts: number; // Entry transaction costs
      exitCosts: number; // Exit transaction costs
    },
    cumulativeLoss: number,
  ): number {
    if (newOpportunity.hourlyReturn <= 0) {
      return Infinity; // Never breaks even if no positive return
    }

    // Total costs = cumulative losses + new entry costs + new exit costs
    const totalCosts = cumulativeLoss + newOpportunity.entryCosts + newOpportunity.exitCosts;
    
    // Break-even hours = total costs / hourly return
    return totalCosts / newOpportunity.hourlyReturn;
  }

  /**
   * Get remaining break-even hours for current position
   * Assumes position is unprofitable and calculates how many hours needed to break even
   * Accounts for fees already earned while holding the position
   */
  getRemainingBreakEvenHours(
    position: PerpPosition,
    currentFundingRate: number, // Current funding rate (per period, typically hourly)
    positionValueUsd?: number, // Optional, will use position.getPositionValue() if not provided
  ): {
    remainingBreakEvenHours: number;
    requiredFundingRate: number;
    currentRate: number;
    entryCost: number;
    positionValueUsd: number;
    feesEarnedSoFar: number;
    hoursHeld: number;
    remainingCost: number;
  } {
    const valueUsd = positionValueUsd ?? position.getPositionValue();
    const key = `${position.symbol}_${position.exchangeType}`;
    const currentPos = this.currentPositions.get(key);
    
    if (!currentPos) {
      return {
        remainingBreakEvenHours: Infinity,
        requiredFundingRate: 0,
        currentRate: currentFundingRate,
        entryCost: 0,
        positionValueUsd: valueUsd,
        feesEarnedSoFar: 0,
        hoursHeld: 0,
        remainingCost: Infinity,
      };
    }

    // Calculate hours held
    const now = new Date();
    const hoursHeldMs = now.getTime() - currentPos.startTime.getTime();
    const hoursHeld = hoursHeldMs / (1000 * 60 * 60);

    // Calculate hourly return based on funding rate
    // For LONG: negative funding rate = receive funding (positive return)
    // For SHORT: positive funding rate = receive funding (positive return)
    let hourlyReturn: number;
    if (position.side === 'LONG') {
      hourlyReturn = -currentFundingRate * valueUsd; // Negative rate = positive return
    } else {
      hourlyReturn = currentFundingRate * valueUsd; // Positive rate = positive return
    }

    if (hourlyReturn <= 0) {
      return {
        remainingBreakEvenHours: Infinity,
        requiredFundingRate: Infinity,
        currentRate: currentFundingRate,
        entryCost: currentPos.entry.entryCost,
        positionValueUsd: valueUsd,
        feesEarnedSoFar: 0,
        hoursHeld,
        remainingCost: Infinity,
      };
    }

    // Calculate fees earned so far
    const feesEarnedSoFar = hoursHeld * hourlyReturn;

    // Remaining costs = entry cost (already incurred) + estimated exit cost - fees earned so far
    // We estimate exit cost as same as entry cost (maker fees)
    const estimatedExitCost = currentPos.entry.entryCost;
    const totalCosts = currentPos.entry.entryCost + estimatedExitCost;
    const remainingCost = totalCosts - feesEarnedSoFar;

    // If we've already earned more than costs, position is profitable
    if (remainingCost <= 0) {
      return {
        remainingBreakEvenHours: 0, // Already profitable
        requiredFundingRate: 0,
        currentRate: currentFundingRate,
        entryCost: currentPos.entry.entryCost,
        positionValueUsd: valueUsd,
        feesEarnedSoFar,
        hoursHeld,
        remainingCost: 0,
      };
    }

    const remainingBreakEvenHours = remainingCost / hourlyReturn;
    // Calculate required funding rate to break even
    const requiredFundingRate = remainingCost / (valueUsd * hoursHeld);

    return {
      remainingBreakEvenHours,
      requiredFundingRate,
      currentRate: currentFundingRate,
      entryCost: currentPos.entry.entryCost,
      positionValueUsd: valueUsd,
      feesEarnedSoFar,
      hoursHeld,
      remainingCost,
    };
  }

  /**
   * Calculate switching costs when closing current position and opening new one
   * Returns breakdown of all costs including lost progress (fees already earned)
   */
  getSwitchingCosts(
    position: PerpPosition,
    currentFundingRate: number,
    newEntryCosts: number,
    newExitCosts: number,
    positionValueUsd?: number,
  ): {
    exitCostCurrent: number;
    entryCostNew: number;
    lostProgress: number;
    totalSwitchingCost: number;
    feesEarnedSoFar: number;
    hoursHeld: number;
  } {
    const valueUsd = positionValueUsd ?? position.getPositionValue();
    const key = `${position.symbol}_${position.exchangeType}`;
    const currentPos = this.currentPositions.get(key);
    
    if (!currentPos) {
      // No tracked entry, assume no switching costs (shouldn't happen in practice)
    return {
      exitCostCurrent: 0,
      entryCostNew: newEntryCosts,
      lostProgress: 0,
      totalSwitchingCost: newEntryCosts,
      feesEarnedSoFar: 0,
      hoursHeld: 0,
    };
    }

    // Calculate hours held and fees earned
    const now = new Date();
    const hoursHeldMs = now.getTime() - currentPos.startTime.getTime();
    const hoursHeld = hoursHeldMs / (1000 * 60 * 60);

    // Calculate hourly return
    let hourlyReturn: number;
    if (position.side === 'LONG') {
      hourlyReturn = -currentFundingRate * valueUsd;
    } else {
      hourlyReturn = currentFundingRate * valueUsd;
    }

    const feesEarnedSoFar = Math.max(0, hoursHeld * hourlyReturn);

    // Exit cost on current position (estimate as same as entry cost)
    const exitCostCurrent = currentPos.entry.entryCost;

    // Lost progress = fees we've already earned that we lose when closing
    const lostProgress = feesEarnedSoFar;

    // Total switching cost = exit fees + entry fees + lost progress
    const totalSwitchingCost = exitCostCurrent + newEntryCosts + lostProgress;

    return {
      exitCostCurrent,
      entryCostNew: newEntryCosts,
      lostProgress,
      totalSwitchingCost,
      feesEarnedSoFar,
      hoursHeld,
    };
  }

  /**
   * Get statistics about position history
   */
  getStatistics(): {
    totalPositions: number;
    totalEntryCosts: number;
    totalExitCosts: number;
    totalRealizedLosses: number;
    cumulativeLoss: number;
    averageTimeHeld: number;
    currentPositions: number;
  } {
    const totalEntryCosts = this.entries.reduce((sum, e) => sum + e.entryCost, 0);
    const totalExitCosts = this.exits.reduce((sum, e) => sum + e.exitCost, 0);
    const totalRealizedLosses = this.exits.reduce((sum, e) => sum + e.realizedLoss, 0);
    const avgTimeHeld = this.exits.length > 0
      ? this.exits.reduce((sum, e) => sum + e.timeHeld, 0) / this.exits.length
      : 0;

    return {
      totalPositions: this.exits.length,
      totalEntryCosts,
      totalExitCosts,
      totalRealizedLosses,
      cumulativeLoss: this.getCumulativeLoss(),
      averageTimeHeld: avgTimeHeld,
      currentPositions: this.currentPositions.size,
    };
  }

  /**
   * Reset all tracked losses (useful for testing)
   * Clears in-memory data and optionally deletes persistence files
   */
  reset(): void {
    this.entries = [];
    this.exits = [];
    this.currentPositions.clear();
    
    // Delete persistence files in test mode to ensure clean state
    const testMode = this.configService.get<string>('TEST_MODE') === 'true';
    if (testMode) {
      try {
        if (fs.existsSync(this.entriesFile)) {
          fs.unlinkSync(this.entriesFile);
        }
        if (fs.existsSync(this.exitsFile)) {
          fs.unlinkSync(this.exitsFile);
        }
        this.logger.log('Cleared position loss tracker files');
      } catch (error: any) {
        this.logger.warn(`Failed to clear loss tracker files: ${error.message}`);
      }
    }
    
    this.logger.log('Position loss tracker reset');
  }

  /**
   * Load data from file
   */
  private loadFromFile(): void {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        return;
      }

      // Load entries
      if (fs.existsSync(this.entriesFile)) {
        const entriesData = fs.readFileSync(this.entriesFile, 'utf-8');
        const parsed = JSON.parse(entriesData);
        this.entries = parsed.map((e: any) => ({
          ...e,
          timestamp: new Date(e.timestamp),
        }));
      }

      // Load exits
      if (fs.existsSync(this.exitsFile)) {
        const exitsData = fs.readFileSync(this.exitsFile, 'utf-8');
        const parsed = JSON.parse(exitsData);
        this.exits = parsed.map((e: any) => ({
          ...e,
          timestamp: new Date(e.timestamp),
        }));
      }

      this.logger.log(
        `Loaded position history: ${this.entries.length} entries, ${this.exits.length} exits`
      );
    } catch (error: any) {
      this.logger.warn(`Failed to load position history from file: ${error.message}`);
      // Continue with empty data
    }
  }

  /**
   * Save data to file
   */
  private saveToFile(): void {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      // Save entries
      fs.writeFileSync(this.entriesFile, JSON.stringify(this.entries, null, 2), 'utf-8');

      // Save exits
      fs.writeFileSync(this.exitsFile, JSON.stringify(this.exits, null, 2), 'utf-8');
    } catch (error: any) {
      this.logger.warn(`Failed to save position history to file: ${error.message}`);
      // Continue without saving (data remains in memory)
    }
  }
}

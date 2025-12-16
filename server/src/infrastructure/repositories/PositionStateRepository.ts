import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

/**
 * Position state status
 */
export type PositionStatus = 'PENDING' | 'COMPLETE' | 'SINGLE_LEG' | 'CLOSED' | 'ERROR';

/**
 * Persisted position state
 */
export interface PersistedPositionState {
  id: string;
  symbol: string;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  longOrderId?: string;
  shortOrderId?: string;
  longFilled: boolean;
  shortFilled: boolean;
  positionSize: number;
  positionSizeUsd: number;
  createdAt: Date;
  updatedAt: Date;
  status: PositionStatus;
  errorMessage?: string;
  retryCount?: number;
}

/**
 * Serialized format for JSON storage
 */
interface SerializedPositionState {
  id: string;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longOrderId?: string;
  shortOrderId?: string;
  longFilled: boolean;
  shortFilled: boolean;
  positionSize: number;
  positionSizeUsd: number;
  createdAt: string;
  updatedAt: string;
  status: PositionStatus;
  errorMessage?: string;
  retryCount?: number;
}

/**
 * PositionStateRepository - Persists position state to file for recovery after restarts
 * 
 * This enables:
 * - Recovery of in-flight positions after service restart
 * - Detection of orphaned single-leg positions
 * - Audit trail of position lifecycle
 */
@Injectable()
export class PositionStateRepository implements OnModuleInit {
  private readonly logger = new Logger(PositionStateRepository.name);
  private readonly dataFilePath: string;
  private positions: Map<string, PersistedPositionState> = new Map();
  private saveInProgress = false;
  private pendingSave = false;

  constructor(private readonly configService: ConfigService) {
    const dataDir = this.configService.get<string>('POSITION_STATE_DIR', 'data');
    this.dataFilePath = path.join(process.cwd(), dataDir, 'position-state.json');
  }

  async onModuleInit(): Promise<void> {
    await this.loadFromFile();
  }

  /**
   * Generate a unique position ID
   */
  generateId(symbol: string, longExchange: ExchangeType, shortExchange: ExchangeType): string {
    return `${symbol}-${longExchange}-${shortExchange}-${Date.now()}`;
  }

  /**
   * Save a new position state
   */
  async save(state: PersistedPositionState): Promise<void> {
    state.updatedAt = new Date();
    this.positions.set(state.id, state);
    await this.persistToFile();
    
    this.logger.debug(`Saved position state: ${state.id} (${state.status})`);
  }

  /**
   * Update an existing position state
   */
  async update(id: string, updates: Partial<PersistedPositionState>): Promise<void> {
    const existing = this.positions.get(id);
    if (!existing) {
      this.logger.warn(`Cannot update non-existent position: ${id}`);
      return;
    }

    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };
    this.positions.set(id, updated);
    await this.persistToFile();
    
    this.logger.debug(`Updated position state: ${id} -> ${updated.status}`);
  }

  /**
   * Get a position by ID
   */
  get(id: string): PersistedPositionState | undefined {
    return this.positions.get(id);
  }

  /**
   * Get all positions
   */
  getAll(): PersistedPositionState[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get positions by status
   */
  getByStatus(status: PositionStatus): PersistedPositionState[] {
    return this.getAll().filter(p => p.status === status);
  }

  /**
   * Get positions for a specific symbol
   */
  getBySymbol(symbol: string): PersistedPositionState[] {
    return this.getAll().filter(p => p.symbol === symbol);
  }

  /**
   * Get active (non-closed) positions
   */
  getActive(): PersistedPositionState[] {
    return this.getAll().filter(p => p.status !== 'CLOSED');
  }

  /**
   * Get single-leg positions that need attention
   */
  getSingleLegPositions(): PersistedPositionState[] {
    return this.getByStatus('SINGLE_LEG');
  }

  /**
   * Delete a position
   */
  async delete(id: string): Promise<void> {
    if (this.positions.delete(id)) {
      await this.persistToFile();
      this.logger.debug(`Deleted position state: ${id}`);
    }
  }

  /**
   * Mark a position as closed
   */
  async markClosed(id: string): Promise<void> {
    await this.update(id, { status: 'CLOSED' });
  }

  /**
   * Mark a position as single-leg
   */
  async markSingleLeg(id: string, longFilled: boolean, shortFilled: boolean): Promise<void> {
    await this.update(id, {
      status: 'SINGLE_LEG',
      longFilled,
      shortFilled,
    });
  }

  /**
   * Mark a position as complete (both legs filled)
   */
  async markComplete(id: string): Promise<void> {
    await this.update(id, {
      status: 'COMPLETE',
      longFilled: true,
      shortFilled: true,
    });
  }

  /**
   * Increment retry count for a position
   */
  async incrementRetryCount(id: string): Promise<number> {
    const existing = this.positions.get(id);
    if (!existing) return 0;

    const newCount = (existing.retryCount || 0) + 1;
    await this.update(id, { retryCount: newCount });
    return newCount;
  }

  /**
   * Get count of positions by status
   */
  getStatusCounts(): Record<PositionStatus, number> {
    const counts: Record<PositionStatus, number> = {
      PENDING: 0,
      COMPLETE: 0,
      SINGLE_LEG: 0,
      CLOSED: 0,
      ERROR: 0,
    };

    for (const position of this.positions.values()) {
      counts[position.status]++;
    }

    return counts;
  }

  /**
   * Clean up old closed positions (older than specified days)
   */
  async cleanupOldPositions(olderThanDays: number = 7): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [id, position] of this.positions.entries()) {
      if (
        position.status === 'CLOSED' &&
        new Date(position.updatedAt).getTime() < cutoff
      ) {
        this.positions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      await this.persistToFile();
      this.logger.log(`Cleaned up ${cleaned} old closed positions`);
    }

    return cleaned;
  }

  /**
   * Load position states from file
   */
  private async loadFromFile(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!fs.existsSync(this.dataFilePath)) {
        this.logger.log('No existing position state file found, starting fresh');
        return;
      }

      const data = fs.readFileSync(this.dataFilePath, 'utf-8');
      const serialized: SerializedPositionState[] = JSON.parse(data);

      this.positions.clear();
      for (const item of serialized) {
        const position: PersistedPositionState = {
          ...item,
          longExchange: item.longExchange as ExchangeType,
          shortExchange: item.shortExchange as ExchangeType,
          createdAt: new Date(item.createdAt),
          updatedAt: new Date(item.updatedAt),
        };
        this.positions.set(position.id, position);
      }

      this.logger.log(`Loaded ${this.positions.size} position states from file`);
      
      // Log summary
      const counts = this.getStatusCounts();
      this.logger.log(
        `Position status: PENDING=${counts.PENDING}, COMPLETE=${counts.COMPLETE}, ` +
        `SINGLE_LEG=${counts.SINGLE_LEG}, CLOSED=${counts.CLOSED}, ERROR=${counts.ERROR}`
      );
    } catch (error: any) {
      this.logger.error(`Failed to load position state file: ${error.message}`);
      // Start with empty state on error
      this.positions.clear();
    }
  }

  /**
   * Persist position states to file
   * Uses debouncing to prevent excessive writes
   */
  private async persistToFile(): Promise<void> {
    if (this.saveInProgress) {
      this.pendingSave = true;
      return;
    }

    this.saveInProgress = true;

    try {
      // Ensure directory exists
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const serialized: SerializedPositionState[] = Array.from(this.positions.values()).map(p => ({
        ...p,
        longExchange: p.longExchange,
        shortExchange: p.shortExchange,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      }));

      // Write to temp file first, then rename (atomic operation)
      const tempPath = `${this.dataFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(serialized, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.dataFilePath);
    } catch (error: any) {
      this.logger.error(`Failed to persist position state: ${error.message}`);
    } finally {
      this.saveInProgress = false;

      // Handle any pending saves
      if (this.pendingSave) {
        this.pendingSave = false;
        await this.persistToFile();
      }
    }
  }
}



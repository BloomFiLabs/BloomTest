import { Injectable, LoggerService, ConsoleLogger } from '@nestjs/common';

export interface LogEntry {
  timestamp: Date;
  level: string;
  context: string;
  message: string;
}

export interface GroupedError {
  message: string;
  context: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

@Injectable()
export class TuiLogService extends ConsoleLogger implements LoggerService {
  private static readonly MAX_LOGS = 100;
  private static readonly MAX_ERRORS = 200;
  private static readonly logBuffer: LogEntry[] = [];
  private static readonly errorBuffer: LogEntry[] = [];

  log(message: any, context?: string) {
    super.log(message, context);
    this.addToBuffer('LOG', message, context);
  }

  error(message: any, stack?: string, context?: string) {
    super.error(message, stack, context);
    this.addToBuffer('ERROR', message, context);
    this.addToErrorBuffer(message, context);
  }

  warn(message: any, context?: string) {
    super.warn(message, context);
    this.addToBuffer('WARN', message, context);
  }

  debug(message: any, context?: string) {
    super.debug(message, context);
    this.addToBuffer('DEBUG', message, context);
  }

  verbose(message: any, context?: string) {
    super.verbose(message, context);
    this.addToBuffer('VERBOSE', message, context);
  }

  private addToBuffer(level: string, message: any, context?: string) {
    TuiLogService.logBuffer.unshift({
      timestamp: new Date(),
      level,
      context: context || 'Global',
      message: typeof message === 'string' ? message : JSON.stringify(message),
    });

    if (TuiLogService.logBuffer.length > TuiLogService.MAX_LOGS) {
      TuiLogService.logBuffer.pop();
    }
  }

  private addToErrorBuffer(message: any, context?: string) {
    TuiLogService.errorBuffer.unshift({
      timestamp: new Date(),
      level: 'ERROR',
      context: context || 'Global',
      message: typeof message === 'string' ? message : JSON.stringify(message),
    });

    if (TuiLogService.errorBuffer.length > TuiLogService.MAX_ERRORS) {
      TuiLogService.errorBuffer.pop();
    }
  }

  getLogs(limit: number = 50, filter?: string): LogEntry[] {
    let logs = TuiLogService.logBuffer;
    if (filter) {
      logs = logs.filter(l => l.level === filter || l.context.includes(filter));
    }
    return logs.slice(0, limit);
  }

  /**
   * Get grouped errors - identical errors are collapsed with a count
   */
  getGroupedErrors(limit: number = 10): GroupedError[] {
    const errorMap = new Map<string, GroupedError>();
    
    for (const err of TuiLogService.errorBuffer) {
      // Create a key from context + normalized message
      // Normalize by removing timestamps, order IDs, and specific numbers
      const normalizedMsg = err.message
        .replace(/\d{10,}/g, 'XXX') // Remove long numbers (order IDs, timestamps)
        .replace(/0x[a-fA-F0-9]+/g, '0xXXX') // Remove hex addresses
        .replace(/\$[\d.]+/g, '$X.XX') // Normalize dollar amounts
        .replace(/[\d.]+%/g, 'X%') // Normalize percentages
        .substring(0, 100); // Limit key length
      
      const key = `${err.context}:${normalizedMsg}`;
      
      const existing = errorMap.get(key);
      if (existing) {
        existing.count++;
        if (err.timestamp < existing.firstSeen) {
          existing.firstSeen = err.timestamp;
        }
        if (err.timestamp > existing.lastSeen) {
          existing.lastSeen = err.timestamp;
        }
      } else {
        errorMap.set(key, {
          message: err.message.substring(0, 80), // Truncate for display
          context: err.context,
          count: 1,
          firstSeen: err.timestamp,
          lastSeen: err.timestamp,
        });
      }
    }
    
    // Sort by count (most frequent first), then by lastSeen (most recent first)
    const sorted = Array.from(errorMap.values())
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.lastSeen.getTime() - a.lastSeen.getTime();
      });
    
    return sorted.slice(0, limit);
  }

  /**
   * Get raw error count
   */
  getErrorCount(): number {
    return TuiLogService.errorBuffer.length;
  }
}


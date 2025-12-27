import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../adapters/persistence/prisma.service';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

export type TradeDecisionType = 'EXECUTED' | 'SKIPPED' | 'REJECTED' | 'ERROR';

export interface TradeDecisionData {
  symbol: string;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  longFundingRate: number;
  shortFundingRate: number;
  spread: number;
  decision: TradeDecisionType;
  reason: string;
  expectedReturnUsd?: number;
  actualReturnUsd?: number;
  positionValueUsd?: number;
  executionTimeMs?: number;
}

@Injectable()
export class TradeLoggingService {
  private readonly logger = new Logger(TradeLoggingService.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /**
   * Log a trade decision to the database
   */
  async logDecision(data: TradeDecisionData): Promise<void> {
    try {
      if (!this.prisma || !this.prisma.client) {
        this.logger.debug(`[TradeLogging] Decision skipped (DB unavailable): ${data.symbol} ${data.decision} - ${data.reason}`);
        return;
      }

      await this.prisma.client.tradeDecision.create({
        data: {
          symbol: data.symbol,
          longExchange: data.longExchange,
          shortExchange: data.shortExchange,
          longFundingRate: data.longFundingRate,
          shortFundingRate: data.shortFundingRate,
          spread: data.spread,
          decision: data.decision,
          reason: data.reason,
          expectedReturnUsd: data.expectedReturnUsd,
          actualReturnUsd: data.actualReturnUsd,
          positionValueUsd: data.positionValueUsd,
          executionTimeMs: data.executionTimeMs,
        },
      });

      this.logger.debug(`[TradeLogging] Recorded decision: ${data.symbol} ${data.decision}`);
    } catch (error: any) {
      this.logger.error(`Failed to log trade decision: ${error.message}`);
    }
  }

  /**
   * Get recent trade decisions
   */
  async getRecentDecisions(limit: number = 100): Promise<any[]> {
    if (!this.prisma || !this.prisma.client) return [];
    
    return this.prisma.client.tradeDecision.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }
}


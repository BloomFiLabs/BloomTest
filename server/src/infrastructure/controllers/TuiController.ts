import { Controller, Get, Query } from '@nestjs/common';
import { ExecutionLockService } from '../services/ExecutionLockService';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';
import { TradeLoggingService } from '../services/TradeLoggingService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { ReconciliationService } from '../../domain/services/execution/ReconciliationService';
import { TuiLogService } from '../services/TuiLogService';

@Controller('tui')
export class TuiController {
  constructor(
    private readonly executionLockService: ExecutionLockService,
    private readonly keeperService: PerpKeeperService,
    private readonly tradeLoggingService: TradeLoggingService,
    private readonly reconciliationService: ReconciliationService,
    private readonly logService: TuiLogService,
  ) {}

  @Get('status')
  async getStatus() {
    const diagnostics = this.executionLockService.getFullDiagnostics();
    const hlAdapter = this.keeperService.getExchangeAdapter(ExchangeType.HYPERLIQUID);
    const lighterAdapter = this.keeperService.getExchangeAdapter(ExchangeType.LIGHTER);

    const [hlEquity, lighterEquity, hlPositions, lighterPositions] = await Promise.all([
      hlAdapter?.getEquity().catch(() => 0) || 0,
      lighterAdapter?.getEquity().catch(() => 0) || 0,
      hlAdapter?.getPositions().catch(() => []) || [],
      lighterAdapter?.getPositions().catch(() => []) || [],
    ]);

    const recentDecisions = await this.tradeLoggingService.getRecentDecisions(10);
    const health = (this.reconciliationService as any).getHealthStatus?.() || { status: 'OK', lastCheck: new Date() };
    const logs = this.logService.getLogs(20);
    const groupedErrors = this.logService.getGroupedErrors(10);
    const errorCount = this.logService.getErrorCount();

    return {
      timestamp: new Date(),
      diagnostics,
      portfolio: {
        hlEquity,
        lighterEquity,
        totalEquity: hlEquity + lighterEquity,
        hlPositions,
        lighterPositions,
      },
      recentDecisions,
      health,
      logs,
      groupedErrors,
      errorCount,
    };
  }

  @Get('logs')
  async getLogs(@Query('type') type?: string, @Query('limit') limit: number = 50) {
    return { logs: this.logService.getLogs(limit, type) };
  }
}


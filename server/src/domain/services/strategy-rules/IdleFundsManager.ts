import { Injectable, Logger } from '@nestjs/common';
import { IIdleFundsManager, IdleFundsInfo, PositionPerformance, IdleFundsAllocation } from './IIdleFundsManager';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { PerpPosition } from '../../entities/PerpPosition';
import { Result } from '../../common/Result';
import { DomainException, ExchangeException } from '../../exceptions/DomainException';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { PerpOrderRequest, OrderSide, OrderType, TimeInForce, OrderStatus } from '../../value-objects/PerpOrder';
import { ExecutionPlanBuilder } from './ExecutionPlanBuilder';
import { CostCalculator } from './CostCalculator';

/**
 * IdleFundsManager - Manages idle funds and reallocates them to best opportunities
 * 
 * Responsibilities:
 * 1. Detect idle funds (unused balance, unfilled orders after retries)
 * 2. Rank positions by performance
 * 3. Allocate idle funds to best performing positions or next best opportunities
 * 4. Execute allocations
 */
@Injectable()
export class IdleFundsManager implements IIdleFundsManager {
  private readonly logger = new Logger(IdleFundsManager.name);
  private readonly MIN_IDLE_THRESHOLD = 10; // Minimum $10 to consider as idle
  private readonly ORDER_FAILURE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly config: StrategyConfig,
    private readonly executionPlanBuilder: ExecutionPlanBuilder,
    private readonly costCalculator: CostCalculator,
  ) {}

  async detectIdleFunds(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    currentPositions: PerpPosition[],
    openOrders: Map<ExchangeType, string[]>,
    failedOrders: Map<ExchangeType, Array<{ orderId: string; symbol: string; timestamp: Date }>>,
  ): Promise<Result<IdleFundsInfo[], DomainException>> {
    const idleFunds: IdleFundsInfo[] = [];

    try {
      // Calculate margin used per exchange
      const marginUsedPerExchange = new Map<ExchangeType, number>();
      for (const position of currentPositions) {
        const current = marginUsedPerExchange.get(position.exchangeType) || 0;
        const positionValue = Math.abs(position.size) * (position.markPrice || position.entryPrice);
        const marginUsed = positionValue / this.config.leverage;
        marginUsedPerExchange.set(position.exchangeType, current + marginUsed);
      }

      // Check each exchange for idle funds
      for (const [exchange, adapter] of adapters.entries()) {
        try {
          const totalBalance = await adapter.getBalance();
          const marginUsed = marginUsedPerExchange.get(exchange) || 0;
          const availableBalance = Math.max(0, totalBalance - marginUsed);

          // Check for unused balance
          if (availableBalance >= this.MIN_IDLE_THRESHOLD) {
            // Check if this exchange has any active positions or open orders
            const hasActivePositions = currentPositions.some(p => p.exchangeType === exchange);
            const hasOpenOrders = (openOrders.get(exchange) || []).length > 0;

            if (!hasActivePositions && !hasOpenOrders) {
              // Completely unused exchange
              idleFunds.push({
                exchange,
                idleBalance: availableBalance,
                reason: 'unused_balance',
              });
            } else if (availableBalance > this.MIN_IDLE_THRESHOLD * 2) {
              // Partially unused (has some activity but excess balance)
              idleFunds.push({
                exchange,
                idleBalance: availableBalance - this.MIN_IDLE_THRESHOLD, // Keep minimum buffer
                reason: 'unused_balance',
              });
            }
          }

          // Check for failed orders (exhausted retries)
          const exchangeFailedOrders = failedOrders.get(exchange) || [];
          for (const failedOrder of exchangeFailedOrders) {
            const ageMs = Date.now() - failedOrder.timestamp.getTime();
            if (ageMs >= this.ORDER_FAILURE_TIMEOUT_MS) {
              // Try to get order status to see if it's still pending
              try {
                const orderStatus = await adapter.getOrderStatus(failedOrder.orderId, failedOrder.symbol);
                
                // If order is still pending after timeout, consider funds idle
                if (orderStatus.status === OrderStatus.SUBMITTED || orderStatus.status === OrderStatus.PENDING) {
                  // Estimate idle balance from order size (approximate)
                  const estimatedIdle = availableBalance * 0.1; // Conservative estimate
                  if (estimatedIdle >= this.MIN_IDLE_THRESHOLD) {
                    idleFunds.push({
                      exchange,
                      idleBalance: estimatedIdle,
                      reason: 'unfilled_order',
                      orderId: failedOrder.orderId,
                      symbol: failedOrder.symbol,
                    });
                  }
                }
              } catch (error: any) {
                // Order might be cancelled or filled, skip
                this.logger.debug(
                  `Could not check status of failed order ${failedOrder.orderId}: ${error.message}`,
                );
              }
            }
          }
        } catch (error: any) {
          this.logger.warn(
            `Failed to detect idle funds for ${exchange}: ${error.message}`,
          );
        }
      }

      if (idleFunds.length > 0) {
        const totalIdle = idleFunds.reduce((sum, info) => sum + info.idleBalance, 0);
        this.logger.log(
          `💰 Detected $${totalIdle.toFixed(2)} in idle funds across ${idleFunds.length} source(s)`,
        );
      }

      return Result.success(idleFunds);
    } catch (error: any) {
      return Result.failure(
        new DomainException(
          `Failed to detect idle funds: ${error.message}`,
          'IDLE_FUNDS_DETECTION_FAILED',
          { error: error.message },
        ),
      );
    }
  }

  rankPositionsByPerformance(
    positions: PerpPosition[],
    opportunities: ArbitrageOpportunity[],
  ): PositionPerformance[] {
    const performance: PositionPerformance[] = [];

    for (const position of positions) {
      // Find matching opportunity
      const opportunity = opportunities.find(
        (opp) =>
          opp.symbol === position.symbol &&
          ((opp.longExchange === position.exchangeType && position.side === 'LONG') ||
            (opp.shortExchange === position.exchangeType && position.side === 'SHORT')),
      );

      if (opportunity) {
        const positionValue = Math.abs(position.size) * (position.markPrice || position.entryPrice);
        const expectedReturnPerPeriod = opportunity.expectedReturn
          ? opportunity.expectedReturn.toDecimal() * positionValue / (24 * 365)
          : 0;
        const expectedAPY = opportunity.expectedReturn
          ? opportunity.expectedReturn.toDecimal()
          : 0;

        performance.push({
          position,
          expectedReturnPerPeriod,
          expectedAPY,
          opportunity,
        });
      } else {
        // Position without matching opportunity - assume zero return
        performance.push({
          position,
          expectedReturnPerPeriod: 0,
          expectedAPY: 0,
        });
      }
    }

    // Sort by expected return per period (best first)
    return performance.sort((a, b) => b.expectedReturnPerPeriod - a.expectedReturnPerPeriod);
  }

  allocateIdleFunds(
    idleFunds: IdleFundsInfo[],
    opportunities: ArbitrageOpportunity[],
    currentPositions: PerpPosition[],
    exchangeBalances: Map<ExchangeType, number>,
  ): Result<IdleFundsAllocation[], DomainException> {
    if (idleFunds.length === 0) {
      return Result.success([]);
    }

    if (opportunities.length === 0) {
      this.logger.warn('No opportunities available for idle funds allocation');
      return Result.success([]);
    }

    const allocations: IdleFundsAllocation[] = [];
    const totalIdle = idleFunds.reduce((sum, info) => sum + info.idleBalance, 0);

    // Rank positions by performance
    const rankedPositions = this.rankPositionsByPerformance(currentPositions, opportunities);

    // Sort opportunities by expected return (best first)
    const sortedOpportunities = [...opportunities].sort(
      (a, b) => (b.expectedReturn?.toDecimal() || 0) - (a.expectedReturn?.toDecimal() || 0),
    );

    // Strategy 1: Allocate to best performing positions first
    for (const rankedPosition of rankedPositions) {
      if (rankedPosition.expectedAPY <= 0) break; // Skip non-profitable positions

      const position = rankedPosition.position;
      const positionValue = Math.abs(position.size) * (position.markPrice || position.entryPrice);
      const currentMargin = positionValue / this.config.leverage;

      // Calculate how much we can add to this position
      const maxAdditionalMargin = currentMargin * 0.5; // Add up to 50% more
      const targetValue = positionValue * 1.5;
      const additionalNeeded = targetValue / this.config.leverage - currentMargin;

      // Find idle funds on the same exchange
      const exchangeIdleFunds = idleFunds.filter(
        (info) => info.exchange === position.exchangeType && info.idleBalance > 0,
      );

      for (const idleInfo of exchangeIdleFunds) {
        if (idleInfo.idleBalance <= 0) continue;

        const allocation = Math.min(idleInfo.idleBalance, additionalNeeded);
        if (allocation >= this.MIN_IDLE_THRESHOLD) {
          allocations.push({
            source: idleInfo,
            target: {
              opportunity: rankedPosition.opportunity!,
              allocation,
              reason: 'best_performing',
            },
          });

          // Reduce idle balance
          idleInfo.idleBalance -= allocation;
        }
      }
    }

    // Strategy 2: Allocate remaining idle funds to next best opportunities
    const remainingIdleFunds = idleFunds.filter((info) => info.idleBalance >= this.MIN_IDLE_THRESHOLD);
    
    if (remainingIdleFunds.length > 0 && sortedOpportunities.length > 0) {
      // Distribute remaining idle funds proportionally to best opportunities
      const totalRemainingIdle = remainingIdleFunds.reduce((sum, info) => sum + info.idleBalance, 0);
      
      // Allocate to top opportunities (up to 5)
      const topOpportunities = sortedOpportunities.slice(0, 5);
      const totalExpectedReturn = topOpportunities.reduce(
        (sum, opp) => sum + (opp.expectedReturn?.toDecimal() || 0),
        0,
      );

      if (totalExpectedReturn > 0) {
        for (const opportunity of topOpportunities) {
          const opportunityWeight = (opportunity.expectedReturn?.toDecimal() || 0) / totalExpectedReturn;
          const targetAllocation = totalRemainingIdle * opportunityWeight;

          // Find idle funds that can be allocated to this opportunity
          // Need funds on both exchanges
          const longExchangeIdle = remainingIdleFunds.find(
            (info) => info.exchange === opportunity.longExchange && info.idleBalance > 0,
          );
          const shortExchangeIdle = remainingIdleFunds.find(
            (info) => info.exchange === opportunity.shortExchange && info.idleBalance > 0,
          );

          if (longExchangeIdle && shortExchangeIdle) {
            // Allocate equally to both sides
            const perSideAllocation = Math.min(
              targetAllocation / 2,
              longExchangeIdle.idleBalance,
              shortExchangeIdle.idleBalance,
            );

            if (perSideAllocation >= this.MIN_IDLE_THRESHOLD) {
              // Allocate to long side
              allocations.push({
                source: longExchangeIdle,
                target: {
                  opportunity,
                  allocation: perSideAllocation,
                  reason: 'next_opportunity',
                },
              });
              longExchangeIdle.idleBalance -= perSideAllocation;

              // Allocate to short side
              allocations.push({
                source: shortExchangeIdle,
                target: {
                  opportunity,
                  allocation: perSideAllocation,
                  reason: 'next_opportunity',
                },
              });
              shortExchangeIdle.idleBalance -= perSideAllocation;
            }
          } else if (longExchangeIdle) {
            // Only long exchange has idle funds
            const longAllocation = Math.min(targetAllocation, longExchangeIdle.idleBalance);
            if (longAllocation >= this.MIN_IDLE_THRESHOLD) {
              allocations.push({
                source: longExchangeIdle,
                target: {
                  opportunity,
                  allocation: longAllocation,
                  reason: 'next_opportunity',
                },
              });
              longExchangeIdle.idleBalance -= longAllocation;
            }
          } else if (shortExchangeIdle) {
            // Only short exchange has idle funds
            const shortAllocation = Math.min(targetAllocation, shortExchangeIdle.idleBalance);
            if (shortAllocation >= this.MIN_IDLE_THRESHOLD) {
              allocations.push({
                source: shortExchangeIdle,
                target: {
                  opportunity,
                  allocation: shortAllocation,
                  reason: 'next_opportunity',
                },
              });
              shortExchangeIdle.idleBalance -= shortAllocation;
            }
          }
        }
      }
    }

    if (allocations.length > 0) {
      const totalAllocated = allocations.reduce((sum, alloc) => sum + alloc.target.allocation, 0);
      this.logger.log(
        `📊 Allocated $${totalAllocated.toFixed(2)} idle funds to ${allocations.length} target(s)`,
      );
    }

    return Result.success(allocations);
  }

  async executeAllocations(
    allocations: IdleFundsAllocation[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<Result<{ allocated: number; allocations: number }, DomainException>> {
    if (allocations.length === 0) {
      return Result.success({ allocated: 0, allocations: 0 });
    }

    let totalAllocated = 0;
    let successfulAllocations = 0;

    for (const allocation of allocations) {
      try {
        const { source, target } = allocation;
        const { opportunity, allocation: amount, reason } = target;

        // Cancel failed order if applicable
        if (source.reason === 'unfilled_order' && source.orderId) {
          try {
            const adapter = adapters.get(source.exchange);
            if (adapter) {
              await adapter.cancelOrder(source.orderId, source.symbol);
              this.logger.debug(
                `Cancelled failed order ${source.orderId} on ${source.exchange}`,
              );
            }
          } catch (error: any) {
            this.logger.warn(
              `Failed to cancel order ${source.orderId}: ${error.message}`,
            );
          }
        }

        // Create execution plan for the opportunity
        // Need to get balances first
        const longAdapter = adapters.get(opportunity.longExchange);
        const shortAdapter = adapters.get(opportunity.shortExchange);
        
        if (!longAdapter || !shortAdapter) {
          this.logger.warn(`Missing adapters for ${opportunity.symbol}, skipping allocation`);
          continue;
        }

        const [longBalance, shortBalance] = await Promise.all([
          longAdapter.getBalance().catch(() => 0),
          shortAdapter.getBalance().catch(() => 0),
        ]);

        const planResult = await this.executionPlanBuilder.buildPlan(
          opportunity,
          adapters,
          { longBalance, shortBalance },
          this.config,
          opportunity.longMarkPrice,
          opportunity.shortMarkPrice,
          amount * this.config.leverage, // Use allocation as max position size
        );

        if (planResult.isFailure) {
          this.logger.warn(
            `Failed to build execution plan for ${opportunity.symbol}: ${planResult.error.message}`,
          );
          continue;
        }

        const plan = planResult.value;

        // Calculate position size from allocation amount
        const markPrice = opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
        if (markPrice <= 0) {
          this.logger.warn(`Invalid mark price for ${opportunity.symbol}, skipping allocation`);
          continue;
        }

        // Position size = allocation * leverage / markPrice
        const positionSize = (amount * this.config.leverage) / markPrice;

        // Determine which side to allocate to
        const isLongSide = source.exchange === opportunity.longExchange;
        const orderSide = isLongSide ? OrderSide.LONG : OrderSide.SHORT;
        const orderSymbol = opportunity.symbol;
        const orderPrice = isLongSide
          ? plan.longOrder.price || markPrice
          : plan.shortOrder.price || markPrice;

        // Place order to utilize idle funds
        const adapter = adapters.get(source.exchange);
        if (!adapter) {
          this.logger.warn(`No adapter found for ${source.exchange}`);
          continue;
        }

        const orderRequest = new PerpOrderRequest(
          orderSymbol,
          orderSide,
          OrderType.LIMIT,
          positionSize,
          orderPrice,
          TimeInForce.GTC,
        );

        const orderResponse = await adapter.placeOrder(orderRequest);

        if (orderResponse.isSuccess()) {
          totalAllocated += amount;
          successfulAllocations++;
          this.logger.log(
            `✅ Allocated $${amount.toFixed(2)} idle funds from ${source.exchange} ` +
              `to ${opportunity.symbol} ${orderSide} (${reason})`,
          );
        } else {
          this.logger.warn(
            `Failed to place order for idle funds allocation: ${orderResponse.orderId || 'unknown error'}`,
          );
        }
      } catch (error: any) {
        this.logger.error(
          `Error executing idle funds allocation: ${error.message}`,
        );
      }
    }

    return Result.success({
      allocated: totalAllocated,
      allocations: successfulAllocations,
    });
  }
}




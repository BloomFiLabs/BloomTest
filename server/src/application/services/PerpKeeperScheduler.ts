import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { ConfigService } from '@nestjs/config';
import { PerpKeeperPerformanceLogger } from '../../infrastructure/logging/PerpKeeperPerformanceLogger';
import { PerpKeeperService } from './PerpKeeperService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpOrderRequest, OrderSide, OrderType, TimeInForce, OrderStatus } from '../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import * as cliProgress from 'cli-progress';

/**
 * PerpKeeperScheduler - Scheduled execution for funding rate arbitrage
 * 
 * Executes hourly at funding rate clock (typically :00 minutes)
 * Also runs immediately on startup
 */
@Injectable()
export class PerpKeeperScheduler implements OnModuleInit {
  private readonly logger = new Logger(PerpKeeperScheduler.name);
  private symbols: string[] = []; // Will be populated by auto-discovery or configuration
  private readonly minSpread: number;
  private readonly maxPositionSizeUsd: number;
  private isRunning = false;
  private lastDiscoveryTime: number = 0;
  private readonly DISCOVERY_CACHE_TTL = 3600000; // 1 hour cache

  constructor(
    private readonly orchestrator: PerpKeeperOrchestrator,
    private readonly configService: ConfigService,
    private readonly performanceLogger: PerpKeeperPerformanceLogger,
    private readonly keeperService: PerpKeeperService,
  ) {
    // Initialize orchestrator with exchange adapters
    const adapters = this.keeperService.getExchangeAdapters();
    this.orchestrator.initialize(adapters);
    this.logger.log(`Orchestrator initialized with ${adapters.size} exchange adapters`);

    // Load configuration
    const symbolsEnv = this.configService.get<string>('KEEPER_SYMBOLS');
    // If KEEPER_SYMBOLS is explicitly set, use it; otherwise auto-discover
    if (symbolsEnv) {
      this.symbols = symbolsEnv.split(',').map(s => s.trim());
      this.logger.log(
        `Scheduler initialized with configured symbols: ${this.symbols.join(',')}`
      );
    } else {
      this.logger.log(
        `Scheduler initialized - will auto-discover all assets on first run`
      );
    }
    
    this.minSpread = parseFloat(this.configService.get<string>('KEEPER_MIN_SPREAD') || '0.0001');
    this.maxPositionSizeUsd = parseFloat(
      this.configService.get<string>('KEEPER_MAX_POSITION_SIZE_USD') || '10000',
    );

    this.logger.log(
      `Configuration: minSpread=${this.minSpread}, maxPositionSize=${this.maxPositionSizeUsd}`
    );
  }

  /**
   * Detect single-leg positions (positions without a matching pair on another exchange)
   * A single-leg position is one where we have LONG on one exchange but no SHORT on another,
   * or SHORT on one exchange but no LONG on another.
   */
  private detectSingleLegPositions(positions: PerpPosition[]): PerpPosition[] {
    if (positions.length === 0) {
      return [];
    }

    // Group positions by symbol
    const positionsBySymbol = new Map<string, PerpPosition[]>();
    for (const position of positions) {
      if (!positionsBySymbol.has(position.symbol)) {
        positionsBySymbol.set(position.symbol, []);
      }
      positionsBySymbol.get(position.symbol)!.push(position);
    }

    const singleLegPositions: PerpPosition[] = [];

    for (const [symbol, symbolPositions] of positionsBySymbol) {
      // For arbitrage, we need both LONG and SHORT positions on DIFFERENT exchanges
      const longPositions = symbolPositions.filter((p) => p.side === OrderSide.LONG);
      const shortPositions = symbolPositions.filter((p) => p.side === OrderSide.SHORT);

      // Check if we have both LONG and SHORT on different exchanges
      const hasLongOnDifferentExchange = longPositions.some(
        (longPos) =>
          !shortPositions.some(
            (shortPos) => shortPos.exchangeType === longPos.exchangeType,
          ),
      );
      const hasShortOnDifferentExchange = shortPositions.some(
        (shortPos) =>
          !longPositions.some(
            (longPos) => longPos.exchangeType === shortPos.exchangeType,
          ),
      );

      // If we have LONG but no SHORT on a different exchange, all LONG positions are single-leg
      if (longPositions.length > 0 && !hasShortOnDifferentExchange) {
        this.logger.warn(
          `⚠️ Single-leg LONG position(s) detected for ${symbol}: ` +
            `Found ${longPositions.length} LONG position(s) but no SHORT position on different exchange. ` +
            `These positions have price exposure and should be closed.`,
        );
        singleLegPositions.push(...longPositions);
      }

      // If we have SHORT but no LONG on a different exchange, all SHORT positions are single-leg
      if (shortPositions.length > 0 && !hasLongOnDifferentExchange) {
        this.logger.warn(
          `⚠️ Single-leg SHORT position(s) detected for ${symbol}: ` +
            `Found ${shortPositions.length} SHORT position(s) but no LONG position on different exchange. ` +
            `These positions have price exposure and should be closed.`,
        );
        singleLegPositions.push(...shortPositions);
      }

      // Edge case: If we have LONG and SHORT but they're on the SAME exchange, they're not arbitrage pairs
      // This is also a single-leg scenario (both legs on same exchange = no arbitrage)
      if (
        longPositions.length > 0 &&
        shortPositions.length > 0 &&
        longPositions.every((longPos) =>
          shortPositions.some(
            (shortPos) => shortPos.exchangeType === longPos.exchangeType,
          ),
        )
      ) {
        this.logger.warn(
          `⚠️ Positions for ${symbol} are on the same exchange(s) - not arbitrage pairs. ` +
            `Both LONG and SHORT positions are single-leg (no cross-exchange arbitrage).`,
        );
        singleLegPositions.push(...symbolPositions);
      }
    }

    return singleLegPositions;
  }

  /**
   * Run immediately on module initialization (startup)
   */
  async onModuleInit() {
    // Wait a bit for other services to initialize
    setTimeout(async () => {
      this.logger.log('🚀 Starting initial arbitrage opportunity check on startup...');
      await this.executeHourly();
    }, 2000); // 2 second delay to ensure all services are ready
  }

  /**
   * Discover all common assets across exchanges (with caching)
   */
  private async discoverAssetsIfNeeded(): Promise<string[]> {
    const now = Date.now();
    
    // Use cache if available and fresh
    if (this.symbols.length > 0 && (now - this.lastDiscoveryTime) < this.DISCOVERY_CACHE_TTL) {
      return this.symbols;
    }

    // Auto-discover all assets
    try {
      this.logger.log('Auto-discovering all available assets across exchanges...');
      this.symbols = await this.orchestrator.discoverCommonAssets();
      this.lastDiscoveryTime = now;
      this.logger.log(
        `Auto-discovery complete: Found ${this.symbols.length} common assets: ${this.symbols.join(', ')}`
      );
      return this.symbols;
    } catch (error: any) {
      this.logger.error(`Asset discovery failed: ${error.message}`);
      // Fallback to defaults if discovery fails
      if (this.symbols.length === 0) {
        this.symbols = ['ETH', 'BTC'];
        this.logger.warn(`Using fallback symbols: ${this.symbols.join(', ')}`);
      }
      return this.symbols;
    }
  }

  /**
   * Get next funding rate payment time
   * Hyperliquid (and most exchanges) pay funding every hour on the hour (14:00, 15:00, 16:00, etc.)
   * This computes the next payment time based on the global clock hour
   */
  private getNextFundingPaymentTime(): Date {
    const now = new Date();
    const nextPayment = new Date(now);
    
    // Set to next hour at :00:00
    nextPayment.setHours(now.getHours() + 1, 0, 0, 0);
    
    return nextPayment;
  }

  /**
   * Execute at funding rate payment times
   * Hyperliquid (and most exchanges) pay funding every hour on the hour (14:00, 15:00, 16:00, etc.)
   * This cron runs at :00 of every hour to align with actual funding payments
   * 
   * Cron format: '0 * * * *' = every hour at :00 minutes
   */
  @Cron('0 * * * *') // Every hour at :00 (e.g., 14:00, 15:00, 16:00)
  async executeHourly() {
    const nextPayment = this.getNextFundingPaymentTime();
    const msUntilPayment = nextPayment.getTime() - Date.now();
    const minutesUntil = Math.floor(msUntilPayment / 1000 / 60);
    const secondsUntil = Math.floor((msUntilPayment / 1000) % 60);
    
    this.logger.log(
      `⏰ Funding payment scheduled for ${nextPayment.toISOString()} ` +
      `(${minutesUntil}m ${secondsUntil}s from now)`
    );
    if (this.isRunning) {
      this.logger.warn('Previous execution still running, skipping this cycle');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log('Starting hourly funding rate arbitrage execution...');

      // Auto-discover all assets if not configured
      const symbols = await this.discoverAssetsIfNeeded();
      
      if (symbols.length === 0) {
        this.logger.warn('No assets found to compare, skipping execution');
        return;
      }

      // Check balances before proceeding
      await this.checkBalances();

      // Health check
      const healthCheck = await this.orchestrator.healthCheck();
      if (!healthCheck.healthy) {
        this.logger.warn('Exchanges not healthy, skipping execution');
        return;
      }

      // Find opportunities across ALL discovered assets (with progress bar)
      this.logger.log(`🔍 Searching for arbitrage opportunities across ${symbols.length} assets...`);
      const opportunities = await this.orchestrator.findArbitrageOpportunities(
        symbols,
        this.minSpread,
        true, // Show progress bar
      );

      this.logger.log(`Found ${opportunities.length} arbitrage opportunities`);

      // STEP 1: Close all existing positions to free up margin for rebalancing
      // This ensures we can use locked margin when rebalancing funds
      try {
        this.logger.log('🔍 Checking for existing positions to close before rebalancing...');
        const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();
        const allPositions = positionsResult.positions;
        if (allPositions.length > 0) {
          // CRITICAL: Detect single-leg positions first (positions without matching pair on another exchange)
          const singleLegPositions = this.detectSingleLegPositions(allPositions);
          if (singleLegPositions.length > 0) {
            this.logger.error(
              `🚨 CRITICAL: Detected ${singleLegPositions.length} single-leg position(s) with price exposure: ` +
                `${singleLegPositions.map((p) => `${p.symbol} (${p.side}) on ${p.exchangeType}`).join(', ')}. ` +
                `Closing these FIRST to prevent losses...`,
            );
            // Close single-leg positions first with progressive price improvement
            for (const position of singleLegPositions) {
              try {
                const adapter = this.keeperService.getExchangeAdapter(position.exchangeType);
                const closeSide = position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
                
                // Progressive price improvement: start with market, then try worse prices
                const priceImprovements = [0, 0.001, 0.005, 0.01, 0.02, 0.05]; // 0%, 0.1%, 0.5%, 1%, 2%, 5% worse
                let positionClosed = false;
                
                for (let attempt = 0; attempt < priceImprovements.length; attempt++) {
                  const priceImprovement = priceImprovements[attempt];
                  
                  try {
                    // Get current market price for limit orders (if not first attempt)
                    let limitPrice: number | undefined = undefined;
                    if (attempt > 0 && position.exchangeType === ExchangeType.LIGHTER) {
                      // For Lighter, get order book price and apply price improvement
                      try {
                        const markPrice = await adapter.getMarkPrice(position.symbol);
                        if (markPrice > 0) {
                          // For closing LONG: we SELL, so use bid price (worse = lower)
                          // For closing SHORT: we BUY, so use ask price (worse = higher)
                          if (position.side === OrderSide.LONG) {
                            limitPrice = markPrice * (1 - priceImprovement);
                          } else {
                            limitPrice = markPrice * (1 + priceImprovement);
                          }
                        }
                      } catch (priceError: any) {
                        // Fall back to market order
                      }
                    }
                    
                    const closeOrder = new PerpOrderRequest(
                      position.symbol,
                      closeSide,
                      limitPrice ? OrderType.LIMIT : OrderType.MARKET,
                      position.size,
                      limitPrice,
                      TimeInForce.IOC,
                      true, // Reduce only
                    );
                    
                    if (attempt === 0) {
                      this.logger.error(`   🚨 CRITICAL: Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType}...`);
                    } else {
                      this.logger.warn(
                        `   🔄 Retry ${attempt}/${priceImprovements.length - 1}: Closing ${position.symbol} with ` +
                        `${(priceImprovement * 100).toFixed(2)}% worse price`,
                      );
                    }
                    
                    const closeResponse = await adapter.placeOrder(closeOrder);
                    
                    // Wait and check if order filled
                    if (!closeResponse.isFilled() && closeResponse.orderId) {
                      const maxRetries = 5;
                      const pollIntervalMs = 2000;
                      
                      for (let pollAttempt = 0; pollAttempt < maxRetries; pollAttempt++) {
                        if (pollAttempt > 0) {
                          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                        }
                        
                        try {
                          const statusResponse = await adapter.getOrderStatus(closeResponse.orderId, position.symbol);
                          if (statusResponse.isFilled()) {
                            break;
                          }
                          if (statusResponse.status === OrderStatus.CANCELLED || statusResponse.error) {
                            break;
                          }
                        } catch (pollError: any) {
                          // Continue polling
                        }
                      }
                    }
                    
                    // Check if position is actually closed
                    await new Promise(resolve => setTimeout(resolve, 500));
                    const currentPositions = await adapter.getPositions();
                    const positionStillExists = currentPositions.some(
                      (p) =>
                        p.symbol === position.symbol &&
                        p.exchangeType === position.exchangeType &&
                        Math.abs(p.size) > 0.0001,
                    );
                    
                    if (closeResponse.isFilled() && !positionStillExists) {
                      positionClosed = true;
                      if (attempt > 0) {
                        this.logger.log(
                          `   ✅ Successfully closed single-leg position ${position.symbol} on attempt ${attempt + 1} ` +
                          `with ${(priceImprovement * 100).toFixed(2)}% worse price`,
                        );
                      } else {
                        this.logger.log(`   ✅ Successfully closed single-leg position: ${position.symbol} on ${position.exchangeType}`);
                      }
                      break; // Position closed successfully
                    }
                    
                    if (attempt < priceImprovements.length - 1) {
                      this.logger.warn(
                        `   ⚠️ Close order for ${position.symbol} didn't fill on attempt ${attempt + 1}, ` +
                        `trying with worse price...`,
                      );
                      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before next attempt
                    }
                  } catch (attemptError: any) {
                    this.logger.warn(
                      `   Error on close attempt ${attempt + 1} for ${position.symbol}: ${attemptError.message}`,
                    );
                    if (attempt === priceImprovements.length - 1) {
                      // Last attempt failed
                      break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                  }
                }
                
                if (!positionClosed) {
                  this.logger.error(
                    `   ❌ CRITICAL: Failed to close single-leg position ${position.symbol} on ${position.exchangeType} ` +
                    `after ${priceImprovements.length} attempts with progressive price improvement`,
                  );
                }
                
                await new Promise(resolve => setTimeout(resolve, 500));
              } catch (error: any) {
                this.logger.error(`   ❌ CRITICAL: Error closing single-leg position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
              }
            }
            
            // Remove single-leg positions from allPositions to avoid double-closing
            const singleLegSet = new Set(singleLegPositions.map(p => `${p.symbol}-${p.exchangeType}-${p.side}`));
            const remainingPositions = allPositions.filter(
              p => !singleLegSet.has(`${p.symbol}-${p.exchangeType}-${p.side}`)
            );
            
            if (remainingPositions.length === 0) {
              this.logger.log('✅ All positions were single-leg and have been closed');
              await new Promise(resolve => setTimeout(resolve, 2000));
              return; // No other positions to close
            }
            
            this.logger.log(`📋 Found ${remainingPositions.length} additional position(s) to close...`);
            for (const position of remainingPositions) {
              try {
                const adapter = this.keeperService.getExchangeAdapter(position.exchangeType);
                const closeOrder = new PerpOrderRequest(
                  position.symbol,
                  position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
                  OrderType.MARKET,
                  position.size,
                  0, // No limit price for market orders
                  TimeInForce.IOC, // Immediate or cancel
                  true, // Reduce only
                );
                
                this.logger.log(`   Closing ${position.symbol} on ${position.exchangeType}...`);
                let closeResponse = await adapter.placeOrder(closeOrder);
                
                // Wait and retry if order didn't fill immediately
                if (!closeResponse.isFilled() && closeResponse.orderId) {
                  this.logger.log(`   ⏳ Order not filled immediately, polling for fill...`);
                  const maxRetries = 5;
                  const pollIntervalMs = 2000;
                  
                  for (let attempt = 0; attempt < maxRetries; attempt++) {
                    if (attempt > 0) {
                      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                    }
                    
                    try {
                      const statusResponse = await adapter.getOrderStatus(closeResponse.orderId, position.symbol);
                      if (statusResponse.isFilled()) {
                        closeResponse = statusResponse;
                        this.logger.log(`   ✅ Order filled on attempt ${attempt + 1}/${maxRetries}`);
                        break;
                      }
                      if (statusResponse.status === OrderStatus.CANCELLED || statusResponse.error) {
                        closeResponse = statusResponse;
                        break;
                      }
                      this.logger.debug(`   Order still ${statusResponse.status} (attempt ${attempt + 1}/${maxRetries})...`);
                    } catch (error: any) {
                      this.logger.warn(`   Failed to check order status (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);
                      if (attempt === maxRetries - 1) {
                        this.logger.warn(`   ⚠️ Could not verify order fill after ${maxRetries} attempts`);
                      }
                    }
                  }
                }
                
                if (closeResponse.isFilled()) {
                  this.logger.log(`   ✅ Successfully closed position: ${position.symbol} on ${position.exchangeType}`);
                } else {
                  this.logger.warn(`   ⚠️ Failed to close position ${position.symbol} on ${position.exchangeType}: ${closeResponse.error || 'order not filled'}`);
                }
                
                // Small delay between closes
                await new Promise(resolve => setTimeout(resolve, 500));
              } catch (error: any) {
                this.logger.warn(`   ⚠️ Error closing position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
              }
            }
          } else {
            this.logger.log(`📋 Found ${allPositions.length} existing position(s) - closing to free up margin...`);
            for (const position of allPositions) {
              try {
                const adapter = this.keeperService.getExchangeAdapter(position.exchangeType);
              const closeOrder = new PerpOrderRequest(
                position.symbol,
                position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
                OrderType.MARKET,
                position.size,
                0, // No limit price for market orders
                TimeInForce.IOC, // Immediate or cancel
                true, // Reduce only
              );
              
              this.logger.log(`   Closing ${position.symbol} on ${position.exchangeType}...`);
              let closeResponse = await adapter.placeOrder(closeOrder);
              
              // Wait and retry if order didn't fill immediately
              if (!closeResponse.isFilled() && closeResponse.orderId) {
                this.logger.log(`   ⏳ Order not filled immediately, polling for fill...`);
                const maxRetries = 5;
                const pollIntervalMs = 2000;
                
                for (let attempt = 0; attempt < maxRetries; attempt++) {
                  if (attempt > 0) {
                    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                  }
                  
                  try {
                    const statusResponse = await adapter.getOrderStatus(closeResponse.orderId, position.symbol);
                    if (statusResponse.isFilled()) {
                      closeResponse = statusResponse;
                      this.logger.log(`   ✅ Order filled on attempt ${attempt + 1}/${maxRetries}`);
                      break;
                    }
                    if (statusResponse.status === OrderStatus.CANCELLED || statusResponse.error) {
                      closeResponse = statusResponse;
                      break;
                    }
                    this.logger.debug(`   Order still ${statusResponse.status} (attempt ${attempt + 1}/${maxRetries})...`);
                  } catch (error: any) {
                    this.logger.warn(`   Failed to check order status (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);
                    if (attempt === maxRetries - 1) {
                      this.logger.warn(`   ⚠️ Could not verify order fill after ${maxRetries} attempts`);
                    }
                  }
                }
              }
              
              if (closeResponse.isFilled()) {
                this.logger.log(`   ✅ Successfully closed position: ${position.symbol} on ${position.exchangeType}`);
              } else {
                this.logger.warn(`   ⚠️ Failed to close position ${position.symbol} on ${position.exchangeType}: ${closeResponse.error || 'order not filled'}`);
              }
              
                // Small delay between closes
                await new Promise(resolve => setTimeout(resolve, 500));
              } catch (error: any) {
                this.logger.warn(`   ⚠️ Error closing position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
              }
            }
          }
          
          // Wait for positions to settle and margin to be freed
          this.logger.log('⏳ Waiting 2 seconds for positions to settle and margin to be freed...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          this.logger.log('✅ No existing positions to close');
        }
      } catch (error: any) {
        this.logger.warn(`Failed to close existing positions: ${error.message}`);
        // Continue anyway - rebalancing might still work
      }

      // STEP 2: Rebalance exchange balances based on opportunities
      // Move funds from exchanges without opportunities to exchanges with opportunities
      try {
        this.logger.log('🔄 Rebalancing exchange balances based on opportunities...');
        const rebalanceResult = await this.keeperService.rebalanceExchangeBalances(opportunities);
        if (rebalanceResult.transfersExecuted > 0) {
          this.logger.log(
            `✅ Rebalanced ${rebalanceResult.transfersExecuted} transfers, ` +
            `$${rebalanceResult.totalTransferred.toFixed(2)} total transferred ` +
            `(moved funds from inactive exchanges to active ones)`
          );
          if (rebalanceResult.errors.length > 0) {
            this.logger.warn(`⚠️ Rebalancing had ${rebalanceResult.errors.length} errors`);
          }
          
          // Wait a bit for transfers to settle before executing trades
          this.logger.log('⏳ Waiting 3 seconds for transfers to settle...');
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          this.logger.log('✅ Exchange balances are balanced, no rebalancing needed');
        }
      } catch (error: any) {
        this.logger.warn(`Failed to rebalance exchange balances: ${error.message}`);
        // Don't fail the entire execution if rebalancing fails
      }

      if (opportunities.length === 0) {
        this.logger.log('No opportunities found, skipping execution');
        return;
      }

      // Execute strategy across ALL discovered assets
      const result = await this.orchestrator.executeArbitrageStrategy(
        symbols,
        this.minSpread,
        this.maxPositionSizeUsd,
      );

      // Track arbitrage opportunities
      this.performanceLogger.recordArbitrageOpportunity(true, result.opportunitiesExecuted > 0);
      if (result.opportunitiesExecuted > 0) {
        this.performanceLogger.recordArbitrageOpportunity(false, true);
      }

      // Update position metrics with current funding rates
      await this.updatePerformanceMetrics();

      const duration = Date.now() - startTime;

      this.logger.log(
        `Execution completed in ${duration}ms: ` +
        `${result.opportunitiesExecuted}/${result.opportunitiesEvaluated} opportunities executed, ` +
        `Expected return: $${result.totalExpectedReturn.toFixed(2)}, ` +
        `Orders placed: ${result.ordersPlaced}`,
      );

      if (result.errors.length > 0) {
        this.logger.warn(`Execution had ${result.errors.length} errors:`, result.errors);
      }
    } catch (error: any) {
      this.logger.error(`Hourly execution failed: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Update performance metrics with current positions and funding rates
   */
  private async updatePerformanceMetrics(): Promise<void> {
    try {
      const positions = await this.keeperService.getAllPositions();
      
      // Only get funding rates for symbols that have positions (not all discovered symbols)
      // This prevents excessive API calls that cause rate limiting
      const symbolsWithPositions = new Set(positions.map(p => p.symbol));
      const allFundingRates: Array<{ symbol: string; exchange: ExchangeType; fundingRate: number }> = [];
      
      // Only fetch funding rates for symbols with active positions
      for (const symbol of symbolsWithPositions) {
        try {
          const comparison = await this.orchestrator.compareFundingRates(symbol);
          if (comparison && comparison.rates) {
            // Flatten funding rates from comparison
            for (const rate of comparison.rates) {
              allFundingRates.push({
                symbol: rate.symbol,
                exchange: rate.exchange,
                fundingRate: rate.currentRate, // Use currentRate from ExchangeFundingRate
              });
            }
          }
        } catch (error) {
          // Skip if we can't get funding rates for this symbol
        }
      }

      // Group positions by exchange
      const positionsByExchange = new Map();
      for (const position of positions) {
        const exchangePositions = positionsByExchange.get(position.exchangeType) || [];
        exchangePositions.push(position);
        positionsByExchange.set(position.exchangeType, exchangePositions);
      }

      // Update metrics for each exchange
      for (const [exchange, exchangePositions] of positionsByExchange.entries()) {
        // Filter funding rates for this exchange
        const exchangeFundingRates = allFundingRates.filter(
          (rate) => rate.exchange === exchange
        );
        this.performanceLogger.updatePositionMetrics(exchange, exchangePositions, exchangeFundingRates);
      }
    } catch (error: any) {
      this.logger.error(`Failed to update performance metrics: ${error.message}`);
    }
  }

  /**
   * Log comprehensive performance metrics every 5 minutes
   */
  @Interval(5 * 60 * 1000) // Every 5 minutes
  async logPerformanceMetrics() {
    try {
      await this.updatePerformanceMetrics();
      
      // Get total capital deployed (sum of all balances)
      let totalCapital = 0;
      for (const exchangeType of ['ASTER', 'LIGHTER', 'HYPERLIQUID'] as any[]) {
        try {
          const balance = await this.keeperService.getBalance(exchangeType);
          totalCapital += balance;
        } catch (error) {
          // Skip if we can't get balance
        }
      }

      this.performanceLogger.logPerformanceMetrics(totalCapital);
    } catch (error: any) {
      this.logger.error(`Failed to log performance metrics: ${error.message}`);
    }
  }

  /**
   * Log compact performance summary every minute
   */
  @Interval(60 * 1000) // Every minute
  async logCompactSummary() {
    try {
      // Update metrics first to ensure we have current data
      await this.updatePerformanceMetrics();
      
      // Get total capital deployed
      let totalCapital = 0;
      for (const exchangeType of ['ASTER', 'LIGHTER', 'HYPERLIQUID'] as any[]) {
        try {
          const balance = await this.keeperService.getBalance(exchangeType);
          totalCapital += balance;
        } catch (error) {
          // Skip if we can't get balance
        }
      }

      this.performanceLogger.logCompactSummary(totalCapital);
    } catch (error: any) {
      // Silently fail for compact summary to avoid spam
      this.logger.debug(`Failed to log compact summary: ${error.message}`);
    }
  }

  /**
   * Manual trigger for testing
   */
  async executeManually(): Promise<void> {
    await this.executeHourly();
  }

  /**
   * Check balances across all exchanges and warn if insufficient
   * Also checks for unallocated USDC that could be deployed
   */
  private async checkBalances(): Promise<void> {
    const minBalanceForTrading = 10; // Minimum $10 needed per exchange to cover fees
    // Only check exchanges that have adapters available
    const adapters = this.keeperService.getExchangeAdapters();
    const exchanges = Array.from(adapters.keys());
    
    if (exchanges.length === 0) {
      this.logger.warn('⚠️  No exchange adapters available - cannot check balances');
      return;
    }
    
    this.logger.log('💰 Checking exchange balances and capital allocation...');
    
    // Get all positions to calculate margin used
    const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();
    const positionsByExchange = positionsResult.positionsByExchange;
    
    // Calculate margin used per exchange (position value / leverage)
    const leverage = parseFloat(this.configService.get<string>('KEEPER_LEVERAGE') || '2.0');
    const marginUsedPerExchange = new Map<ExchangeType, number>();
    
    for (const [exchangeType, positions] of positionsByExchange) {
      const totalMarginUsed = positions.reduce((sum, pos) => {
        // Use marginUsed if available, otherwise calculate as positionValue / leverage
        const margin = pos.marginUsed ?? (pos.getPositionValue() / leverage);
        return sum + margin;
      }, 0);
      marginUsedPerExchange.set(exchangeType, totalMarginUsed);
    }
    
    const balances: Array<{ 
      exchange: ExchangeType; 
      balance: number; 
      marginUsed: number;
      totalCapital: number;
      unallocated: number;
      canTrade: boolean;
    }> = [];
    
    for (const exchange of exchanges) {
      try {
        const freeBalance = await this.keeperService.getBalance(exchange);
        const marginUsed = marginUsedPerExchange.get(exchange) ?? 0;
        const totalCapital = freeBalance + marginUsed;
        const unallocated = freeBalance;
        const canTrade = freeBalance >= minBalanceForTrading;
        
        balances.push({ exchange, balance: freeBalance, marginUsed, totalCapital, unallocated, canTrade });
        
        const status = canTrade ? '✅' : '⚠️';
        this.logger.log(
          `   ${status} ${exchange}:\n` +
          `      Free Balance: $${freeBalance.toFixed(2)}\n` +
          `      Margin Used: $${marginUsed.toFixed(2)}\n` +
          `      Total Capital: $${totalCapital.toFixed(2)}\n` +
          `      Unallocated: $${unallocated.toFixed(2)} ${canTrade ? '(can trade)' : `(need $${minBalanceForTrading}+)`}`
        );
        
        // For HyperLiquid, also log equity to see total account value
        if (exchange === ExchangeType.HYPERLIQUID) {
          try {
            const equity = await this.keeperService.getEquity(exchange);
            this.logger.log(`      Equity: $${equity.toFixed(2)} (account value)`);
          } catch (e) {
            // Ignore equity fetch errors
          }
        }
      } catch (error: any) {
        this.logger.warn(`   ❌ ${exchange}: Failed to check balance - ${error.message}`);
        balances.push({ exchange, balance: 0, marginUsed: 0, totalCapital: 0, unallocated: 0, canTrade: false });
      }
    }
    
    // Calculate totals
    const tradableExchanges = balances.filter(b => b.canTrade).length;
    const totalFreeBalance = balances.reduce((sum, b) => sum + b.balance, 0);
    const totalMarginUsed = balances.reduce((sum, b) => sum + b.marginUsed, 0);
    const totalCapitalOnExchanges = balances.reduce((sum, b) => sum + b.totalCapital, 0);
    const totalUnallocatedOnExchanges = totalFreeBalance;
    const minBalance = Math.min(...balances.map(b => b.balance).filter(b => b > 0));
    
    // Check wallet USDC balance on-chain
    let walletUsdcBalance = 0;
    let walletAddress: string | null = null;
    try {
      walletUsdcBalance = await this.getWalletUsdcBalance();
      if (walletUsdcBalance > 0) {
        // Get wallet address for logging
        const privateKey = this.configService.get<string>('PRIVATE_KEY');
        if (privateKey) {
          const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
          const wallet = new Wallet(normalizedKey);
          walletAddress = wallet.address;
        }
      }
    } catch (error: any) {
      this.logger.debug(`Failed to check wallet USDC balance: ${error.message}`);
    }
    
    // Calculate total capital (on exchanges + in wallet)
    const totalCapitalAll = totalCapitalOnExchanges + walletUsdcBalance;
    const totalDeployed = totalMarginUsed;
    const totalUnallocatedAll = totalFreeBalance + walletUsdcBalance;
    
    this.logger.log(`\n   📊 Capital Summary:`);
    this.logger.log(`      On Exchanges:`);
    this.logger.log(`         Free Balance: $${totalFreeBalance.toFixed(2)}`);
    this.logger.log(`         Margin Used: $${totalMarginUsed.toFixed(2)}`);
    this.logger.log(`         Total on Exchanges: $${totalCapitalOnExchanges.toFixed(2)}`);
    if (walletUsdcBalance > 0) {
      this.logger.log(`      In Wallet (${walletAddress ? walletAddress.slice(0, 10) + '...' : 'on-chain'}):`);
      this.logger.log(`         USDC Balance: $${walletUsdcBalance.toFixed(2)}`);
    }
    this.logger.log(`      Total Capital: $${totalCapitalAll.toFixed(2)}`);
    this.logger.log(`      Total Deployed: $${totalDeployed.toFixed(2)}`);
    this.logger.log(`      Total Unallocated: $${totalUnallocatedAll.toFixed(2)}`);
    
    if (minBalance > 0) {
      this.logger.log(`      Minimum balance (limits position size): $${minBalance.toFixed(2)}`);
    }
    
    // Check for significant unallocated capital (on exchanges + in wallet)
    const unallocatedThreshold = 50; // Warn if more than $50 unallocated
    if (totalUnallocatedAll > unallocatedThreshold) {
      const allocationPercent = totalCapitalAll > 0 ? (totalDeployed / totalCapitalAll) * 100 : 0;
      const walletPercent = totalCapitalAll > 0 ? (walletUsdcBalance / totalCapitalAll) * 100 : 0;
      
      this.logger.warn(
        `⚠️  UNALLOCATED CAPITAL DETECTED: $${totalUnallocatedAll.toFixed(2)} unallocated USDC ` +
        `(${allocationPercent.toFixed(1)}% deployed, ${(100 - allocationPercent).toFixed(1)}% idle)`
      );
      
      if (walletUsdcBalance > 10) {
        this.logger.warn(
          `   💰 Wallet has $${walletUsdcBalance.toFixed(2)} USDC (${walletPercent.toFixed(1)}% of total) - ` +
          `consider depositing to exchanges to deploy capital`
        );
      }
      
      if (totalUnallocatedOnExchanges > 10) {
        this.logger.warn(
          `   📊 Exchanges have $${totalUnallocatedOnExchanges.toFixed(2)} free balance - ` +
          `consider increasing position sizes or rebalancing`
        );
      }
    } else if (totalUnallocatedAll > 0) {
      const allocationPercent = totalCapitalAll > 0 ? (totalDeployed / totalCapitalAll) * 100 : 0;
      this.logger.log(
        `✅ Capital allocation: $${totalUnallocatedAll.toFixed(2)} unallocated ` +
        `(${allocationPercent.toFixed(1)}% deployed)`
      );
    }
    
    if (tradableExchanges < 2) {
      this.logger.warn(
        `⚠️  INSUFFICIENT BALANCE: Need at least $${minBalanceForTrading} on 2+ exchanges to execute arbitrage. ` +
        `Currently have tradable balance on ${tradableExchanges} exchange(s). ` +
        `The bot will use whatever balance is available (minimum $${minBalanceForTrading} per exchange).`
      );
    } else {
      this.logger.log(
        `✅ Ready for arbitrage: ${tradableExchanges} exchange(s) have sufficient balance. ` +
        `Position size will be limited by minimum balance: $${minBalance.toFixed(2)}`
      );
    }
    
    this.logger.log('');
  }

  /**
   * Periodic wallet balance check - runs every 10 minutes
   * Checks for new USDC in wallet and deposits to exchanges if needed
   */
  @Interval(600000) // Every 10 minutes (600000 ms)
  async checkWalletBalancePeriodically() {
    try {
      this.logger.debug('🔍 Periodic wallet balance check (every 10 minutes)...');
      await this.checkAndDepositWalletFunds();
    } catch (error: any) {
      this.logger.debug(`Periodic wallet balance check failed: ${error.message}`);
    }
  }

  /**
   * Check wallet USDC balance and deposit to exchanges if available
   * This proactively deposits wallet funds to exchanges that need capital
   */
  private async checkAndDepositWalletFunds(): Promise<void> {
    try {
      const walletBalance = await this.getWalletUsdcBalance();
      if (walletBalance <= 0) {
        this.logger.debug('No USDC in wallet, skipping deposit');
        return;
      }

      this.logger.log(
        `💰 Found $${walletBalance.toFixed(2)} USDC in wallet, checking if deposits are needed...`,
      );

      // Get all exchange adapters
      const adapters = this.keeperService.getExchangeAdapters();
      if (adapters.size === 0) {
        this.logger.debug('No exchange adapters available, skipping deposit');
        return;
      }

      // Get current balances on all exchanges for logging
      const exchangeBalances = new Map<ExchangeType, number>();
      for (const [exchange, adapter] of adapters) {
        try {
          const balance = await adapter.getBalance();
          exchangeBalances.set(exchange, balance);
        } catch (error: any) {
          this.logger.debug(
            `Failed to get balance for ${exchange}: ${error.message}`,
          );
          exchangeBalances.set(exchange, 0);
        }
      }

      // Log current balances
      this.logger.log('Current exchange balances:');
      for (const [exchange, balance] of exchangeBalances) {
        this.logger.log(`  ${exchange}: $${balance.toFixed(2)}`);
      }

      // Distribute wallet funds equally to all exchanges (scalable approach)
      const exchangesToDeposit = Array.from(adapters.keys());
      if (exchangesToDeposit.length === 0) {
        this.logger.debug('No exchanges available for deposit');
        return;
      }

      // Distribute wallet funds equally to all exchanges
      let remainingWalletBalance = walletBalance;
      const amountPerExchange = walletBalance / exchangesToDeposit.length;

      this.logger.log(
        `📊 Distributing $${walletBalance.toFixed(2)} equally to ${exchangesToDeposit.length} exchange(s): ` +
        `$${amountPerExchange.toFixed(2)} per exchange`,
      );

      for (const exchange of exchangesToDeposit) {
        if (remainingWalletBalance <= 0) {
          break;
        }

        const adapter = adapters.get(exchange);
        if (!adapter) continue;

        const depositAmount = Math.min(amountPerExchange, remainingWalletBalance);
        if (depositAmount < 5) {
          // Minimum deposit is usually $5
          this.logger.debug(
            `Skipping deposit to ${exchange}: amount too small ($${depositAmount.toFixed(2)})`,
          );
          continue;
        }

        try {
          this.logger.log(
            `📥 Depositing $${depositAmount.toFixed(2)} from wallet to ${exchange}...`,
          );
          await adapter.depositExternal(depositAmount, 'USDC');
          this.logger.log(
            `✅ Successfully deposited $${depositAmount.toFixed(2)} to ${exchange}`,
          );
          remainingWalletBalance -= depositAmount;
          // Wait a bit between deposits to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error: any) {
          // Check if it's a 404 error (endpoint doesn't exist) - Aster may require on-chain deposits
          if (error.message?.includes('404') || error.message?.includes('on-chain')) {
            this.logger.warn(
              `⚠️ ${exchange} deposits may require on-chain transactions. ` +
              `Skipping deposit to ${exchange}. Funds remain in wallet. ` +
              `Error: ${error.message}`,
            );
            // Don't subtract from remaining balance - funds stay in wallet
            continue;
          }
          this.logger.warn(
            `Failed to deposit $${depositAmount.toFixed(2)} to ${exchange}: ${error.message}`,
          );
          // Don't subtract on error - funds remain in wallet for retry
        }
      }

      if (remainingWalletBalance < walletBalance) {
        const deposited = walletBalance - remainingWalletBalance;
        this.logger.log(
          `✅ Wallet deposit cycle complete: Deposited $${deposited.toFixed(2)} of $${walletBalance.toFixed(2)} total`,
        );
      }
    } catch (error: any) {
      this.logger.debug(
        `Error checking/depositing wallet funds: ${error.message}`,
      );
    }
  }

  /**
   * Get wallet USDC balance on-chain
   * Checks the wallet's USDC balance directly from the blockchain
   */
  private async getWalletUsdcBalance(): Promise<number> {
    try {
      // Get Arbitrum RPC URL (USDC deposits go through Arbitrum)
      const rpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL') || 
                     this.configService.get<string>('ARB_RPC_URL') ||
                     'https://arb1.arbitrum.io/rpc'; // Public Arbitrum RPC fallback
      const privateKey = this.configService.get<string>('PRIVATE_KEY');
      const walletAddress = this.configService.get<string>('WALLET_ADDRESS') || 
                           this.configService.get<string>('CENTRAL_WALLET_ADDRESS');
      
      if (!privateKey && !walletAddress) {
        this.logger.debug('No PRIVATE_KEY or WALLET_ADDRESS configured, skipping wallet balance check');
        return 0;
      }

      // USDC address on Arbitrum (matches deposit logic)
      const usdcAddress = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
      
      // ERC20 ABI (minimal)
      const erc20Abi = [
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ];

      // Initialize provider
      const provider = new JsonRpcProvider(rpcUrl);
      
      // Get wallet address
      let address: string;
      if (walletAddress) {
        address = walletAddress;
        this.logger.debug(`Using WALLET_ADDRESS from config: ${address}`);
      } else if (privateKey) {
        const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        const wallet = new Wallet(normalizedKey);
        address = wallet.address;
        this.logger.debug(`Derived address from PRIVATE_KEY: ${address}`);
      } else {
        return 0;
      }

      this.logger.log(
        `🔍 Checking USDC balance on Arbitrum for address: ${address} ` +
        `(USDC contract: ${usdcAddress})`,
      );

      // Check USDC balance
      const usdcContract = new Contract(usdcAddress, erc20Abi, provider);
      const balance = await usdcContract.balanceOf(address);
      const decimals = await usdcContract.decimals();
      const balanceUsd = parseFloat(formatUnits(balance, decimals));

      this.logger.log(
        `💰 USDC balance on Arbitrum for ${address}: $${balanceUsd.toFixed(2)} USDC`,
      );

      return balanceUsd;
    } catch (error: any) {
      this.logger.debug(`Failed to get wallet USDC balance on Arbitrum: ${error.message}`);
      return 0;
    }
  }
}


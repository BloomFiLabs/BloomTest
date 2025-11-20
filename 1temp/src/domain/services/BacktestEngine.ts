import { Portfolio } from '../entities/Portfolio';
import { Strategy, MarketData } from '../entities/Strategy';
import { Amount, Price } from '../value-objects';
import { Trade } from '../entities/Trade';
import { Position } from '../entities/Position';
import { PortfolioManager } from './PortfolioManager';
import { RiskCalculator } from './RiskCalculator';
import { DataAdapter, OHLCVData, TradeEvent } from '@infrastructure/adapters/data/DataAdapter';
import { ImpermanentLossCalculator } from '@shared/utils/ImpermanentLossCalculator';
import { CostCalculator } from '@shared/utils/CostCalculator';
import { PositionTracker } from '@shared/utils/PositionTracker';

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: Amount;
  strategies: Array<{
    strategy: Strategy;
    config: Record<string, unknown>;
    allocation: number;
  }>;
  dataAdapter: DataAdapter;
  slippageModel?: (trade: Trade) => Amount;
  gasCostModel?: (trade: Trade) => Amount;
  useRealFees?: boolean; // Use real fees from data adapter if available
  applyIL?: boolean; // Apply impermanent loss
  applyCosts?: boolean; // Apply slippage, gas costs, and rebalance costs
    costModel?: {
      slippageBps: number;
      gasCostUSD?: number; // Legacy - use gasModel instead
      gasModel?: {
        gasUnitsPerRebalance: number;
        gasPriceGwei?: number; // Optional - will fetch if network provided
        nativeTokenPriceUSD: number;
        network?: string; // Network name (e.g., 'base', 'mainnet')
      };
      poolFeeTier?: number; // Will be fetched from adapter if not provided
    };
}

export interface BacktestResult {
  finalPortfolio: Portfolio;
  trades: Trade[];
  positions: Position[];
  metrics: {
    finalValue: number;
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
  };
  historicalValues: number[];
  historicalReturns: number[];
  positionMetrics?: Map<string, any>; // Position tracking metrics
}

export class BacktestEngine {
  private portfolioManager: PortfolioManager;
  private riskCalculator: RiskCalculator;
  private costCalculator: CostCalculator;
  private positionEntryPrices: Map<string, Price> = new Map(); // Track entry prices for IL
  private positionTrackers: Map<string, PositionTracker> = new Map(); // Track position metrics
  private lastCheckTimes: Map<string, Date> = new Map(); // Track last check time for yield accrual
  private lastRecordTime: Date | null = null; // Track last portfolio value recording time
  private aprCache: Map<string, number> = new Map(); // Cache APR per asset to avoid repeated API calls
  private rebalanceCosts: Map<string, number> = new Map(); // Track cumulative rebalance costs per position
  private strategyFeeTiers: Map<string, number> = new Map(); // Per-strategy pool fee tiers

  constructor() {
    this.portfolioManager = new PortfolioManager();
    this.riskCalculator = new RiskCalculator();
    this.costCalculator = new CostCalculator({ slippageBps: 10, gasCostUSD: 50 });
  }

  async run(config: BacktestConfig): Promise<BacktestResult> {
    // Initialize portfolio
    const portfolio = Portfolio.create({
      id: 'backtest-portfolio',
      initialCapital: config.initialCapital,
    });

    // Set up allocation rules
    for (const strategyConfig of config.strategies) {
      this.portfolioManager.addAllocationRule({
        strategyId: strategyConfig.strategy.id,
        minAllocation: 0,
        maxAllocation: 1,
        targetAllocation: strategyConfig.allocation,
      });
    }

    const allTrades: Trade[] = [];
    const historicalValues: number[] = [config.initialCapital.value];
    const historicalReturns: number[] = [];

    // Pre-calculate APR for all assets once to avoid repeated API calls
    if (config.useRealFees && 'calculateActualAPR' in config.dataAdapter) {
      console.log('📈 Pre-calculating APR from fees...');
      for (const strategyConfig of config.strategies) {
        const asset = this.getAssetFromConfig(strategyConfig.config);
        if (!this.aprCache.has(asset)) {
          try {
            const apr = await (config.dataAdapter as any).calculateActualAPR(
              asset,
              config.startDate,
              config.endDate
            );
            this.aprCache.set(asset, apr);
            console.log(`   ${asset}: ${apr.toFixed(2)}% APR`);
          } catch (error) {
            console.warn(`   ⚠️  Could not calculate APR for ${asset}, using config defaults`);
            this.aprCache.set(asset, 0);
          }
        }
      }
      console.log('');
    }

    // Fetch pool fee tier for each strategy (they may have different pools/fee tiers)
    if (config.applyCosts && config.costModel) {
      try {
        const feeTiers: Map<string, number> = new Map();
        
        for (const strategyConfig of config.strategies) {
          const asset = this.getAssetFromConfig(strategyConfig.config);
          if (!feeTiers.has(asset)) {
            // Try to use per-strategy adapter first, then fall back to global adapter
            const strategyAdapter = (strategyConfig.config as any).dataAdapter || config.dataAdapter;
            
            if (strategyAdapter && 'fetchPoolFeeTier' in strategyAdapter) {
              const feeTier = await strategyAdapter.fetchPoolFeeTier(asset);
              feeTiers.set(asset, feeTier);
              console.log(`   Pool fee tier for ${asset}: ${(feeTier * 100).toFixed(2)}%`);
            }
          }
        }
        
        // Store fee tiers for later use (per-strategy)
        this.strategyFeeTiers = feeTiers;
        
        // Update cost calculator with a default pool fee tier (will be overridden per-strategy)
        if (!config.costModel.poolFeeTier && feeTiers.size > 0) {
          config.costModel.poolFeeTier = Array.from(feeTiers.values())[0];
        }
        this.costCalculator = new CostCalculator(config.costModel);
        
        // Inject cost model into strategy configs for optimization
        // Estimate gas cost per rebalance from cost calculator
        if (config.costModel.gasModel) {
          const estimatedGasCost = await this.costCalculator.estimateGasCostUSD();
          
          for (const strategyConfig of config.strategies) {
            const asset = this.getAssetFromConfig(strategyConfig.config);
            const allocation = strategyConfig.allocation || 0.25;
            const estimatedPositionValue = config.initialCapital.multiply(allocation).value;
            
            // Add cost model to strategy config if it supports it
            if (strategyConfig.config && typeof strategyConfig.config === 'object') {
              (strategyConfig.config as any).costModel = {
                gasCostPerRebalance: estimatedGasCost,
                poolFeeTier: config.costModel.poolFeeTier,
                positionValueUSD: estimatedPositionValue,
              };
            }
          }
        }
      } catch (error) {
        console.warn(`   ⚠️  Could not fetch pool fee tier:`, (error as Error).message);
      }
    }

    // Process trade events in batches to avoid memory issues
    // Instead of loading all events into memory, process them as they come
    console.log('📊 Processing trade events (streaming mode)...\n');
    
    let eventCount = 0;
    const BATCH_SIZE = 1000; // Process events in batches
    
    // Deduplicate assets - only fetch each asset's events once
    const uniqueAssets = new Set<string>();
    for (const strategyConfig of config.strategies) {
      const asset = this.getAssetFromConfig(strategyConfig.config);
      uniqueAssets.add(asset);
    }
    
    console.log(`   📋 Unique assets to process: ${Array.from(uniqueAssets).join(', ')}\n`);
    
    // Process each unique asset's events separately to avoid loading everything into memory
    for (const asset of uniqueAssets) {
      try {
        // Prefer hourly OHLCV data if available (more accurate for backtesting)
        if ('fetchHourlyOHLCV' in config.dataAdapter && typeof (config.dataAdapter as any).fetchHourlyOHLCV === 'function') {
          console.log(`   📊 Using hourly OHLCV data for ${asset}...`);
          const hourlyData = await (config.dataAdapter as any).fetchHourlyOHLCV(asset, config.startDate, config.endDate);
          
          if (hourlyData && hourlyData.length > 0) {
            console.log(`   ✅ Loaded ${hourlyData.length} hourly data points for ${asset}`);
            
            // Convert hourly OHLCV to trade events
            for (const dataPoint of hourlyData) {
              if (dataPoint.close && dataPoint.close.value > 0 && !isNaN(dataPoint.close.value)) {
                const event: TradeEvent = {
                  timestamp: dataPoint.timestamp,
                  price: dataPoint.close,
                  volume: dataPoint.volume,
                  type: 'simulated',
                };
                await this.processTradeEvent(event, asset, portfolio, config, allTrades, historicalValues, historicalReturns);
                eventCount++;
              }
            }
            continue; // Skip to next asset
          } else {
            console.warn(`   ⚠️  No hourly data found for ${asset}, falling back to trade events...`);
          }
        }
        
        // Fallback: Try fetchTradeEvents if available
        if (config.dataAdapter.fetchTradeEvents) {
          // Fetch events in batches and process immediately
          const events = await config.dataAdapter.fetchTradeEvents(asset, config.startDate, config.endDate);
          
          // Sort events by timestamp
          events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          
          console.log(`   Processing ${events.length} events for ${asset}...`);
          
          if (events.length === 0) {
            console.warn(`   ⚠️  No trade events found for ${asset}, trying daily OHLCV fallback...`);
          } else {
            // Process events in batches
            for (let i = 0; i < events.length; i += BATCH_SIZE) {
              const batch = events.slice(i, Math.min(i + BATCH_SIZE, events.length));
              
              for (const event of batch) {
                await this.processTradeEvent(event, asset, portfolio, config, allTrades, historicalValues, historicalReturns);
                
                eventCount++;
                if (eventCount % 10000 === 0) {
                  process.stdout.write(`\r⏳ Processed ${eventCount} events...`);
                }
              }
            }
            continue; // Skip to next asset if we successfully processed events
          }
        }
        
        // Final fallback: use daily OHLCV data
        {
          // Fallback: use hourly OHLCV data if available, otherwise daily
          console.log(`   ⚠️  Adapter doesn't support fetchTradeEvents, using OHLCV simulation`);
          
          // Try hourly first if available
          let allData: OHLCVData[] = [];
          if ('fetchHourlyOHLCV' in config.dataAdapter && typeof (config.dataAdapter as any).fetchHourlyOHLCV === 'function') {
            try {
              allData = await (config.dataAdapter as any).fetchHourlyOHLCV(asset, config.startDate, config.endDate);
              console.log(`   ✅ Using hourly OHLCV data (${allData.length} hours)`);
            } catch (error) {
              console.warn(`   ⚠️  Hourly fetch failed, falling back to daily:`, (error as Error).message);
            }
          }
          
          // Fallback to daily if hourly not available or failed
          if (allData.length === 0) {
            allData = await config.dataAdapter.fetchOHLCV(asset, config.startDate, config.endDate);
            console.log(`   ✅ Using daily OHLCV data (${allData.length} days)`);
          }
          
          // Process each data point as a trade event
          for (const dataPoint of allData) {
            if (dataPoint.close && dataPoint.close.value > 0 && !isNaN(dataPoint.close.value)) {
              const event: TradeEvent = {
                timestamp: dataPoint.timestamp,
                price: dataPoint.close,
                volume: dataPoint.volume,
                type: 'simulated',
              };
              await this.processTradeEvent(event, asset, portfolio, config, allTrades, historicalValues, historicalReturns);
              eventCount++;
            }
          }
        }
      } catch (error) {
        console.warn(`   ⚠️  Failed to process trade events for ${asset}:`, (error as Error).message);
      }
    }
    
    console.log(`\n✅ Processed ${eventCount} trade events total\n`);
    
    // Calculate final metrics
    const finalValue = portfolio.totalValue().value;
    const totalReturn = ((finalValue - config.initialCapital.value) / config.initialCapital.value) * 100;
    const metrics = this.riskCalculator.calculateRiskMetrics(
      portfolio,
      historicalValues,
      historicalReturns
    );

    // Collect position metrics
    const positionMetrics = new Map<string, any>();
    for (const [positionId, tracker] of this.positionTrackers.entries()) {
      const position = portfolio.positions.find(p => p.id === positionId);
      if (position && tracker) {
        const strategyConfig = config.strategies.find(s => s.strategy.id === position.strategyId);
        if (strategyConfig) {
          const marketData = portfolio.positions.length > 0 ? {
            price: position.currentPrice,
            volume: undefined,
            timestamp: config.endDate,
            iv: undefined,
            fundingRate: undefined,
          } : undefined;
          
          if (marketData) {
            const calculateIL = (entry: Price, current: Price) => {
              return ImpermanentLossCalculator.calculateIL(entry, current);
            };
            const metrics = tracker.getMetrics(calculateIL);
            if (metrics) {
              // Add rebalance costs to metrics
              const totalRebalanceCosts = this.rebalanceCosts.get(positionId) || 0;
              (metrics as any).totalRebalanceCosts = totalRebalanceCosts;
              positionMetrics.set(positionId, metrics);
            }
          }
        }
      }
    }

    // Calculate total rebalance costs across all positions
    let totalRebalanceCosts = 0;
    for (const cost of this.rebalanceCosts.values()) {
      totalRebalanceCosts += cost;
    }

    return {
      finalPortfolio: portfolio,
      trades: allTrades,
      positions: portfolio.positions,
      metrics: {
        finalValue,
        totalReturn,
        sharpeRatio: metrics.sharpeRatio,
        maxDrawdown: metrics.maxDrawdown,
        totalRebalanceCosts,
      },
      historicalValues,
      historicalReturns,
      positionMetrics,
    };
  }

  /**
   * Process a single trade event
   */
  private async processTradeEvent(
    event: TradeEvent,
    asset: string,
    portfolio: Portfolio,
    config: BacktestConfig,
    allTrades: Trade[],
    historicalValues: number[],
    historicalReturns: number[]
  ): Promise<void> {
    // Validate price before processing
    if (!event.price || isNaN(event.price.value) || event.price.value <= 0) {
      return; // Skip events with invalid prices
    }
    
    const marketDataMap = new Map<string, MarketData>();
    marketDataMap.set(asset, {
      price: event.price,
      volume: event.volume,
      timestamp: event.timestamp,
      iv: undefined,
      fundingRate: undefined,
    });

    // Execute strategies
    for (const strategyConfig of config.strategies) {
      const strategyAsset = this.getAssetFromConfig(strategyConfig.config);
      const marketData = marketDataMap.get(strategyAsset);
      if (!marketData) continue;

        try {
          const result = await strategyConfig.strategy.execute(
            portfolio,
            marketData,
            strategyConfig.config
          );

          // Apply slippage (but NOT gas costs yet)
          for (const trade of result.trades) {
            let finalTrade = trade;
            
            // Update cost calculator if custom model provided (already done at start, but ensure it's current)
            if (config.applyCosts && config.costModel) {
              // Cost calculator is already initialized with pool fee tier at start
              // Just ensure it's using the latest config
              this.costCalculator = new CostCalculator({
                slippageBps: config.costModel.slippageBps,
                gasCostUSD: config.costModel.gasCostUSD,
                gasModel: config.costModel.gasModel,
                poolFeeTier: config.costModel.poolFeeTier,
              });
            }
            
            // Apply slippage only
            if (config.applyCosts && config.costModel) {
              const slippage = this.costCalculator.calculateSlippage(trade);
              const slippagePrice = this.costCalculator.applySlippageToPrice(trade);
              finalTrade = Trade.create({
                id: trade.id,
                strategyId: trade.strategyId,
                asset: trade.asset,
                side: trade.side,
                amount: trade.amount,
                price: slippagePrice,
                timestamp: trade.timestamp,
                fees: trade.fees,
                slippage: slippage,
              });
            }
            
            allTrades.push(finalTrade);
          }

          // Execute trades (deducts cash, NO gas costs yet)
          this.portfolioManager.allocate(portfolio, result.trades);
          
          // Update positions from strategy result
          for (const position of result.positions) {
            const existingPosition = portfolio.positions.find(
              (p) => p.strategyId === position.strategyId && p.asset === position.asset
            );
            
            if (existingPosition) {
              // Update existing position
              portfolio.updatePosition(position);
            } else {
              // Add new position WITHOUT cost (cash already deducted via trades)
              // Initialize position tracker with validated price
              const entryPrice = this.positionEntryPrices.get(position.id) || marketData.price;
              
              // CRITICAL: Validate entry price before initializing tracker
              if (!entryPrice || isNaN(entryPrice.value) || entryPrice.value <= 0) {
                console.warn(`⚠️  Skipping position initialization - invalid entry price: ${entryPrice?.value}`);
                continue; // Skip this position entirely
              }
              
              const tracker = new PositionTracker();
              tracker.initialize(event.timestamp, entryPrice);
              this.positionTrackers.set(position.id, tracker);
              this.lastCheckTimes.set(position.id, event.timestamp);
              
              // Track the market price as entry price for IL calculation
              const strategyConfig = config.strategies.find(s => s.strategy.id === position.strategyId);
              if (strategyConfig && marketData) {
                this.positionEntryPrices.set(position.id, marketData.price);
              } else {
                this.positionEntryPrices.set(position.id, position.entryPrice);
              }
              portfolio.addPosition(position);
            }
          }

          // Track rebalancing events and apply costs
          if (result.shouldRebalance && result.rebalanceReason) {
            const position = result.positions[0];
            if (position) {
              const tracker = this.positionTrackers.get(position.id);
              if (tracker) {
                const entryPrice = this.positionEntryPrices.get(position.id) || marketData.price;
                tracker.recordRebalance(
                  event.timestamp,
                  result.rebalanceReason,
                  entryPrice,
                  marketData.price
                );
                
                
                // Apply rebalance costs (gas + pool fees) if enabled
                if (config.applyCosts && config.costModel) {
                  // Get the correct pool fee tier for this strategy's asset
                  const strategyAsset = this.getAssetFromConfig(strategyConfig.config);
                  const poolFeeTier = this.strategyFeeTiers.get(strategyAsset) || config.costModel.poolFeeTier || 0.003;
                  
                  // Create a cost calculator with the correct pool fee tier for this strategy
                  const strategyCostCalculator = new CostCalculator({
                    ...config.costModel,
                    poolFeeTier,
                  });
                  
                  const rebalanceCost = await strategyCostCalculator.estimateTotalRebalanceCost(position, marketData.price);
                  const costValue = rebalanceCost.value;
                  
                  
                  // Deduct cost from portfolio cash using temporary position pattern
                  if (portfolio.cash.value >= costValue) {
                    const tempPosition = Position.create({
                      id: `rebalance-cost-${position.id}-${Date.now()}`,
                      strategyId: position.strategyId,
                      asset: position.asset,
                      amount: Amount.zero(),
                      entryPrice: Price.create(1),
                      currentPrice: Price.create(1),
                    });
                    
                    try {
                      portfolio.addPosition(tempPosition, rebalanceCost);
                      portfolio.removePosition(tempPosition.id);
                      
                      // Track cumulative costs per position
                      const currentCosts = this.rebalanceCosts.get(position.id) || 0;
                      this.rebalanceCosts.set(position.id, currentCosts + costValue);
                    } catch (error) {
                      console.warn(`⚠️  Failed to deduct rebalance cost: $${costValue.toFixed(2)}`, (error as Error).message);
                    }
                  } else {
                    console.warn(`⚠️  Insufficient cash for rebalance cost: $${costValue.toFixed(2)} (have $${portfolio.cash.value.toFixed(2)})`);
                  }
                }
                
                // Update entry price after rebalance
                this.positionEntryPrices.set(position.id, marketData.price);
              }
            }
          }
        } catch (error) {
          console.error(`Error executing strategy ${strategyConfig.strategy.id}:`, error);
        }
      }

      // Update position prices and accrue yield
      for (const position of portfolio.positions) {
        // Try to find market data
        let marketData = marketDataMap.get(position.asset);
        if (!marketData) {
          const asset = position.asset.split('-')[0];
          marketData = marketDataMap.get(asset);
        }
        if (!marketData) {
          const strategyConfig = config.strategies.find(s => s.strategy.id === position.strategyId);
          if (strategyConfig) {
            const pairAsset = this.getAssetFromConfig(strategyConfig.config);
            marketData = marketDataMap.get(pairAsset);
          }
        }
        
        // Skip if we don't have valid market data for this position
        if (!marketData || !marketData.price || isNaN(marketData.price.value) || marketData.price.value <= 0) {
          continue; // Skip this position update if no valid price data
        }
        
        // For LP positions (pairs) OR stablecoins, use price = 1.0 for VALUATION
        // But use the actual market price for REBALANCE CHECKS
        const isPairPosition = position.asset.includes('-');
        const isStable = ['USDC', 'USDT', 'DAI', 'USD'].includes(position.asset.toUpperCase());
        const positionPrice = (isPairPosition || isStable) ? Price.create(1.0) : marketData.price;
        
        // For range checks, always use the ACTUAL MARKET PRICE (not LP token price)
        const marketPriceForRangeCheck = marketData.price;
        
        let updatedPosition = position.updatePrice(positionPrice);
        
        // Track position metrics
        const tracker = this.positionTrackers.get(position.id);
        if (tracker && marketData) {
          const strategyConfig = config.strategies.find(s => s.strategy.id === position.strategyId);
          if (strategyConfig) {
            const rangeWidth = (strategyConfig.config as any).rangeWidth || 0.05;
            // Use the CURRENT CENTER PRICE (last rebalance point) to determine if price is in range
            // For LP positions, this is the underlying asset price (ETH), not the LP token price
            // positionEntryPrices stores the market price at last rebalance
            const centerPrice =
              this.positionEntryPrices.get(position.id) ||
              tracker.getOriginalEntryPrice() ||
              marketPriceForRangeCheck;
            const priceChange = Math.abs(marketPriceForRangeCheck.percentageChange(centerPrice));
            const inRange = priceChange <= rangeWidth * 100;
            
            
            // Calculate fees earned this day (only when in range)
            let feesEarned = 0;
            let expectedDailyFee = 0;
            if (inRange) {
              // Calculate expected daily fee from APR
              let expectedYield = strategyConfig.strategy.calculateExpectedYield(
                strategyConfig.config,
                marketData
              );
              
              // Use real APR if available
              if (config.useRealFees && this.aprCache.has(position.asset)) {
                const realAPR = this.aprCache.get(position.asset)!;
                if (realAPR > 0) {
                  const volatileConfig = strategyConfig.config as any;
                  const ammFeeAPR = realAPR;
                  const incentiveAPR = volatileConfig.incentiveAPR || 0;
                  const fundingAPR = volatileConfig.fundingAPR || 0;
                  expectedYield = { value: ammFeeAPR + incentiveAPR + fundingAPR } as any;
                }
              }
              
              const positionValue = updatedPosition.marketValue().value;
              const hourlyYieldRate = (expectedYield.value / 100) / (365 * 24);
              
              // Apply concentration multiplier for narrow ranges
              // Formula: multiplier = (fullRange / strategyRange)^1.5
              // For ±0.5% in a typical ±5% full range pool: (0.05 / 0.005)^1.5 ≈ 3.16x
              const fullRangeWidth = 0.05; // Assume typical full-range LP is ±5%
              const concentrationMultiplier = Math.pow(fullRangeWidth / rangeWidth, 1.5);
              // Apply efficiency factor (not all volume routes through our range)
              const efficiencyFactor = 0.65; // 65% efficiency
              
              // Apply fee dilution factor based on pool share
              // Get pool-specific TVL from strategy config
              const poolTVL = (strategyConfig.config as any)?.costModel?.poolTVL || config.costModel?.poolTVL || 180_000_000;
              const positionShare = Math.min(1.0, positionValue / poolTVL);
              
              // Extreme dilution model (same as yield accrual)
              let dilutionFactor = 1.0;
              if (positionShare > 0.2) {
                dilutionFactor = Math.max(0.01, Math.pow(1 - positionShare, 3) + 0.01);
              }
              
              const effectiveMultiplier = concentrationMultiplier * efficiencyFactor * dilutionFactor;
              
              feesEarned = positionValue * hourlyYieldRate * effectiveMultiplier;
              expectedDailyFee = feesEarned * 24; // Expected daily fee = hourly * 24
            }
            
            // Calculate time since last check for yield accrual
            const lastCheck = this.lastCheckTimes.get(position.id) || event.timestamp;
            const hoursSinceLastCheck = Math.max(0.0001, (event.timestamp.getTime() - lastCheck.getTime()) / (60 * 60 * 1000));
            
            // Validate price before recording
            if (!marketData.price || isNaN(marketData.price.value) || marketData.price.value <= 0) {
              continue; // Skip invalid prices
            }
            
            // Adjust fees earned based on actual time elapsed
            if (feesEarned !== undefined && !isNaN(feesEarned)) {
              feesEarned = feesEarned * hoursSinceLastCheck;
            }
            
            tracker.recordHour(event.timestamp, marketData.price, inRange, rangeWidth, feesEarned, expectedDailyFee, hoursSinceLastCheck);
            this.lastCheckTimes.set(position.id, event.timestamp);
          }
        }
        
        // Apply impermanent loss for LP positions
        if (config.applyIL && isPairPosition && marketData) {
          const entryPrice = this.positionEntryPrices.get(position.id);
          if (entryPrice) {
            // Calculate IL based on price change of underlying asset (ETH)
            const ilPercent = ImpermanentLossCalculator.calculateIL(entryPrice, marketData.price);
            
            // Track IL
            if (tracker) {
              tracker.recordIL(ilPercent);
            }
            
            const currentValue = updatedPosition.marketValue();
            // IL multiplier: 1 + (ilPercent / 100)
            // ilPercent is negative for losses, so this reduces value
            const ilMultiplier = 1 + (ilPercent / 100);
            const ilAdjustedAmount = updatedPosition.amount.multiply(Math.max(0.1, ilMultiplier));
            updatedPosition = Position.create({
              id: updatedPosition.id,
              strategyId: updatedPosition.strategyId,
              asset: updatedPosition.asset,
              amount: ilAdjustedAmount,
              entryPrice: updatedPosition.entryPrice,
              currentPrice: positionPrice,
              collateralAmount: updatedPosition.collateralAmount,
              borrowedAmount: updatedPosition.borrowedAmount,
            });
          }
        }
        
        // Accrue yield from strategy
        if (marketData) {
          const strategyConfig = config.strategies.find(s => s.strategy.id === position.strategyId);
          if (strategyConfig) {
            let expectedYield = await strategyConfig.strategy.calculateExpectedYield(
              strategyConfig.config,
              marketData
            );
            
            // Use real fees if available and enabled (from cache, not API call)
            if (config.useRealFees && this.aprCache.has(position.asset)) {
              const realAPR = this.aprCache.get(position.asset)!;
              if (realAPR > 0) {
                // Use real APR, but keep incentive/funding components from config
                const volatileConfig = strategyConfig.config as any;
                const ammFeeAPR = realAPR;
                const incentiveAPR = volatileConfig.incentiveAPR || 0;
                const fundingAPR = volatileConfig.fundingAPR || 0;
                expectedYield = { value: ammFeeAPR + incentiveAPR + fundingAPR } as any;
              }
            }
            
            // Calculate yield rate based on time since last check
            const lastCheck = this.lastCheckTimes.get(position.id) || event.timestamp;
            const hoursSinceLastCheck = Math.max(0.01, (event.timestamp.getTime() - lastCheck.getTime()) / (60 * 60 * 1000));
            const aprDecimal = expectedYield.value / 100; // 40% -> 0.40
            const hourlyYieldRate = aprDecimal / (365 * 24); // Hourly compounding rate
            
            // Apply fee dilution for large positions
            // Get pool-specific TVL from strategy config (already have strategyConfig from line 677)
            const poolTVL = (strategyConfig.config as any)?.costModel?.poolTVL || config.costModel?.poolTVL || 180_000_000;
            const currentValue = updatedPosition.marketValue();
            const positionShare = Math.min(1.0, currentValue.value / poolTVL);
            
            // Extreme dilution model:
            // - At 0-20% share: 100% efficiency (you're small relative to pool)
            // - At 50% share: 25% efficiency (major dilution)
            // - At 100% share: ~1% efficiency (you're the entire market)
            let dilutionFactor = 1.0;
            if (positionShare > 0.2) {
              // Exponential decay after 20% threshold
              dilutionFactor = Math.max(0.01, Math.pow(1 - positionShare, 3) + 0.01);
            }
            
            
            const adjustedYieldRate = hourlyYieldRate * hoursSinceLastCheck * dilutionFactor;
            
            // Accrue yield to position amount
            const yieldAmount = currentValue.multiply(adjustedYieldRate);
            this.lastCheckTimes.set(position.id, event.timestamp);
            
            // Increase position amount by yield (simulating LP token growth)
            const newAmount = updatedPosition.amount.add(yieldAmount);
            
            updatedPosition = Position.create({
              id: updatedPosition.id,
              strategyId: updatedPosition.strategyId,
              asset: updatedPosition.asset,
              amount: newAmount,
              entryPrice: updatedPosition.entryPrice,
              currentPrice: positionPrice,
              collateralAmount: updatedPosition.collateralAmount,
              borrowedAmount: updatedPosition.borrowedAmount,
            });
          }
        }
        
        portfolio.updatePosition(updatedPosition);
      }

      // Record portfolio value periodically (every hour) to avoid massive arrays
      // Only record if enough time has passed since last recording
      const lastRecordTime = this.lastRecordTime || config.startDate;
      const hoursSinceLastRecord = (event.timestamp.getTime() - lastRecordTime.getTime()) / (60 * 60 * 1000);
      
      if (hoursSinceLastRecord >= 1 || historicalValues.length === 0) {
        const currentValue = portfolio.totalValue().value;
        historicalValues.push(currentValue);
        this.lastRecordTime = event.timestamp;
        
        if (historicalValues.length > 1) {
          const prevValue = historicalValues[historicalValues.length - 2];
          const return_ = (currentValue - prevValue) / prevValue;
          historicalReturns.push(return_);
        }
      }
    }

  private getAssetFromConfig(config: Record<string, unknown>): string {
    if (config.pair) return config.pair as string;
    if (config.asset) return config.asset as string;
    if (config.rwaVault) return config.rwaVault as string;
    return 'USDC';
  }
}

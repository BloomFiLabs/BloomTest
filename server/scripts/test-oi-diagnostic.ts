#!/usr/bin/env ts-node
/**
 * Diagnostic script to test Open Interest (OI) retrieval for a single asset across all exchanges
 * 
 * Usage: npm run test:oi-diagnostic [SYMBOL]
 * Example: npm run test:oi-diagnostic ETH
 */

import { ConfigService } from '@nestjs/config';
import { AsterFundingDataProvider } from '../src/infrastructure/adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../src/infrastructure/adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../src/infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { LighterWebSocketProvider } from '../src/infrastructure/adapters/lighter/LighterWebSocketProvider';
import { HyperLiquidWebSocketProvider } from '../src/infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

async function testOIDiagnostic() {
  const symbol = process.argv[2] || 'ETH';
  console.log(`\n🔍 Testing Open Interest retrieval for ${symbol} across all exchanges...\n`);

  // Create ConfigService
  const configService = new ConfigService();
  
  // Create providers
  const asterProvider = new AsterFundingDataProvider(configService);
  const lighterProvider = new LighterFundingDataProvider(configService);
  const hyperliquidProvider = new HyperLiquidDataProvider(configService);
  const lighterWsProvider = new LighterWebSocketProvider();
  const hyperliquidWsProvider = new HyperLiquidWebSocketProvider();

  // Initialize WebSocket providers
  await lighterWsProvider.onModuleInit();
  await hyperliquidWsProvider.onModuleInit();

  // Wait a bit for WebSocket connections to establish
  console.log('⏳ Waiting 3 seconds for WebSocket connections to establish...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  const results: Array<{
    exchange: string;
    symbol: string;
    oi: number | null;
    error?: string;
    method?: string;
  }> = [];

  // Test Aster
  console.log('📊 Testing ASTER...');
  try {
    const asterSymbol = `${symbol}USDT`; // Aster uses USDT suffix
    console.log(`  Symbol: ${asterSymbol}`);
    
    // Check if symbol exists
    const availableSymbols = await asterProvider.getAvailableSymbols().catch(() => []);
    if (!availableSymbols.includes(asterSymbol)) {
      console.log(`  ⚠️  Symbol ${asterSymbol} not found in available symbols`);
      results.push({
        exchange: 'ASTER',
        symbol: asterSymbol,
        oi: null,
        error: `Symbol ${asterSymbol} not available`,
      });
    } else {
      const oi = await asterProvider.getOpenInterest(asterSymbol);
      console.log(`  ${oi > 0 ? '✅' : '❌'} OI: $${oi.toFixed(2)}`);
      results.push({
        exchange: 'ASTER',
        symbol: asterSymbol,
        oi: oi > 0 ? oi : null,
        method: 'REST API',
        error: oi === 0 ? 'OI returned 0' : undefined,
      });
    }
  } catch (error: any) {
    console.log(`  ❌ Error: ${error.message}`);
    if (error.response) {
      console.log(`  Response: ${JSON.stringify(error.response.data)}`);
    }
    results.push({
      exchange: 'ASTER',
      symbol: `${symbol}USDT`,
      oi: null,
      error: error.message,
    });
  }

  console.log('');

  // Test Lighter
  console.log('📊 Testing LIGHTER...');
  try {
    // Get market index for symbol
    const markets = await lighterProvider.getAvailableMarkets().catch(() => []);
    const market = markets.find((m: any) => m.symbol === symbol || m.symbol === symbol.toUpperCase());
    
    if (!market) {
      console.log(`  ⚠️  Symbol ${symbol} not found in available markets`);
      results.push({
        exchange: 'LIGHTER',
        symbol: symbol,
        oi: null,
        error: `Symbol ${symbol} not available`,
      });
    } else {
      const marketIndex = market.marketIndex;
      console.log(`  Symbol: ${symbol} (marketIndex: ${marketIndex})`);
      
      // Try WebSocket first
      if (lighterWsProvider?.isWsConnected()) {
        console.log('  🔌 Checking WebSocket...');
        const wsOI = lighterWsProvider.getOpenInterest(marketIndex);
        if (wsOI !== undefined && wsOI > 0) {
          console.log(`  ✅ OI (WebSocket): $${wsOI.toFixed(2)}`);
          results.push({
            exchange: 'LIGHTER',
            symbol: symbol,
            oi: wsOI,
            method: 'WebSocket',
          });
        } else {
          console.log(`  ⚠️  WebSocket OI not available yet, subscribing...`);
          lighterWsProvider.subscribeToMarket(marketIndex);
          // Wait a bit for data
          await new Promise(resolve => setTimeout(resolve, 2000));
          const wsOI2 = lighterWsProvider.getOpenInterest(marketIndex);
          if (wsOI2 !== undefined && wsOI2 > 0) {
            console.log(`  ✅ OI (WebSocket after subscribe): $${wsOI2.toFixed(2)}`);
            results.push({
              exchange: 'LIGHTER',
              symbol: symbol,
              oi: wsOI2,
              method: 'WebSocket',
            });
          } else {
            console.log(`  ⚠️  WebSocket still no data, trying REST...`);
            const restOI = await lighterProvider.getOpenInterest(marketIndex);
            console.log(`  ${restOI > 0 ? '✅' : '❌'} OI (REST): $${restOI.toFixed(2)}`);
            results.push({
              exchange: 'LIGHTER',
              symbol: symbol,
              oi: restOI > 0 ? restOI : null,
              method: 'REST API',
              error: restOI === 0 ? 'OI returned 0' : undefined,
            });
          }
        }
      } else {
        console.log(`  ⚠️  WebSocket not connected, using REST...`);
        const restOI = await lighterProvider.getOpenInterest(marketIndex);
        console.log(`  ${restOI > 0 ? '✅' : '❌'} OI (REST): $${restOI.toFixed(2)}`);
        results.push({
          exchange: 'LIGHTER',
          symbol: symbol,
          oi: restOI > 0 ? restOI : null,
          method: 'REST API',
          error: restOI === 0 ? 'OI returned 0' : undefined,
        });
      }
    }
  } catch (error: any) {
    console.log(`  ❌ Error: ${error.message}`);
    if (error.response) {
      console.log(`  Response: ${JSON.stringify(error.response.data)}`);
    }
    results.push({
      exchange: 'LIGHTER',
      symbol: symbol,
      oi: null,
      error: error.message,
    });
  }

  console.log('');

  // Test Hyperliquid
  console.log('📊 Testing HYPERLIQUID...');
  try {
    const hlSymbol = symbol.toUpperCase();
    console.log(`  Symbol: ${hlSymbol}`);
    
    // Check if asset exists
    const availableAssets = await hyperliquidProvider.getAvailableAssets().catch(() => []);
    if (!availableAssets.includes(hlSymbol)) {
      console.log(`  ⚠️  Asset ${hlSymbol} not found in available assets`);
      results.push({
        exchange: 'HYPERLIQUID',
        symbol: hlSymbol,
        oi: null,
        error: `Asset ${hlSymbol} not available`,
      });
    } else {
      // Try WebSocket first
      if (hyperliquidWsProvider?.isWsConnected()) {
        console.log('  🔌 Checking WebSocket...');
        const wsOI = hyperliquidWsProvider.getOpenInterest(hlSymbol);
        if (wsOI !== undefined && wsOI > 0) {
          console.log(`  ✅ OI (WebSocket): $${wsOI.toFixed(2)}`);
          results.push({
            exchange: 'HYPERLIQUID',
            symbol: hlSymbol,
            oi: wsOI,
            method: 'WebSocket',
          });
        } else {
          console.log(`  ⚠️  WebSocket OI not available, trying REST...`);
          const restOI = await hyperliquidProvider.getOpenInterest(hlSymbol);
          console.log(`  ${restOI > 0 ? '✅' : '❌'} OI (REST): $${restOI.toFixed(2)}`);
          results.push({
            exchange: 'HYPERLIQUID',
            symbol: hlSymbol,
            oi: restOI > 0 ? restOI : null,
            method: 'REST API',
            error: restOI === 0 ? 'OI returned 0' : undefined,
          });
        }
      } else {
        console.log(`  ⚠️  WebSocket not connected, using REST...`);
        const restOI = await hyperliquidProvider.getOpenInterest(hlSymbol);
        console.log(`  ${restOI > 0 ? '✅' : '❌'} OI (REST): $${restOI.toFixed(2)}`);
        results.push({
          exchange: 'HYPERLIQUID',
          symbol: hlSymbol,
          oi: restOI > 0 ? restOI : null,
          method: 'REST API',
          error: restOI === 0 ? 'OI returned 0' : undefined,
        });
      }
    }
  } catch (error: any) {
    console.log(`  ❌ Error: ${error.message}`);
    if (error.response) {
      console.log(`  Response: ${JSON.stringify(error.response.data)}`);
    }
    results.push({
      exchange: 'HYPERLIQUID',
      symbol: symbol.toUpperCase(),
      oi: null,
      error: error.message,
    });
  }

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📋 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');

  results.forEach(result => {
    const status = result.oi !== null && result.oi > 0 ? '✅' : '❌';
    const oiDisplay = result.oi !== null && result.oi > 0 
      ? `$${result.oi.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : 'N/A';
    const methodDisplay = result.method ? ` (${result.method})` : '';
    const errorDisplay = result.error ? ` - Error: ${result.error}` : '';
    
    console.log(`${status} ${result.exchange.padEnd(12)} ${result.symbol.padEnd(15)} OI: ${oiDisplay.padEnd(20)}${methodDisplay}${errorDisplay}`);
  });

  console.log('\n');
  
  const successCount = results.filter(r => r.oi !== null && r.oi > 0).length;
  const totalCount = results.length;
  
  console.log(`✅ Success: ${successCount}/${totalCount} exchanges`);
  console.log(`❌ Failed:  ${totalCount - successCount}/${totalCount} exchanges\n`);

  // Cleanup
  await lighterWsProvider.onModuleDestroy();
  await hyperliquidWsProvider.onModuleDestroy();
  
  process.exit(0);
}

testOIDiagnostic().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

/**
 * Script to discover common symbols across exchanges and cache them
 * Uses existing provider implementations.
 * 
 * Run with: npx ts-node -r tsconfig-paths/register scripts/discover-common-symbols.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { FundingRateAggregator } from '../src/domain/services/FundingRateAggregator';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  console.log('🔍 Starting symbol discovery using existing providers...\n');
  
  // Bootstrap NestJS app to get access to all providers
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  
  try {
    const aggregator = app.get(FundingRateAggregator);
    
    // Use existing discoverCommonAssets method
    console.log('Calling discoverCommonAssets()...');
    const commonAssets = await aggregator.discoverCommonAssets();
    
    console.log(`\n✅ Found ${commonAssets.length} common symbols:\n`);
    console.log(commonAssets.join(', '));
    
    // Get the full mappings
    const mappings: any[] = [];
    for (const symbol of commonAssets) {
      const mapping: any = {
        normalizedSymbol: symbol,
        exchanges: [],
      };
      
      // Get exchange-specific symbols using existing method
      const asterSymbol = aggregator.getExchangeSymbol(symbol, 'ASTER' as any);
      const lighterIndex = aggregator.getExchangeSymbol(symbol, 'LIGHTER' as any);
      const hlSymbol = aggregator.getExchangeSymbol(symbol, 'HYPERLIQUID' as any);
      
      if (asterSymbol) {
        mapping.asterSymbol = asterSymbol;
        mapping.exchanges.push('ASTER');
      }
      if (lighterIndex !== undefined) {
        mapping.lighterMarketIndex = lighterIndex;
        mapping.lighterSymbol = symbol;
        mapping.exchanges.push('LIGHTER');
      }
      if (hlSymbol) {
        mapping.hyperliquidSymbol = hlSymbol;
        mapping.exchanges.push('HYPERLIQUID');
      }
      
      mappings.push(mapping);
    }
    
    // Write JSON cache
    const outputDir = path.join(__dirname, '..', 'src', 'config');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const cacheData = {
      generatedAt: new Date().toISOString(),
      version: 1,
      symbols: mappings,
    };
    
    const jsonPath = path.join(outputDir, 'cached-symbols.json');
    fs.writeFileSync(jsonPath, JSON.stringify(cacheData, null, 2));
    console.log(`\n💾 Saved JSON to: ${jsonPath}`);
    
    // Write TypeScript file
    const tsContent = `/**
 * Auto-generated cached symbol mappings
 * Generated: ${cacheData.generatedAt}
 * 
 * Re-generate: npx ts-node -r tsconfig-paths/register scripts/discover-common-symbols.ts
 */

export const CACHED_SYMBOLS = ${JSON.stringify(mappings, null, 2)} as const;

export const SYMBOL_LIST = [${mappings.map(m => `'${m.normalizedSymbol}'`).join(', ')}] as const;
`;
    
    const tsPath = path.join(outputDir, 'cached-symbols.ts');
    fs.writeFileSync(tsPath, tsContent);
    console.log(`💾 Saved TypeScript to: ${tsPath}`);
    
  } finally {
    await app.close();
  }
}

main().catch(console.error);

#!/usr/bin/env tsx

/**
 * Sample script to prepare data files for backtesting
 * This demonstrates how to fetch and format data from various sources
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const DATA_DIR = './data';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Fetch OHLCV data from CoinGecko API
 */
async function fetchCoinGeckoData(coinId: string, vsCurrency: string = 'usd', days: number = 365): Promise<void> {
  try {
    console.log(`Fetching ${coinId}/${vsCurrency} data from CoinGecko...`);
    
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`,
      {
        params: {
          vs_currency: vsCurrency,
          days: days,
        },
      }
    );

    const csv = ['timestamp,open,high,low,close,volume'];
    
    for (const [timestamp, open, high, low, close] of response.data) {
      const date = new Date(timestamp).toISOString();
      // CoinGecko OHLC doesn't include volume, so we set it to 0
      csv.push(`${date},${open},${high},${low},${close},0`);
    }
    
    const fileName = `${coinId.toUpperCase()}-${vsCurrency.toUpperCase()}.csv`;
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, csv.join('\n'));
    
    console.log(`✅ Saved ${response.data.length} data points to ${filePath}`);
  } catch (error) {
    console.error(`❌ Error fetching ${coinId} data:`, error);
  }
}

/**
 * Create sample stable pair data (USDC-USDT)
 * Stable pairs typically trade very close to 1:1
 */
function createSampleStablePairData(): void {
  const csv = ['timestamp,open,high,low,close,volume'];
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
  
  let currentDate = new Date(startDate);
  let price = 1.0;
  
  while (currentDate <= endDate) {
    // Small random variation around 1.0 (±0.1%)
    const variation = (Math.random() - 0.5) * 0.002;
    price = 1.0 + variation;
    
    const open = price;
    const high = price + Math.random() * 0.0005;
    const low = price - Math.random() * 0.0005;
    const close = price + (Math.random() - 0.5) * 0.0003;
    const volume = 50000000 + Math.random() * 20000000; // 50-70M volume
    
    csv.push(`${currentDate.toISOString()},${open.toFixed(6)},${high.toFixed(6)},${low.toFixed(6)},${close.toFixed(6)},${Math.floor(volume)}`);
    
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  const filePath = path.join(DATA_DIR, 'USDC-USDT.csv');
  fs.writeFileSync(filePath, csv.join('\n'));
  console.log(`✅ Created sample stable pair data: ${filePath}`);
}

/**
 * Create sample data with IV (for options strategies)
 */
function createSampleDataWithIV(asset: string, basePrice: number): void {
  const csv = ['timestamp,open,high,low,close,volume,iv'];
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
  
  let currentDate = new Date(startDate);
  let price = basePrice;
  let iv = 50; // Start at 50% IV
  
  while (currentDate <= endDate) {
    // Price movement
    const priceChange = (Math.random() - 0.5) * 0.05; // ±5% daily
    price = price * (1 + priceChange);
    
    const open = price;
    const high = price * (1 + Math.random() * 0.03);
    const low = price * (1 - Math.random() * 0.03);
    const close = price * (1 + (Math.random() - 0.5) * 0.02);
    const volume = 1000000 + Math.random() * 500000;
    
    // IV changes (mean-reverting around 50%)
    iv = iv + (Math.random() - 0.5) * 5;
    iv = Math.max(20, Math.min(100, iv)); // Clamp between 20-100%
    
    csv.push(`${currentDate.toISOString()},${open.toFixed(2)},${high.toFixed(2)},${low.toFixed(2)},${close.toFixed(2)},${Math.floor(volume)},${iv.toFixed(2)}`);
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  const filePath = path.join(DATA_DIR, `${asset}.csv`);
  fs.writeFileSync(filePath, csv.join('\n'));
  console.log(`✅ Created sample data with IV: ${filePath}`);
}

/**
 * Main function
 */
async function main() {
  console.log('📊 Preparing sample data for backtesting...\n');
  
  // Create sample stable pair data
  createSampleStablePairData();
  
  // Create sample ETH data with IV
  createSampleDataWithIV('ETH-USDC', 2000);
  
  // Optionally fetch real data from CoinGecko (requires API)
  // Uncomment to use:
  // await fetchCoinGeckoData('ethereum', 'usd', 365);
  // await fetchCoinGeckoData('bitcoin', 'usd', 365);
  
  console.log('\n✅ Data preparation complete!');
  console.log(`📁 Data files saved to: ${DATA_DIR}`);
  console.log('\nYou can now run backtests with:');
  console.log('  npm run cli run -c your-config.yaml -o results.json');
}

main().catch(console.error);



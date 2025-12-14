#!/usr/bin/env tsx

/**
 * Script to fetch price and volume data from various free APIs
 * Supports: CoinGecko, Binance, CryptoCompare
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const DATA_DIR = './data';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface DataSource {
  name: string;
  fetch: (symbol: string, days: number) => Promise<Array<[number, number, number, number, number, number]>>;
}

/**
 * Fetch from CoinGecko API (free, no API key needed)
 */
async function fetchCoinGecko(
  coinId: string,
  vsCurrency: string = 'usd',
  days: number = 365
): Promise<Array<[number, number, number, number, number, number]>> {
  try {
    console.log(`📊 Fetching ${coinId}/${vsCurrency} from CoinGecko...`);
    
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`,
      {
        params: {
          vs_currency: vsCurrency,
          days: days,
        },
        timeout: 30000,
      }
    );

    // CoinGecko returns: [timestamp, open, high, low, close]
    // We'll set volume to 0 as it's not included
    return response.data.map(([timestamp, open, high, low, close]: number[]) => [
      timestamp,
      open,
      high,
      low,
      close,
      0, // Volume not available
    ]);
  } catch (error: any) {
    console.error(`❌ CoinGecko error: ${error.message}`);
    throw error;
  }
}

/**
 * Fetch from Binance API (free, high quality, includes volume)
 */
async function fetchBinance(
  symbol: string,
  days: number = 365
): Promise<Array<[number, number, number, number, number, number]>> {
  try {
    console.log(`📊 Fetching ${symbol} from Binance...`);
    
    const limit = Math.min(days, 1000); // Binance limit
    const response = await axios.get('https://api.binance.com/api/v3/klines', {
      params: {
        symbol: symbol.toUpperCase(),
        interval: '1d',
        limit: limit,
      },
      timeout: 30000,
    });

    // Binance returns: [timestamp, open, high, low, close, volume, ...]
    return response.data.map((kline: any[]) => [
      kline[0], // timestamp
      parseFloat(kline[1]), // open
      parseFloat(kline[2]), // high
      parseFloat(kline[3]), // low
      parseFloat(kline[4]), // close
      parseFloat(kline[5]), // volume
    ]);
  } catch (error: any) {
    console.error(`❌ Binance error: ${error.message}`);
    throw error;
  }
}

/**
 * Fetch from CryptoCompare API (free tier)
 */
async function fetchCryptoCompare(
  fsym: string,
  tsym: string = 'USD',
  days: number = 365
): Promise<Array<[number, number, number, number, number, number]>> {
  try {
    console.log(`📊 Fetching ${fsym}/${tsym} from CryptoCompare...`);
    
    const limit = Math.min(days, 2000);
    const response = await axios.get(
      'https://min-api.cryptocompare.com/data/v2/histoday',
      {
        params: {
          fsym: fsym.toUpperCase(),
          tsym: tsym.toUpperCase(),
          limit: limit,
        },
        timeout: 30000,
      }
    );

    if (response.data.Response === 'Error') {
      throw new Error(response.data.Message);
    }

    return response.data.Data.Data.map((d: any) => [
      d.time * 1000, // Convert to milliseconds
      d.open,
      d.high,
      d.low,
      d.close,
      d.volumefrom || 0, // Volume in base currency
    ]);
  } catch (error: any) {
    console.error(`❌ CryptoCompare error: ${error.message}`);
    throw error;
  }
}

/**
 * Save data to CSV file
 */
function saveToCSV(
  data: Array<[number, number, number, number, number, number]>,
  fileName: string
): void {
  const csv = ['timestamp,open,high,low,close,volume'];
  
  for (const [timestamp, open, high, low, close, volume] of data) {
    const date = new Date(timestamp).toISOString();
    csv.push(`${date},${open},${high},${low},${close},${volume}`);
  }
  
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, csv.join('\n'));
  console.log(`✅ Saved ${data.length} data points to ${filePath}`);
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Usage: npm run fetch-data <source> <symbol> [days]

Sources:
  coingecko  - CoinGecko API (free, no key needed, no volume)
  binance    - Binance API (free, includes volume, exchange pairs only)
  cryptocompare - CryptoCompare API (free tier, includes volume)

Examples:
  npm run fetch-data coingecko ethereum 365
  npm run fetch-data binance ETHUSDC 365
  npm run fetch-data cryptocompare ETH USD 365

Coin IDs for CoinGecko:
  - ethereum (ETH)
  - bitcoin (BTC)
  - usd-coin (USDC)
  - tether (USDT)
  - dai (DAI)

Binance Symbols:
  - ETHUSDC, BTCUSDC, USDCUSDT, etc.
    `);
    process.exit(0);
  }

  const [source, ...symbolArgs] = args;
  const days = parseInt(symbolArgs[symbolArgs.length - 1]) || 365;
  const symbol = symbolArgs.slice(0, -1).join(' ') || symbolArgs[0];

  if (!symbol) {
    console.error('❌ Error: Symbol required');
    process.exit(1);
  }

  try {
    let data: Array<[number, number, number, number, number, number]>;
    let fileName: string;

    switch (source.toLowerCase()) {
      case 'coingecko':
        data = await fetchCoinGecko(symbol, 'usd', days);
        fileName = `${symbol.toUpperCase()}-USD.csv`;
        break;

      case 'binance':
        data = await fetchBinance(symbol, days);
        // Extract base and quote from symbol (e.g., ETHUSDC -> ETH-USDC)
        const base = symbol.slice(0, -4);
        const quote = symbol.slice(-4);
        fileName = `${base}-${quote}.csv`;
        break;

      case 'cryptocompare':
        const [fsym, tsym = 'USD'] = symbol.split(' ');
        data = await fetchCryptoCompare(fsym, tsym, days);
        fileName = `${fsym.toUpperCase()}-${tsym.toUpperCase()}.csv`;
        break;

      default:
        console.error(`❌ Unknown source: ${source}`);
        console.log('Available sources: coingecko, binance, cryptocompare');
        process.exit(1);
    }

    saveToCSV(data, fileName);
    console.log(`\n✅ Data fetch complete!`);
    console.log(`📁 File: ${path.join(DATA_DIR, fileName)}`);
  } catch (error: any) {
    console.error(`\n❌ Failed to fetch data:`, error.message);
    process.exit(1);
  }
}

main();



import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const API_URL = 'https://api.hyperliquid.xyz/info';
const SYMBOL = 'ETH';
const INTERVAL = '1h'; 
const OUTPUT_FILE = path.join('results', 'hyperliquid-eth-history.json');

async function main() {
  console.log(`📡 Fetching Hyperliquid data for ${SYMBOL}...`);

  const endTime = Date.now();
  const startTime = endTime - (365 * 24 * 60 * 60 * 1000); 

  try {
    const response = await axios.post(API_URL, {
      type: 'candleSnapshot',
      req: {
        coin: SYMBOL,
        interval: INTERVAL,
        startTime: startTime,
        endTime: endTime
      }
    });

    const candles = response.data;
    console.log(`✅ Received ${candles.length} candles`);
    
    console.log('   Fetching funding history...');
    
    // CORRECTED PAYLOAD STRUCTURE for fundingHistory
    // Based on API docs: type: 'fundingHistory', coin: string, startTime: number, endTime?: number
    // Note: Unlike candleSnapshot, fundingHistory arguments are top-level or inside user/state
    // Actually, per docs: { "type": "fundingHistory", "coin": "ETH", "startTime": 123... }
    
    const fundingResponse = await axios.post(API_URL, {
      type: 'fundingHistory',
      coin: SYMBOL,
      startTime: startTime,
      endTime: endTime
    });
    
    const funding = fundingResponse.data;
    console.log(`✅ Received ${funding.length} funding updates`);

    const dataset = {
      symbol: SYMBOL,
      interval: INTERVAL,
      candles: candles.map((c: any) => ({
        timestamp: new Date(c.t).toISOString(),
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
        volume: parseFloat(c.v),
      })),
      funding: funding.map((f: any) => ({
        timestamp: new Date(f.time).toISOString(),
        rate: parseFloat(f.fundingRate),
        premium: parseFloat(f.premium || '0')
      }))
    };

    if (!fs.existsSync('results')) fs.mkdirSync('results');

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(dataset, null, 2));
    console.log(`💾 Saved to ${OUTPUT_FILE}`);
    
    const avgFunding = funding.reduce((sum: number, f: any) => sum + parseFloat(f.fundingRate), 0) / funding.length;
    const annualizedFunding = avgFunding * 24 * 365 * 100; 
    
    console.log('\n📊 HYPERLIQUID FUNDING STATS:');
    console.log(`   Average Hourly Rate: ${(avgFunding * 100).toFixed(6)}%`);
    console.log(`   Annualized Funding:  ${annualizedFunding.toFixed(2)}% APY`);

  } catch (error: any) {
    if (error.response) {
      console.error(`❌ API Error ${error.response.status}: ${error.response.statusText}`);
      if (error.response.status === 429) {
        console.warn('   ⚠️  Rate limit exceeded. Try again in a few minutes.');
      }
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

main();

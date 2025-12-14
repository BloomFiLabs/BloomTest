import axios from 'axios';

/**
 * Extract historical funding rates from Lighter Protocol transaction logs
 * Uses funding_rate_prefix_sum from TradeWithFunding transactions
 */

interface LighterTransaction {
  tx_type: string;
  hash: string;
  time: string;
  pubdata?: {
    trade_pubdata_with_funding?: {
      market_index: number;
      funding_rate_prefix_sum: number | string;
      [key: string]: any;
    };
    [key: string]: any;
  };
  pubdata_type?: string;
}

interface FundingRateEntry {
  timestamp: Date;
  rate: number;
  prefixSum: number;
  marketIndex: number;
}

/**
 * Extract funding rates from Lighter transaction logs
 */
async function extractLighterHistoricalFunding(
  symbol: string,
  days: number = 30,
): Promise<FundingRateEntry[]> {
  const baseUrl = `https://explorer.elliot.ai/api/markets/${symbol}/logs`;
  
  console.log(`🔍 Fetching Lighter transaction logs for ${symbol}...`);
  console.log(`   URL: ${baseUrl}`);
  
  try {
    // Try to fetch with pagination parameters
    const allTransactions: LighterTransaction[] = [];
    let page = 1;
    const limit = 100; // Try to get more per page
    let hasMore = true;
    
    // Try different query parameters to get historical data
    const endTime = Date.now();
    const startTime = endTime - (days * 24 * 60 * 60 * 1000);
    
    while (hasMore && page <= 10) { // Limit to 10 pages to avoid infinite loops
      // Try with date range and pagination
      const url = `${baseUrl}?page=${page}&limit=${limit}&start_time=${startTime}&end_time=${endTime}`;
      console.log(`   Fetching page ${page}...`);
      
      let response;
      try {
        response = await axios.get(url, {
          headers: { accept: 'application/json' },
          timeout: 60000,
        });
      } catch (error: any) {
        // If date params don't work, try without them
        if (page === 1) {
          const url2 = `${baseUrl}?page=${page}&limit=${limit}`;
          response = await axios.get(url2, {
            headers: { accept: 'application/json' },
            timeout: 60000,
          });
        } else {
          throw error;
        }
      }
      
      if (!Array.isArray(response.data)) {
        // Try without pagination params
        if (page === 1) {
          const response2 = await axios.get(baseUrl, {
            headers: { accept: 'application/json' },
            timeout: 60000,
          });
          if (Array.isArray(response2.data)) {
            allTransactions.push(...response2.data);
            console.log(`✅ Received ${response2.data.length} transactions (no pagination)`);
            break;
          }
        }
        console.error(`❌ Unexpected response format on page ${page}: ${JSON.stringify(response.data).substring(0, 200)}`);
        break;
      }
      
      if (response.data.length === 0) {
        hasMore = false;
        break;
      }
      
      allTransactions.push(...response.data);
      console.log(`   Page ${page}: ${response.data.length} transactions`);
      
      // If we got fewer than limit, we're done
      if (response.data.length < limit) {
        hasMore = false;
      }
      
      page++;
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log(`✅ Total transactions fetched: ${allTransactions.length}`);
    
    // Filter for TradeWithFunding transactions
    const fundingTransactions = allTransactions.filter((tx: LighterTransaction) => 
      tx.pubdata_type === 'TradeWithFunding' &&
      tx.pubdata?.trade_pubdata_with_funding?.funding_rate_prefix_sum !== undefined &&
      tx.pubdata?.trade_pubdata_with_funding?.funding_rate_prefix_sum !== null &&
      tx.pubdata?.trade_pubdata_with_funding?.funding_rate_prefix_sum !== 0
    );
    
    console.log(`📊 Found ${fundingTransactions.length} transactions with funding data`);
    
    if (fundingTransactions.length === 0) {
      console.warn(`⚠️  No funding transactions found for ${symbol}`);
      return [];
    }
    
    // Sort by timestamp (oldest first)
    fundingTransactions.sort((a, b) => 
      new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    
    // Extract funding rates from prefix sums
    // The prefix sum is cumulative - it represents the total funding rate accumulated since market start
    // When it changes, that's when funding was paid (typically hourly or every 8 hours)
    // To get individual funding rates, we need to find when the prefix sum changes
    
    const fundingRates: FundingRateEntry[] = [];
    
    // Group transactions by prefix sum value to find when funding payments occurred
    const prefixSumGroups = new Map<number, LighterTransaction[]>();
    fundingTransactions.forEach(tx => {
      const ps = typeof tx.pubdata!.trade_pubdata_with_funding!.funding_rate_prefix_sum === 'string'
        ? parseFloat(tx.pubdata!.trade_pubdata_with_funding!.funding_rate_prefix_sum)
        : tx.pubdata!.trade_pubdata_with_funding!.funding_rate_prefix_sum;
      
      if (!prefixSumGroups.has(ps)) {
        prefixSumGroups.set(ps, []);
      }
      prefixSumGroups.get(ps)!.push(tx);
    });
    
    // Sort prefix sum groups chronologically (by earliest transaction in each group)
    const sortedPrefixSumGroups = Array.from(prefixSumGroups.entries()).sort((a, b) => {
      const aTime = Math.min(...a[1].map(tx => new Date(tx.time).getTime()));
      const bTime = Math.min(...b[1].map(tx => new Date(tx.time).getTime()));
      return aTime - bTime;
    });
    
    console.log(`\n📊 Found ${sortedPrefixSumGroups.length} unique funding periods`);
    
    // Analyze prefix sum values
    console.log(`\n🔍 Analyzing prefix sum values...`);
    sortedPrefixSumGroups.forEach(([prefixSum, transactions]) => {
      const timestamps = transactions.map(tx => new Date(tx.time));
      const minTime = new Date(Math.min(...timestamps.map(t => t.getTime())));
      const maxTime = new Date(Math.max(...timestamps.map(t => t.getTime())));
      const timeSpan = (maxTime.getTime() - minTime.getTime()) / (1000 * 60 * 60); // hours
      console.log(`     PrefixSum=${prefixSum}: ${transactions.length} transactions, time span: ${timeSpan.toFixed(2)} hours (${minTime.toISOString()} to ${maxTime.toISOString()})`);
    });
    
    // Lighter uses scaled integers - need to determine scale factor
    // Common scales: 1e18 (wei-like), 1e8 (satoshi-like), 1e6 (micro)
    // funding_rate_prefix_sum values like 24623951772 suggest 1e8 or 1e6 scale
    // Based on typical funding rates (0.0001% = 0.000001), and prefix sum values,
    // let's try different scale factors and see which makes sense
    
    // Try 1e8 first (common for funding rates stored as integers)
    // The prefix sum is cumulative, so differences represent funding paid over time periods
    const SCALE_FACTOR = 1e8;
    
    // If we only have one unique prefix sum, we need more historical data
    if (sortedPrefixSumGroups.length === 1) {
      console.log(`\n⚠️  Only one unique prefix sum value found. This means:`);
      console.log(`   - All transactions occurred within the same funding period`);
      console.log(`   - Funding payments happen periodically (likely hourly or every 8 hours)`);
      console.log(`   - We need to query older transactions to see prefix sum changes`);
      console.log(`   - Try querying with a longer time range or check for funding payment events`);
      return [];
    }
    
    // Calculate funding rates from prefix sum changes
    // Each change in prefix sum represents a funding payment
    for (let i = 0; i < sortedPrefixSumGroups.length; i++) {
      const [prefixSum, transactions] = sortedPrefixSumGroups[i];
      const earliestTx = transactions.reduce((earliest, tx) => 
        new Date(tx.time) < new Date(earliest.time) ? tx : earliest
      );
      const timestamp = new Date(earliestTx.time);
      const marketIndex = earliestTx.pubdata!.trade_pubdata_with_funding!.market_index;
      
      if (i > 0) {
        // Calculate funding rate from prefix sum difference
        const [prevPrefixSum, prevTransactions] = sortedPrefixSumGroups[i - 1];
        const latestPrevTx = prevTransactions.reduce((latest, tx) => 
          new Date(tx.time) > new Date(latest.time) ? tx : latest
        );
        const prevTimestamp = new Date(latestPrevTx.time);
        
        const prefixSumDiff = prefixSum - prevPrefixSum;
        const timeDiffMs = timestamp.getTime() - prevTimestamp.getTime();
        const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
        
        // Convert scaled integer to actual funding rate
        // The prefix sum difference represents cumulative funding over the time period
        // Divide by time to get hourly rate
        const cumulativeRate = prefixSumDiff / SCALE_FACTOR;
        const hourlyRate = timeDiffHours > 0 ? cumulativeRate / timeDiffHours : cumulativeRate;
        
        fundingRates.push({
          timestamp,
          rate: hourlyRate,
          prefixSum: prefixSum / SCALE_FACTOR,
          marketIndex,
        });
        
        console.log(
          `  📅 ${timestamp.toISOString()}: ` +
          `Rate=${(hourlyRate * 100).toFixed(6)}% ` +
          `(PrefixSum=${prefixSum}→${prevPrefixSum}, Diff=${prefixSumDiff}, Hours=${timeDiffHours.toFixed(2)})`
        );
      } else {
        // First period - can't calculate rate yet, but store the timestamp
        console.log(`  📅 ${timestamp.toISOString()}: Initial prefix sum=${prefixSum} (no rate calculation possible)`);
      }
    }
    
    // If we only have one prefix sum value, we can't calculate rates
    // This means all transactions are from the same funding period
    if (sortedPrefixSumGroups.length === 1) {
      console.log(`\n⚠️  Only one funding period found. To get historical rates:`);
      console.log(`   1. Query older transactions (API may only return recent data)`);
      console.log(`   2. Wait for next funding payment to see prefix sum change`);
      console.log(`   3. Check if there's a different endpoint for historical funding data`);
      return [];
    }
    
    // Filter by date range
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const filteredRates = fundingRates.filter(entry => entry.timestamp >= cutoffDate);
    
    console.log(`\n✅ Extracted ${filteredRates.length} funding rate entries (last ${days} days)`);
    if (filteredRates.length > 0) {
      console.log(`   Date range: ${filteredRates[0]?.timestamp.toISOString()} to ${filteredRates[filteredRates.length - 1]?.timestamp.toISOString()}`);
      
      // Show sample data
      console.log(`\n📊 Sample entries (first 5):`);
      filteredRates.slice(0, 5).forEach((entry, i) => {
        console.log(`   ${i + 1}. ${entry.timestamp.toISOString()}: ${(entry.rate * 100).toFixed(6)}%`);
      });
    }
    
    return filteredRates;
  } catch (error: any) {
    console.error(`❌ Failed to fetch Lighter historical funding data for ${symbol}:`, error.message);
    if (error.response) {
      console.error(`   HTTP ${error.response.status}: ${JSON.stringify(error.response.data).substring(0, 200)}`);
    }
    return [];
  }
}

/**
 * Test extraction for multiple symbols
 */
async function main() {
  console.log('🚀 Lighter Historical Funding Rate Extractor');
  console.log('='.repeat(80));
  
  const symbols = ['ETH', 'BTC', 'SOL']; // Test with common symbols
  const days = 30;
  
  for (const symbol of symbols) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Processing ${symbol}...`);
    console.log('='.repeat(80));
    
    const rates = await extractLighterHistoricalFunding(symbol, days);
    
    if (rates.length > 0) {
      // Calculate statistics
      const avgRate = rates.reduce((sum, r) => sum + r.rate, 0) / rates.length;
      const minRate = Math.min(...rates.map(r => r.rate));
      const maxRate = Math.max(...rates.map(r => r.rate));
      
      console.log(`\n📈 Statistics for ${symbol}:`);
      console.log(`   Average Rate: ${(avgRate * 100).toFixed(6)}%`);
      console.log(`   Min Rate: ${(minRate * 100).toFixed(6)}%`);
      console.log(`   Max Rate: ${(maxRate * 100).toFixed(6)}%`);
      console.log(`   Data Points: ${rates.length}`);
    }
    
    // Small delay between symbols
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('✅ Extraction complete!');
  console.log('='.repeat(80));
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { extractLighterHistoricalFunding };
export type { FundingRateEntry };


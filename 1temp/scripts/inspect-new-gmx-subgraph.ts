import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'F8JuJQQuDYoXkM3ngneRnrL9RA7sT5DjL6kBZE1nJZc3';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function inspect() {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set');
    process.exit(1);
  }

  console.log('🔍 Inspecting New GMX Subgraph\n');
  console.log('Subgraph ID:', GMX_SUBGRAPH_ID);
  console.log('='.repeat(80));

  // Try GMX v2 specific queries
  const queries = [
    {
      name: 'Markets',
      query: `{ markets(first: 5) { id name marketToken indexToken longToken shortToken } }`
    },
    {
      name: 'CollectedMarketFeesInfos (Funding Data)',
      query: `{ 
        collectedMarketFeesInfos(
          first: 10, 
          orderBy: timestampGroup, 
          orderDirection: desc,
          where: { period: "1h" }
        ) {
          id
          market
          marketAddress
          period
          timestampGroup
          cumulativeFundingFeeUsdPerPoolValue
          fundingFeeAmountPerSize
          cumulativeBorrowingFeeUsdPerPoolValue
        }
      }`
    },
    {
      name: 'Price Candles',
      query: `{ 
        candles(
          first: 5, 
          orderBy: timestamp, 
          orderDirection: desc,
          where: { period: "1h" }
        ) {
          id
          timestamp
          marketAddress
          high
          low
          open
          close
        }
      }`
    },
    {
      name: 'Market Stat (Latest)',
      query: `{
        marketStats(first: 5, orderBy: timestamp, orderDirection: desc) {
          id
          marketAddress
          timestamp
          fundingAprForLongs
          fundingAprForShorts
          borrowingFactorForLongs
          borrowingFactorForShorts
        }
      }`
    }
  ];

  for (const test of queries) {
    console.log(`\n${test.name}:`);
    console.log('─'.repeat(80));
    try {
      const response = await axios.post(
        SUBGRAPH_URL,
        { query: test.query },
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );

      if (response.data.errors) {
        console.log('  ❌ Query failed:', response.data.errors[0].message);
      } else if (response.data.data) {
        const key = Object.keys(response.data.data)[0];
        const results = response.data.data[key];
        if (results && results.length > 0) {
          console.log(`  ✅ Found ${results.length} results`);
          console.log('\n  Sample:');
          console.log(JSON.stringify(results[0], null, 2));
          
          if (results.length > 1 && key === 'marketStats') {
            console.log('\n  Recent funding rates:');
            results.slice(0, 3).forEach((stat: any) => {
              console.log(`    ${new Date(stat.timestamp * 1000).toISOString()}`);
              console.log(`      Market: ${stat.marketAddress}`);
              console.log(`      Funding APR (Longs): ${stat.fundingAprForLongs}`);
              console.log(`      Funding APR (Shorts): ${stat.fundingAprForShorts}`);
            });
          }
        } else {
          console.log('  ⚠️  No results found');
        }
      }
    } catch (error: any) {
      console.log('  ❌ Error:', error.message);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ Inspection complete\n');
}

inspect();

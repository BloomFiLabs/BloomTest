import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'DiR5cWwB3pwXXQWWdus7fDLR2mnFRQLiBFsVmHAH9VAs';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function explore() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  console.log('🔍 Exploring GMX v1 Data Structure\n');

  // Check for hourly/daily snapshots
  const queries = [
    {
      name: 'LiquidityPool DailySn apshots',
      query: `{
        liquidityPoolDailySnapshots(first: 5, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          totalValueLockedUSD
          dailyVolumeUSD
          cumulativeVolumeUSD
        }
      }`
    },
    {
      name: 'LiquidityPoolHourlySnapshots',
      query: `{
        liquidityPoolHourlySnapshots(first: 10, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          totalValueLockedUSD
          hourlyVolumeUSD
        }
      }`
    },
    {
      name: 'FinancialsDailySnapshots',
      query: `{
        financialsDailySnapshots(first: 5, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          totalValueLockedUSD
          dailyVolumeUSD
          dailySupplySideRevenueUSD
          dailyProtocolSideRevenueUSD
        }
      }`
    },
    {
      name: 'Recent Positions',
      query: `{
        positions(first: 10, orderBy: timestampOpened, orderDirection: desc) {
          id
          timestampOpened
          timestampClosed
          side
          asset {
            symbol
          }
          collateral {
            symbol
          }
          leverage
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
          console.log('  Sample:', JSON.stringify(results[0], null, 2));
        } else {
          console.log('  ⚠️  No results found');
        }
      }
    } catch (error: any) {
      console.log('  ❌ Error:', error.message);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n💡 Findings:');
  console.log('This appears to be GMX v1 (Vault-based), not GMX v2.');
  console.log('GMX v1 does not have explicit "funding rate" in the traditional perp sense.');
  console.log('It has "borrow fees" which are somewhat similar but calculated differently.');
  console.log('\nFor funding rate capture, we need either:');
  console.log('1. A GMX v2 subgraph (with actual funding rates)');
  console.log('2. A different perp protocol (Perpetual Protocol, Gains Network, etc.)');
  console.log('3. Use position-level data to infer effective funding costs\n');
}

explore();

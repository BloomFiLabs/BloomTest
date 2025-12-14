/**
 * Inspect GMX v2 Subgraph Schema
 * Query the subgraph to understand funding rate data structure
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'DiR5cWwB3pwXXQWWdus7fDLR2mnFRQLiBFsVmHAH9VAs';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function inspectSubgraph() {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set');
    process.exit(1);
  }

  console.log('🔍 Inspecting GMX v2 Subgraph\n');
  console.log('Subgraph ID:', GMX_SUBGRAPH_ID);
  console.log('='.repeat(80));

  // Step 1: Try to get schema via introspection query
  console.log('\n📋 Step 1: Fetching schema information...\n');
  
  const introspectionQuery = `
    query {
      __schema {
        types {
          name
          kind
          fields {
            name
            type {
              name
              kind
            }
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: introspectionQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('⚠️  Introspection not available, trying direct queries...\n');
    } else {
      const types = response.data.data.__schema.types;
      const relevantTypes = types.filter((t: any) => 
        t.name && (
          t.name.toLowerCase().includes('funding') ||
          t.name.toLowerCase().includes('market') ||
          t.name.toLowerCase().includes('position')
        )
      );
      
      console.log('Found relevant types:');
      relevantTypes.forEach((t: any) => {
        console.log(`\n  Type: ${t.name} (${t.kind})`);
        if (t.fields && t.fields.length > 0) {
          t.fields.slice(0, 10).forEach((f: any) => {
            console.log(`    - ${f.name}: ${f.type.name || f.type.kind}`);
          });
          if (t.fields.length > 10) {
            console.log(`    ... and ${t.fields.length - 10} more fields`);
          }
        }
      });
    }
  } catch (error: any) {
    console.log('⚠️  Introspection failed:', error.message);
  }

  // Step 2: Try common GMX v2 entities
  console.log('\n\n📊 Step 2: Querying common GMX v2 entities...\n');
  
  const commonQueries = [
    {
      name: 'Markets',
      query: `{ markets(first: 5) { id marketToken indexToken longToken shortToken } }`
    },
    {
      name: 'MarketInfos',
      query: `{ marketInfos(first: 5) { id market fundingFeeAmountPerSize borrowingFactorPerSecond } }`
    },
    {
      name: 'Funding Fees',
      query: `{ collectedMarketFeesInfos(first: 5, orderBy: timestampGroup, orderDirection: desc, where: { period: "1h" }) { 
        id 
        timestampGroup 
        cumulativeFundingFeeUsdPerPoolValue
        fundingFeeAmountPerSize
        market
      } }`
    },
    {
      name: 'Price Updates',
      query: `{ priceCandles(first: 5, orderBy: timestamp, orderDirection: desc, where: { period: "1h" }) {
        id
        timestamp
        tokenAddress
        high
        low
        open
        close
      } }`
    }
  ];

  for (const test of commonQueries) {
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

  // Step 3: Check for funding-specific data
  console.log('\n\n💰 Step 3: Looking for funding rate data structures...\n');
  
  const fundingQueries = [
    {
      name: 'CollectedMarketFeesInfo (detailed)',
      query: `{ 
        collectedMarketFeesInfos(
          first: 10, 
          orderBy: timestampGroup, 
          orderDirection: desc,
          where: { period: "1h" }
        ) {
          id
          market
          period
          timestampGroup
          cumulativeFundingFeeUsdPerPoolValue
          fundingFeeAmountPerSize
          cumulativeBorrowingFeeUsdPerPoolValue
        }
      }`
    }
  ];

  for (const test of fundingQueries) {
    console.log(`${test.name}:`);
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
          console.log('\n  First 3 samples:');
          results.slice(0, 3).forEach((r: any, i: number) => {
            console.log(`\n  [${i + 1}] Timestamp: ${new Date(parseInt(r.timestampGroup) * 1000).toISOString()}`);
            console.log(`      Market: ${r.market}`);
            console.log(`      Cumulative Funding: ${r.cumulativeFundingFeeUsdPerPoolValue}`);
            console.log(`      Funding Per Size: ${r.fundingFeeAmountPerSize}`);
          });
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

inspectSubgraph();




import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const SYNTHETIX_SUBGRAPH_ID = '82hQpNuzNB5i5xcFKhk6ZiKcacTWvPeovAkxrKsm8dfM';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${SYNTHETIX_SUBGRAPH_ID}`;

async function inspectSynthetix() {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set');
    process.exit(1);
  }

  console.log('🔍 Inspecting Synthetix Subgraph\n');
  console.log('Subgraph ID:', SYNTHETIX_SUBGRAPH_ID);
  console.log('='.repeat(80));

  // Step 1: Introspect schema
  console.log('\n📋 Step 1: Discovering available entities...\n');
  
  const introspectionQuery = `
    query {
      __schema {
        queryType {
          fields {
            name
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
      console.log('❌ Introspection failed:', response.data.errors[0].message);
      return;
    }

    const fields = response.data.data.__schema.queryType.fields;
    console.log(`✅ Found ${fields.length} queryable entities\n`);
    
    const relevantFields = fields.filter((f: any) => 
      !f.name.startsWith('_') && 
      (f.name.toLowerCase().includes('market') ||
       f.name.toLowerCase().includes('funding') ||
       f.name.toLowerCase().includes('rate') ||
       f.name.toLowerCase().includes('position') ||
       f.name.toLowerCase().includes('stat'))
    );
    
    console.log('Relevant entities:');
    relevantFields.forEach((f: any) => {
      console.log(`  - ${f.name}`);
    });
    
    console.log('\n\nAll entities:');
    fields.filter((f: any) => !f.name.startsWith('_')).forEach((f: any) => {
      console.log(`  - ${f.name}`);
    });
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    return;
  }

  // Step 2: Try to query markets
  console.log('\n\n📊 Step 2: Querying market data...\n');
  
  const marketQueries = [
    {
      name: 'Markets',
      query: `{ markets(first: 5) { id marketKey asset feedAddress } }`
    },
    {
      name: 'FuturesMarkets',
      query: `{ futuresMarkets(first: 5) { id marketKey asset trackingCode } }`
    },
    {
      name: 'PerpsV2Markets',
      query: `{ perpsV2Markets(first: 5) { id marketKey asset maxLeverage fundingRate } }`
    }
  ];

  for (const test of marketQueries) {
    console.log(`${test.name}:`);
    console.log('─'.repeat(80));
    try {
      const response = await axios.post(
        SUBGRAPH_URL,
        { query: test.query },
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );

      if (response.data.errors) {
        console.log(`  ❌ Query failed: ${response.data.errors[0].message}`);
      } else if (response.data.data) {
        const key = Object.keys(response.data.data)[0];
        const results = response.data.data[key];
        if (results && results.length > 0) {
          console.log(`  ✅ Found ${results.length} results\n`);
          console.log('  Sample:');
          console.log(JSON.stringify(results[0], null, 2));
        } else {
          console.log('  ⚠️  No results found');
        }
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    console.log('');
  }

  // Step 3: Look for funding rate data
  console.log('\n💰 Step 3: Looking for funding rate data...\n');
  
  const fundingQueries = [
    {
      name: 'FundingRateUpdates',
      query: `{ 
        fundingRateUpdates(first: 10, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          market
          fundingRate
          marketKey
        }
      }`
    },
    {
      name: 'FundingRateComputed (Alternative)',
      query: `{
        fundingRateComputeds(first: 10, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          market
          funding
          fundingRate
        }
      }`
    },
    {
      name: 'Market Snapshots',
      query: `{
        marketDailySnapshots(first: 5, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          market
          fundingRate
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
        console.log(`  ❌ Query failed: ${response.data.errors[0].message}`);
      } else if (response.data.data) {
        const key = Object.keys(response.data.data)[0];
        const results = response.data.data[key];
        if (results && results.length > 0) {
          console.log(`  ✅ Found ${results.length} funding rate records!\n`);
          console.log('  Recent funding rates:');
          results.slice(0, 5).forEach((r: any) => {
            console.log(`    ${new Date((r.timestamp || r.timestamp) * 1000).toISOString()}`);
            console.log(`      Market: ${r.market || r.marketKey}`);
            console.log(`      Funding Rate: ${r.fundingRate || r.funding}`);
          });
        } else {
          console.log('  ⚠️  No results found');
        }
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    console.log('');
  }

  console.log('='.repeat(80));
  console.log('\n✅ Inspection complete\n');
}

inspectSynthetix();

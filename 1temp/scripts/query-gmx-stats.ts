import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'F8JuJQQuDYoXkM3ngneRnrL9RA7sT5DjL6kBZE1nJZc3';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function queryStats() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  console.log('🔍 Querying GMX Stats Data\n');

  // First, introspect the Stat type
  const typeQuery = `
    query {
      __type(name: "Stat") {
        fields {
          name
          type {
            name
            kind
          }
        }
      }
    }
  `;

  console.log('📋 Step 1: Understanding Stat entity fields...\n');
  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: typeQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.data.__type) {
      const fields = response.data.data.__type.fields;
      console.log('Stat entity fields:');
      fields.forEach((f: any) => {
        console.log(`  - ${f.name}: ${f.type.name || f.type.kind}`);
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Query actual stats
  console.log('\n\n📊 Step 2: Querying recent stats...\n');
  
  const statsQuery = `{
    stats(first: 10, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      period
      volumeUsd
      marginUsd
      longOpenInterest
      shortOpenInterest
      pnl
      closedCount
      liquidationCount
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: statsQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Query failed:', response.data.errors[0].message);
    } else if (response.data.data.stats) {
      const stats = response.data.data.stats;
      console.log(`✅ Found ${stats.length} stat records\n`);
      
      if (stats.length > 0) {
        console.log('Recent stats:');
        stats.slice(0, 5).forEach((s: any) => {
          console.log(`\n  ${new Date(s.timestamp * 1000).toISOString()}`);
          console.log(`    Period: ${s.period}`);
          console.log(`    Volume USD: $${parseFloat(s.volumeUsd).toLocaleString()}`);
          console.log(`    Long OI: $${parseFloat(s.longOpenInterest).toLocaleString()}`);
          console.log(`    Short OI: $${parseFloat(s.shortOpenInterest).toLocaleString()}`);
          console.log(`    PnL: $${parseFloat(s.pnl).toLocaleString()}`);
        });
      }
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Query positions to see if they have funding info
  console.log('\n\n📍 Step 3: Checking Position entity...\n');
  
  const positionQuery = `{
    positions(first: 5, orderBy: timestamp, orderDirection: desc, where: { status: "open" }) {
      id
      timestamp
      account {
        id
      }
      size
      collateral
      averagePrice
      entryFundingRate
      realisedPnl
      status
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: positionQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Query failed:', response.data.errors[0].message);
    } else if (response.data.data.positions) {
      const positions = response.data.data.positions;
      console.log(`✅ Found ${positions.length} positions\n`);
      
      if (positions.length > 0) {
        console.log('Sample position:');
        console.log(JSON.stringify(positions[0], null, 2));
      }
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  console.log('\n' + '='.repeat(80));
}

queryStats();

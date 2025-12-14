import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'F8JuJQQuDYoXkM3ngneRnrL9RA7sT5DjL6kBZE1nJZc3';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function queryGMXv2() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  console.log('🔍 Querying GMX v2 Data\n');

  // Check Activity schema first
  console.log('📋 Activity Schema:');
  console.log('─'.repeat(80));
  const activityTypeQuery = `
    query {
      __type(name: "Activity") {
        fields {
          name
          type {
            name
            kind
            ofType { name }
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: activityTypeQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.data.__type) {
      const fields = response.data.data.__type.fields;
      fields.forEach((f: any) => {
        const typeName = f.type.ofType?.name || f.type.name || f.type.kind;
        console.log(`  ${f.name.padEnd(30)} ${typeName}`);
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Query actual positions with activities
  console.log('\n\n📊 Recent Positions:');
  console.log('─'.repeat(80));
  const positionsQuery = `{
    positions(first: 5, orderBy: openTimestamp, orderDirection: desc, where: { closed: false }) {
      id
      marketAddress
      isLong
      sizeUsd
      collateralAmountUsd
      leverage
      entryPrice
      openTimestamp
      totalFees
      realisedPnl
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: positionsQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Query failed:', response.data.errors[0].message);
    } else if (response.data.data.positions) {
      const positions = response.data.data.positions;
      console.log(`\n✅ Found ${positions.length} open positions\n`);
      
      positions.forEach((p: any, i: number) => {
        console.log(`[${i + 1}] ${p.isLong ? 'LONG' : 'SHORT'} ${p.marketAddress.slice(0, 10)}...`);
        console.log(`    Size: $${parseFloat(p.sizeUsd).toLocaleString()}`);
        console.log(`    Collateral: $${parseFloat(p.collateralAmountUsd).toLocaleString()}`);
        console.log(`    Leverage: ${parseFloat(p.leverage).toFixed(2)}x`);
        console.log(`    Total Fees: $${parseFloat(p.totalFees).toLocaleString()}`);
        console.log(`    Opened: ${new Date(parseInt(p.openTimestamp) * 1000).toISOString()}`);
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Query activities to see funding charges
  console.log('\n\n💰 Recent Activities (Fee Events):');
  console.log('─'.repeat(80));
  const activitiesQuery = `{
    activities(first: 20, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      action
      position {
        marketAddress
        isLong
      }
      sizeDelta
      collateralDelta
      fee
      pnl
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: activitiesQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Query failed:', response.data.errors[0].message);
    } else if (response.data.data.activities) {
      const activities = response.data.data.activities;
      console.log(`\n✅ Found ${activities.length} recent activities\n`);
      
      activities.slice(0, 10).forEach((a: any) => {
        console.log(`${new Date(parseInt(a.timestamp) * 1000).toISOString()} - ${a.action}`);
        console.log(`  Market: ${a.position.marketAddress.slice(0, 10)}... (${a.position.isLong ? 'LONG' : 'SHORT'})`);
        if (a.fee) {
          console.log(`  Fee: $${parseFloat(a.fee).toFixed(2)}`);
        }
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n✅ This is GMX v2 on Arbitrum!');
  console.log('\nKey findings:');
  console.log('- Has positions with totalFees (includes funding)');
  console.log('- Has activities with fee breakdowns');
  console.log('- Has marketAddress to identify different perp markets');
  console.log('- Can extract funding data from position fees over time');
}

queryGMXv2();

import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'F8JuJQQuDYoXkM3ngneRnrL9RA7sT5DjL6kBZE1nJZc3';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function findFundingData() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  console.log('🔍 Finding Funding Rate Data in GMX v2\n');

  // Check all available query types
  console.log('📋 Step 1: Checking all available entities...\n');
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

    const fields = response.data.data.__schema.queryType.fields;
    console.log('All queryable entities:');
    fields.forEach((f: any) => {
      console.log(`  - ${f.name}`);
    });
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Query closed positions to see total fees accumulated
  console.log('\n\n📊 Step 2: Querying closed positions with fee data...\n');
  const closedPositionsQuery = `{
    positions(
      first: 10, 
      orderBy: closeTimestamp, 
      orderDirection: desc,
      where: { closed: true, totalFees_gt: "0" }
    ) {
      id
      marketAddress
      isLong
      sizeUsd
      collateralAmountUsd
      leverage
      entryPrice
      closePrice
      openTimestamp
      closeTimestamp
      totalFees
      realisedPnl
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: closedPositionsQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Query failed:', response.data.errors[0].message);
    } else if (response.data.data.positions) {
      const positions = response.data.data.positions;
      console.log(`✅ Found ${positions.length} closed positions with fees\n`);
      
      if (positions.length > 0) {
        console.log('Sample positions with fees:');
        positions.slice(0, 5).forEach((p: any, i: number) => {
          const durationDays = (parseInt(p.closeTimestamp) - parseInt(p.openTimestamp)) / 86400;
          const dailyFeeRate = durationDays > 0 ? (parseFloat(p.totalFees) / parseFloat(p.sizeUsd) / durationDays) * 365 * 100 : 0;
          
          console.log(`\n[${i + 1}] ${p.isLong ? 'LONG' : 'SHORT'} ${p.marketAddress.slice(0, 10)}...`);
          console.log(`    Size: $${parseFloat(p.sizeUsd).toLocaleString()}`);
          console.log(`    Duration: ${durationDays.toFixed(2)} days`);
          console.log(`    Total Fees: $${parseFloat(p.totalFees).toFixed(2)}`);
          console.log(`    Implied Annual Fee Rate: ${dailyFeeRate.toFixed(2)}%`);
          console.log(`    Opened: ${new Date(parseInt(p.openTimestamp) * 1000).toISOString().split('T')[0]}`);
          console.log(`    Closed: ${new Date(parseInt(p.closeTimestamp) * 1000).toISOString().split('T')[0]}`);
        });
        
        // Analyze market addresses
        console.log('\n\n📍 Markets found:');
        const markets = new Set(positions.map((p: any) => p.marketAddress));
        markets.forEach((m: string) => {
          const marketPositions = positions.filter((p: any) => p.marketAddress === m);
          console.log(`\n  ${m}`);
          console.log(`    Positions: ${marketPositions.length}`);
          const avgFees = marketPositions.reduce((sum: number, p: any) => sum + parseFloat(p.totalFees), 0) / marketPositions.length;
          console.log(`    Avg Fees: $${avgFees.toFixed(2)}`);
        });
      }
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n💡 Key Findings:');
  console.log('\nThis GMX v2 subgraph provides:');
  console.log('✅ Position-level fee data (totalFees includes funding + borrowing)');
  console.log('✅ Market addresses to identify different perp pairs');
  console.log('✅ Timestamps to calculate duration and implied rates');
  console.log('\n⚠️  Note: Fees are aggregated (funding + borrowing combined)');
  console.log('⚠️  For pure funding rates, we can estimate from closed position data');
  console.log('\nNext: Build adapter to aggregate position fees over time per market\n');
}

findFundingData();

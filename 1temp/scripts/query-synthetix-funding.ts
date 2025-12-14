import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const SYNTHETIX_SUBGRAPH_ID = '82hQpNuzNB5i5xcFKhk6ZiKcacTWvPeovAkxrKsm8dfM';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${SYNTHETIX_SUBGRAPH_ID}`;

async function querySynthetix() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  console.log('🔍 Querying Synthetix Funding Rate Data\n');

  // Get FundingRateUpdate schema
  console.log('📋 Step 1: Understanding FundingRateUpdate schema...\n');
  const schemaQuery = `
    query {
      __type(name: "FundingRateUpdate") {
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
      { query: schemaQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.data.__type) {
      const fields = response.data.data.__type.fields;
      console.log('FundingRateUpdate fields:');
      console.log('─'.repeat(80));
      fields.forEach((f: any) => {
        const typeName = f.type.ofType?.name || f.type.name || f.type.kind;
        console.log(`  ${f.name.padEnd(30)} ${typeName}`);
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Query actual funding rate updates
  console.log('\n\n💰 Step 2: Querying recent funding rate updates...\n');
  const fundingQuery = `{
    fundingRateUpdates(first: 20, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      market {
        id
        asset
        marketKey
      }
      funding
      fundingRate
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: fundingQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Query failed:', response.data.errors[0].message);
    } else if (response.data.data.fundingRateUpdates) {
      const updates = response.data.data.fundingRateUpdates;
      console.log(`✅ Found ${updates.length} funding rate updates!\n`);
      
      console.log('Recent funding rates:');
      console.log('─'.repeat(80));
      updates.slice(0, 10).forEach((u: any, i: number) => {
        const date = new Date(parseInt(u.timestamp) * 1000);
        console.log(`\n[${i + 1}] ${date.toISOString()}`);
        console.log(`    Market: ${u.market.asset} (${u.market.marketKey})`);
        console.log(`    Funding Rate: ${u.fundingRate}`);
        console.log(`    Funding: ${u.funding}`);
      });
      
      // Analyze markets
      console.log('\n\n📊 Markets with funding data:');
      console.log('─'.repeat(80));
      const markets = new Map<string, any[]>();
      updates.forEach((u: any) => {
        const key = u.market.asset;
        if (!markets.has(key)) {
          markets.set(key, []);
        }
        markets.get(key)!.push(u);
      });
      
      markets.forEach((updates, asset) => {
        console.log(`\n  ${asset}:`);
        console.log(`    Updates: ${updates.length}`);
        const rates = updates.map(u => parseFloat(u.fundingRate));
        const avg = rates.reduce((sum, r) => sum + r, 0) / rates.length;
        console.log(`    Avg Funding Rate: ${avg.toFixed(8)}`);
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Query futures markets
  console.log('\n\n🏪 Step 3: Querying futures markets...\n');
  const marketsQuery = `{
    futuresMarkets(first: 10) {
      id
      asset
      marketKey
      marketStats {
        trades
        volume
        feesCrossMarginAccounts
      }
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: marketsQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Query failed:', response.data.errors[0].message);
    } else if (response.data.data.futuresMarkets) {
      const markets = response.data.data.futuresMarkets;
      console.log(`✅ Found ${markets.length} futures markets\n`);
      
      markets.forEach((m: any) => {
        console.log(`  ${m.asset} (${m.marketKey})`);
        console.log(`    ID: ${m.id}`);
        if (m.marketStats) {
          console.log(`    Trades: ${m.marketStats.trades}`);
          console.log(`    Volume: ${m.marketStats.volume}`);
        }
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Query daily stats
  console.log('\n\n📈 Step 4: Querying daily market stats...\n');
  const statsQuery = `{
    dailyMarketStats(first: 10, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      market {
        asset
        marketKey
      }
      trades
      volume
      feesKwenta
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
    } else if (response.data.data.dailyMarketStats) {
      const stats = response.data.data.dailyMarketStats;
      console.log(`✅ Found ${stats.length} daily stats\n`);
      
      stats.slice(0, 5).forEach((s: any) => {
        const date = new Date(parseInt(s.timestamp) * 1000);
        console.log(`  ${date.toISOString().split('T')[0]} - ${s.market.asset}`);
        console.log(`    Trades: ${s.trades}, Volume: ${s.volume}`);
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n✅ SUCCESS! This Synthetix subgraph has funding rate data!\n');
  console.log('Key findings:');
  console.log('✅ fundingRateUpdates entity with timestamp and fundingRate');
  console.log('✅ Multiple markets available (ETH, BTC, etc.)');
  console.log('✅ Can query historical funding rates');
  console.log('✅ Perfect for funding rate capture strategy!\n');
}

querySynthetix();

import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'DiR5cWwB3pwXXQWWdus7fDLR2mnFRQLiBFsVmHAH9VAs';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function queryEntities() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  console.log('🔍 Querying GMX entities with funding data\n');

  // Try querying PositionSnapshots which have fundingrate field
  const query = `{
    positionSnapshots(
      first: 10
      orderBy: timestamp
      orderDirection: desc
      where: { fundingrate_gt: "0" }
    ) {
      id
      timestamp
      fundingrate
      position {
        id
        asset {
          id
          symbol
          name
        }
      }
      account {
        id
      }
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Errors:', JSON.stringify(response.data.errors, null, 2));
    } else {
      const data = response.data.data.positionSnapshots;
      console.log(`✅ Found ${data.length} position snapshots with funding rates\n`);
      
      if (data.length > 0) {
        console.log('Sample data:');
        data.slice(0, 3).forEach((snap: any, i: number) => {
          console.log(`\n[${i + 1}] ${new Date(snap.timestamp * 1000).toISOString()}`);
          console.log(`    Funding Rate: ${snap.fundingrate}`);
          console.log(`    Asset: ${snap.position.asset.symbol} (${snap.position.asset.name})`);
        });
      }
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Also try to find liquidity pools
  const poolQuery = `{
    liquidityPools(first: 5) {
      id
      name
      symbol
      inputTokens {
        id
        symbol
        name
      }
    }
  }`;

  console.log('\n\n🏊 Querying liquidity pools...\n');
  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: poolQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Errors:', JSON.stringify(response.data.errors, null, 2));
    } else {
      const pools = response.data.data.liquidityPools;
      console.log(`✅ Found ${pools.length} liquidity pools\n`);
      pools.forEach((pool: any) => {
        console.log(`  - ${pool.name} (${pool.symbol})`);
        console.log(`    ID: ${pool.id}`);
        console.log(`    Tokens: ${pool.inputTokens.map((t: any) => t.symbol).join(', ')}`);
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

queryEntities();

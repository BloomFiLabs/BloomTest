import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'F8JuJQQuDYoXkM3ngneRnrL9RA7sT5DjL6kBZE1nJZc3';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function checkSchema() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  console.log('🔍 Checking Position Schema\n');

  const typeQuery = `
    query {
      __type(name: "Position") {
        fields {
          name
          type {
            name
            kind
            ofType {
              name
            }
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: typeQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.data.__type) {
      const fields = response.data.data.__type.fields;
      console.log('Position entity fields:');
      console.log('─'.repeat(80));
      fields.forEach((f: any) => {
        const typeName = f.type.ofType?.name || f.type.name || f.type.kind;
        console.log(`  ${f.name.padEnd(30)} ${typeName}`);
      });
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }

  // Try a basic query to see what data is actually there
  console.log('\n\n📊 Sample Position Data:\n');
  const basicQuery = `{
    positions(first: 2) {
      id
      size
      collateral
      averagePrice
      entryFundingRate
      realisedPnl
    }
  }`;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: basicQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Query failed:', response.data.errors[0].message);
    } else if (response.data.data.positions) {
      const positions = response.data.data.positions;
      console.log(`✅ Found ${positions.length} positions`);
      console.log(JSON.stringify(positions, null, 2));
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

checkSchema();

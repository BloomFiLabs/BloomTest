import 'dotenv/config';
import axios from 'axios';

const SUBGRAPH_ID = 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk';
const API_KEY = process.env.THE_GRAPH_API_KEY;

async function main() {
  if (!API_KEY) {
    throw new Error('THE_GRAPH_API_KEY not set');
  }

  const url = `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
  console.log(`Inspecting Subgraph: ${url}`);

  // 1. Introspect Schema (Basic Entities)
  const query = `
    {
      _meta {
        deployment
        block {
          number
        }
      }
      # Check for Aave V3 entities
      reserves(first: 5) {
        id
        symbol
        name
        aToken { id symbol }
        vToken { id symbol }
        baseLTVasCollateral
        reserveFactor
      }
      # Check for Morpho entities (if it's not Aave)
      markets(first: 5) {
        id
        inputToken { symbol }
        outputToken { symbol }
      }
    }
  `;

  try {
    const response = await axios.post(url, { query });
    
    if (response.data.errors) {
      console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
      return;
    }

    const data = response.data.data;
    console.log('Metadata:', data._meta);
    
    if (data.reserves && data.reserves.length > 0) {
      console.log('\nDetected Aave V3 Structure. Sample Reserves:');
      data.reserves.forEach((r: any) => {
        console.log(`- ${r.symbol} (${r.name})`);
      });
    } else if (data.markets && data.markets.length > 0) {
      console.log('\nDetected Generic/Morpho Structure. Sample Markets:');
      data.markets.forEach((m: any) => console.log(m));
    } else {
      console.log('\nUnknown Structure. Available keys:', Object.keys(data));
    }

  } catch (error: any) {
    console.error('Request failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

main();

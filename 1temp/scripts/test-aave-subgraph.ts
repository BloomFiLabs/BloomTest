import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

async function testSubgraph() {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  const subgraphUrl = 'https://gateway.thegraph.com/api/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF';
  
  // Query to get subgraph metadata
  const query = `
    query {
      reserves(first: 3, orderBy: totalLiquidity, orderDirection: desc) {
        id
        symbol
        name
        underlyingAsset
        decimals
        liquidityRate
        variableBorrowRate
      }
    }
  `;
  
  try {
    const response = await axios.post(
      subgraphUrl,
      { query },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    console.log('Subgraph Response:');
    console.log(JSON.stringify(response.data, null, 2));
    
    if (response.data.data?.reserves) {
      const reserve = response.data.data.reserves[0];
      console.log('\nFirst reserve details:');
      console.log('Symbol:', reserve.symbol);
      console.log('Address:', reserve.underlyingAsset);
      console.log('Raw liquidityRate:', reserve.liquidityRate);
      
      // Try conversion
      const SECONDS_PER_YEAR = 31536000;
      const RAY = 1e27;
      const rate = parseFloat(reserve.liquidityRate);
      const apr = (rate * SECONDS_PER_YEAR / RAY) * 100;
      console.log('Converted APR:', apr.toFixed(2) + '%');
    }
  } catch (error: any) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

testSubgraph();




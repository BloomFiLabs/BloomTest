import 'dotenv/config';
import axios from 'axios';

const SUBGRAPH_ID = 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk';
const API_KEY = process.env.THE_GRAPH_API_KEY;

async function main() {
  const url = `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
  
  // Search for PYUSD and USDT
  const query = `
    {
      markets(where: { 
        inputToken_: { symbol_in: ["PYUSD", "USDT", "USDC"] }
        isActive: true 
      }) {
        id
        name
        inputToken {
          symbol
          decimals
        }
        maximumLTV
        rates {
          rate
          side
          type
        }
        totalValueLockedUSD
      }
    }
  `;

  try {
    const response = await axios.post(url, { query });
    const data = response.data.data;
    
    console.log('Found Markets:');
    data.markets.forEach((m: any) => {
      const supply = m.rates.find((r: any) => r.side === 'LENDER')?.rate || 0;
      const borrow = m.rates.find((r: any) => r.side === 'BORROWER' && r.type === 'VARIABLE')?.rate || 0;
      console.log(`${m.inputToken.symbol}: LTV ${m.maximumLTV}%, Supply ${supply}%, Borrow ${borrow}%`);
    });

  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

main();

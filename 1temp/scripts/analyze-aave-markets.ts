import 'dotenv/config';
import axios from 'axios';

const SUBGRAPH_ID = 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk';
const API_KEY = process.env.THE_GRAPH_API_KEY;

async function main() {
  const url = `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
  
  const query = `
    {
      lendingProtocols {
        name
        slug
        network
      }
      markets(first: 1000, where: { isActive: true }) {
        id
        name
        inputToken {
          symbol
          name
          decimals
        }
        rates {
          rate
          side
          type
        }
        maximumLTV
        liquidationThreshold
        inputTokenPriceUSD
        totalValueLockedUSD
      }
    }
  `;

  try {
    const response = await axios.post(url, { query });
    const data = response.data.data;
    
    console.log('Protocol:', data.lendingProtocols[0]?.name);
    
    const targetSymbols = ['WSTETH', 'ETH', 'WETH', 'RLUSD', 'USDT0', 'USDE', 'PYUSD'];
    
    const relevantMarkets = data.markets.filter((m: any) => 
      targetSymbols.some(s => m.inputToken.symbol.toUpperCase().includes(s))
    );

    console.log(`\nFound ${relevantMarkets.length} relevant markets:\n`);

    relevantMarkets.forEach((m: any) => {
      const supplyRate = m.rates.find((r: any) => r.side === 'LENDER')?.rate || 0;
      const borrowRate = m.rates.find((r: any) => r.side === 'BORROWER' && r.type === 'VARIABLE')?.rate || 0;
      
      console.log(`Asset: ${m.inputToken.symbol} (${m.name})`);
      console.log(`  - ID: ${m.id}`);
      console.log(`  - TVL: $${parseFloat(m.totalValueLockedUSD).toLocaleString()}`);
      console.log(`  - Price: $${parseFloat(m.inputTokenPriceUSD).toFixed(2)}`);
      console.log(`  - Max LTV: ${m.maximumLTV}%`);
      console.log(`  - Supply APY: ${supplyRate}%`);
      console.log(`  - Borrow APY: ${borrowRate}%`);
      console.log('---');
    });

  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

main();

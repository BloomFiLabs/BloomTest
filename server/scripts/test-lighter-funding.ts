import axios from 'axios';

async function main() {
  const baseUrl = 'https://mainnet.zklighter.elliot.ai';
  const fundingUrl = `${baseUrl}/api/v1/funding-rates`;
  
  try {
    const response = await axios.get(fundingUrl);
    console.log('Lighter Funding Rates Response:');
    const zoraRate = response.data.funding_rates.find((r: any) => r.symbol === 'ZORA');
    console.log(JSON.stringify(zoraRate, null, 2));
    
    // Also check 0G
    const ogRate = response.data.funding_rates.find((r: any) => r.symbol === '0G');
    console.log('0G Rate:');
    console.log(JSON.stringify(ogRate, null, 2));
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

main();


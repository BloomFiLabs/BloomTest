import axios from 'axios';
import { ethers } from 'ethers';
import 'dotenv/config';
import { loadConfig, signParams } from './open-perp-position';

const DEFAULT_BASE_URL = 'https://fapi.asterdex.com';
const ORDER_ENDPOINT = '/fapi/v3/order';

async function testAvaxLimitOrder() {
  const config = loadConfig();
  const client = axios.create({
    baseURL: config.baseUrl,
    timeout: 30000,
  });

  // Test with AVAXUSDT
  const symbol = 'AVAXUSDT';
  
  // Fetch exchange info to get stepSize
  let stepSize = 0.001;
  try {
    const exchangeInfoResponse = await client.get(`/fapi/v1/exchangeInfo`);
    const symbolInfo = exchangeInfoResponse.data.symbols?.find((s: any) => s.symbol === symbol);
    if (symbolInfo) {
      const quantityFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      if (quantityFilter?.stepSize) {
        stepSize = parseFloat(quantityFilter.stepSize);
        console.log(`Step size for ${symbol}: ${stepSize}`);
      }
    }
  } catch (error) {
    console.warn('Could not fetch exchange info');
  }

  // Fetch current price
  let currentPrice: number;
  try {
    const priceResponse = await client.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
    currentPrice = parseFloat(priceResponse.data.price);
    console.log(`Current ${symbol} price: $${currentPrice}`);
  } catch (error) {
    throw new Error('Could not fetch current price');
  }

  // Test with quantity = 1 (matching the failing case)
  const rawQuantity = 1.341366660474793; // Same as failing case
  const precision = stepSize.toString().split('.')[1]?.length || 3;
  
  // Round to stepSize first
  const roundedSize = Math.round(rawQuantity / stepSize) * stepSize;
  
  // Format quantity - matching our adapter logic
  let quantity: string;
  if (stepSize >= 1 && precision === 0) {
    quantity = Math.round(roundedSize).toFixed(0);
  } else {
    quantity = roundedSize.toFixed(precision);
  }
  
  console.log(`\n📊 Test Parameters:`);
  console.log(`   Raw quantity: ${rawQuantity}`);
  console.log(`   Step size: ${stepSize}`);
  console.log(`   Precision: ${precision}`);
  console.log(`   Rounded size: ${roundedSize}`);
  console.log(`   Formatted quantity: "${quantity}" (type: ${typeof quantity})`);

  // Generate nonce
  const nonce = Math.floor(Date.now() * 1000);

  // Create LIMIT order (SELL/SHORT)
  const orderParams: Record<string, any> = {
    symbol,
    positionSide: 'BOTH',
    side: 'SELL', // SHORT position
    type: 'LIMIT',
    quantity, // String quantity
    price: currentPrice.toFixed(8), // Limit price
    timeInForce: 'GTC',
    recvWindow: 50000,
  };

  console.log(`\n📤 Order Params:`);
  console.log(JSON.stringify(orderParams, null, 2));

  // Sign the parameters
  const signedParams = signParams(
    orderParams,
    config.user,
    config.signer,
    config.privateKey,
    nonce,
  );

  // Create form data
  const formData = new URLSearchParams();
  for (const [key, value] of Object.entries(signedParams)) {
    if (value !== null && value !== undefined) {
      formData.append(key, String(value));
    }
  }

  console.log(`\n📋 Form Data (first 200 chars):`);
  console.log(formData.toString().substring(0, 200) + '...');
  console.log(`\n🔍 Quantity in form data: ${formData.get('quantity')}`);

  try {
    console.log(`\n🚀 Placing LIMIT order...`);
    const response = await client.post(ORDER_ENDPOINT, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    console.log(`\n✅ Order placed successfully!`);
    console.log(`Response:`, JSON.stringify(response.data, null, 2));
  } catch (error: any) {
    console.error(`\n❌ Order failed:`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Response:`, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(`Error:`, error.message);
    }
    throw error;
  }
}

testAvaxLimitOrder().catch(console.error);









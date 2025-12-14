import { SignerClient } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY;
const LIGHTER_ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const LIGHTER_API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '2');

async function main() {
  console.log('🔍 Checking Lighter Fast Withdraw Pool...\n');

  if (!LIGHTER_API_KEY) {
    throw new Error('LIGHTER_API_KEY environment variable is required');
  }

  // Normalize API key (remove 0x if present)
  const normalizedApiKey = LIGHTER_API_KEY.startsWith('0x')
    ? LIGHTER_API_KEY.slice(2)
    : LIGHTER_API_KEY;

  // Initialize SignerClient
  const signerClient = new SignerClient({
    url: LIGHTER_API_BASE_URL,
    privateKey: normalizedApiKey,
    accountIndex: LIGHTER_ACCOUNT_INDEX,
    apiKeyIndex: LIGHTER_API_KEY_INDEX,
  });

  await signerClient.initialize();
  await signerClient.ensureWasmClient();

  try {
    // Create auth token
    const authToken = await signerClient.createAuthTokenWithExpiry(600);

    // Get pool info
    const response = await axios.get(
      `${LIGHTER_API_BASE_URL}/api/v1/fastwithdraw/info`,
      {
        params: { 
          account_index: LIGHTER_ACCOUNT_INDEX,
          auth: authToken
        },
        timeout: 30000,
      }
    );

    if (response.data.code !== 200) {
      throw new Error(`Pool info failed: ${response.data.message || 'Unknown error'}`);
    }

    const poolLimit = response.data.withdraw_limit;
    const poolLimitUsdc = poolLimit ? (poolLimit / 1e6).toFixed(2) : 'N/A';
    const toAccountIndex = response.data.to_account_index;

    console.log('📊 Fast Withdraw Pool Status:');
    console.log(`   Pool Account: ${toAccountIndex}`);
    console.log(`   Available: $${poolLimitUsdc} USDC`);
    console.log('\n   Raw response:', JSON.stringify(response.data, null, 2));
  } finally {
    await signerClient.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });

import { SignerClient } from '@reservoir0x/lighter-ts-sdk';
import { ethers } from 'ethers';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from server directory first, then parent
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY;
const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY || process.env.PRIVATE_KEY; // Ethereum private key for signing
const LIGHTER_ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const LIGHTER_API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '2');
const WITHDRAW_ADDRESS = process.env.WITHDRAW_ADDRESS || '0x0000000000000000000000000000000000000000';
const AMOUNT_USDC = parseFloat(process.env.AMOUNT_USDC || '10.0');

const ASSET_ID_USDC = 3;
const ROUTE_PERP = 0;

/**
 * Build memo from Ethereum address (20 bytes address + 12 zeros = 32 bytes total)
 */
function buildMemo(address: string): string {
  const cleanAddress = address.toLowerCase().replace(/^0x/, '');
  if (cleanAddress.length !== 40) {
    throw new Error(`Invalid address length: ${cleanAddress.length}`);
  }
  
  // Convert address to bytes (20 bytes)
  const addrBytes = Buffer.from(cleanAddress, 'hex');
  
  // Create 32-byte memo: 20 bytes address + 12 zeros
  const memo = Buffer.alloc(32, 0);
  addrBytes.copy(memo, 0);
  
  // Return as hex string (without 0x prefix, matching Python format)
  return memo.toString('hex');
}

/**
 * Get fast withdraw pool info with retry logic
 */
async function getFastWithdrawInfo(
  accountIndex: number,
  authToken: string,
  maxRetries: number = 3
): Promise<{ to_account_index: number; withdraw_limit?: number }> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`   Attempt ${attempt}/${maxRetries}...`);
      const response = await axios.get(
        `${LIGHTER_API_BASE_URL}/api/v1/fastwithdraw/info`,
        {
          params: { 
            account_index: accountIndex,
            auth: authToken
          },
          timeout: 30000,  // Increased timeout
        }
      );

      if (response.data.code !== 200) {
        throw new Error(`Pool info failed: ${response.data.message || 'Unknown error'}`);
      }

      return {
        to_account_index: response.data.to_account_index,
        withdraw_limit: response.data.withdraw_limit,
      };
    } catch (error: any) {
      lastError = error;
      console.log(`   Attempt ${attempt} failed: ${error.message}`);
      
      if (attempt < maxRetries) {
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  throw lastError;
}

/**
 * Get transfer fee using direct API call
 */
async function getTransferFee(
  accountIndex: number,
  toAccountIndex: number,
  authToken: string
): Promise<number> {
  const response = await axios.get(
    `${LIGHTER_API_BASE_URL}/api/v1/transferFeeInfo`,
    {
      params: {
        account_index: accountIndex,
        to_account_index: toAccountIndex,
        auth: authToken,
      },
      timeout: 10000,
    }
  );

  if (response.data.code !== 200) {
    throw new Error(`Transfer fee failed: ${response.data.message || 'Unknown error'}`);
  }

  // transfer_fee_usdc is already an integer (in micro-USDC, i.e., 1e6)
  return response.data.transfer_fee_usdc;
}

/**
 * Get next nonce and API key index
 */
async function getNextNonce(
  accountIndex: number,
  apiKeyIndex: number
): Promise<{ apiKeyIndex: number; nonce: number }> {
  const response = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/nextNonce`, {
    params: { account_index: accountIndex, api_key_index: apiKeyIndex },
    timeout: 10000,
  });

  if (response.data && typeof response.data === 'object') {
    if (response.data.nonce !== undefined && response.data.api_key_index !== undefined) {
      return {
        apiKeyIndex: response.data.api_key_index,
        nonce: response.data.nonce,
      };
    } else if (response.data.nonce !== undefined) {
      return {
        apiKeyIndex: apiKeyIndex,
        nonce: response.data.nonce,
      };
    }
  } else if (typeof response.data === 'number') {
    return {
      apiKeyIndex: apiKeyIndex,
      nonce: response.data,
    };
  }

  throw new Error(`Unexpected nonce format: ${JSON.stringify(response.data)}`);
}

async function main() {
  console.log('🚀 Lighter Fast Withdraw Script\n');

  if (!LIGHTER_API_KEY) {
    throw new Error('LIGHTER_API_KEY environment variable is required');
  }

  if (!ETH_PRIVATE_KEY) {
    throw new Error('ETH_PRIVATE_KEY or PRIVATE_KEY environment variable is required');
  }

  // Normalize API key (remove 0x if present)
  const normalizedApiKey = LIGHTER_API_KEY.startsWith('0x')
    ? LIGHTER_API_KEY.slice(2)
    : LIGHTER_API_KEY;

  // Normalize Ethereum private key (ensure 0x prefix)
  const normalizedEthKey = ETH_PRIVATE_KEY.startsWith('0x')
    ? ETH_PRIVATE_KEY
    : `0x${ETH_PRIVATE_KEY}`;

  // Derive withdrawal address from Ethereum private key if not set
  let withdrawAddress = WITHDRAW_ADDRESS;
  if (withdrawAddress === '0x0000000000000000000000000000000000000000') {
    const wallet = new ethers.Wallet(normalizedEthKey);
    withdrawAddress = wallet.address;
    console.log(`ℹ️  WITHDRAW_ADDRESS not set, using address from ETH_PRIVATE_KEY: ${withdrawAddress}\n`);
  }

  // Initialize SignerClient
  console.log('🔧 Initializing SignerClient...');
  const signerClient = new SignerClient({
    url: LIGHTER_API_BASE_URL,
    privateKey: normalizedApiKey, // API key for SDK initialization
    accountIndex: LIGHTER_ACCOUNT_INDEX,
    apiKeyIndex: LIGHTER_API_KEY_INDEX,
  });

  await signerClient.initialize();
  await signerClient.ensureWasmClient();
  console.log('✅ SignerClient initialized\n');

  try {
    // 1. Create auth token using the proper SignerClient method
    console.log('🔐 Creating auth token...');
    // Use createAuthTokenWithExpiry with explicit expiry in seconds
    // This is the proper SDK usage as shown in examples/system_setup.ts
    const authToken = await signerClient.createAuthTokenWithExpiry(600); // 10 minutes
    console.log(`✅ Auth token created: ${authToken.substring(0, 50)}...\n`);

    // 2. Get fast withdraw pool info
    console.log('📊 Getting fast withdraw pool info...');
    const poolInfo = await getFastWithdrawInfo(LIGHTER_ACCOUNT_INDEX, authToken);
    const toAccountIndex = poolInfo.to_account_index;
    console.log(`✅ Pool: ${toAccountIndex}, Limit: ${poolInfo.withdraw_limit || 'N/A'}\n`);

    // 3. Get transfer fee
    console.log('💰 Getting transfer fee...');
    const fee = await getTransferFee(LIGHTER_ACCOUNT_INDEX, toAccountIndex, authToken);
    console.log(`✅ Transfer fee: ${fee / 1e6} USDC (${fee} micro-USDC)\n`);

    // 4. Get nonce & API key
    console.log('🔢 Getting next nonce...');
    const { apiKeyIndex, nonce } = await getNextNonce(
      LIGHTER_ACCOUNT_INDEX,
      LIGHTER_API_KEY_INDEX
    );
    console.log(`✅ Nonce: ${nonce}, API Key Index: ${apiKeyIndex}\n`);

    // 5. Build memo (20-byte address + 12 zeros)
    console.log('📝 Building memo...');
    const memoHex = buildMemo(withdrawAddress);
    console.log(`✅ Memo: 0x${memoHex}\n`);

    // 6. Sign transfer with BOTH L2 (Lighter) and L1 (Ethereum) signatures
    // Fast withdraw requires both signatures:
    // - L2 Sig: Signed with Lighter API key (40-byte key)
    // - L1 Sig: Signed with Ethereum private key (for on-chain verification)
    console.log('✍️  Signing transfer...');
    const amountMicroUsdc = Math.floor(AMOUNT_USDC * 1e6);

    // Build the L1 message (matching SDK format)
    const CHAIN_ID = 304; // Lighter chain ID
    const toHex = (value: number): string => '0x' + value.toString(16).padStart(16, '0');
    
    const l1Message = `Transfer\n\nnonce: ${toHex(nonce)}\nfrom: ${toHex(LIGHTER_ACCOUNT_INDEX)} (route ${toHex(ROUTE_PERP)})\napi key: ${toHex(apiKeyIndex)}\nto: ${toHex(toAccountIndex)} (route ${toHex(ROUTE_PERP)})\nasset: ${toHex(ASSET_ID_USDC)}\namount: ${toHex(amountMicroUsdc)}\nfee: ${toHex(fee)}\nchainId: ${toHex(CHAIN_ID)}\nmemo: ${memoHex}\nOnly sign this message for a trusted client!`;
    
    console.log('   L1 Message:');
    console.log('   ' + l1Message.replace(/\n/g, '\n   '));
    
    // Sign L1 message with Ethereum private key
    const wallet = new ethers.Wallet(normalizedEthKey);
    const l1Sig = await wallet.signMessage(l1Message);
    console.log(`   L1 Signature: ${l1Sig.substring(0, 50)}...`);

    // Access the internal wallet signer from the SignerClient
    const wasmSigner = (signerClient as any).wallet;
    
    // Sign transfer using the internal WASM signer (which has the correct Lighter key)
    const transferResult = await wasmSigner.signTransfer({
      toAccountIndex: toAccountIndex,
      assetIndex: ASSET_ID_USDC,
      fromRouteType: ROUTE_PERP,
      toRouteType: ROUTE_PERP,
      amount: amountMicroUsdc,
      usdcFee: fee,
      memo: memoHex, // Hex string without 0x prefix
      nonce: nonce,
    });

    if (transferResult.error) {
      throw new Error(`Failed to sign transfer: ${transferResult.error}`);
    }

    // Add L1 signature to the tx_info
    const txInfoParsed = JSON.parse(transferResult.txInfo);
    txInfoParsed.L1Sig = l1Sig;
    const txInfoStr = JSON.stringify(txInfoParsed);
    console.log(`   TX Info (with L1Sig): ${txInfoStr.substring(0, 120)}...`);

    console.log('✅ Transfer signed\n');

    // 7. Submit to fastwithdraw endpoint
    // Use query param auth (discovered to work for this endpoint)
    console.log('📤 Submitting fast withdraw...');
    console.log(`   Amount: $${AMOUNT_USDC} USDC`);
    console.log(`   To Address: ${withdrawAddress}\n`);
    
    const formData = new URLSearchParams();
    formData.append('tx_info', txInfoStr);
    formData.append('to_address', withdrawAddress);

    const response = await axios.post(
      `${LIGHTER_API_BASE_URL}/api/v1/fastwithdraw?auth=${encodeURIComponent(authToken)}`,
      formData.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );

    if (response.data.code === 200) {
      console.log(`✅ Success! TX: ${response.data.tx_hash || response.data.txHash || 'N/A'}`);
      console.log('Response:', JSON.stringify(response.data, null, 2));
    } else {
      throw new Error(`Failed: ${response.data.message || 'Unknown error'}`);
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  } finally {
    await signerClient.close();
  }
}

if (require.main === module) {
  main()
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}




# Commands to Inspect Lighter SDK Signing Mechanism

## 1. Inspect TypeScript SDK Source Code

### Find SDK location
```bash
cd /home/aurellius/Documents/Bloom/server
readlink -f node_modules/@reservoir0x/lighter-ts-sdk
```

### View SDK structure
```bash
cd /home/aurellius/Documents/Bloom
SDK_PATH=$(readlink -f server/node_modules/@reservoir0x/lighter-ts-sdk)
ls -la "$SDK_PATH"
```

### Inspect WASM signing files (most important!)
```bash
# View WASM signer client (main signing logic)
cat "$SDK_PATH/dist/signer/wasm-signer-client.js" | head -100

# View WASM manager (loads WASM module)
cat "$SDK_PATH/dist/signer/wasm-manager.js" | head -100

# View WASM signer (low-level signing)
cat "$SDK_PATH/dist/signer/wasm-signer.js" | head -100

# Check WASM module location
ls -lh "$SDK_PATH/wasm/"
```

### Search for signing-related code
```bash
cd /home/aurellius/Documents/Bloom
SDK_PATH=$(readlink -f server/node_modules/@reservoir0x/lighter-ts-sdk)

# Search for EIP712 references
grep -r "eip712\|EIP712\|typed.*data" "$SDK_PATH/dist" -i | head -20

# Search for signature creation
grep -r "sign\|Sign\|signature\|Signature" "$SDK_PATH/dist/signer" -i | head -30

# Search for createUnifiedOrder implementation
grep -r "createUnifiedOrder" "$SDK_PATH/dist" -A 10 | head -50
```

### View package.json for repository links
```bash
cat "$SDK_PATH/package.json" | grep -E "(repository|homepage|bugs)"
```

## 2. Inspect Go SDK Reference Implementation

The Go SDK at https://github.com/elliottech/lighter-go is the **reference implementation** showing exactly how signing works.

### Clone and inspect Go SDK
```bash
cd /tmp
git clone https://github.com/elliottech/lighter-go.git
cd lighter-go

# View order signing implementation
cat signer/signer.go | grep -A 50 "SignCreateOrder"

# View EIP712 domain and types
cat signer/signer.go | grep -A 30 "EIP712Domain\|Order"

# View WASM implementation
ls -la wasm/
cat wasm/*.go | head -100
```

### Key files to examine:
- `signer/signer.go` - Main signing functions (SignCreateOrder, SignWithdraw, etc.)
- `types/types.go` - Order structure definitions
- `wasm/` - WASM binding implementation

## 3. Inspect Network Requests

### Add debug logging to capture what SDK sends
Edit `server/src/infrastructure/adapters/lighter/LighterExchangeAdapter.ts`:

```typescript
// After line 507, add:
const result = await this.signerClient!.createUnifiedOrder(orderParams);

// Log full result to see signature format
this.logger.debug(`🔍 SDK Order Result: ${JSON.stringify(result, null, 2)}`);

// Try to access internal signing data
if ((this.signerClient as any).wasmClient) {
  this.logger.debug(`🔍 WASM Client exists: ${typeof (this.signerClient as any).wasmClient}`);
}
```

### Use browser DevTools or network proxy
```bash
# If running in browser, use DevTools Network tab
# Filter for requests to Lighter API (mainnet.zklighter.elliot.ai)

# Or use mitmproxy/Charles to intercept HTTP requests
mitmproxy -p 8080
# Then configure your app to use proxy
```

## 4. Compare with Manual EIP712 Signing

### Your existing manual signing (test-lighter-withdraw.ts)
```bash
cd /home/aurellius/Documents/Bloom/server
cat test-lighter-withdraw.ts | grep -A 50 "createWithdrawalSignature"
```

### Compare domain structure
The Go SDK shows the exact EIP712 domain structure. Compare:
- Domain name
- Domain version  
- Chain ID
- Verifying contract
- Message types

## 5. Inspect WASM Module

The SDK uses a compiled WASM module for signing:

```bash
cd /home/aurellius/Documents/Bloom
SDK_PATH=$(readlink -f server/node_modules/@reservoir0x/lighter-ts-sdk)

# Check WASM file size (indicates complexity)
ls -lh "$SDK_PATH/wasm/lighter-signer.wasm"

# View WASM loader
cat "$SDK_PATH/wasm/wasm_exec.js" | head -50

# The WASM module is compiled Go code - you can't easily inspect it
# But you can compare with the Go SDK source to understand what it does
```

## 6. Quick Inspection Script

Create a script to dump SDK internals:

```bash
cat > /tmp/inspect-lighter-sdk.sh << 'EOF'
#!/bin/bash
SDK_PATH=$(readlink -f /home/aurellius/Documents/Bloom/server/node_modules/@reservoir0x/lighter-ts-sdk)

echo "=== SDK Structure ==="
ls -la "$SDK_PATH"

echo -e "\n=== Package Info ==="
cat "$SDK_PATH/package.json" | jq '{name, version, repository, homepage}'

echo -e "\n=== WASM Files ==="
ls -lh "$SDK_PATH/wasm/"

echo -e "\n=== Signer Files ==="
ls -lh "$SDK_PATH/dist/signer/"

echo -e "\n=== Search for EIP712 ==="
grep -r "eip712\|EIP712" "$SDK_PATH/dist" -i | head -10

echo -e "\n=== Search for createUnifiedOrder ==="
grep -r "createUnifiedOrder" "$SDK_PATH/dist" -A 5 | head -30
EOF

chmod +x /tmp/inspect-lighter-sdk.sh
/tmp/inspect-lighter-sdk.sh
```

## 7. Key Findings from Go SDK

Based on the Go SDK reference implementation:

1. **Signing Method**: Uses EIP712 typed data signing
2. **WASM Module**: The TypeScript SDK loads a compiled Go WASM module (`lighter-signer.wasm`)
3. **Order Structure**: Orders are signed with specific EIP712 domain and message types
4. **Nonce Management**: SDK handles nonce automatically (can fetch from API)

### Go SDK SignCreateOrder signature:
```go
func SignCreateOrder(
    marketIndex uint64,
    clientOrderIndex uint64,
    baseAmount *big.Int,
    price *big.Int,
    isAsk bool,
    orderType uint8,
    timeInForce uint8,
    reduceOnly bool,
    orderExpiry uint64,
    expiredAt uint64,
    nonce int,
    apiKeyIndex uint8,
    accountIndex uint64,
) (string, error)
```

## 8. Verify EIP712 Structure

Compare your manual EIP712 signing (from `test-lighter-withdraw.ts`) with what the SDK likely does:

1. **Domain**: Check if domain matches
2. **Types**: Verify Order type structure matches
3. **Message**: Ensure message fields match order params
4. **Encoding**: Confirm hash encoding matches

## Next Steps

1. Run the inspection script above
2. Compare Go SDK `SignCreateOrder` with your manual signing
3. Add debug logging to see what the SDK actually sends
4. Check if SDK uses same EIP712 domain/types as manual signing



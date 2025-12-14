# Lighter SDK Signing Inspection Results

## Summary

**The signing IS abstracted** - it happens inside a **14MB compiled WASM module** (`lighter-signer.wasm`) that contains compiled Go code.

## Signing Flow

```
1. Your Code
   └─> LighterExchangeAdapter.placeOrder()
       └─> signerClient.createUnifiedOrder(orderParams)
           └─> this.wallet.signCreateOrder(wasmParams)  [WASM Signer Client]
               └─> this.wasmModule.signCreateOrder(...)  [WASM Module Call]
                   └─> lighter-signer.wasm (14MB compiled Go code)
                       └─> Performs EIP712 signing internally
                           └─> Returns signed transaction info (JSON string)
```

## Key Findings

### 1. WASM Module Location
- **File**: `node_modules/@reservoir0x/lighter-ts-sdk/wasm/lighter-signer.wasm`
- **Size**: 14MB (compiled Go code)
- **Purpose**: Contains all signing logic compiled from Go

### 2. Signing Method
```javascript
// From wasm-signer.js
async signCreateOrder(params) {
    await this.ensureInitialized();
    const result = this.wasmModule.signCreateOrder(
        params.marketIndex,
        params.clientOrderIndex,
        params.baseAmount,
        params.price,
        params.isAsk,
        params.orderType,
        params.timeInForce,
        params.reduceOnly,
        params.triggerPrice,
        params.orderExpiry,
        params.nonce,
        this.apiKeyIndex,
        this.accountIndex
    );
    if (result.error) {
        throw new Error(`Failed to sign create order: ${result.error}`);
    }
    return result.txInfo;  // Returns JSON string with signed transaction
}
```

### 3. WASM Functions Exposed
The WASM module exposes these functions (from Go SDK):
- `SignCreateOrder` - Signs order creation (EIP712)
- `SignCancelOrder` - Signs order cancellation
- `SignCancelAllOrders` - Signs batch cancellation
- `SignTransfer` - Signs transfers
- `SignWithdraw` - Signs withdrawals
- `SignUpdateLeverage` - Signs leverage updates
- `CreateAuthToken` - Creates auth tokens
- `GenerateAPIKey` - Generates API key pairs
- `CheckClient` - Verifies client configuration

### 4. EIP712 Signing
- **Yes, it uses EIP712** - The Go SDK reference implementation confirms this
- The actual EIP712 domain, types, and message structure are **inside the WASM module**
- You cannot see the EIP712 structure without:
  1. Inspecting the Go SDK source code (reference implementation)
  2. Decompiling the WASM module (very difficult)
  3. Comparing with your manual EIP712 signing

## How to See the Actual Signing Logic

### Option 1: Go SDK Reference Implementation (Recommended)
```bash
cd /tmp
git clone https://github.com/elliottech/lighter-go.git
cd lighter-go

# View order signing implementation
cat signer/signer.go | grep -A 50 "SignCreateOrder"

# View EIP712 domain and types
cat signer/signer.go | grep -A 30 "EIP712Domain\|Order"
```

The Go SDK at https://github.com/elliottech/lighter-go is the **reference implementation** showing exactly how signing works.

### Option 2: Compare with Your Manual Signing
Your `test-lighter-withdraw.ts` shows manual EIP712 signing for withdrawals. The order signing follows the same pattern but with different domain/types.

### Option 3: Inspect Network Requests
Add debug logging to see what the SDK sends:
```typescript
// In LighterExchangeAdapter.ts after line 507
const result = await this.signerClient!.createUnifiedOrder(orderParams);
this.logger.debug(`🔍 SDK Order Result: ${JSON.stringify(result, null, 2)}`);
```

## Why It's Abstracted

1. **Security**: Private key never exposed to JavaScript
2. **Performance**: Compiled Go is faster than JavaScript
3. **Consistency**: Same signing logic across all SDKs (Go, Python, TypeScript)
4. **Simplicity**: You just call `createUnifiedOrder()` without handling EIP712 details

## SDK Repository

- **TypeScript SDK**: https://github.com/bvvvp009/lighter-ts
- **Go SDK (Reference)**: https://github.com/elliottech/lighter-go
- **Package**: `@reservoir0x/lighter-ts-sdk@1.0.7-alpha9`

## Conclusion

**Yes, signing is EIP712**, but it's compiled into WASM for security and performance. To see the exact EIP712 structure:

1. **Best option**: Check the Go SDK source code (reference implementation)
2. **Alternative**: Compare network requests with your manual EIP712 signing
3. **Advanced**: Decompile WASM (not recommended, very difficult)

The Go SDK at https://github.com/elliottech/lighter-go is your best resource for understanding the exact EIP712 domain, types, and message structure used for order signing.



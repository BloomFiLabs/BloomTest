# Why Unit Tests Didn't Catch the Bugs

## 🎯 **TL;DR**

Your unit tests **mocked away** the exact bugs that occurred in production. The tests passed because they used fake data that was always valid, hiding the real-world issues.

---

## 🐛 **The Bugs That Slipped Through**

### **Bug 1: Bot State Always [$0.00, $0.00]**

**What Happened in Production:**
```typescript
state.priceLower = 0;  // File storage returned 0
state.priceUpper = 0;  // File storage returned 0
```

**What the Test Did:**
```typescript
// BotService.spec.ts line 75-76
(mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(
    new BotState('0x123', '0x123', 90, 110, 100, new Date())  // ✅ Always valid!
);
```

**Why It Didn't Catch the Bug:**
- Test **mocked** the repository to always return valid state (90, 110)
- Real file-based repository **actually returned 0s** due to persistence issues
- Test never exercised the actual storage layer

---

### **Bug 2: Current Price Always $0.00**

**What Happened in Production:**
```typescript
const currentPrice = candles[candles.length - 1].close;  // Sometimes undefined
// Later code tried to use currentPrice but it was 0
```

**What the Test Did:**
```typescript
// BotService.spec.ts line 72
const candles = Array(50).fill(new Candle(new Date(), 100, 110, 90, 105, 1000));
```

**Why It Didn't Catch the Bug:**
- Test **hardcoded** 50 perfect candles, all with price 105
- Real data from The Graph API can be **empty, malformed, or have edge cases**
- Test never checked: "What if candles array is empty?" or "What if last candle has 0 close?"

---

### **Bug 3: Range Calculation Broken [0.0003, 0.0004]**

**What Happened in Production:**
```typescript
const newLower = currentPrice * (1 - halfWidth);  // 0 * 0.995 = 0.0000
const newUpper = currentPrice * (1 + halfWidth);  // 0 * 1.005 = 0.0000
```

**What the Test Did:**
```typescript
// BotService.spec.ts line 126
expect(mockExecutor.rebalance).toHaveBeenCalledWith(pool.strategyAddress);
// ❌ Didn't verify the RANGE VALUES passed to rebalance!
```

**Why It Didn't Catch the Bug:**
- Test **only checked that rebalance was called**
- Test **didn't verify the actual range values** (rangePct1e5 parameter)
- So when production calculated nonsense ranges, tests had no assertion to fail

---

### **Bug 4: Rebalancing Every 5 Minutes (Too Frequent)**

**What Happened in Production:**
```typescript
// Regime change trigger was too sensitive
if (rangeMismatch > 0.5 && !shouldRebalance) {  // 50% threshold
  shouldRebalance = true;  // Triggered constantly!
}
```

**What the Test Did:**
```typescript
// No test for rebalance frequency!
// No test checking: "Should NOT rebalance if range is close enough"
```

**Why It Didn't Catch the Bug:**
- Tests **only checked positive cases** (should rebalance when at edge)
- Tests **didn't check negative cases** (should NOT rebalance when range is only 100% off)
- No test for: "Should rebalance at most once every X minutes"

---

## 📊 **Test Coverage Gaps**

| Area | Current Test | What's Missing |
|------|-------------|----------------|
| **State Persistence** | Mocked (always valid) | Test actual file/DB read/write with edge cases |
| **Empty/Invalid Data** | Perfect 50 candles | Test with 0 candles, 1 candle, invalid prices |
| **Zero Value Handling** | All prices > 0 | Test with price = 0, range = 0 |
| **Range Calculation** | Only checks rebalance called | Verify actual range values passed |
| **Rebalance Frequency** | No test | Ensure not rebalancing too often |
| **State Corruption Recovery** | No test | Test auto-recovery from zero state |

---

## ✅ **What Good Tests Would Look Like**

### **Test 1: Handle Zero State**
```typescript
it('should recover from corrupted state with zero values', async () => {
  const pool = { address: '0x123', name: 'ETH/USDC', strategyAddress: '0xStrat' };
  const currentPrice = 2800;
  const candles = createCandles(50, currentPrice);
  
  // Simulate corrupted state (zeros)
  const corruptedState = new BotState('0x123', '0x123', 0, 0, 0, new Date());
  (mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(corruptedState);
  (mockMarketData.getHistory as jest.Mock).mockResolvedValue(candles);
  
  await service.processPool(pool);
  
  // Should have reinitialized state with proper values
  const savedState = (mockBotStateRepo.save as jest.Mock).mock.calls[0][0];
  expect(savedState.priceLower).toBeGreaterThan(0);
  expect(savedState.priceUpper).toBeGreaterThan(0);
  expect(savedState.priceLower).toBeLessThan(currentPrice);
  expect(savedState.priceUpper).toBeGreaterThan(currentPrice);
});
```

### **Test 2: Empty Candles**
```typescript
it('should handle empty candle data gracefully', async () => {
  const pool = { address: '0x123', name: 'ETH/USDC', strategyAddress: '0xStrat' };
  
  (mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(null);
  (mockMarketData.getHistory as jest.Mock).mockResolvedValue([]); // Empty!
  
  await service.processPool(pool);
  
  // Should log warning and return early
  expect(mockExecutor.rebalance).not.toHaveBeenCalled();
});
```

### **Test 3: Verify Range Values**
```typescript
it('should calculate correct range values for rebalance', async () => {
  const pool = { address: '0x123', name: 'ETH/USDC', strategyAddress: '0xStrat' };
  const currentPrice = 2800;
  const candles = createCandles(50, currentPrice);
  
  // Price at edge
  const state = new BotState('0x123', '0x123', 2600, 3000, 2800, new Date());
  (mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(state);
  (mockMarketData.getHistory as jest.Mock).mockResolvedValue(candles);
  (mockOptimizer.optimize as jest.Mock).mockReturnValue({
    optimalWidth: 0.005, // 0.5%
    estimatedNetApy: 0.2
  });
  
  await service.processPool(pool);
  
  // Verify rangePct1e5 parameter
  expect(mockExecutor.rebalance).toHaveBeenCalledWith(
    '0xStrat',
    BigInt(50000) // 0.005 * 100 * 1e5 = 50000
  );
  
  // Verify new state range
  const savedState = (mockBotStateRepo.save as jest.Mock).mock.calls[1][0];
  expect(savedState.priceLower).toBeCloseTo(2786, 0); // 2800 * 0.995
  expect(savedState.priceUpper).toBeCloseTo(2814, 0); // 2800 * 1.005
});
```

### **Test 4: Rebalance Frequency Guard**
```typescript
it('should NOT rebalance if range is close to optimal', async () => {
  const pool = { address: '0x123', name: 'ETH/USDC', strategyAddress: '0xStrat' };
  const currentPrice = 2800;
  const candles = createCandles(50, currentPrice);
  
  // Current range: 1.0%, Optimal: 0.95% (only 5% mismatch, under 50% threshold)
  const state = new BotState('0x123', '0x123', 2786, 2814, 2800, new Date());
  (mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(state);
  (mockMarketData.getHistory as jest.Mock).mockResolvedValue(candles);
  (mockOptimizer.optimize as jest.Mock).mockReturnValue({
    optimalWidth: 0.0095, // 0.95% (close to current 1.0%)
    estimatedNetApy: 0.2
  });
  
  await service.processPool(pool);
  
  // Should NOT rebalance (mismatch < 50%)
  expect(mockExecutor.rebalance).not.toHaveBeenCalled();
});
```

### **Test 5: Integration Test with Real Storage**
```typescript
describe('BotService Integration Tests', () => {
  it('should persist state correctly through file storage', async () => {
    const fileRepo = new FileBotStateRepository('./test-data');
    const service = new BotService(
      mockMarketData,
      fileRepo, // Real file storage!
      mockExecutor,
      mockAnalyst,
      mockOptimizer,
      mockDeribit,
      mockConfig
    );
    
    const pool = { address: '0x123', name: 'ETH/USDC', strategyAddress: '0xStrat' };
    
    // First process - should create state
    await service.processPool(pool);
    
    // Second process - should load saved state
    await service.processPool(pool);
    
    // Verify state persisted (not reset to zeros)
    const loadedState = await fileRepo.findByPoolId('0x123');
    expect(loadedState.priceLower).not.toBe(0);
    expect(loadedState.priceUpper).not.toBe(0);
  });
});
```

---

## 🔧 **How to Fix Test Suite**

### **1. Add Edge Case Tests**
```bash
# Test files to create:
- BotService.edge-cases.spec.ts
  - Zero state recovery
  - Empty candles
  - Invalid prices
  - Network errors

- BotService.rebalance-logic.spec.ts
  - Verify range calculations
  - Check rebalance frequency guards
  - Validate regime change triggers
```

### **2. Add Integration Tests**
```bash
- bot-service.integration.spec.ts (already exists, needs expansion)
  - Test with real FileBotStateRepository
  - Test with real PostgresBotStateRepository
  - Test with real UniswapGraphAdapter (using test network)
```

### **3. Add Property-Based Tests**
```typescript
import fc from 'fast-check';

it('range calculation should always be valid for any price', () => {
  fc.assert(
    fc.property(
      fc.float({ min: 1, max: 100000 }), // currentPrice
      fc.float({ min: 0.001, max: 0.5 }), // optimalWidth
      (currentPrice, optimalWidth) => {
        const newLower = currentPrice * (1 - optimalWidth);
        const newUpper = currentPrice * (1 + optimalWidth);
        
        // Properties that must always hold:
        expect(newLower).toBeGreaterThan(0);
        expect(newUpper).toBeGreaterThan(newLower);
        expect(newLower).toBeLessThan(currentPrice);
        expect(newUpper).toBeGreaterThan(currentPrice);
      }
    )
  );
});
```

---

## 📋 **Action Items**

1. **Add Zero/Invalid Data Tests** ✅ High Priority
   - Test state with zeros
   - Test empty candle arrays
   - Test invalid prices

2. **Add Range Calculation Verification** ✅ High Priority
   - Assert actual rangePct1e5 values
   - Verify new state ranges are sensible

3. **Add Rebalance Frequency Tests** ✅ Medium Priority
   - Test that small range mismatches don't trigger
   - Test cooldown periods

4. **Add Integration Tests** ✅ Medium Priority
   - Test with real storage layers
   - Test with mock blockchain responses

5. **Add Property-Based Tests** 🟡 Low Priority
   - Test invariants hold for any input

---

## 💡 **Key Lesson**

> **"Tests that only mock happy paths give false confidence."**

Your tests passed because they tested **ideal scenarios** with **fake data**. The bugs only appeared when:
- Real storage returned zeros
- Real API returned empty data
- Real calculations hit edge cases

**Solution:** Test the **unhappy paths** and use **real implementations** in integration tests.

---

## ✅ **Current Test Status**

- **Unit Tests**: ✅ Pass (but test mocked scenarios only)
- **Integration Tests**: ⚠️  Exist but incomplete
- **Edge Case Tests**: ❌ Missing
- **Property-Based Tests**: ❌ Missing
- **E2E Tests**: ❌ Missing

**Coverage**: ~40% effective (high code coverage, low bug coverage)

---

## 🚀 **Recommendation**

Add a new test file:

```typescript
// src/application/services/BotService.edge-cases.spec.ts
describe('BotService Edge Cases & Bug Regression', () => {
  describe('State Corruption Recovery', () => {
    it('should handle zero state values');
    it('should handle null/undefined state');
    it('should reinitialize from on-chain position');
  });
  
  describe('Invalid Input Handling', () => {
    it('should handle empty candles');
    it('should handle single candle');
    it('should handle candles with zero prices');
    it('should handle missing current price');
  });
  
  describe('Range Calculation Correctness', () => {
    it('should never produce zero ranges');
    it('should never produce negative ranges');
    it('should scale correctly with any price');
  });
  
  describe('Rebalance Frequency Guards', () => {
    it('should not rebalance for small range mismatches');
    it('should rebalance for large regime changes');
  });
});
```

This would have caught **all 4 bugs**! 🎯


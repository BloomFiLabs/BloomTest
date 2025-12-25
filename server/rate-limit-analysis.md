# Rate Limit Usage Analysis

## Current Scheduled Tasks (from PerpKeeperScheduler.ts)

| Interval | Task | Est. REST Calls | Weight | Calls/min |
|----------|------|-----------------|--------|-----------|
| 30s | cancelOrdersForPairedPositions | 2 (getPositions x2) | 2x20=40 | 80 |
| 30s | cancelOrdersForPairedPositions | 2 (getOpenOrders x2) | 2x20=40 | 80 |
| 45s | verifyRecentExecutionFills | 2 (getPositions x2) | 2x20=40 | 53 |
| 60s | checkPositionSizeBalance | 2 (getPositions x2) | 2x20=40 | 40 |
| 60s | checkProfitTaking | 2 (getPositions x2) | 2x20=40 | 40 |
| 60s | refreshCapitalMetrics | 2 (getBalance x2) | 2x2=4 | 4 |
| 90s | checkAndRetrySingleLegPositions | 2 (getPositions x2) | 2x20=40 | 27 |
| 90s | verifyPositionStateWithExchanges | 4 (getPositions x2, refresh x2) | 4x20=80 | 53 |
| 120s | updatePerformanceMetricsPeriodically | 4 (funding x2, positions x2) | 4x20=80 | 40 |
| 120s | checkAndCloseUnprofitablePositions | 2 (getPositions x2) | 2x20=40 | 20 |
| 180s | verifyTrackedOrders | 2 (getOpenOrders x2) | 2x20=40 | 13 |
| 300s | cleanupStaleOrders | 2 (getOpenOrders x2) | 2x20=40 | 8 |
| 300s | syncExchangeOrderHistory | 4 (orderHistory x2 each) | 4x20=80 | 16 |
| 600s | checkSpreadRotation | 4 (getPositions, funding rates) | 4x20=80 | 8 |
| 900s | refreshMarketData | 10+ (all markets) | 10x20=200 | 13 |

## Estimated Total Weight Per Minute

### Hyperliquid (Limit: 1200/min, we set 960)
- Scheduled tasks: ~250-400 weight/min
- Order placement (during active trading): ~50-100 weight/min
- WebSocket data: 0 (doesn't count)
- **Estimated Total: ~300-500 weight/min (31-52% of limit)**

### Lighter (Limit: 24,000/min, we set 19,200)
- Scheduled tasks: ~250-400 weight/min
- Order placement: ~50-100 weight/min
- **Estimated Total: ~300-500 weight/min (1.6-2.6% of limit)**

## Problem Areas Identified

### 1. Heavy Polling (Every 30-60s)
- `getPositions` called 6-8 times per minute from different tasks
- `getOpenOrders` called 4 times per minute
- These should be cached or use WebSockets

### 2. Not Using WebSockets For:
- **Positions**: Still REST polling
- **Open Orders**: Still REST polling  
- **Balance**: Still REST polling
- **Funding Rates**: Still REST polling (only some from WS)
- **Order Status**: Still REST polling

### 3. What IS Using WebSockets:
- Hyperliquid: Best Bid/Ask only
- Lighter: Best Bid/Ask, Mark Price only

## Recommendations

### High Priority (Reduce REST by 60%+)
1. **Use WebSocket for Position Updates**
   - Both exchanges support position subscriptions
   - Eliminates 6-8 REST calls/min

2. **Use WebSocket for Order Updates**  
   - Both support order fill/cancel notifications
   - Eliminates 4 REST calls/min

3. **Consolidate Position Checks**
   - Multiple tasks call getPositions independently
   - Add a shared cache with 5-10s TTL

### Medium Priority
4. **Batch Operations Where Possible**
   - Hyperliquid supports batched orders (weight 1 + floor(n/40))
   
5. **Reduce Check Frequencies During Idle**
   - Many checks don't need to run when no positions

### WebSocket Subscriptions Available

**Hyperliquid:**
- `userEvents` - positions, orders, fills (✅ already subscribed)
- `l2Book` - order book (✅ using)
- `trades` - recent trades
- `notification` - order status changes

**Lighter:**
- `user_fills` - fill notifications (✅ already subscribed)
- `orderbook` - order book (✅ using)
- `positions` - position updates (NOT SUBSCRIBED)
- `orders` - order status (NOT SUBSCRIBED)


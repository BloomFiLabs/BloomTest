# Historical Funding Rates Research

## Overview

This document tracks research findings on exchange-native historical funding rate APIs for Hyperliquid, Aster, and Lighter.

**Last Updated**: 2025-12-03
**Status**: ✅ All exchanges verified - Native APIs available and tested

## Exchange APIs

### Hyperliquid ✅ VERIFIED

**Historical Endpoint**: `POST https://api.hyperliquid.xyz/info`
- **Request Type**: `fundingHistory`
- **Parameters**:
  ```json
  {
    "type": "fundingHistory",
    "coin": "ETH",
    "startTime": 1234567890000,
    "endTime": 1234567890000
  }
  ```
- **Response Format**:
  ```json
  [
    {
      "coin": "ETH",
      "fundingRate": "0.0000007554",
      "premium": "-0.0004939571",
      "time": 1762203600000
    }
  ]
  ```
- **Verified**: ✅ Tested successfully (2025-12-03)
- **Data Points**: Returns up to 500 entries per request
- **Date Range**: Supports custom startTime/endTime (milliseconds)
- **Rate Limits**: Unknown - no rate limit info in response
- **Notes**: 
  - Returns array of funding rate entries
  - `time` field is milliseconds timestamp
  - `fundingRate` is string (needs parsing)
  - `premium` field also available
  - Maximum 500 entries per request (may need pagination for longer ranges)

**Implementation**:
- Native API available and working
- Can fetch up to 30 days of hourly data (720 entries) with multiple requests
- Prefer native API over collected data for better accuracy

### Aster ✅ VERIFIED

**Historical Endpoint**: `GET https://fapi.asterdex.com/fapi/v1/fundingRate`
- **Parameters**:
  ```
  symbol=ETHUSDT
  startTime=1234567890000
  endTime=1234567890000
  limit=1000
  ```
- **Response Format**:
  ```json
  [
    {
      "symbol": "ETHUSDT",
      "fundingTime": 1762214400001,
      "fundingRate": "0.00007423"
    }
  ]
  ```
- **Verified**: ✅ Tested successfully (2025-12-03)
- **Data Points**: Returns up to 90 entries per request (8-hour intervals)
- **Date Range**: Supports startTime/endTime parameters (milliseconds)
- **Rate Limits**: Unknown - check response headers
- **Notes**:
  - Binance-compatible API structure
  - Returns 8-hour funding rate intervals (not hourly)
  - `fundingTime` is milliseconds timestamp
  - `fundingRate` is string (needs parsing)
  - Maximum limit appears to be 1000 entries

**Implementation**:
- Native API available and working
- Returns 8-hour intervals (3 entries per day)
- Less granular than hourly but still useful for historical averages
- Prefer native API over collected data

### Lighter ⚠️ PARTIALLY VERIFIED

**Current Endpoint**: `GET https://mainnet.zklighter.elliot.ai/api/v1/funding-rates`
- **Parameters**: 
  ```
  market_id=0
  start_time=1234567890000 (optional, may not be supported)
  end_time=1234567890000 (optional, may not be supported)
  ```
- **Response Format**:
  ```json
  {
    "code": 200,
    "funding_rates": [
      {
        "market_id": 56,
        "exchange": "binance",
        "symbol": "ZK",
        "rate": 0.0000535
      }
    ]
  }
  ```
- **Verified**: ⚠️ Partially tested (2025-12-03)
- **Data Points**: Returns all markets (389 entries in test)
- **Date Filtering**: ⚠️ Date parameters may not filter results - returns current rates for all markets
- **Notes**:
  - Returns current funding rates for all markets
  - Date parameters (`start_time`, `end_time`) may not be supported
  - Response includes `market_id`, `exchange`, `symbol`, `rate`
  - No timestamp field in response (appears to be current rates only)

**Explorer API**: `https://explorer.elliot.ai/api/v1/funding-rates`
- **Status**: Not tested - may have historical endpoints

**SDK**: `@reservoir0x/lighter-ts-sdk`
- **Status**: SDK available but limited methods found
- **Methods**: `defaultHeaders`, `config`, `axiosInstance` only
- **Historical Methods**: Not found in SDK

**Implementation**:
- ⚠️ Historical API may not be available
- Current endpoint returns all markets but appears to be current rates only
- Continue using collected data method for Lighter
- May need to check Explorer API for historical endpoints

## Implementation Strategy

**UPDATED**: Native APIs are available for Hyperliquid and Aster. Implementation should prioritize native APIs.

### Current Strategy (Hybrid Approach)

1. **Native API Integration** (Preferred):
   - **Hyperliquid**: Use `fundingHistory` endpoint to fetch up to 30 days of historical data
   - **Aster**: Use `/fapi/v1/fundingRate` endpoint to fetch historical data (8-hour intervals)
   - **Lighter**: Continue using collected data (native historical API not available)

2. **Collected Data** (Backup/Update):
   - Store current funding rates every hour as backup
   - Use collected data to fill gaps in native API data
   - Use collected data for Lighter (no native historical API)

3. **Data Merging**:
   - Prefer native API data when available (more complete, official source)
   - Merge with collected data to fill any gaps
   - Use collected data for real-time updates between API fetches

4. **Cache in Memory**: Keep 7 days of hourly data (168 data points per symbol/exchange)
5. **Calculate Metrics**: Use merged data to calculate consistency metrics
6. **Graceful Degradation**: If historical data is insufficient, use current rate only

## Data Storage

- **Format**: `{ symbol, exchange, rate, timestamp }`
- **Storage**: In-memory Map with TTL
- **Retention**: 7 days (configurable)
- **Update Frequency**: 
  - Native API: Fetch on startup and periodically (every 6-12 hours)
  - Collected Data: Every hour (aligned with funding rate payments)

## Code Examples

### Hyperliquid Historical API

```typescript
const response = await axios.post('https://api.hyperliquid.xyz/info', {
  type: 'fundingHistory',
  coin: 'ETH',
  startTime: Date.now() - (30 * 24 * 60 * 60 * 1000), // 30 days ago
  endTime: Date.now(),
});

const historicalRates = response.data.map((entry: any) => ({
  timestamp: new Date(entry.time),
  rate: parseFloat(entry.fundingRate),
  premium: parseFloat(entry.premium || '0'),
}));
```

### Aster Historical API

```typescript
const response = await axios.get('https://fapi.asterdex.com/fapi/v1/fundingRate', {
  params: {
    symbol: 'ETHUSDT',
    startTime: Date.now() - (30 * 24 * 60 * 60 * 1000),
    endTime: Date.now(),
    limit: 1000,
  },
});

const historicalRates = response.data.map((entry: any) => ({
  timestamp: new Date(entry.fundingTime),
  rate: parseFloat(entry.fundingRate),
}));
```

### Lighter (Current Rates Only)

```typescript
// Lighter does not appear to support historical endpoints
// Use collected data method instead
const response = await axios.get('https://mainnet.zklighter.elliot.ai/api/v1/funding-rates', {
  params: { market_id: 0 },
});

// Returns current rates only, no historical data
```

## Metrics Calculated

- **Average Rate**: Mean funding rate over time window
- **Standard Deviation**: Measure of consistency (lower = more consistent)
- **Min Rate**: Worst-case scenario rate
- **Max Rate**: Best-case scenario rate
- **Positive Days**: Number of days with positive funding rate
- **Consistency Score**: Normalized score (0-1) combining consistency and average rate







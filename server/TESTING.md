# Perp Keeper Testing Guide

## Overview

This document describes the comprehensive test suite for the Perp Keeper system, including both unit and integration tests.

## Test Structure

### Unit Tests

Unit tests are located alongside their source files with `.spec.ts` extension:

#### Value Objects
- `src/domain/value-objects/PerpOrder.spec.ts` - Tests for order request/response value objects
- `src/domain/value-objects/ExchangeConfig.spec.ts` - Tests for exchange configuration

#### Entities
- `src/domain/entities/PerpPosition.spec.ts` - Tests for position entity and calculations

#### Domain Services
- `src/domain/services/FundingRateAggregator.spec.ts` - Tests for funding rate aggregation logic
- `src/domain/services/FundingArbitrageStrategy.spec.ts` - Tests for arbitrage decision logic
- `src/domain/services/PerpKeeperOrchestrator.spec.ts` - Tests for orchestrator coordination

#### Infrastructure Adapters
- `src/infrastructure/adapters/aster/AsterExchangeAdapter.spec.ts` - Tests for Aster exchange adapter

#### Application Services
- `src/application/services/PerpKeeperService.spec.ts` - Tests for keeper service

### Integration Tests

Integration tests are located in `test/integration/`:

- `test/integration/perp-keeper.integration.spec.ts` - End-to-end integration tests for keeper flows
- `test/integration/perp-keeper-controllers.integration.spec.ts` - API controller integration tests

## Running Tests

### Run All Tests
```bash
npm test
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```

### Run Tests with Coverage
```bash
npm run test:cov
```

### Run Specific Test File
```bash
npm test -- PerpOrder.spec.ts
```

### Run Integration Tests Only
```bash
npm run test:e2e
```

## Test Coverage

### Unit Test Coverage

#### Value Objects (100% coverage target)
- ✅ PerpOrderRequest validation and methods
- ✅ PerpOrderResponse status checks
- ✅ ExchangeConfig validation and factory methods

#### Entities (100% coverage target)
- ✅ PerpPosition creation and calculations
- ✅ PerpOrder lifecycle management

#### Domain Services (80%+ coverage target)
- ✅ FundingRateAggregator - rate aggregation and comparison
- ✅ FundingArbitrageStrategy - opportunity evaluation and execution
- ✅ PerpKeeperOrchestrator - order tracking and coordination

#### Adapters (70%+ coverage target)
- ✅ AsterExchangeAdapter - order placement, position fetching
- ⚠️ LighterExchangeAdapter - (needs implementation)
- ⚠️ HyperliquidExchangeAdapter - (needs implementation)

### Integration Test Coverage

- ✅ Full arbitrage flow (find → plan → execute)
- ✅ API endpoints (funding rates, keeper status, execution)
- ✅ Multi-exchange coordination
- ✅ Error handling and recovery

## Mocking Strategy

### Exchange Adapters
Exchange adapters are mocked to avoid actual API calls during testing:
- Use Jest mocks for `IPerpExchangeAdapter` implementations
- Mock HTTP clients (axios) for API calls
- Mock SDK clients for Lighter and Hyperliquid

### Data Providers
Funding data providers are mocked:
- Mock API responses for funding rates
- Use predictable test data for comparisons
- Simulate network errors for error handling tests

## Test Data

### Sample Funding Rates
```typescript
// Positive funding (longs pay shorts)
ASTER: 0.0001 (0.01%)
LIGHTER: 0.0003 (0.03%)
HYPERLIQUID: -0.0001 (-0.01%) // Negative (shorts pay longs)
```

### Sample Positions
```typescript
{
  exchange: ExchangeType.HYPERLIQUID,
  symbol: 'ETHUSDT',
  side: OrderSide.LONG,
  size: 1.0,
  entryPrice: 3000,
  markPrice: 3100,
  unrealizedPnl: 100,
}
```

## Writing New Tests

### Unit Test Template
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { YourService } from './YourService';

describe('YourService', () => {
  let service: YourService;
  let mockDependency: jest.Mocked<YourDependency>;

  beforeEach(async () => {
    mockDependency = {
      method: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        YourService,
        { provide: YourDependency, useValue: mockDependency },
      ],
    }).compile();

    service = module.get<YourService>(YourService);
  });

  it('should do something', () => {
    // Arrange
    // Act
    // Assert
  });
});
```

### Integration Test Template
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { YourController } from './YourController';

describe('YourController Integration', () => {
  let app: INestApplication;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [YourController],
      providers: [/* ... */],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should handle full flow', async () => {
    // Test end-to-end flow
  });
});
```

## Continuous Integration

Tests should pass before merging:
- All unit tests must pass
- Integration tests should pass (may require test environment setup)
- Coverage should meet minimum thresholds

## Known Limitations

1. **Real API Calls**: Integration tests use mocks. For true integration testing, set up testnet environments.

2. **Lighter SDK**: Some Lighter SDK methods may need additional mocking based on actual SDK behavior.

3. **Hyperliquid SDK**: Hyperliquid adapter tests may need adjustment based on SDK version.

4. **Time-dependent Tests**: Tests involving timestamps should use fixed dates or mock Date.

## Next Steps

1. Add more adapter tests (Lighter, Hyperliquid)
2. Add scheduler tests
3. Add error recovery tests
4. Add performance tests for high-frequency operations
5. Set up testnet integration environment



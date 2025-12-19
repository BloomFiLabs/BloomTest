import { Test, TestingModule } from '@nestjs/testing';
import { PerpSpotBalanceManager } from './PerpSpotBalanceManager';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ISpotExchangeAdapter } from '../../ports/ISpotExchangeAdapter';

describe('PerpSpotBalanceManager', () => {
  let manager: PerpSpotBalanceManager;
  let mockPerpAdapter: jest.Mocked<IPerpExchangeAdapter>;
  let mockSpotAdapter: jest.Mocked<ISpotExchangeAdapter>;

  beforeEach(async () => {
    mockPerpAdapter = {
      getBalance: jest.fn(),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.HYPERLIQUID),
    } as any;

    mockSpotAdapter = {
      getSpotBalance: jest.fn(),
      transferInternal: jest.fn(),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.HYPERLIQUID),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [PerpSpotBalanceManager],
    }).compile();

    manager = module.get<PerpSpotBalanceManager>(PerpSpotBalanceManager);
  });

  describe('calculateOptimalDistribution', () => {
    it('should calculate optimal distribution for 2x leverage', () => {
      const result = manager.calculateOptimalDistribution(
        1000, // perpBalance
        1000, // spotBalance
        2000, // targetPositionSize
        2, // leverage
      );

      // Total capital = 2000
      // Optimal: perpBalance = 2000 / (1 + 2) = 666.67
      //          spotBalance = 2000 * 2 / (1 + 2) = 1333.33
      expect(result.optimalPerpBalance).toBeCloseTo(666.67, 1);
      expect(result.optimalSpotBalance).toBeCloseTo(1333.33, 1);
    });

    it('should calculate optimal distribution for 3x leverage', () => {
      const result = manager.calculateOptimalDistribution(1000, 1000, 3000, 3);

      // Total capital = 2000
      // Optimal: perpBalance = 2000 / 4 = 500
      //          spotBalance = 2000 * 3 / 4 = 1500
      expect(result.optimalPerpBalance).toBeCloseTo(500, 1);
      expect(result.optimalSpotBalance).toBeCloseTo(1500, 1);
    });
  });

  describe('shouldRebalance', () => {
    it('should not rebalance when distribution is optimal', () => {
      const result = manager.shouldRebalance(
        500, // perpBalance
        1500, // spotBalance
        3000, // targetPositionSize
        3, // leverage
      );

      // Perp capacity = 500 * 3 = 1500
      // Spot capacity = 1500
      // Current max = 1500
      // Optimal perp = 2000 / 4 = 500
      // Optimal spot = 2000 * 3 / 4 = 1500
      // Already optimal, no rebalancing needed
      expect(result.shouldRebalance).toBe(false);
    });

    it('should rebalance when spot balance is too low', () => {
      const result = manager.shouldRebalance(
        1000, // perpBalance (too high)
        500, // spotBalance (too low)
        3000, // targetPositionSize
        3, // leverage
      );

      // Perp capacity = 1000 * 3 = 3000
      // Spot capacity = 500
      // Current max = 500
      // Optimal perp = 1500 / 4 = 375
      // Optimal spot = 1500 * 3 / 4 = 1125
      // Need to transfer from perp to spot
      expect(result.shouldRebalance).toBe(true);
      expect(result.toPerp).toBe(false);
      expect(result.transferAmount).toBeGreaterThan(0);
    });

    it('should not rebalance if improvement is too small', () => {
      const result = manager.shouldRebalance(
        510, // perpBalance (slightly off)
        1490, // spotBalance (slightly off)
        3000, // targetPositionSize
        3, // leverage
      );

      // Improvement is less than 10% threshold
      expect(result.shouldRebalance).toBe(false);
    });

    it('should not rebalance if transfer amount is too small', () => {
      // Use small balances so that the optimal transfer amount is < $10
      const result = manager.shouldRebalance(
        10, // perpBalance
        10, // spotBalance
        30, // targetPositionSize (small)
        2, // leverage
      );

      // Total capital = 20
      // Optimal spot = 20 * 2 / 3 = 13.33
      // Spot deficit = 13.33 - 10 = 3.33 < $10 minimum
      expect(result.shouldRebalance).toBe(false);
    });
  });

  describe('ensureOptimalBalanceDistribution', () => {
    it('should transfer funds when rebalancing is needed', async () => {
      mockPerpAdapter.getBalance.mockResolvedValue(1000);
      mockSpotAdapter.getSpotBalance.mockResolvedValue(500);
      mockSpotAdapter.transferInternal.mockResolvedValue('tx-hash-123');

      const result = await manager.ensureOptimalBalanceDistribution(
        ExchangeType.HYPERLIQUID,
        mockPerpAdapter,
        mockSpotAdapter,
        3000, // targetPositionSize
        3, // leverage
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        expect(result.value).toBe(true);
      }
      expect(mockSpotAdapter.transferInternal).toHaveBeenCalled();
    });

    it('should not transfer when distribution is optimal', async () => {
      mockPerpAdapter.getBalance.mockResolvedValue(500);
      mockSpotAdapter.getSpotBalance.mockResolvedValue(1500);

      const result = await manager.ensureOptimalBalanceDistribution(
        ExchangeType.HYPERLIQUID,
        mockPerpAdapter,
        mockSpotAdapter,
        3000,
        3,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        expect(result.value).toBe(false);
      }
      expect(mockSpotAdapter.transferInternal).not.toHaveBeenCalled();
    });

    it('should handle transfer failures gracefully', async () => {
      mockPerpAdapter.getBalance.mockResolvedValue(1000);
      mockSpotAdapter.getSpotBalance.mockResolvedValue(500);
      mockSpotAdapter.transferInternal.mockRejectedValue(
        new Error('Transfer failed'),
      );

      const result = await manager.ensureOptimalBalanceDistribution(
        ExchangeType.HYPERLIQUID,
        mockPerpAdapter,
        mockSpotAdapter,
        3000,
        3,
      );

      // Should return success=false but not throw
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        expect(result.value).toBe(false);
      }
    });
  });
});

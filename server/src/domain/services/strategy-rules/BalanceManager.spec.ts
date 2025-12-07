import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BalanceManager } from './BalanceManager';
import { ExchangeBalanceRebalancer } from '../ExchangeBalanceRebalancer';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';

// Mock ethers
jest.mock('ethers', () => {
  const mockContract = {
    balanceOf: jest.fn(),
    decimals: jest.fn(),
  };

  const mockProvider = {
    // Provider methods
  };

  return {
    Contract: jest.fn().mockImplementation(() => mockContract),
    JsonRpcProvider: jest.fn().mockImplementation(() => mockProvider),
    Wallet: jest.fn().mockImplementation(() => ({
      address: '0x1234567890123456789012345678901234567890',
    })),
    formatUnits: jest.fn((value: bigint, decimals: number) => {
      return (Number(value) / Math.pow(10, decimals)).toString();
    }),
  };
});

describe('BalanceManager', () => {
  let manager: BalanceManager;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockBalanceRebalancer: jest.Mocked<ExchangeBalanceRebalancer>;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = new StrategyConfig();

    mockConfigService = {
      get: jest.fn(),
    } as any;

    mockBalanceRebalancer = {
      getExchangeBalances: jest.fn(),
      transferBetweenExchanges: jest.fn(),
    } as any;

    // Create mock adapters
    mockAdapters = new Map();
    const asterAdapter = {
      getBalance: jest.fn(),
      depositExternal: jest.fn(),
    } as any;

    const lighterAdapter = {
      getBalance: jest.fn(),
      depositExternal: jest.fn(),
    } as any;

    const hyperliquidAdapter = {
      getBalance: jest.fn(),
      depositExternal: jest.fn(),
    } as any;

    mockAdapters.set(ExchangeType.ASTER, asterAdapter);
    mockAdapters.set(ExchangeType.LIGHTER, lighterAdapter);
    mockAdapters.set(ExchangeType.HYPERLIQUID, hyperliquidAdapter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceManager,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ExchangeBalanceRebalancer, useValue: mockBalanceRebalancer },
        { provide: StrategyConfig, useValue: config },
      ],
    }).compile();

    manager = module.get<BalanceManager>(BalanceManager);
  });

  describe('getWalletUsdcBalance', () => {
    it('should return balance from wallet address', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'ARBITRUM_RPC_URL') return 'https://arb1.arbitrum.io/rpc';
        if (key === 'WALLET_ADDRESS') return '0x1234567890123456789012345678901234567890';
        return undefined;
      });

      const mockContract = {
        balanceOf: jest.fn().mockResolvedValue(BigInt('1000000000')), // 1000 USDC (6 decimals)
        decimals: jest.fn().mockResolvedValue(6),
      };
      (Contract as jest.Mock).mockImplementation(() => mockContract);

      const balance = await manager.getWalletUsdcBalance();

      expect(balance).toBe(1000);
      expect(mockContract.balanceOf).toHaveBeenCalled();
    });

    it('should derive address from private key if wallet address not provided', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'ARBITRUM_RPC_URL') return 'https://arb1.arbitrum.io/rpc';
        if (key === 'PRIVATE_KEY') return '0x1234567890123456789012345678901234567890123456789012345678901234';
        return undefined;
      });

      const mockContract = {
        balanceOf: jest.fn().mockResolvedValue(BigInt('500000000')), // 500 USDC
        decimals: jest.fn().mockResolvedValue(6),
      };
      (Contract as jest.Mock).mockImplementation(() => mockContract);

      const balance = await manager.getWalletUsdcBalance();

      expect(balance).toBe(500);
    });

    it('should return 0 if no wallet address or private key configured', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      const balance = await manager.getWalletUsdcBalance();

      expect(balance).toBe(0);
    });

    it('should return 0 on error', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'ARBITRUM_RPC_URL') return 'https://arb1.arbitrum.io/rpc';
        if (key === 'WALLET_ADDRESS') return '0x1234567890123456789012345678901234567890';
        return undefined;
      });

      const mockContract = {
        balanceOf: jest.fn().mockRejectedValue(new Error('RPC error')),
        decimals: jest.fn(),
      };
      (Contract as jest.Mock).mockImplementation(() => mockContract);

      const balance = await manager.getWalletUsdcBalance();

      expect(balance).toBe(0);
    });
  });

  describe('checkAndDepositWalletFunds', () => {
    beforeEach(() => {
      jest.spyOn(manager, 'getWalletUsdcBalance').mockResolvedValue(1000);
    });

    it('should distribute funds equally to all exchanges', async () => {
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const hyperliquidAdapter = mockAdapters.get(ExchangeType.HYPERLIQUID)!;

      asterAdapter.getBalance.mockResolvedValue(0);
      lighterAdapter.getBalance.mockResolvedValue(0);
      hyperliquidAdapter.getBalance.mockResolvedValue(0);

      asterAdapter.depositExternal.mockResolvedValue('tx-1');
      lighterAdapter.depositExternal.mockResolvedValue('tx-2');
      hyperliquidAdapter.depositExternal.mockResolvedValue('tx-3');

      // Mock setTimeout to resolve immediately
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = jest.fn((fn: any) => {
        fn();
        return {} as any;
      }) as any;

      try {
        await manager.checkAndDepositWalletFunds(
          mockAdapters,
          new Set([ExchangeType.ASTER, ExchangeType.LIGHTER, ExchangeType.HYPERLIQUID]),
        );

        // Should deposit ~333.33 to each exchange
        expect(asterAdapter.depositExternal).toHaveBeenCalledWith(
          expect.closeTo(333.33, 0.01),
          'USDC',
        );
        expect(lighterAdapter.depositExternal).toHaveBeenCalledWith(
          expect.closeTo(333.33, 0.01),
          'USDC',
        );
        expect(hyperliquidAdapter.depositExternal).toHaveBeenCalledWith(
          expect.closeTo(333.33, 0.01),
          'USDC',
        );
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    }, 20000);

    it('should skip deposits if wallet balance is zero', async () => {
      jest.spyOn(manager, 'getWalletUsdcBalance').mockResolvedValue(0);

      await manager.checkAndDepositWalletFunds(
        mockAdapters,
        new Set([ExchangeType.ASTER]),
      );

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      expect(asterAdapter.depositExternal).not.toHaveBeenCalled();
    });

    it('should skip deposits if amount is too small (< $5)', async () => {
      jest.spyOn(manager, 'getWalletUsdcBalance').mockResolvedValue(10); // $10 total

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.getBalance.mockResolvedValue(0);

      await manager.checkAndDepositWalletFunds(
        mockAdapters,
        new Set([ExchangeType.ASTER, ExchangeType.LIGHTER, ExchangeType.HYPERLIQUID]),
      );

      // Each exchange would get ~$3.33, which is < $5, so should skip
      expect(asterAdapter.depositExternal).not.toHaveBeenCalled();
    });

    it('should handle deposit failures gracefully', async () => {
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.getBalance.mockResolvedValue(0);
      asterAdapter.depositExternal.mockRejectedValue(new Error('Deposit failed'));

      await manager.checkAndDepositWalletFunds(
        mockAdapters,
        new Set([ExchangeType.ASTER]),
      );

      // Should not throw, just log error
      expect(asterAdapter.depositExternal).toHaveBeenCalled();
    });

    it('should handle 404 errors for exchanges that require on-chain deposits', async () => {
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.getBalance.mockResolvedValue(0);
      asterAdapter.depositExternal.mockRejectedValue(
        new Error('Request failed with status code 404'),
      );

      await manager.checkAndDepositWalletFunds(
        mockAdapters,
        new Set([ExchangeType.ASTER]),
      );

      // Should handle gracefully
      expect(asterAdapter.depositExternal).toHaveBeenCalled();
    });
  });

  describe('attemptRebalanceForOpportunity', () => {
    const createMockOpportunity = (): ArbitrageOpportunity => ({
      symbol: 'ETHUSDT',
      longExchange: ExchangeType.LIGHTER,
      shortExchange: ExchangeType.ASTER,
      longRate: 0.0003,
      shortRate: 0.0001,
      spread: 0.0002,
      expectedReturn: 0.219,
      longMarkPrice: 3001,
      shortMarkPrice: 3000,
      longOpenInterest: 1000000,
      shortOpenInterest: 1000000,
      timestamp: new Date(),
    });

    it('should return true if no rebalancing needed', async () => {
      const opportunity = createMockOpportunity();
      mockBalanceRebalancer.getExchangeBalances.mockResolvedValue(
        new Map([
          [ExchangeType.LIGHTER, 1000],
          [ExchangeType.ASTER, 1000],
        ]),
      );

      const result = await manager.attemptRebalanceForOpportunity(
        opportunity,
        mockAdapters,
        500, // Required collateral
        1000, // Long balance
        1000, // Short balance
      );

      expect(result).toBe(true);
    });

    it('should rebalance from unused exchanges', async () => {
      const opportunity = createMockOpportunity();
      mockBalanceRebalancer.getExchangeBalances.mockResolvedValue(
        new Map([
          [ExchangeType.LIGHTER, 100], // Needs more
          [ExchangeType.ASTER, 100], // Needs more
          [ExchangeType.HYPERLIQUID, 1000], // Unused, has funds
        ]),
      );
      mockBalanceRebalancer.transferBetweenExchanges.mockResolvedValue(true);

      const result = await manager.attemptRebalanceForOpportunity(
        opportunity,
        mockAdapters,
        500, // Required collateral
        100, // Long balance (deficit: 400)
        100, // Short balance (deficit: 400)
      );

      expect(result).toBe(true);
      expect(mockBalanceRebalancer.transferBetweenExchanges).toHaveBeenCalled();
    });

    it('should return false if balanceRebalancer not available', async () => {
      const managerWithoutRebalancer = new BalanceManager(
        mockConfigService,
        null as any, // No rebalancer
        config,
      );

      const opportunity = createMockOpportunity();
      const result = await managerWithoutRebalancer.attemptRebalanceForOpportunity(
        opportunity,
        mockAdapters,
        500,
        100,
        100,
      );

      expect(result).toBe(false);
    });

    it('should return false if adapters missing', async () => {
      const opportunity = createMockOpportunity();
      const emptyAdapters = new Map<ExchangeType, IPerpExchangeAdapter>();

      const result = await manager.attemptRebalanceForOpportunity(
        opportunity,
        emptyAdapters,
        500,
        100,
        100,
      );

      expect(result).toBe(false);
    });
  });
});


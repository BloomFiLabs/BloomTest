import { Test, TestingModule } from '@nestjs/testing';
import { EthersStrategyExecutor } from './EthersStrategyExecutor';
import { ConfigService } from '@nestjs/config';
import { Contract, Wallet } from 'ethers';

// Mock ethers
jest.mock('ethers', () => {
  return {
    JsonRpcProvider: jest.fn(),
    Wallet: jest.fn(),
    Contract: jest.fn(),
  };
});

describe('EthersStrategyExecutor', () => {
  let executor: EthersStrategyExecutor;
  let mockConfigService: Partial<ConfigService>;
  let mockContract: any;
  let mockWallet: any;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'RPC_URL') return 'http://localhost:8545';
        if (key === 'KEEPER_PRIVATE_KEY') return '0x1234567890123456789012345678901234567890123456789012345678901234'; // Dummy key
        return null;
      }),
    };

    mockWallet = {
        address: '0xKeeperAddress'
    };
    (Wallet as unknown as jest.Mock).mockImplementation(() => mockWallet);

    mockContract = {
      rebalance: jest.fn(),
      emergencyExit: jest.fn(),
    };
    (Contract as unknown as jest.Mock).mockImplementation(() => mockContract);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EthersStrategyExecutor,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    executor = module.get<EthersStrategyExecutor>(EthersStrategyExecutor);
  });

  it('should be defined', () => {
    expect(executor).toBeDefined();
  });

  it('should call rebalance on the contract', async () => {
    const strategyAddress = '0xStrategyAddress';
    const mockTx = { hash: '0xTxHash', wait: jest.fn().mockResolvedValue({ hash: '0xReceiptHash' }) };
    
    mockContract.rebalance.mockResolvedValue(mockTx);

    const result = await executor.rebalance(strategyAddress);

    expect(Contract).toHaveBeenCalledWith(strategyAddress, expect.any(Array), mockWallet);
    expect(mockContract.rebalance).toHaveBeenCalled();
    expect(result).toBe('0xReceiptHash');
  });

  it('should call emergencyExit on the contract', async () => {
      const strategyAddress = '0xStrategyAddress';
      const mockTx = { hash: '0xTxHash', wait: jest.fn().mockResolvedValue({ hash: '0xReceiptHash' }) };
      
      mockContract.emergencyExit.mockResolvedValue(mockTx);
  
      const result = await executor.emergencyExit(strategyAddress);
  
      expect(Contract).toHaveBeenCalledWith(strategyAddress, expect.any(Array), mockWallet);
      expect(mockContract.emergencyExit).toHaveBeenCalled();
      expect(result).toBe('0xReceiptHash');
    });
});








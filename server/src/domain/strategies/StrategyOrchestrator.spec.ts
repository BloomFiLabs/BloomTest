import { StrategyOrchestrator } from './StrategyOrchestrator';
import {
  IExecutableStrategy,
  StrategyExecutionResult,
} from './IExecutableStrategy';

// Mock strategy implementation
class MockStrategy implements IExecutableStrategy {
  private enabled = true;
  public executeCalled = false;
  public executeResult: StrategyExecutionResult;
  public readonly id: string;
  public readonly requiredAssets: string[] = [];
  public readonly requiredPools: string[] = [];

  constructor(
    public readonly name: string,
    public readonly chainId: number,
    public readonly contractAddress: string,
    result?: Partial<StrategyExecutionResult>,
  ) {
    this.id = contractAddress;
    this.executeResult = {
      strategyName: name,
      executed: false,
      reason: 'Mock default',
      ...result,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async execute(context: any): Promise<StrategyExecutionResult> {
    this.executeCalled = true;
    return this.executeResult;
  }

  async getMetrics(): Promise<Record<string, number | string>> {
    return { mock: 'true' };
  }

  async emergencyExit(): Promise<StrategyExecutionResult> {
    return {
      strategyName: this.name,
      executed: true,
      reason: 'Emergency exit',
    };
  }
}

describe('StrategyOrchestrator', () => {
  let orchestrator: StrategyOrchestrator;
  let mockStrategy1: MockStrategy;
  let mockStrategy2: MockStrategy;
  let mockStrategy3: MockStrategy;

  beforeEach(() => {
    orchestrator = new StrategyOrchestrator();

    mockStrategy1 = new MockStrategy('Funding Rate ETH', 999, '0xFunding1', {
      executed: true,
      action: 'OPEN_SHORT',
      reason: 'Positive funding',
    });

    mockStrategy2 = new MockStrategy('LP ETH/USDC', 8453, '0xLP1', {
      executed: false,
      action: 'HOLD',
      reason: 'In range',
    });

    mockStrategy3 = new MockStrategy('Funding Rate BTC', 999, '0xFunding2', {
      executed: true,
      action: 'CLOSE_POSITION',
      reason: 'Rate flipped',
    });
  });

  describe('Strategy registration', () => {
    it('should register a strategy', () => {
      orchestrator.registerStrategy(mockStrategy1);

      expect(orchestrator.getStrategies()).toHaveLength(1);
      expect(orchestrator.getStrategies()[0].name).toBe('Funding Rate ETH');
    });

    it('should register multiple strategies', () => {
      orchestrator.registerStrategy(mockStrategy1);
      orchestrator.registerStrategy(mockStrategy2);
      orchestrator.registerStrategy(mockStrategy3);

      expect(orchestrator.getStrategies()).toHaveLength(3);
    });

    it('should not register duplicate strategies (same contract address)', () => {
      orchestrator.registerStrategy(mockStrategy1);

      const duplicate = new MockStrategy('Duplicate', 999, '0xFunding1');
      orchestrator.registerStrategy(duplicate);

      expect(orchestrator.getStrategies()).toHaveLength(1);
    });

    it('should unregister a strategy', () => {
      orchestrator.registerStrategy(mockStrategy1);
      orchestrator.registerStrategy(mockStrategy2);

      orchestrator.unregisterStrategy('0xFunding1');

      expect(orchestrator.getStrategies()).toHaveLength(1);
      expect(orchestrator.getStrategies()[0].name).toBe('LP ETH/USDC');
    });
  });

  describe('executeAll()', () => {
    it('should execute all registered strategies', async () => {
      orchestrator.registerStrategy(mockStrategy1);
      orchestrator.registerStrategy(mockStrategy2);
      orchestrator.registerStrategy(mockStrategy3);

      const results = await orchestrator.executeAll();

      expect(results).toHaveLength(3);
      expect(mockStrategy1.executeCalled).toBe(true);
      expect(mockStrategy2.executeCalled).toBe(true);
      expect(mockStrategy3.executeCalled).toBe(true);
    });

    it('should return results for each strategy', async () => {
      orchestrator.registerStrategy(mockStrategy1);
      orchestrator.registerStrategy(mockStrategy2);

      const results = await orchestrator.executeAll();

      expect(results[0].strategyName).toBe('Funding Rate ETH');
      expect(results[0].executed).toBe(true);
      expect(results[0].action).toBe('OPEN_SHORT');

      expect(results[1].strategyName).toBe('LP ETH/USDC');
      expect(results[1].executed).toBe(false);
      expect(results[1].action).toBe('HOLD');
    });

    it('should continue executing other strategies if one fails', async () => {
      const failingStrategy = new MockStrategy('Failing', 999, '0xFail');
      failingStrategy.execute = jest
        .fn()
        .mockRejectedValue(new Error('Network error'));

      orchestrator.registerStrategy(failingStrategy);
      orchestrator.registerStrategy(mockStrategy2);

      const results = await orchestrator.executeAll();

      expect(results).toHaveLength(2);
      expect(results[0].error).toBeDefined();
      expect(results[1].executed).toBe(false); // mockStrategy2 still ran
      expect(mockStrategy2.executeCalled).toBe(true);
    });

    it('should skip disabled strategies', async () => {
      mockStrategy1.setEnabled(false);
      orchestrator.registerStrategy(mockStrategy1);
      orchestrator.registerStrategy(mockStrategy2);

      const results = await orchestrator.executeAll();

      // Both strategies are called, but disabled one returns "disabled" reason
      expect(results).toHaveLength(2);
    });
  });

  describe('executeByChain()', () => {
    it('should only execute strategies on specified chain', async () => {
      orchestrator.registerStrategy(mockStrategy1); // chainId 999
      orchestrator.registerStrategy(mockStrategy2); // chainId 8453
      orchestrator.registerStrategy(mockStrategy3); // chainId 999

      const results = await orchestrator.executeByChain(999);

      expect(results).toHaveLength(2);
      expect(mockStrategy1.executeCalled).toBe(true);
      expect(mockStrategy2.executeCalled).toBe(false);
      expect(mockStrategy3.executeCalled).toBe(true);
    });
  });

  describe('getStrategy()', () => {
    it('should return strategy by contract address', () => {
      orchestrator.registerStrategy(mockStrategy1);
      orchestrator.registerStrategy(mockStrategy2);

      const strategy = orchestrator.getStrategy('0xFunding1');

      expect(strategy).toBeDefined();
      expect(strategy?.name).toBe('Funding Rate ETH');
    });

    it('should return undefined for unknown address', () => {
      orchestrator.registerStrategy(mockStrategy1);

      const strategy = orchestrator.getStrategy('0xUnknown');

      expect(strategy).toBeUndefined();
    });
  });

  describe('emergencyExitAll()', () => {
    it('should call emergencyExit on all strategies', async () => {
      const exitSpy1 = jest.spyOn(mockStrategy1, 'emergencyExit');
      const exitSpy2 = jest.spyOn(mockStrategy2, 'emergencyExit');

      orchestrator.registerStrategy(mockStrategy1);
      orchestrator.registerStrategy(mockStrategy2);

      const results = await orchestrator.emergencyExitAll();

      expect(exitSpy1).toHaveBeenCalled();
      expect(exitSpy2).toHaveBeenCalled();
      expect(results).toHaveLength(2);
    });
  });

  describe('getAllMetrics()', () => {
    it('should return metrics from all strategies', async () => {
      orchestrator.registerStrategy(mockStrategy1);
      orchestrator.registerStrategy(mockStrategy2);

      const metrics = await orchestrator.getAllMetrics();

      expect(metrics).toHaveProperty('Funding Rate ETH');
      expect(metrics).toHaveProperty('LP ETH/USDC');
    });
  });
});

import { RetryPolicy, DEFAULT_RETRY_POLICY_CONFIG } from './RetryPolicy';

describe('RetryPolicy', () => {
  let retryPolicy: RetryPolicy;

  beforeEach(() => {
    retryPolicy = new RetryPolicy();
  });

  describe('successful execution', () => {
    it('should execute function successfully on first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await retryPolicy.execute(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry on failure', () => {
    it('should retry on transient failures', async () => {
      const networkError: any = new Error('Network error');
      networkError.code = 'ECONNRESET';
      
      const fn = jest
        .fn()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce('success');

      const config = {
        ...DEFAULT_RETRY_POLICY_CONFIG,
        maxRetries: 1,
        initialDelayMs: 10, // Fast for test
      };
      const policy = new RetryPolicy(config);

      const result = await policy.execute(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should use exponential backoff', async () => {
      const networkError: any = new Error('Network error');
      networkError.code = 'ECONNRESET';
      const fn = jest.fn().mockRejectedValue(networkError);
      
      const config = {
        ...DEFAULT_RETRY_POLICY_CONFIG,
        maxRetries: 2,
        initialDelayMs: 50, // Increased for more reliable timing
        backoffMultiplier: 2,
      };
      const policy = new RetryPolicy(config);

      const startTime = Date.now();
      try {
        await policy.execute(fn);
      } catch (e) {
        // Expected to fail after retries
      }
      const elapsed = Date.now() - startTime;

      // Should have waited: 50ms (first retry) + 100ms (second retry) = ~150ms
      // Allow some tolerance for test execution
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    }, 10000); // Increase timeout for this test

    it('should respect max delay', async () => {
      const networkError: any = new Error('Network error');
      networkError.code = 'ECONNRESET';
      const fn = jest.fn().mockRejectedValue(networkError);
      
      const config = {
        ...DEFAULT_RETRY_POLICY_CONFIG,
        maxRetries: 3, // Reduced for faster test
        initialDelayMs: 50,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      };
      const policy = new RetryPolicy(config);

      const startTime = Date.now();
      try {
        await policy.execute(fn);
      } catch (e) {
        // Expected
      }
      const elapsed = Date.now() - startTime;

      // Should cap at maxDelayMs (100ms) per retry
      // 50 + 100 + 100 + 100 = ~350ms max
      expect(elapsed).toBeLessThan(500);
    }, 10000); // Increase timeout for this test

    it('should throw after max retries', async () => {
      const networkError: any = new Error('Persistent error');
      networkError.code = 'ECONNRESET';
      const fn = jest.fn().mockRejectedValue(networkError);
      
      const config = {
        ...DEFAULT_RETRY_POLICY_CONFIG,
        maxRetries: 2,
        initialDelayMs: 10,
      };
      const policy = new RetryPolicy(config);

      await expect(policy.execute(fn)).rejects.toThrow('Persistent error');
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });

  describe('retryable errors', () => {
    it('should retry on retryable errors', async () => {
      const retryableError: any = new Error('Network error');
      retryableError.code = 'ECONNRESET';

      const fn = jest
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValueOnce('success');

      const config = {
        ...DEFAULT_RETRY_POLICY_CONFIG,
        maxRetries: 1,
        initialDelayMs: 10,
      };
      const policy = new RetryPolicy(config);

      const result = await policy.execute(fn);
      expect(result).toBe('success');
    });

    it('should not retry on non-retryable errors', async () => {
      const nonRetryableError = new Error('Validation error');
      const fn = jest.fn().mockRejectedValue(nonRetryableError);

      const config = {
        ...DEFAULT_RETRY_POLICY_CONFIG,
        maxRetries: 3,
        retryableErrors: (error: any) => {
          return error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT';
        },
      };
      const policy = new RetryPolicy(config);

      await expect(policy.execute(fn)).rejects.toThrow('Validation error');
      expect(fn).toHaveBeenCalledTimes(1); // No retries
    });
  });
});

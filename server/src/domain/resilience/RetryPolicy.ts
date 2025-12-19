import { Logger } from '@nestjs/common';

export interface RetryPolicyConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: (error: any) => boolean;
}

export const DEFAULT_RETRY_POLICY_CONFIG: RetryPolicyConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

export class RetryPolicy {
  private readonly logger = new Logger(RetryPolicy.name);
  private readonly config: RetryPolicyConfig;

  constructor(config: Partial<RetryPolicyConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_POLICY_CONFIG, ...config };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;
    let delay = this.config.initialDelayMs;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;

        if (attempt === this.config.maxRetries) {
          break;
        }

        if (this.config.retryableErrors && !this.config.retryableErrors(error)) {
          throw error;
        }

        this.logger.warn(
          `Attempt ${attempt + 1} failed, retrying in ${delay}ms... Error: ${error.message}`,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * this.config.backoffMultiplier, this.config.maxDelayMs);
      }
    }

    throw lastError;
  }
}




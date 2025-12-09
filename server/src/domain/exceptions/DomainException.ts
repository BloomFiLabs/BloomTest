/**
 * Base domain exception class
 */
export class DomainException extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, any>;

  constructor(
    message: string,
    code: string = 'DOMAIN_ERROR',
    context?: Record<string, any>,
  ) {
    super(message);
    this.name = 'DomainException';
    this.code = code;
    this.timestamp = new Date();
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Exchange-specific exception
 */
export class ExchangeException extends DomainException {
  public readonly exchange: string;

  constructor(message: string, exchange: string, context?: Record<string, any>) {
    super(`[${exchange}] ${message}`, 'EXCHANGE_ERROR', context);
    this.name = 'ExchangeException';
    this.exchange = exchange;
  }
}

/**
 * Validation exception
 */
export class ValidationException extends DomainException {
  public readonly validationCode: string;

  constructor(
    message: string,
    validationCode: string,
    context?: Record<string, any>,
  ) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationException';
    this.validationCode = validationCode;
  }
}

/**
 * Insufficient balance exception
 */
export class InsufficientBalanceException extends DomainException {
  public readonly required: number;
  public readonly available: number;
  public readonly currency: string;

  constructor(
    required: number,
    available: number,
    currency: string = 'USDC',
    context?: Record<string, any>,
  ) {
    super(
      `Insufficient balance: required ${required} ${currency}, available ${available} ${currency}`,
      'INSUFFICIENT_BALANCE',
      context,
    );
    this.name = 'InsufficientBalanceException';
    this.required = required;
    this.available = available;
    this.currency = currency;
  }
}

/**
 * Order execution exception
 */
export class OrderExecutionException extends DomainException {
  public readonly orderId: string;
  public readonly exchange: string;

  constructor(
    message: string,
    orderId: string,
    exchange: string,
    context?: Record<string, any>,
  ) {
    super(`Order execution failed: ${message}`, 'ORDER_EXECUTION_ERROR', context);
    this.name = 'OrderExecutionException';
    this.orderId = orderId;
    this.exchange = exchange;
  }
}

/**
 * Position not found exception
 */
export class PositionNotFoundException extends DomainException {
  public readonly symbol: string;
  public readonly exchange: string;

  constructor(
    symbol: string,
    exchange: string,
    context?: Record<string, any>,
  ) {
    super(
      `Position not found: ${symbol} on ${exchange}`,
      'POSITION_NOT_FOUND',
      context,
    );
    this.name = 'PositionNotFoundException';
    this.symbol = symbol;
    this.exchange = exchange;
  }
}

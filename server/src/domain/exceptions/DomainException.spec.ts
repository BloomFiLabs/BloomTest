import {
  DomainException,
  ExchangeException,
  ValidationException,
  InsufficientBalanceException,
  OrderExecutionException,
  PositionNotFoundException,
} from './DomainException';

describe('DomainException', () => {
  describe('DomainException (base)', () => {
    it('should create exception with message', () => {
      const ex = new DomainException('test message');
      expect(ex.message).toBe('test message');
      expect(ex.name).toBe('DomainException');
      expect(ex.code).toBe('DOMAIN_ERROR');
      expect(ex.timestamp).toBeInstanceOf(Date);
    });

    it('should create exception with code', () => {
      const ex = new DomainException('test', 'CUSTOM_CODE');
      expect(ex.code).toBe('CUSTOM_CODE');
    });

    it('should create exception with context', () => {
      const context = { userId: '123', action: 'test' };
      const ex = new DomainException('test', 'CODE', context);
      expect(ex.context).toEqual(context);
    });

    it('should be instance of Error', () => {
      const ex = new DomainException('test');
      expect(ex).toBeInstanceOf(Error);
    });

    it('should have stack trace', () => {
      const ex = new DomainException('test');
      expect(ex.stack).toBeDefined();
    });
  });

  describe('ExchangeException', () => {
    it('should create exchange exception', () => {
      const ex = new ExchangeException('test', 'HYPERLIQUID');
      expect(ex.message).toBe('[HYPERLIQUID] test');
      expect(ex.exchange).toBe('HYPERLIQUID');
      expect(ex.code).toBe('EXCHANGE_ERROR');
      expect(ex.name).toBe('ExchangeException');
    });

    it('should be instance of DomainException', () => {
      const ex = new ExchangeException('test', 'ASTER');
      expect(ex).toBeInstanceOf(DomainException);
    });
  });

  describe('ValidationException', () => {
    it('should create validation exception', () => {
      const ex = new ValidationException('test', 'INVALID_INPUT');
      expect(ex.message).toBe('test');
      expect(ex.validationCode).toBe('INVALID_INPUT');
      expect(ex.code).toBe('VALIDATION_ERROR');
      expect(ex.name).toBe('ValidationException');
    });

    it('should be instance of DomainException', () => {
      const ex = new ValidationException('test', 'INVALID_INPUT');
      expect(ex).toBeInstanceOf(DomainException);
    });
  });

  describe('InsufficientBalanceException', () => {
    it('should create insufficient balance exception', () => {
      const ex = new InsufficientBalanceException(100, 50);
      expect(ex.message).toContain('100');
      expect(ex.message).toContain('50');
      expect(ex.required).toBe(100);
      expect(ex.available).toBe(50);
      expect(ex.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('should be instance of DomainException', () => {
      const ex = new InsufficientBalanceException(100, 50);
      expect(ex).toBeInstanceOf(DomainException);
    });
  });

  describe('OrderExecutionException', () => {
    it('should create order execution exception', () => {
      const ex = new OrderExecutionException('test', 'ORDER_ID_123', 'HYPERLIQUID');
      expect(ex.message).toBe('Order execution failed: test');
      expect(ex.orderId).toBe('ORDER_ID_123');
      expect(ex.exchange).toBe('HYPERLIQUID');
      expect(ex.code).toBe('ORDER_EXECUTION_ERROR');
    });

    it('should be instance of DomainException', () => {
      const ex = new OrderExecutionException('test', 'ORDER_ID', 'ASTER');
      expect(ex).toBeInstanceOf(DomainException);
    });
  });

  describe('PositionNotFoundException', () => {
    it('should create position not found exception', () => {
      const ex = new PositionNotFoundException('ETH', 'HYPERLIQUID');
      expect(ex.message).toContain('ETH');
      expect(ex.message).toContain('HYPERLIQUID');
      expect(ex.symbol).toBe('ETH');
      expect(ex.exchange).toBe('HYPERLIQUID');
      expect(ex.code).toBe('POSITION_NOT_FOUND');
    });

    it('should be instance of DomainException', () => {
      const ex = new PositionNotFoundException('ETH', 'ASTER');
      expect(ex).toBeInstanceOf(DomainException);
    });
  });
});

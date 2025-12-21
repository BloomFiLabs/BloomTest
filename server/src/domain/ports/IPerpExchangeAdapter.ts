import { ExchangeConfig } from '../value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
} from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';

/**
 * Funding payment received or paid on a position
 */
export interface FundingPayment {
  /** Exchange name */
  exchange: string;
  /** Trading symbol (e.g., 'ETH', 'BTC') */
  symbol: string;
  /** USD amount (positive = received, negative = paid) */
  amount: number;
  /** Funding rate applied */
  fundingRate: number;
  /** Position size at time of funding */
  positionSize: number;
  /** When the funding was applied */
  timestamp: Date;
}

/**
 * Exchange-specific error
 */
export class ExchangeError extends Error {
  constructor(
    message: string,
    public readonly exchangeType: string,
    public readonly code?: string,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}

/**
 * IPerpExchangeAdapter - Interface for perpetual exchange adapters
 *
 * This interface abstracts the operations needed to interact with perpetual exchanges
 * (Aster, Lighter, Hyperliquid). Each exchange will have its own implementation.
 */
export interface IPerpExchangeAdapter {
  /**
   * Get the exchange configuration
   */
  getConfig(): ExchangeConfig;

  /**
   * Get the exchange type
   */
  getExchangeType(): string;

  /**
   * Place an order on the exchange
   * @param request Order request
   * @returns Order response with order ID and status
   * @throws ExchangeError if order placement fails
   */
  placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse>;

  /**
   * Get current position for a symbol
   * @param symbol Trading symbol (e.g., 'ETHUSDT', 'ETH')
   * @returns Position information or null if no position
   * @throws ExchangeError if position fetch fails
   */
  getPosition(symbol: string): Promise<PerpPosition | null>;

  /**
   * Get all open positions
   * @returns Array of all open positions
   * @throws ExchangeError if positions fetch fails
   */
  getPositions(): Promise<PerpPosition[]>;

  /**
   * Cancel an order
   * @param orderId Exchange-provided order ID
   * @param symbol Trading symbol (optional, some exchanges require it)
   * @returns True if cancellation was successful
   * @throws ExchangeError if cancellation fails
   */
  cancelOrder(orderId: string, symbol?: string): Promise<boolean>;

  /**
   * Cancel all open orders for a symbol
   * @param symbol Trading symbol
   * @returns Number of orders cancelled
   * @throws ExchangeError if cancellation fails
   */
  cancelAllOrders(symbol: string): Promise<number>;

  /**
   * Get order status
   * @param orderId Exchange-provided order ID
   * @param symbol Trading symbol (optional, some exchanges require it)
   * @returns Order response with current status
   * @throws ExchangeError if order fetch fails
   */
  getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse>;

  /**
   * Get current mark price for a symbol
   * @param symbol Trading symbol
   * @returns Current mark price
   * @throws ExchangeError if price fetch fails
   */
  getMarkPrice(symbol: string): Promise<number>;

  /**
   * Get account balance (available margin/collateral)
   * @returns Available balance in USD
   * @throws ExchangeError if balance fetch fails
   */
  getBalance(): Promise<number>;

  /**
   * Get account equity (total account value)
   * @returns Total equity in USD
   * @throws ExchangeError if equity fetch fails
   */
  getEquity(): Promise<number>;

  /**
   * Get available margin for opening new positions
   * This accounts for margin already used by existing positions and applies safety buffers.
   * Use this instead of getBalance() when determining position sizing.
   *
   * @returns Available margin in USD for new positions
   * @throws ExchangeError if calculation fails
   */
  getAvailableMargin?(): Promise<number>;

  /**
   * Check if the exchange adapter is connected and ready
   * @returns True if adapter is ready
   */
  isReady(): Promise<boolean>;

  /**
   * Test the connection to the exchange
   * @throws ExchangeError if connection test fails
   */
  testConnection(): Promise<void>;

  /**
   * Transfer funds between spot and perp margin accounts (internal transfer)
   * @param amount Amount to transfer in USD
   * @param toPerp True to transfer from spot to perp margin, false to transfer from perp margin to spot
   * @returns Transaction hash or confirmation ID
   * @throws ExchangeError if transfer fails
   */
  transferInternal(amount: number, toPerp: boolean): Promise<string>;

  /**
   * Deposit funds from external source (if supported by exchange)
   * @param amount Amount to deposit in USD
   * @param asset Asset symbol (e.g., 'USDT', 'USDC')
   * @param destination Optional destination address or identifier
   * @returns Transaction hash or deposit ID
   * @throws ExchangeError if deposit fails
   */
  depositExternal(
    amount: number,
    asset: string,
    destination?: string,
  ): Promise<string>;

  /**
   * Withdraw funds to external wallet address
   * @param amount Amount to withdraw in USD
   * @param asset Asset symbol (e.g., 'USDT', 'USDC')
   * @param destination Destination wallet address
   * @returns Transaction hash or withdrawal ID
   * @throws ExchangeError if withdrawal fails
   */
  withdrawExternal(
    amount: number,
    asset: string,
    destination: string,
  ): Promise<string>;

  /**
   * Get historical funding payments for the account
   * @param startTime Optional start time (default: 7 days ago)
   * @param endTime Optional end time (default: now)
   * @returns Array of funding payments
   * @throws ExchangeError if fetch fails
   */
  getFundingPayments(
    startTime?: number,
    endTime?: number,
  ): Promise<FundingPayment[]>;

  /**
   * Get all open orders
   * @returns Array of open orders with order ID, symbol, side, price, size, and timestamp
   * @throws ExchangeError if fetch fails
   */
  getOpenOrders?(): Promise<OpenOrder[]>;

  /**
   * Get fast withdraw pool availability (Lighter-specific)
   * Returns the amount available in the fast withdraw pool, or null if not applicable
   * @returns Available USDC in the fast withdraw pool, or null
   */
  getFastWithdrawPoolAvailability?(): Promise<number | null>;

  /**
   * Set leverage for a symbol
   * Should be called before opening positions to ensure correct margin requirements
   * @param symbol Trading symbol
   * @param leverage Target leverage (e.g., 3, 5, 10)
   * @param isCross Whether to use cross margin (true) or isolated margin (false)
   * @returns True if leverage was set successfully
   */
  setLeverage?(
    symbol: string,
    leverage: number,
    isCross?: boolean,
  ): Promise<boolean>;

  /**
   * Get max leverage allowed for a symbol
   * @param symbol Trading symbol
   * @returns Maximum leverage allowed
   */
  getMaxLeverage?(symbol: string): Promise<number>;

  /**
   * Get the tick size (minimum price increment) for a symbol
   * @param symbol Trading symbol
   * @returns Tick size (e.g., 0.01, 0.0001)
   */
  getTickSize(symbol: string): Promise<number>;

  /**
   * Modify an existing order (price or size)
   * @param orderId Exchange-provided order ID
   * @param request New order parameters
   * @returns Order response with new order ID (if changed) and status
   * @throws ExchangeError if modification fails
   */
  modifyOrder?(orderId: string, request: PerpOrderRequest): Promise<PerpOrderResponse>;

  /**
   * Check if the exchange supports a specific symbol
   * @param symbol Trading symbol
   * @returns True if supported
   */
  supportsSymbol(symbol: string): boolean | Promise<boolean>;
}

/**
 * Open order information
 */
export interface OpenOrder {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  filledSize: number;
  timestamp: Date;
}

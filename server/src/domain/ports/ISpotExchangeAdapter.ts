import { ExchangeConfig, ExchangeType } from '../value-objects/ExchangeConfig';
import { SpotOrderRequest, SpotOrderResponse } from '../value-objects/SpotOrder';
import { SpotPosition } from '../entities/SpotPosition';

/**
 * Exchange-specific error for spot trading
 */
export class SpotExchangeError extends Error {
  constructor(
    message: string,
    public readonly exchangeType: ExchangeType,
    public readonly code?: string,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = 'SpotExchangeError';
  }
}

/**
 * ISpotExchangeAdapter - Interface for spot exchange adapters
 * 
 * This interface abstracts the operations needed to interact with spot trading
 * on exchanges (Hyperliquid, Aster, Lighter, Extended). Each exchange will have its own implementation.
 */
export interface ISpotExchangeAdapter {
  /**
   * Get the exchange configuration
   */
  getConfig(): ExchangeConfig;

  /**
   * Get the exchange type
   */
  getExchangeType(): ExchangeType;

  /**
   * Place a spot order on the exchange
   * @param request Spot order request
   * @returns Order response with order ID and status
   * @throws SpotExchangeError if order placement fails
   */
  placeSpotOrder(request: SpotOrderRequest): Promise<SpotOrderResponse>;

  /**
   * Get current spot position for a symbol
   * @param symbol Trading symbol (e.g., 'ETHUSDT', 'ETH')
   * @returns Position information or null if no position
   * @throws SpotExchangeError if position fetch fails
   */
  getSpotPosition(symbol: string): Promise<SpotPosition | null>;

  /**
   * Get all open spot positions
   * @returns Array of all open spot positions
   * @throws SpotExchangeError if positions fetch fails
   */
  getSpotPositions(): Promise<SpotPosition[]>;

  /**
   * Cancel a spot order
   * @param orderId Exchange-provided order ID
   * @param symbol Trading symbol (optional, some exchanges require it)
   * @returns True if cancellation was successful
   * @throws SpotExchangeError if cancellation fails
   */
  cancelSpotOrder(orderId: string, symbol?: string): Promise<boolean>;

  /**
   * Get spot order status
   * @param orderId Exchange-provided order ID
   * @param symbol Trading symbol (optional, some exchanges require it)
   * @returns Order response with current status
   * @throws SpotExchangeError if order fetch fails
   */
  getSpotOrderStatus(orderId: string, symbol?: string): Promise<SpotOrderResponse>;

  /**
   * Get spot balance for an asset
   * @param asset Asset symbol (e.g., 'ETH', 'USDC', 'USDT')
   * @returns Available balance in base asset units
   * @throws SpotExchangeError if balance fetch fails
   */
  getSpotBalance(asset: string): Promise<number>;

  /**
   * Get current spot price for a symbol
   * @param symbol Trading symbol
   * @returns Current spot price
   * @throws SpotExchangeError if price fetch fails
   */
  getSpotPrice(symbol: string): Promise<number>;

  /**
   * Transfer funds between spot and perp margin accounts (internal transfer)
   * @param amount Amount to transfer in USD
   * @param toPerp True to transfer from spot to perp margin, false to transfer from perp margin to spot
   * @returns Transaction hash or confirmation ID
   * @throws SpotExchangeError if transfer fails
   */
  transferInternal(amount: number, toPerp: boolean): Promise<string>;

  /**
   * Check if the exchange adapter is connected and ready
   * @returns True if adapter is ready
   */
  isReady(): Promise<boolean>;

  /**
   * Test the connection to the exchange
   * @throws SpotExchangeError if connection test fails
   */
  testConnection(): Promise<void>;
}






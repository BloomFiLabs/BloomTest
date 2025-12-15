import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { ExchangeConfig, ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter, ExchangeError, FundingPayment } from '../../../domain/ports/IPerpExchangeAdapter';
import { ExtendedSigningService } from './ExtendedSigningService';

/**
 * ExtendedExchangeAdapter - Implements IPerpExchangeAdapter for Extended exchange
 * 
 * Extended is a Starknet-based perpetual exchange that uses:
 * - SNIP12/EIP712 signing for orders
 * - Vault-based account system (l2Vault = position ID)
 * - Bridge deposits/withdrawals via Rhino.fi (Arbitrum, Base, etc.)
 * - REST API at https://api.starknet.extended.exchange
 * 
 * API Docs: https://api.docs.extended.exchange/
 */
@Injectable()
export class ExtendedExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(ExtendedExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly client: AxiosInstance;
  private readonly signingService: ExtendedSigningService;
  private readonly apiKey: string;
  private readonly starkPublicKey: string;
  private readonly vaultNumber: number; // This is l2Vault/collateralPosition in API
  private readonly isTestnet: boolean;
  
  // Arbitrum configuration for deposits/withdrawals
  private readonly ARBITRUM_CHAIN_ID = 42161;
  private readonly ARBITRUM_RPC_URL: string;
  private readonly arbitrumWallet: ethers.Wallet | null;

  // Cache for symbol -> market name mapping
  private marketInfoCache: Map<string, any> = new Map();
  private marketCacheTimestamp: number = 0;
  private readonly MARKET_CACHE_TTL = 3600000; // 1 hour

  constructor(private readonly configService: ConfigService) {
    // Extended Starknet instance base URL
    const baseUrl = this.configService.get<string>('EXTENDED_API_BASE_URL') || 
                    'https://api.starknet.extended.exchange';
    const apiKey = this.configService.get<string>('EXTENDED_API_KEY');
    // Support both EXTENDED_STARK_KEY and EXTENDED_STARK_PRIVATE_KEY
    const starkPrivateKey = this.configService.get<string>('EXTENDED_STARK_PRIVATE_KEY') ||
                            this.configService.get<string>('EXTENDED_STARK_KEY');
    const starkPublicKey = this.configService.get<string>('EXTENDED_STARK_PUBLIC_KEY');
    const vaultNumber = parseInt(this.configService.get<string>('EXTENDED_VAULT_NUMBER') || '0');
    const isTestnet = this.configService.get<string>('EXTENDED_TESTNET') === 'true';

    if (!apiKey) {
      throw new Error('Extended exchange requires EXTENDED_API_KEY');
    }
    if (!starkPrivateKey) {
      throw new Error('Extended exchange requires EXTENDED_STARK_PRIVATE_KEY');
    }
    if (!starkPublicKey) {
      throw new Error('Extended exchange requires EXTENDED_STARK_PUBLIC_KEY (l2Key from API management page)');
    }
    if (vaultNumber === 0) {
      throw new Error('Extended exchange requires EXTENDED_VAULT_NUMBER (l2Vault from API management page)');
    }

    this.apiKey = apiKey;
    this.starkPublicKey = starkPublicKey.startsWith('0x') ? starkPublicKey : `0x${starkPublicKey}`;
    this.vaultNumber = vaultNumber;
    this.isTestnet = isTestnet;

    // Initialize signing service with Starknet domain
    this.signingService = new ExtendedSigningService(starkPrivateKey, isTestnet);

    // Initialize Arbitrum wallet for bridge deposits/withdrawals
    const privateKey = this.configService.get<string>('PRIVATE_KEY') || 
                      this.configService.get<string>('EXTENDED_PRIVATE_KEY');
    this.ARBITRUM_RPC_URL = this.configService.get<string>('ARBITRUM_RPC_URL') ||
                            this.configService.get<string>('ARB_RPC_URL') ||
                            'https://arb1.arbitrum.io/rpc';

    if (privateKey) {
      const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const provider = new ethers.JsonRpcProvider(this.ARBITRUM_RPC_URL);
      this.arbitrumWallet = new ethers.Wallet(normalizedPrivateKey, provider);
    } else {
      this.arbitrumWallet = null;
    }

    this.config = new ExchangeConfig(
      ExchangeType.EXTENDED,
      baseUrl,
      apiKey,
      undefined,
      privateKey,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      starkPrivateKey,
      vaultNumber,
      undefined,
    );

    // Create axios client with proper headers per Extended API docs
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: this.config.getTimeout(),
      headers: {
        'X-Api-Key': this.apiKey,  // Note: lowercase 'pi' per API docs
        'Content-Type': 'application/json',
        'User-Agent': 'Bloom-Vault-Bot/1.0',  // Required header per API docs
      },
    });

    this.logger.log(`Extended adapter initialized for vault: ${vaultNumber} (testnet: ${isTestnet})`);
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return ExchangeType.EXTENDED;
  }

  /**
   * Refresh market info cache from Extended API
   * API: GET /api/v1/info/markets
   * Returns markets in format: { name: "BTC-USD", assetName: "BTC", ... }
   */
  private async refreshMarketCache(): Promise<void> {
    const now = Date.now();
    if (this.marketInfoCache.size > 0 && (now - this.marketCacheTimestamp) < this.MARKET_CACHE_TTL) {
      return;
    }

    try {
      // Extended API uses /api/v1/ prefix
      const response = await this.client.get('/api/v1/info/markets');
      if (response.data?.status === 'ok' && Array.isArray(response.data.data)) {
        this.marketInfoCache.clear();
        for (const market of response.data.data) {
          // Market name format is "BTC-USD", "ETH-USD", etc.
          if (market.name) {
            this.marketInfoCache.set(market.name.toUpperCase(), market);
            // Also index by asset name for convenience
            if (market.assetName) {
              this.marketInfoCache.set(market.assetName.toUpperCase(), market);
            }
          }
        }
        this.marketCacheTimestamp = now;
        this.logger.debug(`Cached ${this.marketInfoCache.size} markets from Extended API`);
      }
    } catch (error: any) {
      this.logger.warn(`Failed to refresh market cache: ${error.message}`);
    }
  }

  /**
   * Get market name for a symbol (Extended uses "BTC-USD" format)
   * @param symbol Input symbol like "BTC", "BTCUSDC", "BTC-PERP", etc.
   * @returns Extended market name like "BTC-USD"
   */
  private async getMarketName(symbol: string): Promise<string> {
    await this.refreshMarketCache();
    
    // Normalize: remove common suffixes and convert to Extended format
    let normalized = symbol.toUpperCase()
      .replace('USDC', '')
      .replace('USDT', '')
      .replace('-PERP', '')
      .replace('-USD', '');
    
    // Try direct match first
    if (this.marketInfoCache.has(`${normalized}-USD`)) {
      return `${normalized}-USD`;
    }
    
    // Try as asset name
    const market = this.marketInfoCache.get(normalized);
    if (market?.name) {
      return market.name;
    }
    
    // Default: assume it's the base asset and append -USD
    return `${normalized}-USD`;
  }

  /**
   * Get market info for a symbol
   */
  private async getMarketInfo(symbol: string): Promise<any> {
    await this.refreshMarketCache();
    const marketName = await this.getMarketName(symbol);
    return this.marketInfoCache.get(marketName) || null;
  }

  /**
   * Generate a random nonce for signing (must be ≥1 and ≤2^31)
   */
  private generateNonce(): number {
    return Math.floor(Math.random() * 2147483646) + 1;
  }

  /**
   * Place an order on Extended exchange
   * API: POST /api/v1/user/order
   * 
   * Extended order format requires:
   * - id: Order ID assigned by user (UUID or unique string)
   * - market: Market name like "BTC-USD"
   * - type: "LIMIT", "MARKET", "CONDITIONAL", or "TPSL"
   * - side: "BUY" or "SELL"
   * - qty: Order size in base asset
   * - price: Worst accepted price (required even for market orders)
   * - fee: Maximum fee willing to pay (taker fee for market/IOC, maker for post-only)
   * - timeInForce: "GTT" or "IOC"
   * - expiryEpochMillis: Expiration timestamp in milliseconds
   * - settlement: { signature: { r, s }, starkKey, collateralPosition }
   */
  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    try {
      const marketName = await this.getMarketName(request.symbol);
      const side = request.side === OrderSide.LONG ? 'BUY' : 'SELL';
      const orderType = request.type === OrderType.MARKET ? 'MARKET' : 'LIMIT';
      
      // Extended requires price even for market orders
      // For market orders: Buy = markPrice * 1.05, Sell = markPrice * 0.95
      let price = request.price;
      if (!price || request.type === OrderType.MARKET) {
        const markPrice = await this.getMarkPrice(request.symbol);
        price = request.side === OrderSide.LONG 
          ? markPrice * 1.05  // 5% above for market buy
          : markPrice * 0.95; // 5% below for market sell
      }
      
      // Expiration: max 90 days (mainnet) or 28 days (testnet)
      const maxDays = this.isTestnet ? 28 : 90;
      const expiryEpochMillis = Date.now() + (maxDays * 24 * 60 * 60 * 1000);
      
      // Nonce for signing
      const nonce = this.generateNonce();
      
      // Generate unique order ID
      const orderId = request.clientOrderId || `bloom-${Date.now()}-${nonce}`;
      
      // Fee: Use taker fee (0.025% = 0.00025) for market/IOC orders
      const fee = '0.00025';

      // Build order data for signing
      const orderData = {
        symbol: marketName,
        side: side as 'buy' | 'sell',
        orderType: orderType.toLowerCase() as 'limit' | 'market',
        size: request.size.toString(),
        price: price.toString(),
        timeInForce: request.timeInForce === TimeInForce.IOC ? 'IOC' : 'GTC',
        reduceOnly: request.reduceOnly || false,
        postOnly: false,
        expiration: Math.floor(expiryEpochMillis / 1000),
        clientOrderId: orderId,
      };

      // Sign the order and get r,s signature components
      const signatureResult = await this.signingService.signOrderWithComponents(orderData);

      // Build API request payload per Extended API docs
      const payload: any = {
        id: orderId,
        market: marketName,
        type: orderType,
        side: side,
        qty: request.size.toString(),
        price: price.toString(),
        timeInForce: request.timeInForce === TimeInForce.IOC ? 'IOC' : 'GTT',
        expiryEpochMillis: expiryEpochMillis,
        fee: fee,
        nonce: nonce.toString(),
        reduceOnly: request.reduceOnly || false,
        postOnly: false,
        selfTradeProtectionLevel: 'ACCOUNT',
        settlement: {
          signature: {
            r: signatureResult.r,
            s: signatureResult.s,
          },
          starkKey: this.starkPublicKey,
          collateralPosition: this.vaultNumber.toString(),
        },
      };

      // Submit order to Extended API
      const response = await this.client.post('/api/v1/user/order', payload);

      if (response.data?.status === 'OK' && response.data.data) {
        const resultOrderId = response.data.data.id?.toString() || response.data.data.externalId || orderId;
        
        this.logger.log(
          `✅ Order placed on Extended: ${resultOrderId} - ${side} ${request.size} ${marketName} @ ${price}`
        );

        return new PerpOrderResponse(
          resultOrderId,
          OrderStatus.SUBMITTED, // Extended is async - actual status comes via WebSocket
          request.symbol,
          request.side,
          orderId,
          undefined,
          undefined,
          undefined,
          new Date(),
        );
      } else {
        const errorMsg = response.data?.error?.message || 'Unknown error';
        throw new Error(`Order rejected: ${errorMsg}`);
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || 
                       error.response?.data?.message || 
                       error.message || String(error);
      this.logger.error(`Failed to place order on Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to place order: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }

  async getPosition(symbol: string): Promise<PerpPosition | null> {
    try {
      const marketName = await this.getMarketName(symbol);
      const positions = await this.getPositions();
      return positions.find(p => 
        p.symbol === symbol || 
        p.symbol === marketName ||
        p.symbol.replace('-USD', '') === symbol.toUpperCase()
      ) || null;
    } catch (error: any) {
      throw new ExchangeError(
        `Failed to get position: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  /**
   * Get all open positions
   * API: GET /api/v1/user/positions
   */
  async getPositions(): Promise<PerpPosition[]> {
    try {
      const response = await this.client.get('/api/v1/user/positions');

      if (response.data?.status !== 'OK' || !Array.isArray(response.data.data)) {
        return [];
      }

      const positions: PerpPosition[] = [];
      for (const pos of response.data.data) {
        const size = parseFloat(pos.size || '0');
        if (size !== 0) {
          positions.push(new PerpPosition(
            ExchangeType.EXTENDED,
            pos.market,  // Extended uses "market" field with format "BTC-USD"
            pos.side === 'LONG' ? OrderSide.LONG : OrderSide.SHORT,
            Math.abs(size),
            parseFloat(pos.openPrice || '0'),  // Entry price
            parseFloat(pos.markPrice || '0'),
            parseFloat(pos.unrealisedPnl || '0'),
            parseFloat(pos.leverage || '1'),
            parseFloat(pos.liquidationPrice || '0'),
            undefined,
            pos.updatedTime ? new Date(pos.updatedTime) : new Date(),
          ));
        }
      }

      return positions;
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      this.logger.error(`Failed to get positions from Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to get positions: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }

  /**
   * Cancel order by ID
   * API: DELETE /api/v1/user/order/{id}
   */
  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      const response = await this.client.delete(`/api/v1/user/order/${orderId}`);
      
      if (response.data?.status === 'OK') {
        this.logger.log(`✅ Order cancelled on Extended: ${orderId}`);
        return true;
      }
      return false;
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      this.logger.error(`Failed to cancel order on Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to cancel order: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }

  /**
   * Cancel all orders for a market
   * API: POST /api/v1/user/order/massCancel
   */
  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      const marketName = await this.getMarketName(symbol);
      
      const response = await this.client.post('/api/v1/user/order/massCancel', {
        markets: [marketName],
      });
      
      // Extended mass cancel is async, returns status
      if (response.data?.status === 'OK') {
        this.logger.log(`✅ Mass cancel initiated on Extended for ${marketName}`);
        return 1; // Async - we don't know exact count
      }
      return 0;
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      this.logger.error(`Failed to cancel all orders on Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }

  /**
   * Get order status by ID
   * API: GET /api/v1/user/orders/{id}
   */
  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    try {
      const response = await this.client.get(`/api/v1/user/orders/${orderId}`);

      if (response.data?.status !== 'OK' || !response.data.data) {
        throw new Error(`Order not found: ${orderId}`);
      }

      const order = response.data.data;
      const statusMap: Record<string, OrderStatus> = {
        'NEW': OrderStatus.SUBMITTED,
        'PARTIALLY_FILLED': OrderStatus.SUBMITTED,
        'FILLED': OrderStatus.FILLED,
        'CANCELLED': OrderStatus.CANCELLED,
        'REJECTED': OrderStatus.REJECTED,
        'EXPIRED': OrderStatus.EXPIRED,
        'UNTRIGGERED': OrderStatus.SUBMITTED,
        'TRIGGERED': OrderStatus.SUBMITTED,
      };

      return new PerpOrderResponse(
        order.id?.toString() || orderId,
        statusMap[order.status] || OrderStatus.SUBMITTED,
        order.market,
        order.side === 'BUY' ? OrderSide.LONG : OrderSide.SHORT,
        order.externalId,
        order.filledQty ? parseFloat(order.filledQty) : undefined,
        order.averagePrice ? parseFloat(order.averagePrice) : undefined,
        undefined,
        order.updatedTime ? new Date(order.updatedTime) : new Date(),
      );
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to get order status: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }

  /**
   * Get mark price for a symbol
   * API: GET /api/v1/info/markets/{market}/stats
   * Mark price is in marketStats.markPrice
   */
  async getMarkPrice(symbol: string): Promise<number> {
    try {
      const marketName = await this.getMarketName(symbol);
      const response = await this.client.get(`/api/v1/info/markets/${marketName}/stats`);
      
      if (response.data?.status === 'OK' && response.data.data?.markPrice) {
        return parseFloat(response.data.data.markPrice);
      }
      throw new Error(`Mark price not found for ${symbol}`);
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to get mark price: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }

  /**
   * Get available balance for trading
   * API: GET /api/v1/user/balance
   * Returns 404 if balance is 0
   */
  async getBalance(): Promise<number> {
    try {
      const response = await this.client.get('/api/v1/user/balance');

      if (response.data?.status === 'OK' && response.data.data) {
        // availableForTrade = Available Balance for Trading
        return parseFloat(response.data.data.availableForTrade || '0');
      }
      return 0;
    } catch (error: any) {
      // Extended returns 404 if balance is 0
      if (error.response?.status === 404) {
        return 0;
      }
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to get balance: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }

  /**
   * Get account equity
   * API: GET /api/v1/user/balance
   * Equity = Account Balance + Unrealised PnL
   */
  async getEquity(): Promise<number> {
    try {
      const response = await this.client.get('/api/v1/user/balance');

      if (response.data?.status === 'OK' && response.data.data) {
        return parseFloat(response.data.data.equity || '0');
      }
      return 0;
    } catch (error: any) {
      // Extended returns 404 if balance is 0
      if (error.response?.status === 404) {
        return 0;
      }
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to get equity: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.testConnection();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Test API connection
   * Use markets endpoint as ping test (Extended doesn't have a /ping endpoint)
   */
  async testConnection(): Promise<void> {
    try {
      const response = await this.client.get('/api/v1/info/markets', { timeout: 5000 });
      if (response.data?.status !== 'ok') {
        throw new Error('Invalid response from Extended API');
      }
    } catch (error: any) {
      throw new ExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async transferInternal(amount: number, toPerp: boolean): Promise<string> {
    // Extended uses vault-based system, internal transfers are between vaults
    // This is a simplified implementation - adjust based on actual API
    try {
      const transferData = {
        asset: 'USDC',
        amount: amount.toString(),
        toVault: toPerp ? this.vaultNumber : 0, // Simplified - adjust based on actual API
      };

      const signature = await this.signingService.signTransfer(transferData);

      const response = await this.client.post('/api/v1/user/transfer', {
        ...transferData,
        signature,
      });

      if (response.data && response.data.transferId) {
        return response.data.transferId.toString();
      }
      throw new Error(`Transfer failed: ${JSON.stringify(response.data)}`);
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to transfer: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async depositExternal(amount: number, asset: string, destination?: string): Promise<string> {
    // Extended deposits from Arbitrum
    if (!this.arbitrumWallet) {
      throw new ExchangeError(
        'PRIVATE_KEY required for Arbitrum deposits',
        ExchangeType.EXTENDED,
        'MISSING_PRIVATE_KEY',
      );
    }

    try {
      // Get bridge quote from Extended API
      const quoteResponse = await this.client.get('/v1/bridge/quote', {
        params: {
          fromChain: 'arbitrum',
          toChain: 'starknet',
          asset: asset.toUpperCase(),
          amount: amount.toString(),
        },
      });

      if (!quoteResponse.data || !quoteResponse.data.depositAddress) {
        throw new Error('Failed to get deposit address from Extended');
      }

      const depositAddress = quoteResponse.data.depositAddress;
      const usdcContractAddress = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // USDC on Arbitrum

      // ERC20 ABI for approve and transfer
      const erc20Abi = [
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)',
      ];

      const usdcContract = new ethers.Contract(usdcContractAddress, erc20Abi, this.arbitrumWallet);
      const decimals = await usdcContract.decimals();
      const amountWei = ethers.parseUnits(amount.toString(), decimals);

      // Approve Extended bridge contract
      this.logger.log(`Approving Extended bridge contract: ${depositAddress}`);
      const approveTx = await usdcContract.approve(depositAddress, amountWei);
      await approveTx.wait();

      // Transfer USDC to Extended bridge
      this.logger.log(`Depositing ${amount} ${asset} to Extended via Arbitrum bridge...`);
      const transferTx = await usdcContract.transfer(depositAddress, amountWei);
      const receipt = await transferTx.wait();

      if (receipt.status === 1) {
        this.logger.log(`✅ Deposit successful! Transaction: ${receipt.hash}`);
        return receipt.hash;
      } else {
        throw new Error(`Deposit transaction failed: ${receipt.hash}`);
      }
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      this.logger.error(`Failed to deposit to Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to deposit: ${errorMsg}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async withdrawExternal(amount: number, asset: string, destination: string): Promise<string> {
    // Extended withdrawals to Arbitrum
    if (!this.arbitrumWallet) {
      throw new ExchangeError(
        'PRIVATE_KEY required for Arbitrum withdrawals',
        ExchangeType.EXTENDED,
        'MISSING_PRIVATE_KEY',
      );
    }

    try {
      // Get bridge quote
      const quoteResponse = await this.client.get('/v1/bridge/quote', {
        params: {
          fromChain: 'starknet',
          toChain: 'arbitrum',
          asset: asset.toUpperCase(),
          amount: amount.toString(),
        },
      });

      if (!quoteResponse.data) {
        throw new Error('Failed to get withdrawal quote from Extended');
      }

      // Sign withdrawal request
      const withdrawalData = {
        asset: asset.toUpperCase(),
        amount: amount.toString(),
        destinationAddress: destination,
        chainId: this.ARBITRUM_CHAIN_ID,
        expiration: Math.floor(Date.now() / 1000) + 14 * 24 * 3600, // 14 days
      };

      const signature = await this.signingService.signWithdrawal(withdrawalData);

      // Submit withdrawal request
      const response = await this.client.post('/api/v1/user/withdrawal', {
        ...withdrawalData,
        signature,
        vaultNumber: this.vaultNumber,
      });

      if (response.data && response.data.withdrawalId) {
        const withdrawalId = response.data.withdrawalId.toString();
        this.logger.log(
          `✅ Withdrawal initiated on Extended: ${withdrawalId} - ${amount} ${asset} to ${destination} (Arbitrum)`
        );
        return withdrawalId;
      } else {
        throw new Error(`Withdrawal failed: ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      this.logger.error(`Failed to withdraw from Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to withdraw: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  /**
   * Get historical funding payments for the account
   * API: GET /api/v1/user/funding/history?market={market}&fromTime={fromTime}
   * 
   * @param startTime Optional start time in milliseconds (default: 7 days ago)
   * @param endTime Optional end time in milliseconds (default: now)
   * @returns Array of funding payments
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPayment[]> {
    try {
      const now = Date.now();
      const fromTime = startTime || now - (7 * 24 * 60 * 60 * 1000);

      // Extended requires fromTime parameter
      const response = await this.client.get('/api/v1/user/funding/history', {
        params: {
          fromTime: fromTime,
        },
        timeout: 30000,
      });

      if (response.data?.status === 'OK' && Array.isArray(response.data.data)) {
        return response.data.data
          .filter((entry: any) => {
            // Filter by endTime if provided
            const paidTime = entry.paidTime || 0;
            return !endTime || paidTime <= endTime;
          })
          .map((entry: any) => ({
            exchange: ExchangeType.EXTENDED,
            symbol: entry.market || 'UNKNOWN',
            amount: parseFloat(entry.fundingFee || '0'),
            fundingRate: parseFloat(entry.fundingRate || '0'),
            positionSize: parseFloat(entry.size || '0'),
            timestamp: new Date(entry.paidTime || Date.now()),
          }));
      }

      return [];
    } catch (error: any) {
      // Don't throw - just return empty if endpoint doesn't exist or fails
      this.logger.debug(`Extended funding history not available: ${error.message}`);
      return [];
    }
  }

  /**
   * Get open orders
   * API: GET /api/v1/user/orders
   */
  async getOpenOrders(symbol?: string): Promise<any[]> {
    try {
      const params: any = {};
      if (symbol) {
        params.market = await this.getMarketName(symbol);
      }

      const response = await this.client.get('/api/v1/user/orders', { params });

      if (response.data?.status === 'OK' && Array.isArray(response.data.data)) {
        return response.data.data;
      }
      return [];
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      this.logger.error(`Failed to get open orders from Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to get open orders: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.error?.code,
        error,
      );
    }
  }
}


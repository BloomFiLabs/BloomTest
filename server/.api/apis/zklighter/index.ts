import type * as types from './types';
import type { ConfigOptions, FetchResponse } from 'api/dist/core'
import Oas from 'oas';
import APICore from 'api/dist/core';
import definition from './openapi.json';

class SDK {
  spec: Oas;
  core: APICore;

  constructor() {
    this.spec = Oas.init(definition);
    this.core = new APICore(this.spec, 'zklighter/ (api/6.1.3)');
  }

  /**
   * Optionally configure various options that the SDK allows.
   *
   * @param config Object of supported SDK options and toggles.
   * @param config.timeout Override the default `fetch` request timeout of 30 seconds. This number
   * should be represented in milliseconds.
   */
  config(config: ConfigOptions) {
    this.core.setConfig(config);
  }

  /**
   * If the API you're using requires authentication you can supply the required credentials
   * through this method and the library will magically determine how they should be used
   * within your API request.
   *
   * With the exception of OpenID and MutualTLS, it supports all forms of authentication
   * supported by the OpenAPI specification.
   *
   * @example <caption>HTTP Basic auth</caption>
   * sdk.auth('username', 'password');
   *
   * @example <caption>Bearer tokens (HTTP or OAuth 2)</caption>
   * sdk.auth('myBearerToken');
   *
   * @example <caption>API Keys</caption>
   * sdk.auth('myApiKey');
   *
   * @see {@link https://spec.openapis.org/oas/v3.0.3#fixed-fields-22}
   * @see {@link https://spec.openapis.org/oas/v3.1.0#fixed-fields-22}
   * @param values Your auth credentials for the API; can specify up to two strings or numbers.
   */
  auth(...values: string[] | number[]) {
    this.core.setAuth(...values);
    return this;
  }

  /**
   * If the API you're using offers alternate server URLs, and server variables, you can tell
   * the SDK which one to use with this method. To use it you can supply either one of the
   * server URLs that are contained within the OpenAPI definition (along with any server
   * variables), or you can pass it a fully qualified URL to use (that may or may not exist
   * within the OpenAPI definition).
   *
   * @example <caption>Server URL with server variables</caption>
   * sdk.server('https://{region}.api.example.com/{basePath}', {
   *   name: 'eu',
   *   basePath: 'v14',
   * });
   *
   * @example <caption>Fully qualified server URL</caption>
   * sdk.server('https://eu.api.example.com/v14');
   *
   * @param url Server URL
   * @param variables An object of variables to replace into the server URL.
   */
  server(url: string, variables = {}) {
    this.core.setServer(url, variables);
  }

  /**
   * Get status of zklighter
   *
   * @summary status
   * @throws FetchError<400, types.StatusResponse400> Bad request
   */
  status(): Promise<FetchResponse<200, types.StatusResponse200>> {
    return this.core.fetch('/', 'get');
  }

  /**
   * Get account by account's index. <br>More details about account index: [Account
   * Index](https://apidocs.lighter.xyz/docs/account-index)<hr>**Response
   * Description:**<br><br>1) **Status:** 1 is active 0 is inactive.<br>2) **Collateral:**
   * The amount of collateral in the account.<hr>**Position Details Description:**<br>1)
   * **OOC:** Open order count in that market.<br>2) **Sign:** 1 for Long, -1 for
   * Short.<br>3) **Position:** The amount of position in that market.<br>4) **Avg Entry
   * Price:** The average entry price of the position.<br>5) **Position Value:** The value of
   * the position.<br>6) **Unrealized PnL:** The unrealized profit and loss of the
   * position.<br>7) **Realized PnL:** The realized profit and loss of the position.
   *
   * @summary account
   * @throws FetchError<400, types.AccountResponse400> Bad request
   */
  account(metadata: types.AccountMetadataParam): Promise<FetchResponse<200, types.AccountResponse200>> {
    return this.core.fetch('/api/v1/account', 'get', metadata);
  }

  /**
   * Get account active orders. `auth` can be generated using the SDK.
   *
   * @summary accountActiveOrders
   * @throws FetchError<400, types.AccountActiveOrdersResponse400> Bad request
   */
  accountActiveOrders(metadata: types.AccountActiveOrdersMetadataParam): Promise<FetchResponse<200, types.AccountActiveOrdersResponse200>> {
    return this.core.fetch('/api/v1/accountActiveOrders', 'get', metadata);
  }

  /**
   * Get account inactive orders
   *
   * @summary accountInactiveOrders
   * @throws FetchError<400, types.AccountInactiveOrdersResponse400> Bad request
   */
  accountInactiveOrders(metadata: types.AccountInactiveOrdersMetadataParam): Promise<FetchResponse<200, types.AccountInactiveOrdersResponse200>> {
    return this.core.fetch('/api/v1/accountInactiveOrders', 'get', metadata);
  }

  /**
   * Get account limits
   *
   * @summary accountLimits
   * @throws FetchError<400, types.AccountLimitsResponse400> Bad request
   */
  accountLimits(metadata: types.AccountLimitsMetadataParam): Promise<FetchResponse<200, types.AccountLimitsResponse200>> {
    return this.core.fetch('/api/v1/accountLimits', 'get', metadata);
  }

  /**
   * Get account metadatas
   *
   * @summary accountMetadata
   * @throws FetchError<400, types.AccountMetadataResponse400> Bad request
   */
  accountMetadata(metadata: types.AccountMetadataMetadataParam): Promise<FetchResponse<200, types.AccountMetadataResponse200>> {
    return this.core.fetch('/api/v1/accountMetadata', 'get', metadata);
  }

  /**
   * Get transactions of a specific account
   *
   * @summary accountTxs
   * @throws FetchError<400, types.AccountTxsResponse400> Bad request
   */
  accountTxs(metadata: types.AccountTxsMetadataParam): Promise<FetchResponse<200, types.AccountTxsResponse200>> {
    return this.core.fetch('/api/v1/accountTxs', 'get', metadata);
  }

  /**
   * Get accounts by l1_address returns all accounts associated with the given L1 address
   *
   * @summary accountsByL1Address
   * @throws FetchError<400, types.AccountsByL1AddressResponse400> Bad request
   */
  accountsByL1Address(metadata: types.AccountsByL1AddressMetadataParam): Promise<FetchResponse<200, types.AccountsByL1AddressResponse200>> {
    return this.core.fetch('/api/v1/accountsByL1Address', 'get', metadata);
  }

  /**
   * Get announcement
   *
   * @summary announcement
   * @throws FetchError<400, types.AnnouncementResponse400> Bad request
   */
  announcement(): Promise<FetchResponse<200, types.AnnouncementResponse200>> {
    return this.core.fetch('/api/v1/announcement', 'get');
  }

  /**
   * Get account api key. Set `api_key_index` to 255 to retrieve all api keys associated with
   * the account.
   *
   * @summary apikeys
   * @throws FetchError<400, types.ApikeysResponse400> Bad request
   */
  apikeys(metadata: types.ApikeysMetadataParam): Promise<FetchResponse<200, types.ApikeysResponse200>> {
    return this.core.fetch('/api/v1/apikeys', 'get', metadata);
  }

  /**
   * Get block by its height or commitment
   *
   * @summary block
   * @throws FetchError<400, types.BlockResponse400> Bad request
   */
  block(metadata: types.BlockMetadataParam): Promise<FetchResponse<200, types.BlockResponse200>> {
    return this.core.fetch('/api/v1/block', 'get', metadata);
  }

  /**
   * Get transactions in a block
   *
   * @summary blockTxs
   * @throws FetchError<400, types.BlockTxsResponse400> Bad request
   */
  blockTxs(metadata: types.BlockTxsMetadataParam): Promise<FetchResponse<200, types.BlockTxsResponse200>> {
    return this.core.fetch('/api/v1/blockTxs', 'get', metadata);
  }

  /**
   * Get blocks
   *
   * @summary blocks
   * @throws FetchError<400, types.BlocksResponse400> Bad request
   */
  blocks(metadata: types.BlocksMetadataParam): Promise<FetchResponse<200, types.BlocksResponse200>> {
    return this.core.fetch('/api/v1/blocks', 'get', metadata);
  }

  /**
   * Get candlesticks
   *
   * @summary candlesticks
   * @throws FetchError<400, types.CandlesticksResponse400> Bad request
   */
  candlesticks(metadata: types.CandlesticksMetadataParam): Promise<FetchResponse<200, types.CandlesticksResponse200>> {
    return this.core.fetch('/api/v1/candlesticks', 'get', metadata);
  }

  /**
   * Change account tier
   *
   * @summary changeAccountTier
   * @throws FetchError<400, types.ChangeAccountTierResponse400> Bad request
   */
  changeAccountTier(body: types.ChangeAccountTierBodyParam, metadata?: types.ChangeAccountTierMetadataParam): Promise<FetchResponse<200, types.ChangeAccountTierResponse200>> {
    return this.core.fetch('/api/v1/changeAccountTier', 'post', body, metadata);
  }

  /**
   * Get current height
   *
   * @summary currentHeight
   * @throws FetchError<400, types.CurrentHeightResponse400> Bad request
   */
  currentHeight(): Promise<FetchResponse<200, types.CurrentHeightResponse200>> {
    return this.core.fetch('/api/v1/currentHeight', 'get');
  }

  /**
   * Get deposit history
   *
   * @summary deposit_history
   * @throws FetchError<400, types.DepositHistoryResponse400> Bad request
   */
  deposit_history(metadata: types.DepositHistoryMetadataParam): Promise<FetchResponse<200, types.DepositHistoryResponse200>> {
    return this.core.fetch('/api/v1/deposit/history', 'get', metadata);
  }

  /**
   * Get exchange stats
   *
   * @summary exchangeStats
   * @throws FetchError<400, types.ExchangeStatsResponse400> Bad request
   */
  exchangeStats(): Promise<FetchResponse<200, types.ExchangeStatsResponse200>> {
    return this.core.fetch('/api/v1/exchangeStats', 'get');
  }

  /**
   * Export data
   *
   * @summary export
   * @throws FetchError<400, types.ExportResponse400> Bad request
   */
  export(metadata: types.ExportMetadataParam): Promise<FetchResponse<200, types.ExportResponse200>> {
    return this.core.fetch('/api/v1/export', 'get', metadata);
  }

  /**
   * Get fast bridge info
   *
   * @summary fastbridge_info
   * @throws FetchError<400, types.FastbridgeInfoResponse400> Bad request
   */
  fastbridge_info(): Promise<FetchResponse<200, types.FastbridgeInfoResponse200>> {
    return this.core.fetch('/api/v1/fastbridge/info', 'get');
  }

  /**
   * Get funding rates
   *
   * @summary funding-rates
   * @throws FetchError<400, types.FundingRatesResponse400> Bad request
   */
  fundingRates(): Promise<FetchResponse<200, types.FundingRatesResponse200>> {
    return this.core.fetch('/api/v1/funding-rates', 'get');
  }

  /**
   * Get fundings
   *
   * @summary fundings
   * @throws FetchError<400, types.FundingsResponse400> Bad request
   */
  fundings(metadata: types.FundingsMetadataParam): Promise<FetchResponse<200, types.FundingsResponse200>> {
    return this.core.fetch('/api/v1/fundings', 'get', metadata);
  }

  /**
   * Get L1 metadata
   *
   * @summary l1Metadata
   * @throws FetchError<400, types.L1MetadataResponse400> Bad request
   */
  l1Metadata(metadata: types.L1MetadataMetadataParam): Promise<FetchResponse<200, types.L1MetadataResponse200>> {
    return this.core.fetch('/api/v1/l1Metadata', 'get', metadata);
  }

  /**
   * Get liquidation infos
   *
   * @summary liquidations
   * @throws FetchError<400, types.LiquidationsResponse400> Bad request
   */
  liquidations(metadata: types.LiquidationsMetadataParam): Promise<FetchResponse<200, types.LiquidationsResponse200>> {
    return this.core.fetch('/api/v1/liquidations', 'get', metadata);
  }

  /**
   * Get next nonce for a specific account and api key
   *
   * @summary nextNonce
   * @throws FetchError<400, types.NextNonceResponse400> Bad request
   */
  nextNonce(metadata: types.NextNonceMetadataParam): Promise<FetchResponse<200, types.NextNonceResponse200>> {
    return this.core.fetch('/api/v1/nextNonce', 'get', metadata);
  }

  /**
   * Ack notification
   *
   * @summary notification_ack
   * @throws FetchError<400, types.NotificationAckResponse400> Bad request
   */
  notification_ack(body: types.NotificationAckBodyParam, metadata?: types.NotificationAckMetadataParam): Promise<FetchResponse<200, types.NotificationAckResponse200>> {
    return this.core.fetch('/api/v1/notification/ack', 'post', body, metadata);
  }

  /**
   * Get order books metadata
   *
   * @summary orderBookDetails
   * @throws FetchError<400, types.OrderBookDetailsResponse400> Bad request
   */
  orderBookDetails(metadata?: types.OrderBookDetailsMetadataParam): Promise<FetchResponse<200, types.OrderBookDetailsResponse200>> {
    return this.core.fetch('/api/v1/orderBookDetails', 'get', metadata);
  }

  /**
   * Get order book orders
   *
   * @summary orderBookOrders
   * @throws FetchError<400, types.OrderBookOrdersResponse400> Bad request
   */
  orderBookOrders(metadata: types.OrderBookOrdersMetadataParam): Promise<FetchResponse<200, types.OrderBookOrdersResponse200>> {
    return this.core.fetch('/api/v1/orderBookOrders', 'get', metadata);
  }

  /**
   * Get order books metadata.<hr>**Response Description:**<br><br>1) **Taker and maker
   * fees** are in percentage.<br>2) **Min base amount:** The amount of base token that can
   * be traded in a single order.<br>3) **Min quote amount:** The amount of quote token that
   * can be traded in a single order.<br>4) **Supported size decimals:** The number of
   * decimal places that can be used for the size of the order.<br>5) **Supported price
   * decimals:** The number of decimal places that can be used for the price of the
   * order.<br>6) **Supported quote decimals:** Size Decimals + Quote Decimals.
   *
   * @summary orderBooks
   * @throws FetchError<400, types.OrderBooksResponse400> Bad request
   */
  orderBooks(metadata?: types.OrderBooksMetadataParam): Promise<FetchResponse<200, types.OrderBooksResponse200>> {
    return this.core.fetch('/api/v1/orderBooks', 'get', metadata);
  }

  /**
   * Get account PnL chart
   *
   * @summary pnl
   * @throws FetchError<400, types.PnlResponse400> Bad request
   */
  pnl(metadata: types.PnlMetadataParam): Promise<FetchResponse<200, types.PnlResponse200>> {
    return this.core.fetch('/api/v1/pnl', 'get', metadata);
  }

  /**
   * Get accounts position fundings
   *
   * @summary positionFunding
   * @throws FetchError<400, types.PositionFundingResponse400> Bad request
   */
  positionFunding(metadata: types.PositionFundingMetadataParam): Promise<FetchResponse<200, types.PositionFundingResponse200>> {
    return this.core.fetch('/api/v1/positionFunding', 'get', metadata);
  }

  /**
   * Get public pools metadata
   *
   * @summary publicPoolsMetadata
   * @throws FetchError<400, types.PublicPoolsMetadataResponse400> Bad request
   */
  publicPoolsMetadata(metadata: types.PublicPoolsMetadataMetadataParam): Promise<FetchResponse<200, types.PublicPoolsMetadataResponse200>> {
    return this.core.fetch('/api/v1/publicPoolsMetadata', 'get', metadata);
  }

  /**
   * Get recent trades
   *
   * @summary recentTrades
   * @throws FetchError<400, types.RecentTradesResponse400> Bad request
   */
  recentTrades(metadata: types.RecentTradesMetadataParam): Promise<FetchResponse<200, types.RecentTradesResponse200>> {
    return this.core.fetch('/api/v1/recentTrades', 'get', metadata);
  }

  /**
   * Get referral points
   *
   * @summary referral_points
   * @throws FetchError<400, types.ReferralPointsResponse400> Bad request
   */
  referral_points(metadata: types.ReferralPointsMetadataParam): Promise<FetchResponse<200, types.ReferralPointsResponse200>> {
    return this.core.fetch('/api/v1/referral/points', 'get', metadata);
  }

  /**
   * You need to sign the transaction body before sending it to the server. More details can
   * be found in the Get Started docs: [Get Started For
   * Programmers](https://apidocs.lighter.xyz/docs/get-started-for-programmers)
   *
   * @summary sendTx
   * @throws FetchError<400, types.SendTxResponse400> Bad request
   */
  sendTx(body: types.SendTxBodyParam): Promise<FetchResponse<200, types.SendTxResponse200>> {
    return this.core.fetch('/api/v1/sendTx', 'post', body);
  }

  /**
   * You need to sign the transaction body before sending it to the server. More details can
   * be found in the Get Started docs: [Get Started For
   * Programmers](https://apidocs.lighter.xyz/docs/get-started-for-programmers)
   *
   * @summary sendTxBatch
   * @throws FetchError<400, types.SendTxBatchResponse400> Bad request
   */
  sendTxBatch(body: types.SendTxBatchBodyParam): Promise<FetchResponse<200, types.SendTxBatchResponse200>> {
    return this.core.fetch('/api/v1/sendTxBatch', 'post', body);
  }

  /**
   * Get trades
   *
   * @summary trades
   * @throws FetchError<400, types.TradesResponse400> Bad request
   */
  trades(metadata: types.TradesMetadataParam): Promise<FetchResponse<200, types.TradesResponse200>> {
    return this.core.fetch('/api/v1/trades', 'get', metadata);
  }

  /**
   * Get transfer history
   *
   * @summary transfer_history
   * @throws FetchError<400, types.TransferHistoryResponse400> Bad request
   */
  transfer_history(metadata: types.TransferHistoryMetadataParam): Promise<FetchResponse<200, types.TransferHistoryResponse200>> {
    return this.core.fetch('/api/v1/transfer/history', 'get', metadata);
  }

  /**
   * Transfer fee info
   *
   * @summary transferFeeInfo
   * @throws FetchError<400, types.TransferFeeInfoResponse400> Bad request
   */
  transferFeeInfo(metadata: types.TransferFeeInfoMetadataParam): Promise<FetchResponse<200, types.TransferFeeInfoResponse200>> {
    return this.core.fetch('/api/v1/transferFeeInfo', 'get', metadata);
  }

  /**
   * Get transaction by hash or sequence index
   *
   * @summary tx
   * @throws FetchError<400, types.TxResponse400> Bad request
   */
  tx(metadata: types.TxMetadataParam): Promise<FetchResponse<200, types.TxResponse200>> {
    return this.core.fetch('/api/v1/tx', 'get', metadata);
  }

  /**
   * Get L1 transaction by L1 transaction hash
   *
   * @summary txFromL1TxHash
   * @throws FetchError<400, types.TxFromL1TxHashResponse400> Bad request
   */
  txFromL1TxHash(metadata: types.TxFromL1TxHashMetadataParam): Promise<FetchResponse<200, types.TxFromL1TxHashResponse200>> {
    return this.core.fetch('/api/v1/txFromL1TxHash', 'get', metadata);
  }

  /**
   * Get transactions which are already packed into blocks
   *
   * @summary txs
   * @throws FetchError<400, types.TxsResponse400> Bad request
   */
  txs(metadata: types.TxsMetadataParam): Promise<FetchResponse<200, types.TxsResponse200>> {
    return this.core.fetch('/api/v1/txs', 'get', metadata);
  }

  /**
   * Get withdraw history
   *
   * @summary withdraw_history
   * @throws FetchError<400, types.WithdrawHistoryResponse400> Bad request
   */
  withdraw_history(metadata: types.WithdrawHistoryMetadataParam): Promise<FetchResponse<200, types.WithdrawHistoryResponse200>> {
    return this.core.fetch('/api/v1/withdraw/history', 'get', metadata);
  }

  /**
   * Withdrawal delay in seconds
   *
   * @summary withdrawalDelay
   * @throws FetchError<400, types.WithdrawalDelayResponse400> Bad request
   */
  withdrawalDelay(): Promise<FetchResponse<200, types.WithdrawalDelayResponse200>> {
    return this.core.fetch('/api/v1/withdrawalDelay', 'get');
  }

  /**
   * Get info of zklighter
   *
   * @summary info
   * @throws FetchError<400, types.InfoResponse400> Bad request
   */
  info(): Promise<FetchResponse<200, types.InfoResponse200>> {
    return this.core.fetch('/info', 'get');
  }
}

const createSDK = (() => { return new SDK(); })()
;

export default createSDK;

export type { AccountActiveOrdersMetadataParam, AccountActiveOrdersResponse200, AccountActiveOrdersResponse400, AccountInactiveOrdersMetadataParam, AccountInactiveOrdersResponse200, AccountInactiveOrdersResponse400, AccountLimitsMetadataParam, AccountLimitsResponse200, AccountLimitsResponse400, AccountMetadataMetadataParam, AccountMetadataParam, AccountMetadataResponse200, AccountMetadataResponse400, AccountResponse200, AccountResponse400, AccountTxsMetadataParam, AccountTxsResponse200, AccountTxsResponse400, AccountsByL1AddressMetadataParam, AccountsByL1AddressResponse200, AccountsByL1AddressResponse400, AnnouncementResponse200, AnnouncementResponse400, ApikeysMetadataParam, ApikeysResponse200, ApikeysResponse400, BlockMetadataParam, BlockResponse200, BlockResponse400, BlockTxsMetadataParam, BlockTxsResponse200, BlockTxsResponse400, BlocksMetadataParam, BlocksResponse200, BlocksResponse400, CandlesticksMetadataParam, CandlesticksResponse200, CandlesticksResponse400, ChangeAccountTierBodyParam, ChangeAccountTierMetadataParam, ChangeAccountTierResponse200, ChangeAccountTierResponse400, CurrentHeightResponse200, CurrentHeightResponse400, DepositHistoryMetadataParam, DepositHistoryResponse200, DepositHistoryResponse400, ExchangeStatsResponse200, ExchangeStatsResponse400, ExportMetadataParam, ExportResponse200, ExportResponse400, FastbridgeInfoResponse200, FastbridgeInfoResponse400, FundingRatesResponse200, FundingRatesResponse400, FundingsMetadataParam, FundingsResponse200, FundingsResponse400, InfoResponse200, InfoResponse400, L1MetadataMetadataParam, L1MetadataResponse200, L1MetadataResponse400, LiquidationsMetadataParam, LiquidationsResponse200, LiquidationsResponse400, NextNonceMetadataParam, NextNonceResponse200, NextNonceResponse400, NotificationAckBodyParam, NotificationAckMetadataParam, NotificationAckResponse200, NotificationAckResponse400, OrderBookDetailsMetadataParam, OrderBookDetailsResponse200, OrderBookDetailsResponse400, OrderBookOrdersMetadataParam, OrderBookOrdersResponse200, OrderBookOrdersResponse400, OrderBooksMetadataParam, OrderBooksResponse200, OrderBooksResponse400, PnlMetadataParam, PnlResponse200, PnlResponse400, PositionFundingMetadataParam, PositionFundingResponse200, PositionFundingResponse400, PublicPoolsMetadataMetadataParam, PublicPoolsMetadataResponse200, PublicPoolsMetadataResponse400, RecentTradesMetadataParam, RecentTradesResponse200, RecentTradesResponse400, ReferralPointsMetadataParam, ReferralPointsResponse200, ReferralPointsResponse400, SendTxBatchBodyParam, SendTxBatchResponse200, SendTxBatchResponse400, SendTxBodyParam, SendTxResponse200, SendTxResponse400, StatusResponse200, StatusResponse400, TradesMetadataParam, TradesResponse200, TradesResponse400, TransferFeeInfoMetadataParam, TransferFeeInfoResponse200, TransferFeeInfoResponse400, TransferHistoryMetadataParam, TransferHistoryResponse200, TransferHistoryResponse400, TxFromL1TxHashMetadataParam, TxFromL1TxHashResponse200, TxFromL1TxHashResponse400, TxMetadataParam, TxResponse200, TxResponse400, TxsMetadataParam, TxsResponse200, TxsResponse400, WithdrawHistoryMetadataParam, WithdrawHistoryResponse200, WithdrawHistoryResponse400, WithdrawalDelayResponse200, WithdrawalDelayResponse400 } from './types';

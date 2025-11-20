import { BaseStrategy as DomainBaseStrategy } from '../../../domain/entities/Strategy';
import { Amount, Price } from '../../../domain/value-objects';
import { Trade } from '../../../domain/entities/Trade';

export abstract class BaseStrategy extends DomainBaseStrategy {
  // DomainBaseStrategy already has constructor(id, name)
  // We don't need to redeclare it unless we change it.
  
  protected createTradeForStrategy(
    asset: string,
    side: 'buy' | 'sell',
    amount: Amount,
    price: Price,
    timestamp: Date,
    fees?: Amount,
    slippage?: Amount
  ): Trade {
    return super['createTrade'](
      this.id,
      asset,
      side,
      amount,
      price,
      timestamp,
      fees,
      slippage
    );
  }
}


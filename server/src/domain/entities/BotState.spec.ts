import { BotState } from './BotState';
import { Volatility } from '../value-objects/Volatility';
import { HurstExponent } from '../value-objects/HurstExponent';

describe('BotState', () => {
  it('should initialize active by default', () => {
    const state = new BotState(
      'pool1', 'pool1', 1000, 2000, 1500, new Date()
    );
    expect(state.isActive).toBe(true);
  });

  it('should update metrics correctly', () => {
    const state = new BotState(
      'pool1', 'pool1', 1000, 2000, 1500, new Date()
    );
    const vol = new Volatility(0.5);
    const hurst = new HurstExponent(0.6);

    state.updateMetrics(vol, hurst);

    expect(state.currentVolatility).toBe(vol);
    expect(state.currentHurst).toBe(hurst);
  });

  it('should update state on rebalance', () => {
    const oldDate = new Date('2023-01-01');
    const state = new BotState(
      'pool1', 'pool1', 1000, 2000, 1500, oldDate
    );

    const newLower = 1800;
    const newUpper = 2200;
    const currentPrice = 2000;

    state.rebalance(newLower, newUpper, currentPrice);

    expect(state.priceLower).toBe(newLower);
    expect(state.priceUpper).toBe(newUpper);
    expect(state.lastRebalancePrice).toBe(currentPrice);
    expect(state.lastRebalanceAt.getTime()).toBeGreaterThan(oldDate.getTime());
  });
});








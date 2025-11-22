export class HurstCalculator {
  /**
   * Calculates the Hurst Exponent (H) for a time series
   * H < 0.5: Mean Reverting (Anti-correlated)
   * H ~ 0.5: Random Walk
   * H > 0.5: Trending (Correlated)
   */
  static calculate(prices: number[]): number {
    if (prices.length < 10) return 0.5; // Not enough data

    // 1. Calculate Log Returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }

    // R/S Analysis requires splitting series into chunks, but for a rolling signal
    // we can use a simplified simplified R/S over the whole window for speed/reactivity.
    
    // Range (R)
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const deviations = returns.map(r => r - mean);
    
    let sum = 0;
    const cumulativeDeviations = deviations.map(d => {
      sum += d;
      return sum;
    });
    
    const maxDev = Math.max(...cumulativeDeviations);
    const minDev = Math.min(...cumulativeDeviations);
    const R = maxDev - minDev;

    // Standard Deviation (S)
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const S = Math.sqrt(variance);

    if (S === 0) return 0.5; // Flat line

    // Rescaled Range
    const RS = R / S;

    // H = log(R/S) / log(N)
    // This is a rough estimator for a fixed window N, usually you do regression over multiple N.
    // But for a "signal", this proportional value works.
    const N = returns.length;
    const H = Math.log(RS) / Math.log(N);

    return H;
  }
}


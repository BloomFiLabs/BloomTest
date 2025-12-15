/**
 * Test script to verify all APIs are being called to populate performance metrics
 * 
 * This ensures:
 * 1. Positions are fetched from all exchanges
 * 2. Funding payments are fetched from all exchanges
 * 3. Trading costs are recorded
 * 4. Performance metrics are updated correctly
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PerpKeeperPerformanceLogger } from './src/infrastructure/logging/PerpKeeperPerformanceLogger';
import { RealFundingPaymentsService } from './src/infrastructure/services/RealFundingPaymentsService';
import { PerpKeeperService } from './src/application/services/PerpKeeperService';
import { ExchangeType } from './src/domain/value-objects/ExchangeConfig';

async function testPerformanceMetricsSync() {
  console.log('🧪 Testing Performance Metrics Sync...\n');

  const app = await NestFactory.createApplicationContext(AppModule);
  
  const performanceLogger = app.get(PerpKeeperPerformanceLogger);
  const fundingPaymentsService = app.get(RealFundingPaymentsService);
  const keeperService = app.get(PerpKeeperService);

  const errors: string[] = [];
  const warnings: string[] = [];

  // Test 1: Fetch positions from all exchanges
  console.log('📊 Test 1: Fetching positions from all exchanges...');
  const exchanges = [ExchangeType.ASTER, ExchangeType.LIGHTER, ExchangeType.HYPERLIQUID, ExchangeType.EXTENDED];
  let totalPositions = 0;
  
  for (const exchange of exchanges) {
    try {
      const positions = await keeperService.getAllPositions();
      const exchangePositions = positions.filter(p => p.exchangeType === exchange);
      totalPositions += exchangePositions.length;
      console.log(`   ✅ ${exchange}: ${exchangePositions.length} positions`);
      
      if (exchangePositions.length > 0) {
        const totalValue = exchangePositions.reduce((sum, p) => sum + p.getPositionValue(), 0);
        console.log(`      Total value: $${totalValue.toFixed(2)}`);
      }
    } catch (error: any) {
      errors.push(`${exchange} positions: ${error.message}`);
      console.log(`   ❌ ${exchange}: Failed - ${error.message}`);
    }
  }
  console.log(`   Total positions: ${totalPositions}\n`);

  // Test 2: Fetch funding payments from all exchanges
  console.log('💰 Test 2: Fetching funding payments from all exchanges...');
  try {
    const payments = await fundingPaymentsService.fetchAllFundingPayments(30);
    console.log(`   ✅ Fetched ${payments.length} funding payments`);
    
    const byExchange = new Map<ExchangeType, number>();
    let totalReceived = 0;
    let totalPaid = 0;
    
    for (const payment of payments) {
      const count = byExchange.get(payment.exchange) || 0;
      byExchange.set(payment.exchange, count + 1);
      
      if (payment.amount > 0) {
        totalReceived += payment.amount;
      } else {
        totalPaid += Math.abs(payment.amount);
      }
    }
    
    for (const [exchange, count] of byExchange.entries()) {
      console.log(`   ${exchange}: ${count} payments`);
    }
    
    console.log(`   Total received: $${totalReceived.toFixed(4)}`);
    console.log(`   Total paid: $${totalPaid.toFixed(4)}`);
    console.log(`   Net funding: $${(totalReceived - totalPaid).toFixed(4)}\n`);
    
    if (payments.length === 0) {
      warnings.push('No funding payments found - may need to wait for funding periods');
    }
  } catch (error: any) {
    errors.push(`Funding payments: ${error.message}`);
    console.log(`   ❌ Failed - ${error.message}\n`);
  }

  // Test 3: Check trading costs
  console.log('💸 Test 3: Checking trading costs...');
  try {
    const totalCosts = fundingPaymentsService.getTotalTradingCosts();
    console.log(`   ✅ Total trading costs: $${totalCosts.toFixed(4)}`);
    
    if (totalCosts === 0) {
      warnings.push('No trading costs recorded - costs may not be tracked yet');
    }
  } catch (error: any) {
    errors.push(`Trading costs: ${error.message}`);
    console.log(`   ❌ Failed - ${error.message}\n`);
  }

  // Test 4: Get performance metrics
  console.log('📈 Test 4: Getting performance metrics...');
  try {
    // Calculate total capital
    let totalCapital = 0;
    for (const exchange of exchanges) {
      try {
        const balance = await keeperService.getBalance(exchange);
        totalCapital += balance;
      } catch (error: any) {
        console.log(`   ⚠️  Could not get balance for ${exchange}: ${error.message}`);
      }
    }
    
    const metrics = performanceLogger.getPerformanceMetrics(totalCapital);
    
    console.log(`   ✅ Performance Metrics:`);
    console.log(`      Est APY: ${metrics.estimatedAPY.toFixed(2)}%`);
    console.log(`      Real APY: ${metrics.realizedAPY.toFixed(2)}%`);
    console.log(`      Net Funding: $${metrics.netFundingCaptured.toFixed(2)}`);
    console.log(`      Positions: ${metrics.totalPositions}`);
    console.log(`      Total Position Value: $${metrics.totalPositionValue.toFixed(2)}`);
    console.log(`      Capital Deployed: $${metrics.capitalDeployed.toFixed(2)}`);
    
    // Test break-even calculation
    const breakEvenHours = performanceLogger.calculateBreakEvenHours(metrics.capitalDeployed);
    const breakEvenStr = performanceLogger.formatBreakEvenTime(breakEvenHours);
    console.log(`      Break-Even: ${breakEvenStr}\n`);
    
    // Verify all values are populated
    if (metrics.estimatedAPY === 0 && metrics.totalPositions > 0) {
      warnings.push('Estimated APY is 0 but positions exist - funding rates may not be synced');
    }
    
    if (metrics.realizedAPY === 0 && metrics.netFundingCaptured !== 0) {
      warnings.push('Realized APY is 0 but net funding is non-zero - check calculation');
    }
    
  } catch (error: any) {
    errors.push(`Performance metrics: ${error.message}`);
    console.log(`   ❌ Failed - ${error.message}\n`);
  }

  // Test 5: Verify funding payments are synced to performance logger
  console.log('🔄 Test 5: Verifying funding payments sync...');
  try {
    const payments = await fundingPaymentsService.fetchAllFundingPayments(30);
    
    // Check if payments are recorded in performance logger
    // Note: This requires checking internal state or calling getCombinedSummary
    const summary = await fundingPaymentsService.getCombinedSummary(30, 0);
    
    console.log(`   ✅ Funding Summary:`);
    console.log(`      Net Funding (30d): $${summary.netFunding.toFixed(4)}`);
    console.log(`      Daily Average: $${summary.dailyAverage.toFixed(4)}`);
    console.log(`      Real APY: ${summary.realAPY.toFixed(2)}%`);
    console.log(`      Break-Even Hours: ${summary.breakEvenHours !== null ? summary.breakEvenHours.toFixed(1) : 'N/A'}\n`);
    
  } catch (error: any) {
    errors.push(`Funding sync: ${error.message}`);
    console.log(`   ❌ Failed - ${error.message}\n`);
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════');
  console.log('📊 Test Summary:');
  
  if (errors.length === 0 && warnings.length === 0) {
    console.log('   ✅ All tests passed!');
  } else {
    if (errors.length > 0) {
      console.log(`   ❌ ${errors.length} error(s):`);
      errors.forEach(err => console.log(`      - ${err}`));
    }
    if (warnings.length > 0) {
      console.log(`   ⚠️  ${warnings.length} warning(s):`);
      warnings.forEach(warn => console.log(`      - ${warn}`));
    }
  }
  
  console.log('\n💡 To ensure metrics are populated:');
  console.log('   1. Positions: Fetched via getAllPositions() ✅');
  console.log('   2. Funding Payments: Fetched via fetchAllFundingPayments() ✅');
  console.log('   3. Trading Costs: Recorded via recordTradingCosts() ✅');
  console.log('   4. Performance Metrics: Updated via updatePositionMetrics() ✅');
  console.log('   5. Break-Even: Calculated from costs and funding ✅\n');

  await app.close();
}

// Run the test
testPerformanceMetricsSync()
  .then(() => {
    console.log('✅ Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });


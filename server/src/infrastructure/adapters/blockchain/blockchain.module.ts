import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IBlockchainAdapter } from '../../../domain/ports/IBlockchainAdapter';
import { IStrategyExecutor } from '../../../domain/ports/IStrategyExecutor';
import { EthersBlockchainAdapter } from './EthersBlockchainAdapter';
import { EthersStrategyExecutor } from './EthersStrategyExecutor';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'IBlockchainAdapter',
      useClass: EthersBlockchainAdapter,
    },
    {
      provide: 'IStrategyExecutor',
      useClass: EthersStrategyExecutor,
    },
  ],
  exports: ['IBlockchainAdapter', 'IStrategyExecutor'],
})
export class BlockchainModule {}







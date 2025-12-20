import { Module } from '@nestjs/common';
import { UniswapGraphAdapter } from './UniswapGraphAdapter';
import { BloomGraphAdapter } from './BloomGraphAdapter';

@Module({
  providers: [
    {
      provide: 'IMarketDataProvider',
      useClass: UniswapGraphAdapter,
    },
    BloomGraphAdapter,
  ],
  exports: ['IMarketDataProvider', BloomGraphAdapter],
})
export class GraphModule {}

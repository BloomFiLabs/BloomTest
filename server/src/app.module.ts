import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PersistenceModule } from './infrastructure/adapters/persistence/persistence.module';
import { FilePersistenceModule } from './infrastructure/adapters/persistence/file-persistence.module';
import { MemoryPersistenceModule } from './infrastructure/adapters/persistence/memory-persistence.module';
import { GraphModule } from './infrastructure/adapters/graph/graph.module';
import { ApplicationModule } from './application/application.module';
import { PerpKeeperModule } from './infrastructure/perp-keeper/perp-keeper.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // Conditionally load storage adapter based on STORAGE_TYPE
    ...(process.env.STORAGE_TYPE?.toLowerCase() === 'file'
      ? [FilePersistenceModule]
      : process.env.STORAGE_TYPE?.toLowerCase() === 'memory'
      ? [MemoryPersistenceModule]
      : [PersistenceModule]), // Default to Prisma (SQLite/Postgres)
    GraphModule,
    ApplicationModule,
    PerpKeeperModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}

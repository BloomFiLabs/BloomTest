import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TuiLogService } from './infrastructure/services/TuiLogService';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Use TuiLogService as global logger to capture logs for the TUI
  app.useLogger(app.get(TuiLogService));
  
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

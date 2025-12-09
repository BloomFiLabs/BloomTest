import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';

// PrismaClient is conditionally imported to avoid build errors when Prisma is not generated
let PrismaClient: any;
try {
  PrismaClient = require('@prisma/client').PrismaClient;
} catch (error) {
  // Prisma client not generated - this is OK if database is not configured
  Logger.warn('PrismaClient not available - database features will be disabled');
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  public client: any;
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    if (PrismaClient) {
      // Prisma 7 reads DATABASE_URL from prisma.config.ts
      this.client = new PrismaClient();
    } else {
      this.logger.warn('PrismaClient not available - PrismaService will be disabled');
      this.client = null;
    }
  }

  async onModuleInit() {
    if (this.client) {
      try {
        await this.client.$connect();
      } catch (error: any) {
        this.logger.warn(`Failed to connect to database: ${error.message}`);
      }
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      try {
        await this.client.$disconnect();
      } catch (error: any) {
        this.logger.warn(`Failed to disconnect from database: ${error.message}`);
      }
    }
  }
}

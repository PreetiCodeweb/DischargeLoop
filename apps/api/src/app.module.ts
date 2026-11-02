import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { OidcGuard } from './auth/oidc.guard';
import { BedsController } from './bed/beds.controller';
import { BedInventoryService, PG_POOL } from './bed/bed-inventory.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController, BedsController],
  providers: [
    HealthService,
    OidcGuard,
    BedInventoryService,
    {
      provide: PG_POOL,
      useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }),
    },
  ],
})
export class AppModule {}

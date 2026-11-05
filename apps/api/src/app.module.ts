import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { OidcGuard } from './auth/oidc.guard';
import { BedsController } from './bed/beds.controller';
import { BedInventoryService, PG_POOL } from './bed/bed-inventory.service';
import { DischargeController } from './discharge/discharge.controller';
import { DischargeService } from './discharge/discharge.service';
import { DevAuthController } from './auth/dev-auth.controller';
import { WorkflowController } from './workflow/workflow.controller';
import { WorkflowService } from './workflow/workflow.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController, BedsController, DischargeController, WorkflowController, DevAuthController],
  providers: [
    HealthService,
    OidcGuard,
    BedInventoryService,
    DischargeService,
    WorkflowService,
    {
      provide: PG_POOL,
      useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }),
    },
  ],
})
export class AppModule {}

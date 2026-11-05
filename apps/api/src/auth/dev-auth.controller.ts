import { Body, Controller, Get, Inject, NotFoundException, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../bed/bed-inventory.service';
import { PERSONAS, isDevAuthEnabled, issueDevToken } from './dev-auth';

@Controller('/api/v1/dev')
export class DevAuthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private assertEnabled(): void {
    if (!isDevAuthEnabled()) throw new NotFoundException('Dev auth is disabled');
  }

  @Get('personas')
  personas(): Record<string, unknown> {
    this.assertEnabled();
    return {
      personas: Object.entries(PERSONAS).map(([key, value]) => ({
        key, name: value.name, roles: value.roles, id: value.id,
      })),
    };
  }

  @Post('session')
  async session(@Body() body: { persona?: string; wardIds?: string[] }): Promise<Record<string, unknown>> {
    this.assertEnabled();
    const persona = typeof body?.persona === 'string' ? body.persona : 'admin';
    let wardIds = Array.isArray(body?.wardIds) ? body.wardIds.filter((value) => typeof value === 'string') : [];
    if (wardIds.length === 0) {
      const wards = await this.pool.query('SELECT id FROM dischargeloop.ward WHERE is_active = true ORDER BY name');
      wardIds = wards.rows.map((row: { id: string }) => row.id);
    }
    return issueDevToken(persona, wardIds);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';

interface TTLCleanupResult {
  entityType: string;
  recordsDeleted: number;
  durationMs: number;
}

@Injectable()
export class TTLCleanupService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async runCleanup(): Promise<TTLCleanupResult[]> {
    const result = await this.pool.query('SELECT * FROM dischargeloop.run_ttl_cleanup()');
    return result.rows.map((row) => ({
      entityType: row.entity_type,
      recordsDeleted: parseInt(row.records_deleted, 10),
      durationMs: parseInt(row.duration_ms, 10),
    }));
  }

  async getCleanupHistory(limit = 100): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT entity_type, records_deleted, cleanup_duration_ms, cleaned_at, error_message
       FROM dischargeloop.ttl_cleanup_log
       ORDER BY cleaned_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async getTTLConfig(): Promise<any[]> {
    const result = await this.pool.query('SELECT * FROM dischargeloop.ttl_config ORDER BY entity_type');
    return result.rows;
  }

  async updateTTLConfig(entityType: string, config: { ttlSeconds?: number; isEnabled?: boolean; cleanupBatchSize?: number }): Promise<void> {
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (config.ttlSeconds !== undefined) {
      updates.push(`ttl_seconds = $${paramIndex++}`);
      params.push(config.ttlSeconds);
    }
    if (config.isEnabled !== undefined) {
      updates.push(`is_enabled = $${paramIndex++}`);
      params.push(config.isEnabled);
    }
    if (config.cleanupBatchSize !== undefined) {
      updates.push(`cleanup_batch_size = $${paramIndex++}`);
      params.push(config.cleanupBatchSize);
    }

    if (updates.length === 0) return;

    updates.push(`updated_at = NOW()`);
    params.push(entityType);

    await this.pool.query(
      `UPDATE dischargeloop.ttl_config SET ${updates.join(', ')} WHERE entity_type = $${paramIndex}`,
      params,
    );
  }
}

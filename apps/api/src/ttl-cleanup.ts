import { Pool } from 'pg';

// Inline TTL cleanup logic for standalone worker
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runCleanupWorker(): Promise<void> {
  console.log(JSON.stringify({ level: 'info', message: 'ttl_cleanup_started', timestamp: new Date().toISOString() }));

  try {
    const result = await pool.query('SELECT * FROM dischargeloop.run_ttl_cleanup()');

    for (const row of result.rows) {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'ttl_cleanup_entity',
          entityType: row.entity_type,
          recordsDeleted: parseInt(row.records_deleted, 10),
          durationMs: parseInt(row.duration_ms, 10),
        }),
      );
    }

    const totalDeleted = result.rows.reduce((sum: number, r: any) => sum + parseInt(r.records_deleted, 10), 0);
    const totalDuration = result.rows.reduce((sum: number, r: any) => sum + parseInt(r.duration_ms, 10), 0);

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'ttl_cleanup_completed',
        totalRecordsDeleted: totalDeleted,
        totalDurationMs: totalDuration,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'ttl_cleanup_failed',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void runCleanupWorker();

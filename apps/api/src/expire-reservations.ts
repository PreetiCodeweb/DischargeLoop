import { Pool } from 'pg';
import { BedInventoryService } from './bed/bed-inventory.service';

async function run(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const bedInventory = new BedInventoryService(pool);
  const intervalMs = 30_000;
  try {
    for (;;) {
      try {
        const expired = await bedInventory.expireReservations(100);
        process.stdout.write(JSON.stringify({ level: 'info', event: 'reservation_expiry_scan', expired }) + '\n');
      } catch {
        process.stderr.write(JSON.stringify({ level: 'error', event: 'reservation_expiry_scan_failed' }) + '\n');
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await pool.end();
  }
}

void run();

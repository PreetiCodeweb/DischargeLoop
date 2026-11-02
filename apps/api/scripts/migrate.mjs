import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const connectionString = process.env.MIGRATION_DATABASE_URL;

if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL is required to run schema migrations');
}

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("SET search_path TO dischargeloop, public");
  await client.query("SELECT pg_advisory_lock(hashtext('dischargeloop:schema-migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name varchar(200) PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith('.up.sql'))
    .sort();

  for (const file of files) {
    const name = file.slice(0, -'.up.sql'.length);
    const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (existing.rowCount) continue;

    const sql = await readFile(resolve(migrationDirectory, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      process.stdout.write(`applied ${name}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('dischargeloop:schema-migrations'))").catch(() => undefined);
  await client.end();
}

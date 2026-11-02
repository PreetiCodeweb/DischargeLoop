import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const connectionString = process.env.MIGRATION_DATABASE_URL;

if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL is required to roll back a schema migration');
}

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query('SET search_path TO dischargeloop, public');
  await client.query("SELECT pg_advisory_lock(hashtext('dischargeloop:schema-migrations'))");
  const latest = await client.query(
    'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
  );
  if (!latest.rowCount) {
    process.stdout.write('no migration to roll back\n');
  } else {
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'dischargeloop' AND table_name <> 'schema_migrations'`,
    );
    const populated = [];
    for (const { table_name: tableName } of tables.rows) {
      const safeTable = `"${String(tableName).replaceAll('"', '""')}"`;
      const count = await client.query(`SELECT count(*) FROM dischargeloop.${safeTable}`);
      if (BigInt(count.rows[0].count) > 0n) populated.push(tableName);
    }
    if (populated.length) {
      throw new Error(`Refusing rollback: domain data exists in ${populated.join(', ')}`);
    }

    const name = latest.rows[0].name;
    const downSql = await readFile(resolve(migrationDirectory, `${name}.down.sql`), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(downSql);
      await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
      process.stdout.write(`rolled back ${name}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('dischargeloop:schema-migrations'))").catch(() => undefined);
  await client.end();
}

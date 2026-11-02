import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newId } from '../domain/ids';
import { UnitOfWork } from './unit-of-work';

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration('PostgreSQL transaction and audit invariants', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const unitOfWork = new UnitOfWork(pool);

  beforeAll(async () => {
    await pool.query('SELECT 1 FROM dischargeloop.schema_migrations LIMIT 1');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rolls back entity, audit, and outbox writes together after a transaction failure', async () => {
    const ids = { hospital: newId(), ward: newId(), bed: newId(), actor: newId() };
    await expect(unitOfWork.transaction(async (client) => {
      await client.query(
        `INSERT INTO hospital (id, name, timezone) VALUES ($1, 'Rollback check', 'UTC')`,
        [ids.hospital],
      );
      await client.query(
        `INSERT INTO ward (id, hospital_id, name, code) VALUES ($1, $2, 'Rollback check', $3)`,
        [ids.ward, ids.hospital, ids.ward.slice(0, 32)],
      );
      await client.query(
        `INSERT INTO bed (id, ward_id, label, state, state_reason_code) VALUES ($1, $2, $3, 'AVAILABLE', 'CREATED')`,
        [ids.bed, ids.ward, ids.bed],
      );
      await client.query(
        `INSERT INTO audit_event (id, actor_id, actor_role, action, entity_type, entity_id, after_state, reason_code, correlation_id)
         VALUES ($1, $2, 'admin', 'created', 'bed', $3, '{}'::jsonb, 'CREATED', 'rollback-check')`,
        [newId(), ids.actor, ids.bed],
      );
      await client.query(
        `INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'bed', $2, 'BedCreated', '{}'::jsonb)`,
        [newId(), ids.bed],
      );
      throw new Error('injected transaction failure');
    })).rejects.toThrow('injected transaction failure');

    const result = await pool.query(
      `SELECT
         (SELECT count(*) FROM dischargeloop.hospital WHERE id = $1) AS hospitals,
         (SELECT count(*) FROM dischargeloop.ward WHERE id = $2) AS wards,
         (SELECT count(*) FROM dischargeloop.bed WHERE id = $3) AS beds,
         (SELECT count(*) FROM dischargeloop.audit_event WHERE entity_id = $3) AS audits,
         (SELECT count(*) FROM dischargeloop.outbox WHERE aggregate_id = $3) AS outbox`,
      [ids.hospital, ids.ward, ids.bed],
    );
    expect(Object.values(result.rows[0])).toEqual(['0', '0', '0', '0', '0']);
  });

  it('does not allow the runtime DB role to update or delete audit events', async () => {
    await expect(pool.query('UPDATE dischargeloop.audit_event SET reason_code = reason_code WHERE false'))
      .rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('DELETE FROM dischargeloop.audit_event WHERE false'))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('enforces one active reservation or occupancy per bed with a partial unique index', async () => {
    const ids = { hospital: newId(), ward: newId(), bed: newId(), actor: newId() };
    await expect(unitOfWork.transaction(async (client) => {
      await client.query(
        `INSERT INTO hospital (id, name, timezone) VALUES ($1, 'Constraint check', 'UTC')`,
        [ids.hospital],
      );
      await client.query(
        `INSERT INTO ward (id, hospital_id, name, code) VALUES ($1, $2, 'Constraint check', $3)`,
        [ids.ward, ids.hospital, ids.ward.slice(0, 32)],
      );
      await client.query(
        `INSERT INTO bed (id, ward_id, label, state, state_reason_code) VALUES ($1, $2, $3, 'AVAILABLE', 'CREATED')`,
        [ids.bed, ids.ward, ids.bed],
      );
      await client.query(
        `INSERT INTO bed_assignment (id, bed_id, kind, state, starts_at, expires_at, created_by)
         VALUES ($1, $2, 'RESERVATION', 'ACTIVE', now(), now() + interval '30 minutes', $3)`,
        [newId(), ids.bed, ids.actor],
      );
      await client.query('SAVEPOINT duplicate_assignment');
      await expect(client.query(
        `INSERT INTO bed_assignment (id, bed_id, kind, state, starts_at, expires_at, created_by)
         VALUES ($1, $2, 'RESERVATION', 'ACTIVE', now(), now() + interval '30 minutes', $3)`,
        [newId(), ids.bed, ids.actor],
      )).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT duplicate_assignment');
      throw new Error('rollback constraint check');
    })).rejects.toThrow('rollback constraint check');

    const result = await pool.query(
      'SELECT count(*) FROM dischargeloop.bed_assignment WHERE bed_id = $1',
      [ids.bed],
    );
    expect(result.rows[0].count).toBe('0');
  });
});

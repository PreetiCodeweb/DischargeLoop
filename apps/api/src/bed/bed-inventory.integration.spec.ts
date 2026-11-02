import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newId } from '../domain/ids';
import { DomainError } from '../domain/domain-error';
import type { Actor } from '../auth/auth.types';
import { BedInventoryService } from './bed-inventory.service';

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
const integration = describe.skipIf(!runtimeUrl || !migrationUrl);

integration('bed inventory PostgreSQL invariants', () => {
  const pool = new Pool({ connectionString: runtimeUrl });
  const ownerPool = new Pool({ connectionString: migrationUrl });
  const service = new BedInventoryService(pool);
  const actor: Actor = { id: newId(), roles: ['admission'], wardIds: [] };
  let fixturesOwned = false;
  let hospitalId = '';

  beforeAll(async () => {
    const existing = await ownerPool.query(
      `SELECT count(*)::int AS count FROM (
        SELECT id FROM dischargeloop.hospital UNION ALL
        SELECT id FROM dischargeloop.ward UNION ALL
        SELECT id FROM dischargeloop.bed UNION ALL
        SELECT id FROM dischargeloop.bed_assignment UNION ALL
        SELECT id FROM dischargeloop.audit_event UNION ALL
        SELECT id FROM dischargeloop.outbox UNION ALL
        SELECT actor_id AS id FROM dischargeloop.idempotency_request
      ) AS domain_rows`,
    );
    if (existing.rows[0].count !== 0) {
      throw new Error('Bed inventory integration tests require an empty DischargeLoop database');
    }
    fixturesOwned = true;
    hospitalId = newId();
    await pool.query(
      `INSERT INTO dischargeloop.hospital (id, name, timezone) VALUES ($1, 'Transient integration fixture', 'UTC')`,
      [hospitalId],
    );
  });

  afterAll(async () => {
    if (fixturesOwned) {
      await ownerPool.query(`TRUNCATE TABLE
        dischargeloop.audit_event,
        dischargeloop.outbox,
        dischargeloop.idempotency_request,
        dischargeloop.bed_assignment,
        dischargeloop.encounter,
        dischargeloop.patient,
        dischargeloop.cleaning,
        dischargeloop.task,
        dischargeloop.discharge,
        dischargeloop.integration_link,
        dischargeloop.integration_quarantine,
        dischargeloop.escalation_policy,
        dischargeloop.bed,
        dischargeloop.ward,
        dischargeloop.hospital CASCADE`);
    }
    await Promise.all([pool.end(), ownerPool.end()]);
  });

  it('serializes 50 concurrent reservations so exactly one can claim a bed', async () => {
    const { wardId, bedId } = await createBed('RACE');
    actor.wardIds = [wardId];
    const attempts = await Promise.allSettled(Array.from({ length: 50 }, (_, index) =>
      service.reserve(actor, {
        bedId,
        reasonCode: 'RESERVATION_REQUESTED',
        idempotencyKey: `parallel:${index}`,
        correlationId: `parallel-${index}`,
      }),
    ));

    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(failures).toHaveLength(49);
    expect(failures.every((failure) => failure.reason instanceof DomainError && failure.reason.code === 'BED_NOT_AVAILABLE')).toBe(true);

    const state = await pool.query('SELECT state FROM dischargeloop.bed WHERE id = $1', [bedId]);
    const assignments = await pool.query(
      `SELECT count(*)::int AS count FROM dischargeloop.bed_assignment WHERE bed_id = $1 AND state = 'ACTIVE'`,
      [bedId],
    );
    const audits = await pool.query(
      `SELECT count(*)::int AS count FROM dischargeloop.audit_event WHERE entity_id = $1 AND action = 'bed.state_changed'`,
      [bedId],
    );
    const outbox = await pool.query(
      `SELECT count(*)::int AS count FROM dischargeloop.outbox WHERE aggregate_id = $1 AND event_type = 'ReservationCreated'`,
      [bedId],
    );
    expect(state.rows[0].state).toBe('RESERVED');
    expect(assignments.rows[0].count).toBe(1);
    expect(audits.rows[0].count).toBe(1);
    expect(outbox.rows[0].count).toBe(1);
  });

  it('replays an idempotent request and expires an elapsed reservation once', async () => {
    const { wardId, bedId } = await createBed('EXPIRE');
    actor.wardIds = [wardId];
    const request = {
      bedId,
      ttlSeconds: 1,
      reasonCode: 'RESERVATION_REQUESTED' as const,
      idempotencyKey: 'expiry:once',
      correlationId: 'expiry-check',
    };
    const created = await service.reserve(actor, request);
    const replay = await service.reserve(actor, request);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(created.body);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(service.expireReservations(100)).resolves.toBe(1);
    await expect(service.expireReservations(100)).resolves.toBe(0);

    const expiredEvents = await pool.query(
      `SELECT count(*)::int AS count FROM dischargeloop.outbox
       WHERE aggregate_id = $1 AND event_type = 'ReservationExpired'`,
      [bedId],
    );
    const bed = await pool.query('SELECT state FROM dischargeloop.bed WHERE id = $1', [bedId]);
    expect(expiredEvents.rows[0].count).toBe(1);
    expect(bed.rows[0].state).toBe('AVAILABLE');
  });

  async function createBed(label: string): Promise<{ wardId: string; bedId: string }> {
    const wardId = newId();
    const bedId = newId();
    await pool.query(
      `INSERT INTO dischargeloop.ward (id, hospital_id, name, code) VALUES ($1, $2, 'Transient integration fixture', $3)`,
      [wardId, hospitalId, label],
    );
    await pool.query(
      `INSERT INTO dischargeloop.bed (id, ward_id, label, state, state_reason_code) VALUES ($1, $2, $3, 'AVAILABLE', 'CREATED')`,
      [bedId, wardId, label],
    );
    return { wardId, bedId };
  }
});

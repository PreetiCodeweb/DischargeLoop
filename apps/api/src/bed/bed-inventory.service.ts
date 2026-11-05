import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../domain/domain-error';
import { assertBedTransition, type BedState, type BedReasonCode } from '../domain/bed-state';

export type { BedReasonCode } from '../domain/bed-state';
import { newId } from '../domain/ids';
import type { Actor } from '../auth/auth.types';
import { hasHospitalWideScope } from '../auth/oidc.guard';
import { UnitOfWork } from '../database/unit-of-work';

export const PG_POOL = 'PG_POOL';

interface ReservationInput {
  bedId: string;
  ttlSeconds?: number;
  reasonCode: 'RESERVATION_REQUESTED';
  idempotencyKey: string;
  correlationId: string;
}

interface BedChangeInput {
  bedId: string;
  target: 'BLOCKED' | 'MAINTENANCE' | 'AVAILABLE';
  reasonCode: 'CLINICAL_BLOCK' | 'CLINICAL_UNBLOCK' | 'MAINTENANCE_STARTED' | 'MAINTENANCE_COMPLETED';
  idempotencyKey: string;
  correlationId: string;
}

type IdempotentResult = { status: number; body: Record<string, unknown>; replayed?: boolean };

const SERVICE_ACTOR_ID = '00000000-0000-7000-8000-000000000001';

@Injectable()
export class BedInventoryService {
  private readonly unitOfWork: UnitOfWork;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.unitOfWork = new UnitOfWork(pool);
  }

  async bedboard(actor: Actor, filter: { wardId?: string; state?: BedState } = {}): Promise<Record<string, unknown>[]> {
    const scope = hasHospitalWideScope(actor) ? null : actor.wardIds;
    if (!scope && filter.wardId) {
      const rows = await this.pool.query(
        `SELECT b.id, b.ward_id, b.label, b.state, b.state_reason_code, b.version,
                b.updated_at, w.name AS ward_name
         FROM dischargeloop.bed b JOIN dischargeloop.ward w ON w.id = b.ward_id
         WHERE b.ward_id = $1 AND ($2::bed_state IS NULL OR b.state = $2)
         ORDER BY w.name, b.label`,
        [filter.wardId, filter.state ?? null],
      );
      return rows.rows;
    }
    if (scope && filter.wardId && !scope.includes(filter.wardId)) {
      throw new DomainError('WARD_SCOPE_DENIED', 'Ward is outside the caller scope', 403);
    }
    const rows = await this.pool.query(
      `SELECT b.id, b.ward_id, b.label, b.state, b.state_reason_code, b.version,
              b.updated_at, w.name AS ward_name
       FROM dischargeloop.bed b JOIN dischargeloop.ward w ON w.id = b.ward_id
       WHERE ($1::uuid[] IS NULL OR b.ward_id = ANY($1))
         AND ($2::uuid IS NULL OR b.ward_id = $2)
         AND ($3::bed_state IS NULL OR b.state = $3)
       ORDER BY w.name, b.label`,
      [scope, filter.wardId ?? null, filter.state ?? null],
    );
    return rows.rows;
  }

  async bedDetail(actor: Actor, bedId: string): Promise<Record<string, unknown>> {
    const rows = await this.pool.query(
      `SELECT b.id, b.ward_id, b.label, b.state, b.state_reason_code, b.version,
              b.updated_at, w.name AS ward_name,
              a.id AS assignment_id, a.kind AS assignment_kind, a.expires_at
       FROM dischargeloop.bed b
       JOIN dischargeloop.ward w ON w.id = b.ward_id
       LEFT JOIN dischargeloop.bed_assignment a ON a.bed_id = b.id AND a.state = 'ACTIVE'
       WHERE b.id = $1`,
      [bedId],
    );
    const bed = rows.rows[0];
    if (!bed) throw new DomainError('BED_NOT_FOUND', 'Bed does not exist', 404);
    this.assertWardScope(actor, bed.ward_id);
    return bed;
  }

  async bedSnapshot(actor: Actor): Promise<{ cursor: string | null; beds: Record<string, unknown>[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const cursorResult = await client.query('SELECT max(id)::text AS cursor FROM dischargeloop.outbox');
      const scope = hasHospitalWideScope(actor) ? null : actor.wardIds;
      const result = await client.query(
        `SELECT b.id, b.ward_id, b.label, b.state, b.state_reason_code, b.version,
                b.updated_at, w.name AS ward_name
         FROM dischargeloop.bed b JOIN dischargeloop.ward w ON w.id = b.ward_id
         WHERE $1::uuid[] IS NULL OR b.ward_id = ANY($1)
         ORDER BY w.name, b.label`,
        [scope],
      );
      await client.query('COMMIT');
      return { cursor: cursorResult.rows[0].cursor, beds: result.rows };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async eventsAfter(actor: Actor, cursor: string | null): Promise<{
    cursor: string | null;
    events: Array<{ id: string; type: string; occurredAt: Date; payload: Record<string, unknown> }>;
  }> {
    const result = await this.pool.query(
      `SELECT id::text, event_type, occurred_at, payload
       FROM dischargeloop.outbox
       WHERE $1::uuid IS NULL OR id > $1::uuid
       ORDER BY id LIMIT 100`,
      [cursor],
    );
    const rows = result.rows as Array<{ id: string; event_type: string; occurred_at: Date; payload: Record<string, unknown> }>;
    const scope = hasHospitalWideScope(actor) ? null : actor.wardIds;
    const events = rows.filter((row) => {
      if (!scope) return true;
      const wardId = row.payload.wardId;
      return typeof wardId === 'string' && scope.includes(wardId);
    }).map((row) => ({
      id: row.id,
      type: row.event_type,
      occurredAt: row.occurred_at,
      payload: row.payload,
    }));
    return { cursor: rows.at(-1)?.id ?? cursor, events };
  }

  async reserve(actor: Actor, input: ReservationInput): Promise<IdempotentResult> {
    const ttlSeconds = input.ttlSeconds ?? 1800;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7200) {
      throw new DomainError('INVALID_RESERVATION_TTL', 'Reservation TTL must be between 1 and 7200 seconds', 400);
    }
    if (ttlSeconds > 1800 && !actor.roles.some((role) => ['coordinator', 'admin'].includes(role))) {
      throw new DomainError('RESERVATION_TTL_OVERRIDE_FORBIDDEN', 'Only coordinators may extend a reservation beyond 30 minutes', 403);
    }
    if (input.reasonCode !== 'RESERVATION_REQUESTED') {
      throw new DomainError('INVALID_REASON_CODE', 'Reservation requires RESERVATION_REQUESTED', 400);
    }

    return this.unitOfWork.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, actor, input.idempotencyKey, 'POST:/api/v1/reservations', {
        bedId: input.bedId, ttlSeconds, reasonCode: input.reasonCode,
      });
      if (replay) return replay;

      const bed = await this.lockBed(client, actor, input.bedId);
      if (bed.state !== 'AVAILABLE') {
        throw new DomainError('BED_NOT_AVAILABLE', `Bed is ${bed.state}`, 409);
      }
      assertBedTransition(bed.state, 'RESERVED');

      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      const reservationId = newId();
      await client.query(
        `INSERT INTO dischargeloop.bed_assignment
           (id, bed_id, kind, state, starts_at, expires_at, created_by)
         VALUES ($1, $2, 'RESERVATION', 'ACTIVE', $3, $4, $5)`,
        [reservationId, bed.id, now, expiresAt, actor.id],
      );
      await this.updateBedState(client, bed, 'RESERVED', input.reasonCode);
      const body = {
        reservationId,
        bedId: bed.id,
        wardId: bed.ward_id,
        state: 'RESERVED',
        expiresAt: expiresAt.toISOString(),
      };
      await this.writeTransition(client, actor, bed, 'RESERVED', input.reasonCode, input.correlationId, 'ReservationCreated', body);
      await this.completeIdempotent(client, actor.id, input.idempotencyKey, 201, body);
      return { status: 201, body };
    });
  }

  async cancelReservation(
    actor: Actor,
    input: { reservationId: string; reasonCode: 'RESERVATION_CANCELLED'; idempotencyKey: string; correlationId: string },
  ): Promise<IdempotentResult> {
    return this.unitOfWork.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, actor, input.idempotencyKey, `DELETE:/api/v1/reservations/${input.reservationId}`, {
        reservationId: input.reservationId, reasonCode: input.reasonCode,
      });
      if (replay) return replay;

      const bedId = await this.assignmentBedId(client, input.reservationId);
      const bed = await this.lockBed(client, actor, bedId);
      const assignment = await this.lockReservation(client, input.reservationId, bed.id);
      if (!assignment) throw new DomainError('RESERVATION_NOT_ACTIVE', 'Reservation is no longer active', 409);
      const body = await this.endReservation(client, actor, bed, assignment, input.reasonCode, input.correlationId, 'ReservationCancelled');
      await this.completeIdempotent(client, actor.id, input.idempotencyKey, 200, body);
      return { status: 200, body };
    });
  }

  async confirmAdmission(
    actor: Actor,
    input: { reservationId: string; encounterId: string; reasonCode: 'ADMISSION_CONFIRMED'; idempotencyKey: string; correlationId: string },
  ): Promise<IdempotentResult> {
    return this.unitOfWork.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, actor, input.idempotencyKey, `POST:/api/v1/reservations/${input.reservationId}/confirm`, {
        reservationId: input.reservationId, encounterId: input.encounterId, reasonCode: input.reasonCode,
      });
      if (replay) return replay;

      const bedId = await this.assignmentBedId(client, input.reservationId);
      const bed = await this.lockBed(client, actor, bedId);
      const assignment = await this.lockReservation(client, input.reservationId, bed.id);
      if (!assignment) throw new DomainError('RESERVATION_NOT_ACTIVE', 'Reservation is no longer active', 409);
      if (new Date(assignment.expires_at).getTime() <= Date.now()) {
        throw new DomainError('RESERVATION_EXPIRED', 'Reservation has expired', 409);
      }
      if (bed.state !== 'RESERVED') throw new DomainError('BED_STATE_INCONSISTENT', 'Active reservation does not match bed state', 409);
      assertBedTransition('RESERVED', 'OCCUPIED');

      const encounterResult = await client.query(
        `SELECT id, ward_id, status FROM dischargeloop.encounter WHERE id = $1 FOR UPDATE`,
        [input.encounterId],
      );
      const encounter = encounterResult.rows[0];
      if (!encounter) throw new DomainError('ENCOUNTER_NOT_FOUND', 'Encounter does not exist', 404);
      if (encounter.status !== 'EXPECTED' || encounter.ward_id !== bed.ward_id) {
        throw new DomainError('ENCOUNTER_NOT_ADMISSIBLE', 'Encounter is not expected in this ward', 409);
      }

      const now = new Date();
      await client.query(
        `UPDATE dischargeloop.bed_assignment
         SET kind = 'OCCUPANCY', encounter_id = $2, expires_at = NULL, updated_at = $3
         WHERE id = $1`,
        [assignment.id, encounter.id, now],
      );
      await client.query(
        `UPDATE dischargeloop.encounter
         SET status = 'ADMITTED', bed_id = $2, admitted_at = $3, version = version + 1, updated_at = $3
         WHERE id = $1`,
        [encounter.id, bed.id, now],
      );
      await this.updateBedState(client, bed, 'OCCUPIED', input.reasonCode);
      const body = { reservationId: assignment.id, encounterId: encounter.id, bedId: bed.id, wardId: bed.ward_id, state: 'OCCUPIED' };
      await this.writeTransition(client, actor, bed, 'OCCUPIED', input.reasonCode, input.correlationId, 'PatientAdmitted', body);
      await this.completeIdempotent(client, actor.id, input.idempotencyKey, 200, body);
      return { status: 200, body };
    });
  }

  async changeBedState(actor: Actor, input: BedChangeInput): Promise<IdempotentResult> {
    return this.unitOfWork.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, actor, input.idempotencyKey, `POST:/api/v1/beds/${input.bedId}/${input.target.toLowerCase()}`, {
        bedId: input.bedId, target: input.target, reasonCode: input.reasonCode,
      });
      if (replay) return replay;

      const bed = await this.lockBed(client, actor, input.bedId);
      if (bed.state === input.target) {
        const body = { bedId: bed.id, wardId: bed.ward_id, state: bed.state, version: bed.version };
        await this.completeIdempotent(client, actor.id, input.idempotencyKey, 200, body);
        return { status: 200, body };
      }
      if ((bed.state === 'OCCUPIED' || bed.state === 'RESERVED') && ['BLOCKED', 'MAINTENANCE'].includes(input.target)) {
        throw new DomainError('BED_IN_USE', 'A reserved or occupied bed cannot be blocked or taken out of service', 409);
      }
      assertBedTransition(bed.state, input.target);
      await this.updateBedState(client, bed, input.target, input.reasonCode);
      const eventType = input.target === 'AVAILABLE'
        ? input.reasonCode === 'MAINTENANCE_COMPLETED' ? 'BedMaintenanceCompleted' : 'BedUnblocked'
        : input.target === 'MAINTENANCE' ? 'BedMaintenanceStarted' : 'BedBlocked';
      const body = { bedId: bed.id, wardId: bed.ward_id, state: input.target, version: bed.version + 1 };
      await this.writeTransition(client, actor, bed, input.target, input.reasonCode, input.correlationId, eventType, body);
      await this.completeIdempotent(client, actor.id, input.idempotencyKey, 200, body);
      return { status: 200, body };
    });
  }

  async expireReservations(limit = 100): Promise<number> {
    const candidates = await this.pool.query(
      `SELECT id, bed_id FROM dischargeloop.bed_assignment
       WHERE kind = 'RESERVATION' AND state = 'ACTIVE' AND expires_at <= now()
       ORDER BY expires_at LIMIT $1`,
      [limit],
    );
    let expired = 0;
    for (const candidate of candidates.rows) {
      const didExpire = await this.unitOfWork.transaction(async (client) => {
        const bed = await this.lockBedForService(client, candidate.bed_id);
        const assignment = await this.lockReservation(client, candidate.id, bed.id);
        if (!assignment || new Date(assignment.expires_at).getTime() > Date.now()) return false;
        if (bed.state !== 'RESERVED') throw new DomainError('BED_STATE_INCONSISTENT', 'Active reservation does not match bed state', 409);
        assertBedTransition('RESERVED', 'AVAILABLE');
        return this.endReservation(client, { id: SERVICE_ACTOR_ID, roles: ['service'], wardIds: [] }, bed, assignment, 'RESERVATION_EXPIRED', 'reservation-expiry', 'ReservationExpired').then(() => true);
      });
      if (didExpire) expired += 1;
    }
    return expired;
  }

  private async beginIdempotent(
    client: PoolClient,
    actor: Actor,
    key: string,
    endpoint: string,
    input: Record<string, unknown>,
  ): Promise<IdempotentResult | null> {
    if (!key || key.length > 128 || !/^[\w:.-]+$/.test(key)) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1–128 safe characters', 400);
    }
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await client.query(
      `INSERT INTO dischargeloop.idempotency_request
         (actor_id, idempotency_key, endpoint, request_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '24 hours')
       ON CONFLICT (actor_id, idempotency_key) DO NOTHING`,
      [actor.id, key, endpoint, requestHash],
    );
    const existing = await client.query(
      `SELECT endpoint, request_hash, response_status, response_body
       FROM dischargeloop.idempotency_request
       WHERE actor_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [actor.id, key],
    );
    const record = existing.rows[0];
    if (record.endpoint !== endpoint || record.request_hash.trim() !== requestHash) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for a different request', 409);
    }
    if (record.response_body !== null) {
      return { status: record.response_status, body: record.response_body, replayed: true };
    }
    return null;
  }

  private async completeIdempotent(
    client: PoolClient,
    actorId: string,
    key: string,
    status: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `UPDATE dischargeloop.idempotency_request
       SET response_status = $3, response_body = $4::jsonb, updated_at = now()
       WHERE actor_id = $1 AND idempotency_key = $2`,
      [actorId, key, status, JSON.stringify(body)],
    );
  }

  private async lockBed(client: PoolClient, actor: Actor, bedId: string): Promise<LockedBed> {
    const bed = await this.lockBedForService(client, bedId);
    this.assertWardScope(actor, bed.ward_id);
    return bed;
  }

  private async lockBedForService(client: PoolClient, bedId: string): Promise<LockedBed> {
    const result = await client.query(
      `SELECT id, ward_id, label, state, version
       FROM dischargeloop.bed WHERE id = $1 FOR UPDATE`,
      [bedId],
    );
    const bed = result.rows[0];
    if (!bed) throw new DomainError('BED_NOT_FOUND', 'Bed does not exist', 404);
    return bed as LockedBed;
  }

  private assertWardScope(actor: Actor, wardId: string): void {
    if (!hasHospitalWideScope(actor) && !actor.wardIds.includes(wardId)) {
      throw new DomainError('WARD_SCOPE_DENIED', 'Ward is outside the caller scope', 403);
    }
  }

  private async updateBedState(client: PoolClient, bed: LockedBed, state: BedState, reasonCode: BedReasonCode): Promise<void> {
    assertBedTransition(bed.state, state);
    const result = await client.query(
      `UPDATE dischargeloop.bed
       SET state = $3, state_reason_code = $4, version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2`,
      [bed.id, bed.version, state, reasonCode],
    );
    if (result.rowCount !== 1) throw new DomainError('BED_VERSION_CONFLICT', 'Bed changed during this operation', 409);
  }

  private async writeTransition(
    client: PoolClient,
    actor: Actor,
    bed: LockedBed,
    afterState: BedState,
    reasonCode: BedReasonCode,
    correlationId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO dischargeloop.audit_event
         (id, actor_id, actor_role, action, entity_type, entity_id, before_state, after_state, reason_code, correlation_id, request_id)
       VALUES ($1, $2, $3, 'bed.state_changed', 'bed', $4, $5::jsonb, $6::jsonb, $7, $8, $8)`,
      [newId(), actor.id, this.auditRole(actor), bed.id,
        JSON.stringify({ state: bed.state, version: bed.version }),
        JSON.stringify({ state: afterState, version: bed.version + 1 }), reasonCode, correlationId],
    );
    const eventPayload = { ...payload, bedId: bed.id, wardId: bed.ward_id };
    await client.query(
      `INSERT INTO dischargeloop.outbox (id, aggregate_type, aggregate_id, event_type, payload, headers)
       VALUES ($1, 'bed', $2, $3, $4::jsonb, $5::jsonb)`,
      [newId(), bed.id, eventType, JSON.stringify(eventPayload), JSON.stringify({ correlationId })],
    );
  }

  private auditRole(actor: Actor): string {
    return actor.roles.find((role) => role !== 'default-roles-dischargeloop') ?? 'service';
  }

  private async assignmentBedId(client: PoolClient, reservationId: string): Promise<string> {
    const result = await client.query(
      `SELECT bed_id FROM dischargeloop.bed_assignment WHERE id = $1 AND kind = 'RESERVATION'`,
      [reservationId],
    );
    if (!result.rows[0]) throw new DomainError('RESERVATION_NOT_FOUND', 'Reservation does not exist', 404);
    return result.rows[0].bed_id;
  }

  private async lockReservation(client: PoolClient, reservationId: string, bedId: string): Promise<LockedAssignment | null> {
    const result = await client.query(
      `SELECT id, bed_id, state, expires_at
       FROM dischargeloop.bed_assignment
       WHERE id = $1 AND bed_id = $2 AND kind = 'RESERVATION'
       FOR UPDATE`,
      [reservationId, bedId],
    );
    const assignment = result.rows[0] as LockedAssignment | undefined;
    return assignment?.state === 'ACTIVE' ? assignment : null;
  }

  private async endReservation(
    client: PoolClient,
    actor: Actor,
    bed: LockedBed,
    assignment: LockedAssignment,
    reasonCode: 'RESERVATION_CANCELLED' | 'RESERVATION_EXPIRED',
    correlationId: string,
    eventType: string,
  ): Promise<Record<string, unknown>> {
    if (bed.state !== 'RESERVED') throw new DomainError('BED_STATE_INCONSISTENT', 'Active reservation does not match bed state', 409);
    const now = new Date();
    await client.query(
      `UPDATE dischargeloop.bed_assignment SET state = $2, ended_at = $3, updated_at = $3 WHERE id = $1`,
      [assignment.id, reasonCode === 'RESERVATION_EXPIRED' ? 'EXPIRED' : 'CANCELLED', now],
    );
    await this.updateBedState(client, bed, 'AVAILABLE', reasonCode);
    const body = { reservationId: assignment.id, bedId: bed.id, wardId: bed.ward_id, state: 'AVAILABLE' };
    await this.writeTransition(client, actor, bed, 'AVAILABLE', reasonCode, correlationId, eventType, body);
    return body;
  }
}

interface LockedBed {
  id: string;
  ward_id: string;
  label: string;
  state: BedState;
  version: number;
}

interface LockedAssignment {
  id: string;
  bed_id: string;
  state: string;
  expires_at: Date;
}

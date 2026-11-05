import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../domain/domain-error';
import { assertDischargeTransition, type DischargeState, type DischargeReasonCode } from '../domain/discharge-state';
import { newId } from '../domain/ids';
import type { Actor } from '../auth/auth.types';
import { UnitOfWork } from '../database/unit-of-work';

export const PG_POOL = 'PG_POOL';

interface InitiateDischargeInput {
  encounterId: string;
  initiatedBy?: string;
  idempotencyKey: string;
  correlationId: string;
}

interface UpdateDischargeStateInput {
  dischargeId: string;
  targetState: DischargeState;
  reasonCode?: DischargeReasonCode;
  reversalReason?: string;
  idempotencyKey: string;
  correlationId: string;
}

type IdempotentResult = { status: number; body: Record<string, unknown>; replayed?: boolean };

@Injectable()
export class DischargeService {
  private readonly unitOfWork: UnitOfWork;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.unitOfWork = new UnitOfWork(pool);
  }

  async initiateDischarge(actor: Actor, input: InitiateDischargeInput): Promise<IdempotentResult> {
    return this.unitOfWork.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, actor, input.idempotencyKey, 'POST:/api/v1/discharges', {
        encounterId: input.encounterId,
      });
      if (replay) return replay;

      // Verify encounter exists and is admitted
      const encounterResult = await client.query(
        `SELECT id, status, bed_id FROM dischargeloop.encounter WHERE id = $1 FOR UPDATE`,
        [input.encounterId],
      );
      const encounter = encounterResult.rows[0];
      if (!encounter) throw new DomainError('ENCOUNTER_NOT_FOUND', 'Encounter does not exist', 404);
      if (encounter.status !== 'ADMITTED') {
        throw new DomainError('ENCOUNTER_NOT_ADMITTED', 'Encounter is not currently admitted', 409);
      }

      // Check if discharge already exists
      const existingDischarge = await client.query(
        `SELECT id, state FROM dischargeloop.discharge WHERE encounter_id = $1`,
        [input.encounterId],
      );
      if (existingDischarge.rows.length > 0) {
        throw new DomainError('DISCHARGE_ALREADY_EXISTS', 'Discharge already initiated for this encounter', 409);
      }

      const now = new Date();
      const dischargeId = newId();
      await client.query(
        `INSERT INTO dischargeloop.discharge
           (id, encounter_id, state, initiated_by, initiated_at, version, created_at, updated_at)
         VALUES ($1, $2, 'INITIATED', $3, $4, 1, $4, $4)`,
        [dischargeId, input.encounterId, input.initiatedBy ?? actor.id, now],
      );

      // Fire outbox event
      await client.query(
        `INSERT INTO dischargeloop.outbox (id, aggregate_type, aggregate_id, event_type, payload, headers, occurred_at)
         VALUES ($1, 'discharge', $2, 'DischargeInitiated', $3::jsonb, $4::jsonb, $5)`,
        [
          newId(),
          dischargeId,
          JSON.stringify({ dischargeId, encounterId: input.encounterId, initiatedBy: input.initiatedBy ?? actor.id }),
          JSON.stringify({ correlationId: input.correlationId }),
          now,
        ],
      );

      const body = {
        dischargeId,
        encounterId: input.encounterId,
        state: 'INITIATED',
        initiatedAt: now.toISOString(),
      };
      await this.completeIdempotent(client, actor.id, input.idempotencyKey, 201, body);
      return { status: 201, body };
    });
  }

  async updateDischargeState(actor: Actor, input: UpdateDischargeStateInput): Promise<IdempotentResult> {
    return this.unitOfWork.transaction(async (client) => {
      const replay = await this.beginIdempotent(client, actor, input.idempotencyKey, `PATCH:/api/v1/discharges/${input.dischargeId}`, {
        dischargeId: input.dischargeId,
        targetState: input.targetState,
      });
      if (replay) return replay;

      // Lock discharge record
      const dischargeResult = await client.query(
        `SELECT id, encounter_id, state, version FROM dischargeloop.discharge WHERE id = $1 FOR UPDATE`,
        [input.dischargeId],
      );
      const discharge = dischargeResult.rows[0];
      if (!discharge) throw new DomainError('DISCHARGE_NOT_FOUND', 'Discharge does not exist', 404);

      // Validate transition
      assertDischargeTransition(discharge.state, input.targetState);

      // Special handling for CANCELLED_REVERSED (clinical reversal)
      if (input.targetState === 'CANCELLED_REVERSED') {
        if (!input.reversalReason) {
          throw new DomainError('REVERSAL_REASON_REQUIRED', 'A reason is required for discharge reversal', 400);
        }
        if (!['READY_TO_DEPART', 'TASKS_PENDING', 'MEDICALLY_CLEARED'].includes(discharge.state)) {
          throw new DomainError('INVALID_REVERSAL_STATE', 'Can only reverse from READY_TO_DEPART, TASKS_PENDING, or MEDICALLY_CLEARED', 409);
        }
      }

      const now = new Date();
      const updates: string[] = ['state = $2', 'version = version + 1', 'updated_at = $3'];
      const params: unknown[] = [input.dischargeId, input.targetState, now];
      let paramIndex = 4;

      if (input.reasonCode) {
        updates.push(`cancelled_reason_code = $${paramIndex++}`);
        params.push(input.reasonCode);
      }

      if (input.targetState === 'READY_TO_DEPART') {
        const open = await client.query(
          `SELECT count(*)::int AS open FROM dischargeloop.task
           WHERE discharge_id = $1 AND blocking = true AND status IN ('OPEN','CLAIMED')`,
          [input.dischargeId],
        );
        if ((open.rows[0]?.open ?? 0) > 0) {
          throw new DomainError('TASKS_INCOMPLETE', 'All blocking tasks must be completed before departure', 409);
        }
      }

      if (input.targetState === 'MEDICALLY_CLEARED') {
        updates.push(`cleared_at = $${paramIndex++}`);
        params.push(now);
      }

      if (input.targetState === 'READY_TO_DEPART') {
        updates.push(`ready_at = $${paramIndex++}`);
        params.push(now);
      }

      if (input.targetState === 'DEPARTED') {
        updates.push(`departed_at = $${paramIndex++}`);
        params.push(now);
      }

      if (input.reversalReason) {
        updates.push(`cancelled_reason_code = $${paramIndex++}`);
        params.push('DISCHARGE_CANCELLED_REVERSED');
      }

      const query = `UPDATE dischargeloop.discharge SET ${updates.join(', ')} WHERE id = $1 AND version = $${paramIndex}`;
      params.push(discharge.version);

      const result = await client.query(query, params);
      if (result.rowCount !== 1) {
        throw new DomainError('DISCHARGE_VERSION_CONFLICT', 'Discharge changed during this operation', 409);
      }

      if (input.targetState === 'TASKS_PENDING') {
        const defaults = [
          ['medication_reconciliation', 'Medication reconciliation complete', 'pharmacy', 1, 45],
          ['billing_clearance', 'Billing and insurance cleared', 'billing', 2, 90],
          ['lab_results', 'Final lab results reviewed', 'clinical', 3, 120],
          ['transport_booking', 'Transport booked', 'transport', 4, 180],
        ] as const;
        for (const [type, title, role, priority, minutes] of defaults) {
          await client.query(
            `INSERT INTO dischargeloop.task
               (id, discharge_id, type, title, owner_role, status, priority, blocking, due_at)
             VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, true, now() + ($7 || ' minutes')::interval)`,
            [newId(), input.dischargeId, type, title, role, priority, String(minutes)],
          );
        }
      }

      if (input.targetState === 'DEPARTED') {
        const bedResult = await client.query(
          `SELECT bed_id FROM dischargeloop.bed_assignment
           WHERE encounter_id = $1 AND kind = 'OCCUPANCY' AND state = 'ACTIVE'
           ORDER BY starts_at DESC LIMIT 1`,
          [discharge.encounter_id],
        );
        const bedId = bedResult.rows[0]?.bed_id;
        if (bedId) {
          await client.query(
            `UPDATE dischargeloop.bed_assignment
             SET state = 'ENDED', ended_at = $2
             WHERE encounter_id = $1 AND kind = 'OCCUPANCY' AND state = 'ACTIVE'`,
            [discharge.encounter_id, now],
          );
          await client.query(
            `INSERT INTO dischargeloop.cleaning (id, bed_id, status)
             SELECT $1, $2, 'OPEN'
             WHERE NOT EXISTS (SELECT 1 FROM dischargeloop.cleaning WHERE bed_id = $2 AND status <> 'VERIFIED')`,
            [newId(), bedId],
          );
        }
      }

      await client.query(
        `INSERT INTO dischargeloop.audit_event
           (id, actor_id, actor_role, action, entity_type, entity_id, before_state, after_state,
            reason_code, correlation_id, request_id)
         VALUES ($1, $2, $3, $4, 'discharge', $5, $6::jsonb, $7::jsonb, $8, $9, $9)`,
        [
          newId(),
          actor.id,
          actor.roles[0] ?? 'unknown',
          `discharge.${input.targetState.toLowerCase()}`,
          input.dischargeId,
          JSON.stringify({ state: discharge.state, version: discharge.version }),
          JSON.stringify({ state: input.targetState, version: discharge.version + 1 }),
          input.reasonCode ?? 'DISCHARGE_PENDING',
          input.correlationId ?? 'unknown',
        ],
      );

      // Fire outbox event
      const eventType = input.targetState === 'CANCELLED_REVERSED' ? 'DischargeReversed' : `Discharge${input.targetState}`;
      await client.query(
        `INSERT INTO dischargeloop.outbox (id, aggregate_type, aggregate_id, event_type, payload, headers, occurred_at)
         VALUES ($1, 'discharge', $2, $3, $4::jsonb, $5::jsonb, $6)`,
        [
          newId(),
          input.dischargeId,
          eventType,
          JSON.stringify({
            dischargeId: input.dischargeId,
            encounterId: discharge.encounter_id,
            previousState: discharge.state,
            newState: input.targetState,
            reversalReason: input.reversalReason,
          }),
          JSON.stringify({ correlationId: input.correlationId }),
          now,
        ],
      );

      const body = {
        dischargeId: input.dischargeId,
        encounterId: discharge.encounter_id,
        state: input.targetState,
        version: discharge.version + 1,
      };
      await this.completeIdempotent(client, actor.id, input.idempotencyKey, 200, body);
      return { status: 200, body };
    });
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
}

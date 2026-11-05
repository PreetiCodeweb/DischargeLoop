import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../bed/bed-inventory.service';
import { UnitOfWork } from '../database/unit-of-work';
import { DomainError } from '../domain/domain-error';
import { newId } from '../domain/ids';
import { hasHospitalWideScope } from '../auth/oidc.guard';
import type { Actor } from '../auth/auth.types';

export interface TaskInput {
  type: string;
  title: string;
  ownerRole: string;
  priority?: number;
  blocking?: boolean;
  dueMinutes?: number;
}

@Injectable()
export class WorkflowService {
  private readonly unitOfWork: UnitOfWork;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.unitOfWork = new UnitOfWork(pool);
  }

  private scope(actor: Actor): string[] | null {
    return hasHospitalWideScope(actor) || actor.roles.includes('auditor') ? null : actor.wardIds;
  }

  async wards(actor: Actor): Promise<Record<string, unknown>[]> {
    const scope = this.scope(actor);
    const result = await this.pool.query(
      `SELECT w.id, w.name, w.code, w.is_active,
              count(b.id)::int AS bed_count,
              count(b.id) FILTER (WHERE b.state = 'AVAILABLE')::int AS available,
              count(b.id) FILTER (WHERE b.state = 'RESERVED')::int AS reserved,
              count(b.id) FILTER (WHERE b.state = 'OCCUPIED')::int AS occupied,
              count(b.id) FILTER (WHERE b.state = 'CLEANING')::int AS cleaning,
              count(b.id) FILTER (WHERE b.state IN ('BLOCKED','MAINTENANCE'))::int AS unavailable
       FROM dischargeloop.ward w
       LEFT JOIN dischargeloop.bed b ON b.ward_id = w.id
       WHERE w.is_active = true AND ($1::uuid[] IS NULL OR w.id = ANY($1))
       GROUP BY w.id ORDER BY w.name`,
      [scope],
    );
    return result.rows;
  }

  async encounters(actor: Actor, filter: { wardId?: string; status?: string }): Promise<Record<string, unknown>[]> {
    const scope = this.scope(actor);
    const result = await this.pool.query(
      `SELECT e.id, e.status, e.ward_id, w.name AS ward_name,
              e.bed_id, b.label AS bed_label,
              p.id AS patient_id, p.display_name AS patient_name, p.date_of_birth, p.sex,
              d.id AS discharge_id, d.state AS discharge_state,
              a.id AS assignment_id, a.expires_at,
              e.admitted_at, e.updated_at
       FROM dischargeloop.encounter e
       JOIN dischargeloop.patient p ON p.id = e.patient_id
       JOIN dischargeloop.ward w ON w.id = e.ward_id
       LEFT JOIN dischargeloop.bed b ON b.id = e.bed_id
       LEFT JOIN dischargeloop.discharge d ON d.encounter_id = e.id
       LEFT JOIN dischargeloop.bed_assignment a ON a.encounter_id = e.id AND a.state = 'ACTIVE'
       WHERE ($1::uuid[] IS NULL OR e.ward_id = ANY($1))
         AND ($2::uuid IS NULL OR e.ward_id = $2)
         AND ($3::text IS NULL OR e.status = $3::encounter_status)
       ORDER BY e.updated_at DESC LIMIT 200`,
      [scope, filter.wardId ?? null, filter.status ?? null],
    );
    return result.rows;
  }

  async createPatient(actor: Actor, input: { displayName: string; dateOfBirth?: string; sex?: string }): Promise<Record<string, unknown>> {
    return this.unitOfWork.transaction(async (client) => {
      const hospital = await client.query(`SELECT id FROM dischargeloop.hospital WHERE is_primary = true LIMIT 1`);
      const hospitalId = hospital.rows[0]?.id;
      if (!hospitalId) throw new DomainError('HOSPITAL_NOT_CONFIGURED', 'No hospital configured', 409);
      const id = newId();
      await client.query(
        `INSERT INTO dischargeloop.patient (id, hospital_id, his_patient_id, display_name, date_of_birth, sex)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, hospitalId, `LOCAL-${id.replace(/-/g, '').slice(-10).toUpperCase()}`, input.displayName, input.dateOfBirth ?? null, input.sex ?? null],
      );
      return { patientId: id, displayName: input.displayName };
    });
  }

  async createEncounter(actor: Actor, input: { patientId: string; wardId: string }): Promise<Record<string, unknown>> {
    return this.unitOfWork.transaction(async (client) => {
      const patient = await client.query(`SELECT id FROM dischargeloop.patient WHERE id = $1`, [input.patientId]);
      if (!patient.rows[0]) throw new DomainError('PATIENT_NOT_FOUND', 'Patient does not exist', 404);
      const ward = await client.query(`SELECT id, name FROM dischargeloop.ward WHERE id = $1 AND is_active = true`, [input.wardId]);
      if (!ward.rows[0]) throw new DomainError('WARD_NOT_FOUND', 'Ward does not exist', 404);
      const id = newId();
      await client.query(
        `INSERT INTO dischargeloop.encounter (id, patient_id, ward_id, status, his_encounter_id)
         VALUES ($1, $2, $3, 'EXPECTED', $4)`,
        [id, input.patientId, input.wardId, `LOCAL-ENC-${id.replace(/-/g, '').slice(-10).toUpperCase()}`],
      );
      return { encounterId: id, wardId: input.wardId, wardName: ward.rows[0].name, status: 'EXPECTED' };
    });
  }

  async discharges(actor: Actor, filter: { wardId?: string; state?: string }): Promise<Record<string, unknown>[]> {
    const scope = this.scope(actor);
    const result = await this.pool.query(
      `SELECT d.id, d.state, d.initiated_at, d.cleared_at, d.ready_at, d.departed_at,
              d.cancelled_reason_code, d.version,
              e.id AS encounter_id, e.ward_id, w.name AS ward_name, e.bed_id, b.label AS bed_label,
              p.display_name AS patient_name,
              (SELECT count(*)::int FROM dischargeloop.task t WHERE t.discharge_id = d.id AND t.status IN ('OPEN','CLAIMED')) AS open_tasks,
              (SELECT count(*)::int FROM dischargeloop.task t WHERE t.discharge_id = d.id AND t.status IN ('OPEN','CLAIMED') AND t.blocking) AS blocking_tasks
       FROM dischargeloop.discharge d
       JOIN dischargeloop.encounter e ON e.id = d.encounter_id
       JOIN dischargeloop.ward w ON w.id = e.ward_id
       LEFT JOIN dischargeloop.bed b ON b.id = e.bed_id
       JOIN dischargeloop.patient p ON p.id = e.patient_id
       WHERE ($1::uuid[] IS NULL OR e.ward_id = ANY($1))
         AND ($2::uuid IS NULL OR e.ward_id = $2)
         AND ($3::text IS NULL OR d.state = $3::discharge_state)
       ORDER BY d.updated_at DESC LIMIT 200`,
      [scope, filter.wardId ?? null, filter.state ?? null],
    );
    return result.rows;
  }

  async dischargeDetail(actor: Actor, dischargeId: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT d.*, e.id AS encounter_id, e.ward_id, w.name AS ward_name, e.bed_id, b.label AS bed_label,
              p.display_name AS patient_name, p.date_of_birth, p.sex
       FROM dischargeloop.discharge d
       JOIN dischargeloop.encounter e ON e.id = d.encounter_id
       JOIN dischargeloop.ward w ON w.id = e.ward_id
       LEFT JOIN dischargeloop.bed b ON b.id = e.bed_id
       JOIN dischargeloop.patient p ON p.id = e.patient_id
       WHERE d.id = $1`,
      [dischargeId],
    );
    const discharge = result.rows[0];
    if (!discharge) throw new DomainError('DISCHARGE_NOT_FOUND', 'Discharge does not exist', 404);
    const scope = this.scope(actor);
    if (scope && !scope.includes(discharge.ward_id)) {
      throw new DomainError('WARD_SCOPE_DENIED', 'Ward is outside the caller scope', 403);
    }
    const tasks = await this.pool.query(
      `SELECT id, type, title, owner_role, owner_user_id, status, priority, blocking,
              due_at, completed_at, escalation_level, version
       FROM dischargeloop.task WHERE discharge_id = $1
       ORDER BY blocking DESC, due_at ASC`,
      [dischargeId],
    );
    return { discharge, tasks: tasks.rows };
  }

  async addTask(actor: Actor, dischargeId: string, input: TaskInput): Promise<Record<string, unknown>> {
    return this.unitOfWork.transaction(async (client) => {
      const discharge = await client.query(`SELECT id FROM dischargeloop.discharge WHERE id = $1`, [dischargeId]);
      if (!discharge.rows[0]) throw new DomainError('DISCHARGE_NOT_FOUND', 'Discharge does not exist', 404);
      const id = newId();
      const due = new Date(Date.now() + (input.dueMinutes ?? 60) * 60_000);
      await client.query(
        `INSERT INTO dischargeloop.task
           (id, discharge_id, type, title, owner_role, status, priority, blocking, due_at)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8)`,
        [id, dischargeId, input.type, input.title, input.ownerRole, input.priority ?? 3, input.blocking ?? true, due],
      );
      await client.query(
        `INSERT INTO dischargeloop.outbox (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'task', $2, 'TaskCreated', $3::jsonb)`,
        [newId(), id, JSON.stringify({ taskId: id, dischargeId, title: input.title, ownerRole: input.ownerRole })],
      );
      return { taskId: id, dischargeId, state: 'OPEN', dueAt: due.toISOString() };
    });
  }

  async updateTask(actor: Actor, taskId: string, action: string): Promise<Record<string, unknown>> {
    return this.unitOfWork.transaction(async (client) => {
      const result = await client.query(
        `SELECT id, discharge_id, status, owner_role FROM dischargeloop.task WHERE id = $1 FOR UPDATE`,
        [taskId],
      );
      const task = result.rows[0];
      if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task does not exist', 404);
      if (!['OPEN', 'CLAIMED'].includes(task.status)) {
        throw new DomainError('TASK_NOT_ACTIONABLE', `Task is already ${task.status}`, 409);
      }
      if (!actor.roles.some((role) => ['admin', 'coordinator'].includes(role) || role === task.owner_role)) {
        throw new DomainError('TASK_ROLE_DENIED', `Task belongs to ${task.owner_role}`, 403);
      }

      let status: string;
      if (action === 'claim') status = 'CLAIMED';
      else if (action === 'complete') status = 'DONE';
      else if (action === 'cancel') status = 'CANCELLED';
      else throw new DomainError('INVALID_TASK_ACTION', 'action must be claim, complete or cancel', 400);

      await client.query(
        `UPDATE dischargeloop.task
         SET status = $2::task_status, owner_user_id = COALESCE(owner_user_id, $3),
             completed_at = CASE WHEN $2::task_status IN ('DONE','CANCELLED') THEN now() ELSE NULL END,
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [taskId, status, actor.id],
      );
      await client.query(
        `INSERT INTO dischargeloop.outbox (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'task', $2, $3, $4::jsonb)`,
        [newId(), taskId, action === 'complete' ? 'TaskCompleted' : action === 'claim' ? 'TaskClaimed' : 'TaskCancelled',
          JSON.stringify({ taskId, dischargeId: task.discharge_id, status })],
      );
      return { taskId, status, dischargeId: task.discharge_id };
    });
  }

  async tasks(actor: Actor, filter: { role?: string; status?: string }): Promise<Record<string, unknown>[]> {
    const scope = this.scope(actor);
    const result = await this.pool.query(
      `SELECT t.id, t.discharge_id, t.type, t.title, t.owner_role, t.status, t.priority,
              t.blocking, t.due_at, t.completed_at,
              (t.due_at < now() AND t.status IN ('OPEN','CLAIMED')) AS overdue,
              p.display_name AS patient_name, w.name AS ward_name
       FROM dischargeloop.task t
       JOIN dischargeloop.discharge d ON d.id = t.discharge_id
       JOIN dischargeloop.encounter e ON e.id = d.encounter_id
       JOIN dischargeloop.patient p ON p.id = e.patient_id
       JOIN dischargeloop.ward w ON w.id = e.ward_id
       WHERE ($1::uuid[] IS NULL OR e.ward_id = ANY($1))
         AND ($2::text IS NULL OR t.owner_role = $2)
         AND ($3::text IS NULL OR t.status = $3::task_status)
         AND t.status IN ('OPEN','CLAIMED')
       ORDER BY t.due_at ASC LIMIT 200`,
      [scope, filter.role ?? null, filter.status ?? null],
    );
    return result.rows;
  }

  async cleaning(actor: Actor, filter: { wardId?: string }): Promise<Record<string, unknown>[]> {
    const scope = this.scope(actor);
    const result = await this.pool.query(
      `SELECT c.id, c.bed_id, b.label AS bed_label, b.state AS bed_state,
              w.id AS ward_id, w.name AS ward_name, c.status, c.requested_at,
              c.accepted_at, c.accepted_by, c.verified_at, c.verified_by, c.notes
       FROM dischargeloop.cleaning c
       JOIN dischargeloop.bed b ON b.id = c.bed_id
       JOIN dischargeloop.ward w ON w.id = b.ward_id
       WHERE c.status <> 'VERIFIED'
         AND ($1::uuid[] IS NULL OR w.id = ANY($1))
         AND ($2::uuid IS NULL OR w.id = $2)
       ORDER BY c.requested_at ASC`,
      [scope, filter.wardId ?? null],
    );
    return result.rows;
  }

  async acceptCleaning(actor: Actor, cleaningId: string): Promise<Record<string, unknown>> {
    return this.unitOfWork.transaction(async (client) => {
      const result = await client.query(
        `SELECT id, bed_id, status, accepted_by FROM dischargeloop.cleaning WHERE id = $1 FOR UPDATE`,
        [cleaningId],
      );
      const cleaning = result.rows[0];
      if (!cleaning) throw new DomainError('CLEANING_NOT_FOUND', 'Cleaning job does not exist', 404);
      if (cleaning.status !== 'OPEN') throw new DomainError('CLEANING_NOT_OPEN', `Cleaning job is ${cleaning.status}`, 409);
      await client.query(
        `UPDATE dischargeloop.cleaning SET status = 'ACCEPTED', accepted_by = $2, accepted_at = now(), updated_at = now()
         WHERE id = $1`,
        [cleaningId, actor.id],
      );
      await client.query(
        `INSERT INTO dischargeloop.outbox (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'cleaning', $2, 'BedCleaningStarted', $3::jsonb)`,
        [newId(), cleaningId, JSON.stringify({ cleaningId, bedId: cleaning.bed_id })],
      );
      return { cleaningId, status: 'ACCEPTED', bedId: cleaning.bed_id };
    });
  }

  async verifyCleaning(actor: Actor, cleaningId: string): Promise<Record<string, unknown>> {
    return this.unitOfWork.transaction(async (client) => {
      const result = await client.query(
        `SELECT c.id, c.bed_id, c.status, c.accepted_by, b.state AS bed_state, b.ward_id
         FROM dischargeloop.cleaning c JOIN dischargeloop.bed b ON b.id = c.bed_id
         WHERE c.id = $1 FOR UPDATE OF c`,
        [cleaningId],
      );
      const cleaning = result.rows[0];
      if (!cleaning) throw new DomainError('CLEANING_NOT_FOUND', 'Cleaning job does not exist', 404);
      if (cleaning.status !== 'ACCEPTED') throw new DomainError('CLEANING_NOT_ACCEPTED', 'Cleaning must be accepted first', 409);
      if (cleaning.accepted_by === actor.id) {
        throw new DomainError('SECOND_PERSON_REQUIRED', 'A different user must verify the clean bed', 409);
      }
      if (cleaning.bed_state !== 'CLEANING') {
        throw new DomainError('BED_STATE_INCONSISTENT', `Bed is ${cleaning.bed_state}, not CLEANING`, 409);
      }
      await client.query(
        `UPDATE dischargeloop.cleaning SET status = 'VERIFIED', verified_by = $2, verified_at = now(), updated_at = now()
         WHERE id = $1`,
        [cleaningId, actor.id],
      );
      await client.query(
        `UPDATE dischargeloop.bed SET state = 'AVAILABLE', state_reason_code = 'CREATED',
             version = version + 1, updated_at = now() WHERE id = $1`,
        [cleaning.bed_id],
      );
      await client.query(
        `INSERT INTO dischargeloop.audit_event
           (id, actor_id, actor_role, action, entity_type, entity_id, before_state, after_state, reason_code, correlation_id, request_id)
         VALUES ($1, $2, $3, 'bed.cleaning_verified', 'bed', $4, $5::jsonb, $6::jsonb,
                 'DISCHARGE_PENDING', 'cleaning-verify', 'cleaning-verify')`,
        [newId(), actor.id, actor.roles[0] ?? 'service', cleaning.bed_id,
          JSON.stringify({ state: 'CLEANING' }), JSON.stringify({ state: 'AVAILABLE' })],
      );
      await client.query(
        `INSERT INTO dischargeloop.outbox (id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'bed', $2, 'BedReady', $3::jsonb)`,
        [newId(), cleaning.bed_id, JSON.stringify({ cleaningId, bedId: cleaning.bed_id, wardId: cleaning.ward_id, state: 'AVAILABLE' })],
      );
      return { cleaningId, status: 'VERIFIED', bedId: cleaning.bed_id, bedState: 'AVAILABLE' };
    });
  }

  async audit(actor: Actor, limit = 100): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT id, occurred_at, actor_id, actor_role, action, entity_type, entity_id,
              before_state, after_state, reason_code, correlation_id
       FROM dischargeloop.audit_event ORDER BY occurred_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows;
  }

  async analytics(actor: Actor): Promise<Record<string, unknown>> {
    const scope = this.scope(actor);
    const [beds, discharges, tasks, reserved, stay] = await Promise.all([
      this.pool.query(
        `SELECT b.state, count(*)::int AS count FROM dischargeloop.bed b
         WHERE ($1::uuid[] IS NULL OR b.ward_id = ANY($1)) GROUP BY b.state`, [scope]),
      this.pool.query(
        `SELECT d.state, count(*)::int AS count FROM dischargeloop.discharge d
         JOIN dischargeloop.encounter e ON e.id = d.encounter_id
         WHERE ($1::uuid[] IS NULL OR e.ward_id = ANY($1)) GROUP BY d.state`, [scope]),
      this.pool.query(
        `SELECT count(*) FILTER (WHERE t.status IN ('OPEN','CLAIMED'))::int AS open,
                count(*) FILTER (WHERE t.status IN ('OPEN','CLAIMED') AND t.due_at < now())::int AS overdue
         FROM dischargeloop.task t
         JOIN dischargeloop.discharge d ON d.id = t.discharge_id
         JOIN dischargeloop.encounter e ON e.id = d.encounter_id
         WHERE ($1::uuid[] IS NULL OR e.ward_id = ANY($1))`, [scope]),
      this.pool.query(
        `SELECT a.id, a.expires_at, b.label AS bed_label, w.name AS ward_name
         FROM dischargeloop.bed_assignment a
         JOIN dischargeloop.bed b ON b.id = a.bed_id
         JOIN dischargeloop.ward w ON w.id = b.ward_id
         WHERE a.kind = 'RESERVATION' AND a.state = 'ACTIVE' AND a.expires_at < now() + interval '15 minutes'
           AND ($1::uuid[] IS NULL OR w.id = ANY($1))
         ORDER BY a.expires_at ASC`, [scope]),
      this.pool.query(
        `SELECT COALESCE(round(avg(EXTRACT(EPOCH FROM (e.departed_at - e.admitted_at))/3600)::numeric, 1), 0) AS avg_hours,
                count(*)::int AS departed_30d
         FROM dischargeloop.encounter e
         WHERE e.departed_at IS NOT NULL AND e.departed_at > now() - interval '30 days'
           AND ($1::uuid[] IS NULL OR e.ward_id = ANY($1))`, [scope]),
    ]);
    const bedMap = Object.fromEntries(beds.rows.map((row) => [row.state, row.count])) as Record<string, number>;
    const total = Object.values(bedMap).reduce((sum, value) => sum + value, 0);
    return {
      beds: bedMap,
      totalBeds: total,
      occupancyRate: total ? Math.round(((bedMap.OCCUPIED ?? 0) / total) * 100) : 0,
      dischargesByState: Object.fromEntries(discharges.rows.map((row) => [row.state, row.count])),
      openTasks: tasks.rows[0]?.open ?? 0,
      overdueTasks: tasks.rows[0]?.overdue ?? 0,
      expiringReservations: reserved.rows,
      averageLengthOfStayHours: Number(stay.rows[0]?.avg_hours ?? 0),
      departedLast30Days: stay.rows[0]?.departed_30d ?? 0,
    };
  }
}

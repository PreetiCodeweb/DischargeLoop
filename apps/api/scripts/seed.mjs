import { randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5433/dischargeloop?options=-csearch_path%3Ddischargeloop';

const HOSPITAL_ID = '0b000000-0000-7000-8000-000000000001';
const WARDS = [
  { id: '0b000000-0000-7000-8000-000000000101', name: '2 East Medical', code: '2E-MED' },
  { id: '0b000000-0000-7000-8000-000000000102', name: '3 West Surgical', code: '3W-SURG' },
  { id: '0b000000-0000-7000-8000-000000000103', name: 'ICU Step-Down', code: 'ICU-SD' },
];
const PATIENTS = [
  ['Margaret Chen', '1948-03-11', 'F'],
  ['Darnell Washington', '1962-07-02', 'M'],
  ['Ana Rodrigues', '1975-11-23', 'F'],
  ['Walter Kim', '1951-01-09', 'M'],
  ['Priya Raghavan', '1988-05-30', 'F'],
  ['Frank Delgado', '1943-09-17', 'M'],
  ['Aisha Bello', '1990-12-04', 'F'],
  ['Henryk Kowalski', '1958-02-19', 'M'],
  ['Lucia Marino', '1969-06-01', 'F'],
  ['Owen Gallagher', '1979-08-25', 'M'],
];

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query('BEGIN');
  const existing = await client.query('SELECT id FROM dischargeloop.hospital WHERE is_primary = true LIMIT 1');
  if (existing.rows.length > 0) {
    console.log('Seed skipped: a primary hospital already exists.');
    await client.query('ROLLBACK');
  } else {
    await client.query(
      `INSERT INTO dischargeloop.hospital (id, name, timezone) VALUES ($1, 'Riverside General Hospital', 'America/New_York')`,
      [HOSPITAL_ID],
    );

    const bedsByWard = new Map();
    for (const ward of WARDS) {
      await client.query(
        `INSERT INTO dischargeloop.ward (id, hospital_id, name, code) VALUES ($1, $2, $3, $4)`,
        [ward.id, HOSPITAL_ID, ward.name, ward.code],
      );
      const beds = [];
      for (let index = 1; index <= 8; index += 1) {
        const label = `${ward.code.slice(0, 2)}-${String(index).padStart(2, '0')}`;
        const id = randomUUID();
        let state = 'AVAILABLE';
        let reason = 'CREATED';
        if (index === 8 && ward.code === '3W-SURG') { state = 'CLEANING'; reason = 'DISCHARGE_PENDING'; }
        if (index === 7 && ward.code === 'ICU-SD') { state = 'MAINTENANCE'; reason = 'MAINTENANCE_STARTED'; }
        await client.query(
          `INSERT INTO dischargeloop.bed (id, ward_id, label, state, state_reason_code)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, ward.id, label, state, reason],
        );
        beds.push({ id, label, state });
      }
      bedsByWard.set(ward.id, beds);
    }

    const cleaningBed = bedsByWard.get(WARDS[1].id).find((bed) => bed.state === 'CLEANING');
    await client.query(
      `INSERT INTO dischargeloop.cleaning (id, bed_id, status, notes)
       VALUES ($1, $2, 'OPEN', 'Terminal clean after discharge')`,
      [randomUUID(), cleaningBed.id],
    );

    let patientIndex = 0;
    for (const ward of WARDS) {
      const beds = bedsByWard.get(ward.id).filter((bed) => bed.state === 'AVAILABLE').slice(0, 4);
      for (const bed of beds) {
        const [name, dob, sex] = PATIENTS[patientIndex % PATIENTS.length];
        patientIndex += 1;
        const patientId = randomUUID();
        const encounterId = randomUUID();
        await client.query(
          `INSERT INTO dischargeloop.patient (id, hospital_id, his_patient_id, display_name, date_of_birth, sex)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [patientId, HOSPITAL_ID, `MRN-${1000 + patientIndex}`, name, dob, sex],
        );
        await client.query(
          `INSERT INTO dischargeloop.encounter
             (id, patient_id, ward_id, bed_id, status, his_encounter_id, admitted_at)
           VALUES ($1, $2, $3, $4, 'ADMITTED', $5, now() - ($6 || ' hours')::interval)`,
          [encounterId, patientId, ward.id, bed.id, `ENC-${1000 + patientIndex}`, String(18 + patientIndex * 7)],
        );
        await client.query(
          `INSERT INTO dischargeloop.bed_assignment (id, bed_id, encounter_id, kind, state, starts_at)
           VALUES ($1, $2, $3, 'OCCUPANCY', 'ACTIVE', now() - interval '12 hours')`,
          [randomUUID(), bed.id, encounterId],
        );
        await client.query(
          `UPDATE dischargeloop.bed SET state = 'OCCUPIED', state_reason_code = 'ADMISSION_CONFIRMED', version = version + 1
           WHERE id = $1`,
          [bed.id],
        );
      }
    }

    const expectedWard = WARDS[0];
    const [expectedName, expectedDob, expectedSex] = PATIENTS[PATIENTS.length - 1];
    const expectedPatient = randomUUID();
    await client.query(
      `INSERT INTO dischargeloop.patient (id, hospital_id, his_patient_id, display_name, date_of_birth, sex)
       VALUES ($1, $2, 'MRN-2001', $3, $4, $5)`,
      [expectedPatient, HOSPITAL_ID, `${expectedName} (expected)`, expectedDob, expectedSex],
    );
    await client.query(
      `INSERT INTO dischargeloop.encounter (id, patient_id, ward_id, status, his_encounter_id)
       VALUES ($1, $2, $3, 'EXPECTED', 'ENC-2001')`,
      [randomUUID(), expectedPatient, expectedWard.id],
    );

    // Seed one discharge already in TASKS_PENDING so the demo has live work on first load.
    const seedEncounter = await client.query(
      `SELECT e.id FROM dischargeloop.encounter e
       JOIN dischargeloop.ward w ON w.id = e.ward_id
       WHERE e.status = 'ADMITTED' AND w.code = '2E-MED' LIMIT 1`,
    );
    if (seedEncounter.rows[0]) {
      const dischargeId = randomUUID();
      await client.query(
        `INSERT INTO dischargeloop.discharge
           (id, encounter_id, state, initiated_by, initiated_at, cleared_at, version)
         VALUES ($1, $2, 'TASKS_PENDING', $3, now() - interval '2 hours', now() - interval '90 minutes', 1)`,
        [dischargeId, seedEncounter.rows[0].id, '33333333-3333-7333-8333-333333333333'],
      );
      const tasks = [
        ['medication_reconciliation', 'Medication reconciliation complete', 'pharmacy', 1, 30],
        ['billing_clearance', 'Billing and insurance cleared', 'billing', 2, 60],
        ['lab_results', 'Final lab results reviewed', 'clinical', 3, 90],
        ['transport_booking', 'Transport booked', 'transport', 4, 180],
      ];
      for (const [type, title, role, priority, minutes] of tasks) {
        await client.query(
          `INSERT INTO dischargeloop.task
             (id, discharge_id, type, title, owner_role, status, priority, blocking, due_at)
           VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, true, now() + ($7 || ' minutes')::interval)`,
          [randomUUID(), dischargeId, type, title, role, priority, String(minutes)],
        );
      }
      await client.query(
        `INSERT INTO dischargeloop.audit_event
           (id, actor_id, actor_role, action, entity_type, entity_id, after_state, reason_code, correlation_id, request_id)
         VALUES ($1, '33333333-3333-7333-8333-333333333333', 'clinical', 'discharge.initiated', 'discharge', $2,
                 $3::jsonb, 'CREATED', 'seed', 'seed')`,
        [randomUUID(), dischargeId, JSON.stringify({ state: 'TASKS_PENDING' })],
      );
    }

    await client.query('COMMIT');
    console.log('Seed complete: 1 hospital, 3 wards, 24 beds, 11 patients, 1 open cleaning job, 1 in-flight discharge.');
  }
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}

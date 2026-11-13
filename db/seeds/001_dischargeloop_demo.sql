-- Synthetic demo data only (no real PHI). Applied only when SEED_DEMO=true. Idempotent via fixed ids / ON CONFLICT.
INSERT INTO hospital (id, name, timezone, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Northstar General Hospital', 'America/New_York', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ward (id, hospital_id, name, code, department_type) VALUES
  ('a0000000-0000-0000-0000-00000000004a', '00000000-0000-0000-0000-000000000001', 'General Medicine 4A', '4A', 'WARD'),
  ('a0000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-000000000001', 'Orthopedics 5B', '5B', 'WARD'),
  ('a0000000-0000-0000-0000-00000000001c', '00000000-0000-0000-0000-000000000001', 'Medical ICU', 'ICU', 'ICU'),
  ('a0000000-0000-0000-0000-0000000000ed', '00000000-0000-0000-0000-000000000001', 'Emergency Department', 'ED', 'EMERGENCY')
ON CONFLICT (id) DO NOTHING;

-- Beds: label = <ward>-<nn>; HL7 PV1-3 "4A^^4A-01" resolves by ward code + bed label.
INSERT INTO bed (id, ward_id, label, state, state_reason_code)
SELECT md5(w.code || '-' || n)::uuid, w.id, w.code || '-' || lpad(n::text, 2, '0'), 'AVAILABLE', 'CREATED'
  FROM ward w
  JOIN LATERAL generate_series(1, CASE w.code WHEN '4A' THEN 10 WHEN '5B' THEN 8 WHEN 'ICU' THEN 6 ELSE 6 END) AS n ON true
ON CONFLICT (ward_id, label) DO NOTHING;

-- Synthetic admitted patients.
WITH demo(n, ward_code, bed_no, name, dob) AS (VALUES
  (1, '4A', 1, 'Demo Patient A01', DATE '1946-03-14'), (2, '4A', 2, 'Demo Patient A02', DATE '1959-11-02'),
  (3, '4A', 3, 'Demo Patient A03', DATE '1938-07-21'), (4, '4A', 4, 'Demo Patient A04', DATE '1971-01-30'),
  (5, '4A', 5, 'Demo Patient A05', DATE '1952-09-09'), (6, '4A', 6, 'Demo Patient A06', DATE '1980-05-17'),
  (7, '5B', 1, 'Demo Patient B01', DATE '1949-12-25'), (8, '5B', 2, 'Demo Patient B02', DATE '1963-06-06'),
  (9, '5B', 3, 'Demo Patient B03', DATE '1944-02-11'), (10, 'ICU', 1, 'Demo Patient C01', DATE '1957-08-19'),
  (11, 'ICU', 2, 'Demo Patient C02', DATE '1968-10-03'), (12, 'ICU', 3, 'Demo Patient C03', DATE '1975-04-27')
), p AS (
  INSERT INTO patient (id, hospital_id, his_patient_id, display_name, date_of_birth, sex)
  SELECT md5('patient-' || n)::uuid, '00000000-0000-0000-0000-000000000001', 'MRN' || lpad(n::text, 6, '0'), name, dob,
         CASE WHEN n % 2 = 0 THEN 'F' ELSE 'M' END
    FROM demo
  ON CONFLICT (hospital_id, his_patient_id) DO NOTHING
  RETURNING id
), e AS (
  INSERT INTO encounter (id, patient_id, ward_id, bed_id, status, his_encounter_id, admitted_at)
  SELECT md5('encounter-' || d.n)::uuid, md5('patient-' || d.n)::uuid, w.id, b.id, 'ADMITTED', 'V' || lpad(d.n::text, 8, '0'),
         now() - (d.n || ' days')::interval
    FROM demo d JOIN ward w ON w.code = d.ward_code
    JOIN bed b ON b.ward_id = w.id AND b.label = d.ward_code || '-' || lpad(d.bed_no::text, 2, '0')
  ON CONFLICT (his_encounter_id) DO NOTHING
  RETURNING id, bed_id
), a AS (
  INSERT INTO bed_assignment (id, bed_id, encounter_id, kind, state, starts_at)
  SELECT md5('assign-' || e.id)::uuid, e.bed_id, e.id, 'OCCUPANCY', 'ACTIVE', now() FROM e
  RETURNING bed_id
)
UPDATE bed SET state = 'OCCUPIED', state_reason_code = 'ADMISSION_CONFIRMED', version = version + 1, updated_at = now()
 WHERE id IN (SELECT bed_id FROM a);

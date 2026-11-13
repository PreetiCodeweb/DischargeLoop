# DischargeLoop — Phase 2: from working MVP to first US hospital go-live

Evidence: `US_HOSPITAL_INTEGRATION_RESEARCH.md`. Phase 1 status: `PHASE1_INTEGRATED_MVP_PLAN.md`.
Status legend: [ ] todo · [~] in progress · [x] done

## 1. Positioning that survives an Epic shop's review

Honor Roll hospitals run Epic, and Epic already ships Case Management and Capacity Management (Hopkins retired GE for it).
CarePort already owns the post-acute referral network inside Epic. DischargeLoop therefore sells only what neither closes:

1. **Readiness + blocker ownership across departments** (pharmacy, PT, physician, transport, payer, SNF) with SLAs and escalation.
2. **Passive auto-completion from the EHR feed** (no double charting).
3. **The 2 PM-fever safety loop** (reversal that releases holds and re-runs stale work).
4. **Compliance tasks that are missed today** (Important Message from Medicare timing, CMS 482.43 choice/handoff content).
5. **Shared, timestamped blame-free delay data** (internal vs external).

It does **not** sell a bed board, command center, predictive AI, or a referral directory to Epic customers.

## 2. How a top US hospital actually deploys it (target architecture)

```
Hospital network                                   DischargeLoop (US-only AWS region, BAA)
───────────────                                    ──────────────────────────────────────
Epic Bridges ──MLLPS/TLS over IPsec VPN──►  MLLP listener (ACK, queue) ─┐
 (ADT, ORU, ORM, RDE)                                                  ├─► API + worker ─► Postgres (KMS, PITR)
Hyperdrive (WebView2/Citrix) ──SMART EHR launch (iss allowlist, PKCE)──┤
Entra ID / Okta ──OIDC/SAML (groups→roles, SCIM)───────────────────────┤
Imprivata tap-and-go ──(user switch = new EHR launch = new session)────┘
Secure Chat / Vocera / TigerConnect ◄── escalation adapter (no PHI in push body)
CarePort ◄─► referral status (phase 3)          SIEM ◄── audit + PHI-access export
```

Per-customer onboarding (8–12 weeks, gated): BAA + security review (SOC 2 Type II / HITRUST, pen test, questionnaire) →
VPN + MLLPS cert exchange → Epic TIE builds outbound ADT/ORU/RDE interface in TST → location mapping (PV1-3 → ward/bed) →
SMART app registration (open.epic → customer build) → IdP federation + role mapping → one-ward pilot with baseline metrics →
go-live with downtime runbook and hypercare.

## 3. Real-world failure modes and how the product must behave

| Edge case | Required behavior |
|---|---|
| HL7 feed silent (interface engine down, VPN flap) | Detect staleness, banner to users, CRITICAL alert to ops; manual workflow keeps working |
| Epic downtime then BCA reconciliation burst (late, back-dated ADT) | Apply in order; ignore events older than the encounter's latest applied event; never regress state |
| Duplicate / replayed messages | Idempotent on MSH-10 (done) |
| A17 bed swap, A21/A22 leave of absence, A06/A07 class change, A04/A05 | Handle explicitly (swap both beds atomically; LOA keeps the bed; class drives Medicare IM) |
| A40/A34 patient merge | Re-point encounters to the surviving MRN when unambiguous; otherwise quarantine for HIM review |
| Unknown location / test patient / newborn without name | Quarantine with ACK AE (done for location) / accept with placeholder name |
| Direct MLLP from Bridges (no customer interface engine) | Native MLLP(S) listener with framing, ACK, size limits, idle timeouts |
| Shared workstation user switch (Imprivata) | Short sessions, per-user launch; no cross-user state in the browser |
| Medicare inpatient discharge without IM follow-up | Blocking task with correct due time (≤2 days before, ≥4 h before if decided late) |
| Escalations nobody sees | Deliver to Secure Chat/Vocera/TigerConnect via adapter; never a new inbox only |
| Accessibility audit (Section 504, WCAG 2.1 AA by 2027-05-11) | WCAG 2.1 AA conformance + VPAT/ACR |
| Clock skew / DST | DB clock for lifecycle (done), UTC storage, local render |
| Partial outage of DischargeLoop | Epic remains the source of truth; DischargeLoop failure must not block discharge (advisory, not gating Epic) |

## 4. Phase 2a — implement now (buildable and testable locally)

- [x] PHASE 2a COMPLETE (2026-11-12): backend 40/40 tests (host + inside image), e2e 74/74 on the live stack, tsc/eslint clean,
  browser a11y check (landmarks, skip link, named buttons, table captions, per-route titles incl. first load), JSON PHI-free logs.
  Remaining for go-live = Phase 2b (needs customer/vendor accounts).
- [ ] **HL7 hardening**: migration 006 (new event enum values, encounter `patient_class`, `on_leave`, `last_adt_at`,
  `medicare` flag); out-of-order guard; A04/A05/A06/A07/A17/A21/A22/A34/A40 handling; Medicare detection from IN1.
- [ ] **Native MLLP/MLLPS listener** service (`app.discharge.mllp`, asyncio, stdlib only, TLS optional, ACK, size/idle limits),
  new compose service on loopback port; e2e over a real socket.
- [ ] **Important Message from Medicare tasks**: initial IM (≤2 days after inpatient admission) and follow-up IM (blocking,
  ≤2 days and ≥4 h before expected discharge).
- [ ] **Operability**: `/ready` (DB check), `/metrics` (Prometheus text, no new dependency: HTTP RED + feed lag + quarantine +
  overdue tasks), JSON logs with correlation id and no PHI, feed-staleness detection (worker → CRITICAL ops alert, UI banner).
- [ ] **Accessibility (WCAG 2.1 AA) review + fixes** on DischargeLoop screens: skip link, landmarks, table semantics,
  keyboard-operable rows, live regions, focus visibility, contrast, labelled controls.
- [ ] Verify: unit + integration tests, e2e smoke extended (MLLP, staleness, IM, merge, swap), browser a11y pass, rebuild + run.

## 5. Phase 2b — needs customer/vendor accounts (planned, not buildable alone)

- SMART on FHIR EHR launch (needs open.epic app registration; test in Epic sandbox, then customer TST).
- Enterprise SSO: OIDC (Entra ID/Okta) + group→role mapping + SCIM deprovisioning (replaces local passwords for staff).
- Escalation delivery adapters: Epic Secure Chat / In Basket, Vocera Edge, TigerConnect (vendor APIs + BAAs).
- CarePort referral status ingest (external blocker auto-update); external partner portal for non-CarePort facilities.
- AWS production: US region, VPC + site-to-site VPN per hospital, RDS Postgres (KMS, PITR, Multi-AZ), ALB + WAF, ACM/TLS,
  Secrets Manager, CloudWatch/SIEM export, backups + restore drills; BAA with AWS. (Starts as single EC2 per the user's plan,
  then RDS when the first contract is signed.)
- Compliance program: SOC 2 Type II (then HITRUST), pen test, VPAT/ACR, policies, BAA template, incident response with 24 h notice.

## 6. Phase 3

Oracle Health and MEDITECH adapters; Workday/Oracle HCM SCIM provisioning; multi-tenant control plane; analytics export to
the hospital's warehouse (Clarity/Caboodle side-by-side); predictive EDD only after baseline data exists.

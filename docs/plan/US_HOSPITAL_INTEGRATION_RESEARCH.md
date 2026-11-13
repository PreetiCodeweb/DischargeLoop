# US hospital landscape & integration research (collected 2026-11-12)

Sources are cited inline. This is evidence for `PHASE2_GO_LIVE_PLAN.md`.

## 1. Target accounts: US News 2025-26 Honor Roll (20)
Mayo Clinic (Rochester, Arizona), Cedars-Sinai, Stanford, UCLA, UCSF, AdventHealth Orlando, Northwestern Memorial, Rush,
Johns Hopkins, Brigham and Women's, Mass General, Univ. of Michigan, Hackensack UMC, Mount Sinai, NewYork-Presbyterian,
NYU Langone, Cleveland Clinic, Penn Presbyterian, Houston Methodist.
Source: Becker's, "US News' Best Hospitals 2025-26 Honor Roll" (beckershospitalreview.com/rankings-and-ratings/us-news-best-hospitals-2025-26-honor-roll/).

## 2. EHR market (decides integration priority)
- KLAS end-2025: Epic 43.7% of US acute hospitals / 56.9% of beds; Oracle Health 21.9% / 20.4%; MEDITECH 14.7% / 12.5%;
  TruBridge 7.6%; Altera 2.9%. Both large systems deciding in 2025 chose Epic. (Becker's "How the hospital EHR market has shifted"; KLAS 2026 report.)
- Honor Roll systems are overwhelmingly Epic (Mayo, Cleveland Clinic, Hopkins, MGB, NYU, UCLA, Cedars, Northwestern, Stanford,
  UCSF, Penn, Mount Sinai, NYP, Michigan, Houston Methodist, Rush, Hackensack). => Epic is the integration critical path;
  Oracle Health (VA/DoD, some regional systems) and MEDITECH (HCA, community hospitals) are phase-3 adapters.

## 3. How a third party integrates with Epic
- **Vendor Services / open.epic** for build+test (sandbox, docs); **Showroom** for discovery:
  Connection Hub (≥1 live Epic connection, $500/app/yr), Toolbox (Epic "blueprints" for a category, dedicated TS, facilitated license),
  Workshop (co-development). App Orchard/App Market are retired. (vendorservices.epic.com/Resources/OEC08; mindbowser Showroom guide.)
- **Epic Bridges** = Epic-managed HL7 v2 endpoints. Each interface is built with the customer's Epic TIE: trigger events
  (ADT A01/A02/A03/A08..., ORU R01, ORM O01, SIU), Z-segments, transport. In 2026 almost always **MLLPS (MLLP over TLS 1.2+)**
  on a long-lived TCP socket with ACKs; often over **site-to-site IPsec VPN**; ports assigned by the interface team (e.g. 6661 ADT).
  Hospitals typically front vendors with an interface engine (Mirth/NextGen Connect, Rhapsody, Cloverleaf, InterSystems) — vendor
  must also accept a direct MLLP feed. Disk-backed queueing needed across Epic maintenance windows.
  (mirth.support Epic guide; tactionsoft Epic guide; nirmitee Mirth playbook.)
- **SMART on FHIR (EHR launch)** inside Hyperspace / **Hyperdrive** (Epic's web-based client; embedded **Microsoft Edge WebView2**,
  launched as main activity, sidebar, or external browser; often via **Citrix**). Launch passes `iss` + `launch`; app must
  allowlist `iss`, use PKCE (S256), `aud=iss`, read `.well-known/smart-configuration`; token returns `patient`, `encounter`,
  `fhirUser`, `need_patient_banner`. HL7/SMART integrations need no Hyperdrive code changes; COM/desktop integrations do.
  (open.epic.com/Hyperdrive; HL7 SMART App Launch v2.2; idealogic SMART guide; mindbowser EHR launch guide.)
- Epic recommends OAuth 2.0 / SMART for auth; direct MLLP sockets for HL7. (Epic "Playbooks for Data Exchange Design" OEC08.)

## 4. Incumbents DischargeLoop must coexist with (not replace)
- **Epic native**: Case Management application, Capacity Management / Grand Central dashboards. Johns Hopkins replaced its
  GE command-center displays with Epic Capacity Management Dashboards system-wide in Oct 2026, saving ~$0.5M/yr.
  => Do NOT sell a command center/bed board to Epic shops; sell the cross-organization handoff loop Epic does not close.
  (it.johnshopkins.edu "Epic Capacity Management Dashboards go live system-wide".)
- **WellSky CarePort** (Transition, Guide, Interop, Community Referral Network; 130k post-acute providers; in Epic Toolbox
  for Community Resource Network since Dec 2025; avg referral response 24 min; two-way ADT/clinical data with Epic).
  => Integrate with, don't compete on, the referral network/provider directory; DischargeLoop owns readiness + blockers + SLA.
  (careporthealth.com/epic-clients; wellsky.com Toolbox press release Dec 10 2025.)
- **Clinical communication**: Epic Secure Chat, Rover/Haiku; Stryker Vocera Edge; TigerConnect; PerfectServe; Baxter Voalte.
  => Escalations must deliver into these (or Epic In Basket), not a new inbox nurses ignore. (stryker.com Vocera Edge; tigerconnect.com; KLAS CCP 2023.)
- **Identity**: Imprivata OneSign badge "tap and go" on shared workstations with fast user switching; Epic via Citrix; hospital
  IdP usually Microsoft Entra ID (or Okta/Ping) with SAML/OIDC. => App must handle shared-workstation user switching
  (EHR-context launch per user, short sessions, no cross-user leakage). (docs.imprivata.com Epic reference architecture.)
- **ERP/HR/supply** (staffing, roles, cost-center data — not PHI): Mayo = Oracle Fusion (ERP/SCM/HCM); Johns Hopkins = Workday
  (HCM, Financials, SCM for Healthcare; replacing SAP, go-live Jul 2027); others Workday/Infor CloudSuite/Oracle. => phase-3 only:
  SCIM/HR feed for user provisioning; not needed for MVP. (enterprisetimes Mayo/Oracle; sightline.jhu.edu; Workday newsroom Jan 2025.)

## 5. Regulation that shapes the product
- **42 CFR 482.43 discharge planning CoP**: early identification of at-risk patients, timely evaluation to avoid delays, evaluation in
  the medical record, patient/caregiver as partners, **patient choice of post-acute provider using quality & resource-use data
  (IMPACT Act)**, documented in the record; CMS QSO-23-16 lists common missing info in PAC handoffs (SMI/SUD, full med list,
  skin/wounds, DME such as Trilogy/CPAP/high-flow O2, goals/preferences). => checklist templates + pre-flight scrubber content.
- **Section 504 (HHS) web/mobile accessibility rule**: WCAG 2.1 AA required for HHS-funded recipients (i.e. Medicare hospitals) for
  content they provide "directly or through contractual, licensing, or other arrangements" — deadline extended to **May 11, 2027**
  (≥15 employees). Vendor software is in scope => WCAG 2.1 AA + VPAT/ACR is a procurement gate. (hhs.gov press 2026-05-07; 45 CFR 84.84.)
- HIPAA Security Rule + BAA; most systems also require SOC 2 Type II and/or HITRUST, a security questionnaire, pen test, and
  a vendor risk review before any PHI connection.
- **Important Message from Medicare (IM, CMS-10065)**: every Medicare (FFS + MA) inpatient; deliver in person within 2 calendar days
  of admission; follow-up copy no more than 2 days before discharge (if the discharge decision is <48 h out, at least 4 h before
  discharge); signed copy retained (may be electronic). Missing it is a CoP/appeal-rights failure that can delay discharge.
  (cms.gov FFS & MA IM; 42 CFR 405.1205; medicare.gov fast appeals.) => auto-generated, time-boxed DischargeLoop task.

## 6. Vendor security expectations (what procurement will ask)
- One of SOC 2 Type II / HITRUST / NIST CSF / ISO 27001; signed BAA (also flowed to subprocessors); cyber insurance; subprocessor list;
  right to audit; data return/destruction at termination. (capitalhealth.org IT security standards.)
- NYC H+H example: 24 h breach notification; data transfer via SFTP or **site-to-site VPN**; public CA certs on internet-facing servers,
  internal CA support for internal servers; **US-only hosting**; **federation with hospital AD via SAML 2.0/OIDC** for users and groups.
- TLS 1.2+ (1.3 preferred), AES-256 at rest with FIPS 140-2/3 validated modules where feasible; vuln scanning + patch SLAs; pen-test summary;
  secure SDLC. (accountablehq hospital vendor checklist.)

## 7. Real-world HL7 ADT edge cases to support
Beyond A01/A02/A03/A08/A11/A12/A13/A16/A25 the feed will carry: **A04** register, **A05** pre-admit, **A06/A07** outpatient<->inpatient
(observation → inpatient matters for Medicare IM/2-midnight), **A17 bed swap** (two PV1s; some vendors mis-handle it), **A21/A22 leave
of absence** (+ A52/A53 cancels), **A34/A40 merge** (MRN merge; A34 legacy), A44/A45 account/visit moves, A15/A26 pending transfer.
Plus: duplicates, **out-of-order delivery** after interface-engine replay, Z-segments, repeating PID-3 identifier lists (MRN vs EPI),
newborns without names, test patients, Epic maintenance windows. (CareEvolution ADT transaction list; Summit A17 note; Visage A34/A40 spec.)

## 8. Epic downtime reality
Levels: PRD down → Shadow Read Only (SRO) → BCA Web (read-only reports; Data Entry mode for ADT in the transfer center/ED) → BCA PCs → paper.
Interface-engine (e.g. Rhapsody) downtime is separate: Epic up but feeds queued, results file late. After downtime, ADT events entered
in BCA are reconciled into production (often a burst of back-dated messages). (uiowa BCA Web; RWJBH downtime SBAR; OCHIN overview.)
=> DischargeLoop must: detect a silent/stale feed, show it to users, keep manual workflow usable, and accept late, back-dated bursts
without regressing state (ignore events older than the encounter's latest applied event).

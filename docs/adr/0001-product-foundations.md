# ADR-0001: Product foundations and local deployment

- Status: Accepted
- Date: 2026-11-02

## Context

The repository contains an existing Django hospital management system backed by SQLite. DischargeLoop's product charter specifies a separate NestJS API, React/TypeScript web app, PostgreSQL primary database, Redis for ephemeral services, and local/on-premises deployment.

## Decision

Build the DischargeLoop product alongside the existing Django application. Do not migrate, reuse, or seed the existing SQLite database. The new PostgreSQL volume starts empty and no demo users, patients, beds, fixtures, or seed commands are included. Use PostgreSQL 16, Redis 7, Node.js 22, React 18, and NestJS 10 for the initial foundation. Keycloak is the local OIDC target. The EHR interface target is HL7 v2 ADT through Mirth/NextGen Connect.

Initial product assumptions for M1 are flexible wards with bed labels, a 30-minute reservation TTL with coordinator override, seven-year audit retention, English UI, and workflow-only patient data with no diagnoses or clinical notes.

## Consequences

- The two applications coexist during the initial milestones; the existing Django database and workflows remain untouched.
- Local Compose is for development and is not a production security profile. Keycloak runs in development mode locally.
- EHR connectivity remains unconfigured until a hospital endpoint and representative HL7 fixtures are supplied. `/health` reports liveness; `/ready` remains unavailable until database, queue, and EHR dependencies are all verified.
- UUIDv7, PostgreSQL constraints, transactional outbox, and audit immutability will be defined in the domain schema ADR before M1 migrations.

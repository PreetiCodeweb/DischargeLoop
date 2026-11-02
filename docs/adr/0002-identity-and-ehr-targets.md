# ADR-0002: Identity and EHR integration targets

- Status: Accepted
- Date: 2026-11-02

## Context

The product is local-first and must keep clinical truth in the hospital's EHR. No hospital identity provider, Mirth endpoint, or HL7 sample messages were supplied.

## Decision

Target a locally hosted Keycloak OIDC provider and HL7 v2 ADT via Mirth/NextGen Connect. Keep the integration link `not_configured` until an operator supplies and verifies endpoint settings and sample messages. Do not fabricate patient or encounter records to simulate connectivity.

## Consequences

- Authentication and EHR transport will be implemented behind adapters and remain disabled until configured.
- M0 readiness reports database and queue state independently from the unconfigured EHR link.
- HL7 fixtures used in future automated tests must be synthetic and clearly isolated from runtime databases.

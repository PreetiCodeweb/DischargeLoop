-- Migration 004 Down: Rollback TTL Management

-- 1. Drop functions
DROP FUNCTION IF EXISTS run_ttl_cleanup();
DROP FUNCTION IF EXISTS archive_old_audit_events();
DROP FUNCTION IF EXISTS cleanup_processed_hl7_events(integer);
DROP FUNCTION IF EXISTS cleanup_processed_outbox_events(integer);
DROP FUNCTION IF EXISTS cleanup_expired_idempotency_requests(integer);
DROP FUNCTION IF EXISTS cleanup_expired_fhir_contexts();
DROP FUNCTION IF EXISTS cleanup_expired_magic_links();

-- 2. Drop tables
DROP TABLE IF EXISTS ttl_cleanup_log;
DROP TABLE IF EXISTS ttl_config;

-- 3. Drop indexes
DROP INDEX IF EXISTS idx_audit_event_expiry;
DROP INDEX IF EXISTS idx_hl7_event_processed_expiry;
DROP INDEX IF EXISTS idx_outbox_published_expiry;
DROP INDEX IF EXISTS idx_idempotency_expiry;
DROP INDEX IF EXISTS idx_fhir_launch_expiry;
DROP INDEX IF EXISTS idx_referral_magic_link_expiry;

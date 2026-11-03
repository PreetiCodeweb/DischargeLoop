-- Migration 004: TTL Management for Complex Database Cleanup
-- Adds indexes and configuration for TTL-based cleanup of various entities

-- 1. Add indexes for TTL-based queries
CREATE INDEX IF NOT EXISTS idx_referral_magic_link_expiry
  ON referral(magic_link_expires_at)
  WHERE magic_link_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fhir_launch_expiry
  ON fhir_launch_context(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry
  ON idempotency_request(expires_at);

CREATE INDEX IF NOT EXISTS idx_outbox_published_expiry
  ON outbox(published_at)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hl7_event_processed_expiry
  ON hl7_event_log(processed_at)
  WHERE processed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_event_expiry
  ON audit_event(occurred_at);

-- 2. TTL Configuration Table
CREATE TABLE ttl_config (
  entity_type varchar(48) PRIMARY KEY,
  ttl_seconds integer NOT NULL CHECK (ttl_seconds > 0),
  is_enabled boolean NOT NULL DEFAULT true,
  cleanup_batch_size integer NOT NULL DEFAULT 1000 CHECK (cleanup_batch_size > 0),
  last_cleanup_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Insert default TTL configurations
INSERT INTO ttl_config (entity_type, ttl_seconds, cleanup_batch_size) VALUES
  ('magic_link_token', 3600, 100),              -- 1 hour
  ('fhir_launch_context', 86400, 100),          -- 24 hours
  ('idempotency_request', 86400, 1000),         -- 24 hours
  ('outbox_published', 604800, 1000),           -- 7 days
  ('hl7_event_processed', 2592000, 500),        -- 30 days
  ('hl7_event_quarantined', 7776000, 100),       -- 90 days
  ('audit_event', 31536000, 5000);              -- 1 year

-- 4. TTL Cleanup Log
CREATE TABLE ttl_cleanup_log (
  id uuid PRIMARY KEY,
  entity_type varchar(48) NOT NULL,
  records_deleted integer NOT NULL,
  cleanup_duration_ms integer NOT NULL,
  cleaned_at timestamptz NOT NULL DEFAULT now(),
  error_message text
);
CREATE INDEX idx_ttl_cleanup_log_entity_time ON ttl_cleanup_log(entity_type, cleaned_at DESC);

-- 5. Function: Cleanup expired magic-link tokens
CREATE OR REPLACE FUNCTION cleanup_expired_magic_links()
RETURNS integer AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM referral
  WHERE magic_link_expires_at IS NOT NULL
    AND magic_link_expires_at < NOW()
    AND status = 'PENDING';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 6. Function: Cleanup expired FHIR launch contexts
CREATE OR REPLACE FUNCTION cleanup_expired_fhir_contexts()
RETURNS integer AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM fhir_launch_context
  WHERE expires_at IS NOT NULL
    AND expires_at < NOW();

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 7. Function: Cleanup expired idempotency requests
CREATE OR REPLACE FUNCTION cleanup_expired_idempotency_requests(batch_size integer DEFAULT 1000)
RETURNS integer AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH expired AS (
    SELECT id
    FROM idempotency_request
    WHERE expires_at < NOW()
    LIMIT batch_size
  )
  DELETE FROM idempotency_request
  WHERE id IN (SELECT id FROM expired);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 8. Function: Cleanup processed outbox events
CREATE OR REPLACE FUNCTION cleanup_processed_outbox_events(batch_size integer DEFAULT 1000)
RETURNS integer AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH processed AS (
    SELECT id
    FROM outbox
    WHERE published_at IS NOT NULL
      AND published_at < NOW() - (SELECT ttl_seconds FROM ttl_config WHERE entity_type = 'outbox_published') * INTERVAL '1 SECOND'
    LIMIT batch_size
  )
  DELETE FROM outbox
  WHERE id IN (SELECT id FROM processed);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 9. Function: Cleanup processed HL7 events
CREATE OR REPLACE FUNCTION cleanup_processed_hl7_events(batch_size integer DEFAULT 500)
RETURNS integer AS $$
DECLARE
  deleted_count integer;
  ttl_seconds integer;
BEGIN
  SELECT ttl_seconds INTO ttl_seconds FROM ttl_config WHERE entity_type = 'hl7_event_processed';

  WITH processed AS (
    SELECT id
    FROM hl7_event_log
    WHERE processing_status = 'PROCESSED'
      AND processed_at IS NOT NULL
      AND processed_at < NOW() - (ttl_seconds * INTERVAL '1 SECOND')
    LIMIT batch_size
  )
  DELETE FROM hl7_event_log
  WHERE id IN (SELECT id FROM processed);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 10. Function: Cleanup old audit events (archival, not deletion)
CREATE OR REPLACE FUNCTION archive_old_audit_events(batch_size integer DEFAULT 5000)
RETURNS integer AS $$
DECLARE
  archived_count integer;
  ttl_seconds integer;
BEGIN
  SELECT ttl_seconds INTO ttl_seconds FROM ttl_config WHERE entity_type = 'audit_event';

  -- This would move to an archive table in production
  -- For now, we'll just count what would be archived
  SELECT COUNT(*) INTO archived_count
  FROM audit_event
  WHERE occurred_at < NOW() - (ttl_seconds * INTERVAL '1 SECOND');

  RETURN archived_count;
END;
$$ LANGUAGE plpgsql;

-- 11. Master TTL cleanup function
CREATE OR REPLACE FUNCTION run_ttl_cleanup()
RETURNS TABLE(
  entity_type varchar(48),
  records_deleted integer,
  duration_ms integer
) AS $$
DECLARE
  start_time timestamptz;
  end_time timestamptz;
  deleted_count integer;
  config_record record;
BEGIN
  FOR config_record IN SELECT * FROM ttl_config WHERE is_enabled = true LOOP
    start_time := clock_timestamp();

    CASE config_record.entity_type
      WHEN 'magic_link_token' THEN
        SELECT cleanup_expired_magic_links() INTO deleted_count;
      WHEN 'fhir_launch_context' THEN
        SELECT cleanup_expired_fhir_contexts() INTO deleted_count;
      WHEN 'idempotency_request' THEN
        SELECT cleanup_expired_idempotency_requests(config_record.cleanup_batch_size) INTO deleted_count;
      WHEN 'outbox_published' THEN
        SELECT cleanup_processed_outbox_events(config_record.cleanup_batch_size) INTO deleted_count;
      WHEN 'hl7_event_processed' THEN
        SELECT cleanup_processed_hl7_events(config_record.cleanup_batch_size) INTO deleted_count;
      WHEN 'audit_event' THEN
        SELECT archive_old_audit_events(config_record.cleanup_batch_size) INTO deleted_count;
      ELSE
        deleted_count := 0;
    END CASE;

    end_time := clock_timestamp();

    -- Log the cleanup
    INSERT INTO ttl_cleanup_log (id, entity_type, records_deleted, cleanup_duration_ms)
    VALUES (uuid_generate_v4(), config_record.entity_type, deleted_count, EXTRACT(MILLISECOND FROM (end_time - start_time))::integer);

    -- Update last cleanup timestamp
    UPDATE ttl_config
    SET last_cleanup_at = NOW()
    WHERE entity_type = config_record.entity_type;

    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

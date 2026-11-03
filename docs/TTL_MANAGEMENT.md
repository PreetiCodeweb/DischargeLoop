# TTL Management System for DischargeLoop

## Overview

The TTL (Time-To-Live) Management System provides automated cleanup of expired records across multiple entity types in the DischargeLoop database. This ensures the database remains performant and storage-efficient by removing or archiving stale data.

## Architecture

### Components

1. **Database Layer** (Migration 004)
   - `ttl_config` table - Configurable TTL settings per entity type
   - `ttl_cleanup_log` table - Audit trail of cleanup operations
   - Specialized cleanup functions for each entity type
   - Master `run_ttl_cleanup()` function orchestrates all cleanups

2. **Application Layer**
   - `TTLCleanupService` - Service for managing TTL operations
   - `ttl-cleanup.ts` - Standalone worker for scheduled cleanup

3. **Infrastructure Layer**
   - Docker Compose service `ttl-cleanup` for scheduled execution
   - Configurable batch sizes to prevent long-running transactions

## Supported Entity Types

| Entity Type | Default TTL | Cleanup Batch Size | Description |
|-------------|-------------|-------------------|-------------|
| `magic_link_token` | 1 hour (3600s) | 100 | Expired magic-link tokens for external partner access |
| `fhir_launch_context` | 24 hours (86400s) | 100 | Expired SMART on FHIR launch contexts |
| `idempotency_request` | 24 hours (86400s) | 1000 | Expired idempotency keys |
| `outbox_published` | 7 days (604800s) | 1000 | Successfully published outbox events |
| `hl7_event_processed` | 30 days (2592000s) | 500 | Successfully processed HL7 events |
| `hl7_event_quarantined` | 90 days (7776000s) | 100 | Quarantined HL7 events (longer retention for debugging) |
| `audit_event` | 1 year (31536000s) | 5000 | Audit events (archival, not deletion) |

## Database Schema

### ttl_config Table

```sql
CREATE TABLE ttl_config (
  entity_type varchar(48) PRIMARY KEY,
  ttl_seconds integer NOT NULL CHECK (ttl_seconds > 0),
  is_enabled boolean NOT NULL DEFAULT true,
  cleanup_batch_size integer NOT NULL DEFAULT 1000 CHECK (cleanup_batch_size > 0),
  last_cleanup_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**Fields:**
- `entity_type` - Unique identifier for the entity type
- `ttl_seconds` - Time-to-live in seconds
- `is_enabled` - Whether cleanup is enabled for this entity
- `cleanup_batch_size` - Number of records to delete per batch
- `last_cleanup_at` - Timestamp of last successful cleanup
- `created_at`, `updated_at` - Audit timestamps

### ttl_cleanup_log Table

```sql
CREATE TABLE ttl_cleanup_log (
  id uuid PRIMARY KEY,
  entity_type varchar(48) NOT NULL,
  records_deleted integer NOT NULL,
  cleanup_duration_ms integer NOT NULL,
  cleaned_at timestamptz NOT NULL DEFAULT now(),
  error_message text
);
```

**Fields:**
- `id` - Unique identifier
- `entity_type` - Entity type that was cleaned
- `records_deleted` - Number of records deleted
- `cleanup_duration_ms` - Duration of cleanup in milliseconds
- `cleaned_at` - When cleanup ran
- `error_message` - Error message if cleanup failed

## Cleanup Functions

### Individual Entity Functions

#### 1. cleanup_expired_magic_links()
Removes expired magic-link tokens from the `referral` table.

```sql
SELECT cleanup_expired_magic_links();
-- Returns: number of records deleted
```

#### 2. cleanup_expired_fhir_contexts()
Removes expired SMART on FHIR launch contexts.

```sql
SELECT cleanup_expired_fhir_contexts();
-- Returns: number of records deleted
```

#### 3. cleanup_expired_idempotency_requests(batch_size)
Removes expired idempotency requests in batches.

```sql
SELECT cleanup_expired_idempotency_requests(1000);
-- Returns: number of records deleted
```

#### 4. cleanup_processed_outbox_events(batch_size)
Removes successfully published outbox events older than TTL.

```sql
SELECT cleanup_processed_outbox_events(1000);
-- Returns: number of records deleted
```

#### 5. cleanup_processed_hl7_events(batch_size)
Removes successfully processed HL7 events older than TTL.

```sql
SELECT cleanup_processed_hl7_events(500);
-- Returns: number of records deleted
```

#### 6. archive_old_audit_events(batch_size)
**Note:** Currently counts records that would be archived. In production, this should move records to an archive table rather than deleting.

```sql
SELECT archive_old_audit_events(5000);
-- Returns: number of records that would be archived
```

### Master Orchestration Function

#### run_ttl_cleanup()
Executes cleanup for all enabled entity types and logs results.

```sql
SELECT * FROM run_ttl_cleanup();
-- Returns: table of (entity_type, records_deleted, duration_ms)
```

**Behavior:**
1. Queries `ttl_config` for all enabled entity types
2. For each entity type:
   - Records start time
   - Calls appropriate cleanup function
   - Records end time
   - Logs to `ttl_cleanup_log`
   - Updates `last_cleanup_at` in `ttl_config`
3. Returns results for all entity types

## Usage

### Manual Cleanup via SQL

```sql
-- Run all cleanups
SELECT * FROM dischargeloop.run_ttl_cleanup();

-- Run specific cleanup
SELECT dischargeloop.cleanup_expired_magic_links();

-- Check cleanup history
SELECT * FROM dischargeloop.ttl_cleanup_log
ORDER BY cleaned_at DESC
LIMIT 50;

-- View current TTL configuration
SELECT * FROM dischargeloop.ttl_config
ORDER BY entity_type;

-- Update TTL for a specific entity
UPDATE dischargeloop.ttl_config
SET ttl_seconds = 7200, updated_at = NOW()
WHERE entity_type = 'magic_link_token';

-- Disable cleanup for an entity
UPDATE dischargeloop.ttl_config
SET is_enabled = false, updated_at = NOW()
WHERE entity_type = 'audit_event';
```

### Scheduled Cleanup via Docker Compose

The `ttl-cleanup` service runs cleanup on a schedule (configured via external scheduler or manually):

```bash
# Start the TTL cleanup service
docker compose -f ops/docker-compose.yml up ttl-cleanup

# Run cleanup once
docker compose -f ops/docker-compose.yml run --rm ttl-cleanup

# View logs
docker compose -f ops/docker-compose.yml logs ttl-cleanup
```

### Programmatic Cleanup via Application Service

```typescript
import { TTLCleanupService } from './ttl/ttl-cleanup.service';

// Run all cleanups
const results = await cleanupService.runCleanup();

// Get cleanup history
const history = await cleanupService.getCleanupHistory(100);

// Get current configuration
const config = await cleanupService.getTTLConfig();

// Update configuration
await cleanupService.updateTTLConfig('magic_link_token', {
  ttlSeconds: 7200,
  cleanupBatchSize: 200,
});
```

## Performance Considerations

### Batch Processing

All cleanup functions use batch processing to:
- Prevent long-running transactions
- Avoid table locks during cleanup
- Allow incremental cleanup
- Provide visibility into progress

### Indexes

Indexes are created on TTL columns for efficient cleanup:
- `idx_referral_magic_link_expiry` on `referral(magic_link_expires_at)`
- `idx_fhir_launch_expiry` on `fhir_launch_context(expires_at)`
- `idx_idempotency_expiry` on `idempotency_request(expires_at)`
- `idx_outbox_published_expiry` on `outbox(published_at)`
- `idx_hl7_event_processed_expiry` on `hl7_event_log(processed_at)`
- `idx_audit_event_expiry` on `audit_event(occurred_at)`

### Scheduling

Recommended cleanup schedules:
- **High-frequency entities** (magic_link_token, fhir_launch_context): Every 5-15 minutes
- **Medium-frequency entities** (idempotency_request, outbox_published): Every 1-6 hours
- **Low-frequency entities** (hl7_event_processed, audit_event): Daily

## Monitoring

### Metrics to Track

1. **Cleanup Duration** - `cleanup_duration_ms` in `ttl_cleanup_log`
2. **Records Deleted** - `records_deleted` per entity type
3. **Cleanup Frequency** - `last_cleanup_at` in `ttl_config`
4. **Error Rate** - `error_message` in `ttl_cleanup_log`

### Sample Monitoring Query

```sql
SELECT
  entity_type,
  AVG(records_deleted) as avg_deleted,
  AVG(cleanup_duration_ms) as avg_duration_ms,
  MAX(cleanup_duration_ms) as max_duration_ms,
  COUNT(*) as cleanup_count,
  MAX(cleaned_at) as last_cleanup
FROM ttl_cleanup_log
WHERE cleaned_at > NOW() - INTERVAL '7 days'
GROUP BY entity_type
ORDER BY entity_type;
```

### Alerting

Set up alerts for:
- Cleanup duration > 30 seconds
- Cleanup failures (error_message not null)
- Stale cleanup (last_cleanup_at > 2x expected interval)
- High deletion count (potential data loss issue)

## Safety Features

### Non-Destructive Audit Cleanup

The `archive_old_audit_events` function currently only counts records that would be archived. In production:

1. Create an `audit_event_archive` table with same schema
2. Modify function to INSERT into archive before DELETE
3. Consider compression for archived data
4. Implement retention policy for archive table

### Configuration Validation

- TTL must be > 0 seconds
- Batch size must be > 0
- Entity type must exist in config before cleanup
- Cleanup checks if enabled before running

### Transaction Safety

- Each cleanup function runs in its own transaction
- Batch processing limits transaction size
- Errors are logged without stopping other cleanups
- Master function continues even if individual cleanup fails

## Configuration Examples

### Extend Magic-Link TTL to 2 Hours

```sql
UPDATE ttl_config
SET ttl_seconds = 7200,
    updated_at = NOW()
WHERE entity_type = 'magic_link_token';
```

### Increase Batch Size for Large Tables

```sql
UPDATE ttl_config
SET cleanup_batch_size = 5000,
    updated_at = NOW()
WHERE entity_type = 'audit_event';
```

### Disable Audit Event Cleanup During Migration

```sql
UPDATE ttl_config
SET is_enabled = false,
    updated_at = NOW()
WHERE entity_type = 'audit_event';
```

### Add New Entity Type to TTL System

```sql
INSERT INTO ttl_config (entity_type, ttl_seconds, cleanup_batch_size)
VALUES ('custom_entity', 86400, 1000);
```

Then create corresponding cleanup function and add to `run_ttl_cleanup()`.

## Migration

### Apply Migration

```bash
docker compose -f ops/docker-compose.yml exec api npm run migrate
```

### Rollback Migration

```bash
docker compose -f ops/docker-compose.yml exec api npm run migrate:down
```

**Note:** Rolling back migration 004 will:
- Drop all TTL-related functions
- Drop `ttl_cleanup_log` and `ttl_config` tables
- Drop TTL-related indexes
- **Not** restore any deleted records (cleanup is destructive)

## Future Enhancements

### Planned Features

1. **Audit Archival** - Move old audit events to archive table instead of deletion
2. **Dynamic Scheduling** - Adjust cleanup frequency based on record growth
3. **Per-Entity Schedules** - Different cleanup intervals per entity type
4. **Cleanup Prioritization** - Process high-priority entities first
5. **Dead Letter Queue** - Move problematic records to quarantine instead of deletion
6. **Metric Export** - Export metrics to Prometheus/Grafana
7. **Webhook Notifications** - Alert on cleanup failures or anomalies

### Advanced Use Cases

#### Conditional TTL Based on Entity State

```sql
-- Example: Keep failed tasks longer than completed tasks
DELETE FROM task
WHERE status = 'DONE'
  AND completed_at < NOW() - INTERVAL '30 days'
  AND status = 'CANCELLED'
  AND completed_at < NOW() - INTERVAL '90 days';
```

#### TTL Cascade Deletion

```sql
-- Example: Delete referral when magic-link expires
DELETE FROM referral_scrubber
WHERE referral_id IN (
  SELECT id FROM referral
  WHERE magic_link_expires_at < NOW()
);
```

#### Partition-Based Cleanup

For very large tables, consider partitioning by time and dropping old partitions:

```sql
-- Example: Monthly partitioning for audit_event
CREATE TABLE audit_event_2024_01 PARTITION OF audit_event
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Drop old partition
DROP TABLE audit_event_2023_12;
```

## Troubleshooting

### Issue: Cleanup Running Too Slow

**Diagnosis:**
```sql
SELECT entity_type, cleanup_duration_ms, records_deleted
FROM ttl_cleanup_log
ORDER BY cleaned_at DESC
LIMIT 10;
```

**Solutions:**
- Reduce `cleanup_batch_size` in `ttl_config`
- Check for missing indexes on TTL columns
- Run `ANALYZE` on affected tables
- Consider partitioning large tables

### Issue: No Records Being Deleted

**Diagnosis:**
```sql
SELECT * FROM ttl_config WHERE is_enabled = false;
SELECT last_cleanup_at FROM ttl_config;
```

**Solutions:**
- Check if cleanup is enabled
- Verify cleanup is actually running
- Check TTL values are appropriate
- Verify data has expiration timestamps

### Issue: Cleanup Fails with Errors

**Diagnosis:**
```sql
SELECT * FROM ttl_cleanup_log
WHERE error_message IS NOT NULL
ORDER BY cleaned_at DESC
LIMIT 10;
```

**Solutions:**
- Check error message for specific issue
- Verify foreign key constraints aren't blocking deletion
- Check for table locks
- Review PostgreSQL logs for details

## Conclusion

The TTL Management System provides a robust, configurable solution for automated database cleanup. By using batch processing, proper indexing, and comprehensive logging, it ensures the DischargeLoop database remains performant while preserving data integrity and providing visibility into cleanup operations.

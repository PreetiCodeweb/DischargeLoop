# TTL Management Capabilities - Quick Reference

## Can DischargeLoop Handle Complex TTL? **YES** ✅

The DischargeLoop system now has a **comprehensive TTL management system** that can handle complex, multi-entity time-to-live scenarios.

## What Was Added

### 1. Database Layer (Migration 004)

**New Tables:**
- `ttl_config` - Centralized TTL configuration per entity type
- `ttl_cleanup_log` - Audit trail of all cleanup operations

**Cleanup Functions:**
- `cleanup_expired_magic_links()` - Magic-link tokens (1 hour TTL)
- `cleanup_expired_fhir_contexts()` - SMART on FHIR contexts (24 hours)
- `cleanup_expired_idempotency_requests()` - Idempotency keys (24 hours)
- `cleanup_processed_outbox_events()` - Published outbox events (7 days)
- `cleanup_processed_hl7_events()` - Processed HL7 events (30 days)
- `archive_old_audit_events()` - Audit events (1 year, archival)
- `run_ttl_cleanup()` - Master orchestration function

**Indexes for Performance:**
- All TTL columns indexed for efficient cleanup queries
- Batch processing to prevent long transactions

### 2. Application Layer

**New Service:**
- `TTLCleanupService` - Programmatic TTL management
- Methods: `runCleanup()`, `getCleanupHistory()`, `getTTLConfig()`, `updateTTLConfig()`

**Standalone Worker:**
- `ttl-cleanup.ts` - Scheduled cleanup worker
- Structured JSON logging for monitoring
- Error handling and graceful failure

### 3. Infrastructure Layer

**Docker Compose Service:**
- `ttl-cleanup` - Dedicated cleanup container
- Runs migration before cleanup
- Configurable via environment variables

## Supported Entity Types & Default TTLs

| Entity | TTL | Batch Size | Frequency |
|--------|-----|------------|-----------|
| Magic-link tokens | 1 hour | 100 | Every 5-15 min |
| FHIR launch contexts | 24 hours | 100 | Every 1-6 hours |
| Idempotency requests | 24 hours | 1000 | Every 1-6 hours |
| Outbox events (published) | 7 days | 1000 | Every 1-6 hours |
| HL7 events (processed) | 30 days | 500 | Daily |
| HL7 events (quarantined) | 90 days | 100 | Daily |
| Audit events | 1 year | 5000 | Daily |

## Key Features

### ✅ Configurable TTL per Entity Type
```sql
UPDATE ttl_config
SET ttl_seconds = 7200,  -- 2 hours
    cleanup_batch_size = 200
WHERE entity_type = 'magic_link_token';
```

### ✅ Enable/Disable per Entity
```sql
UPDATE ttl_config
SET is_enabled = false
WHERE entity_type = 'audit_event';
```

### ✅ Batch Processing
- Prevents long-running transactions
- Configurable batch sizes per entity
- Progress visibility via logs

### ✅ Comprehensive Logging
- Every cleanup operation logged
- Records deleted count
- Duration in milliseconds
- Error messages if cleanup fails

### ✅ Safe Defaults
- Conservative TTL values
- Small batch sizes for large tables
- Audit events use archival (not deletion)

### ✅ Monitoring Ready
```sql
SELECT entity_type, AVG(records_deleted), AVG(cleanup_duration_ms)
FROM ttl_cleanup_log
WHERE cleaned_at > NOW() - INTERVAL '7 days'
GROUP BY entity_type;
```

## Comparison: Before vs After

### Before (Basic TTL Only)
- ✅ Reservation TTL (30 min - 2 hours)
- ✅ Idempotency TTL (24 hours, no cleanup worker)
- ❌ No magic-link cleanup
- ❌ No FHIR context cleanup
- ❌ No outbox cleanup
- ❌ No HL7 event cleanup
- ❌ No audit archival
- ❌ No centralized configuration
- ❌ No cleanup history/monitoring

### After (Comprehensive TTL System)
- ✅ Reservation TTL (unchanged)
- ✅ Idempotency TTL (with automated cleanup)
- ✅ Magic-link token cleanup
- ✅ FHIR context cleanup
- ✅ Outbox event cleanup
- ✅ HL7 event cleanup
- ✅ Audit event archival
- ✅ Centralized TTL configuration
- ✅ Complete cleanup history
- ✅ Performance monitoring
- ✅ Configurable batch sizes
- ✅ Enable/disable per entity

## Usage Examples

### Run All Cleanups
```bash
docker compose -f ops/docker-compose.yml run --rm ttl-cleanup
```

### Run via SQL
```sql
SELECT * FROM dischargeloop.run_ttl_cleanup();
```

### Check Cleanup History
```sql
SELECT * FROM dischargeloop.ttl_cleanup_log
ORDER BY cleaned_at DESC
LIMIT 20;
```

### View Configuration
```sql
SELECT * FROM dischargeloop.ttl_config
ORDER BY entity_type;
```

### Programmatically (TypeScript)
```typescript
const results = await cleanupService.runCleanup();
console.log(`Deleted ${results.reduce((s, r) => s + r.recordsDeleted, 0)} records`);
```

## Performance Characteristics

### Expected Performance
- Magic-link cleanup: < 100ms
- FHIR context cleanup: < 100ms
- Idempotency cleanup: < 500ms
- Outbox cleanup: < 1s
- HL7 event cleanup: < 2s
- Audit archival: < 5s (counting only)

### Optimization Features
- Indexed TTL columns
- Batch processing (limits transaction size)
- Parallel cleanup (different entities)
- Minimal locking impact

## Safety Features

### Non-Destructive Defaults
- Audit events use archival (count only)
- Conservative TTL values
- Small batch sizes

### Error Handling
- Individual cleanup failures don't stop others
- Errors logged with full context
- Graceful degradation

### Data Integrity
- Foreign key constraints respected
- Transactional cleanup per batch
- Idempotent cleanup (safe to re-run)

## Migration Path

```bash
# Apply TTL management
docker compose -f ops/docker-compose.yml exec api npm run migrate

# Start cleanup worker
docker compose -f ops/docker-compose.yml up ttl-cleanup

# View logs
docker compose -f ops/docker-compose.yml logs -f ttl-cleanup
```

## Extensibility

### Adding New Entity Types

1. Add index on TTL column
2. Insert into `ttl_config`
3. Create cleanup function
4. Add to `run_ttl_cleanup()` switch statement

Example:
```sql
-- 1. Add index
CREATE INDEX idx_custom_entity_ttl ON custom_entity(expires_at);

-- 2. Add config
INSERT INTO ttl_config (entity_type, ttl_seconds, cleanup_batch_size)
VALUES ('custom_entity', 86400, 1000);

-- 3. Create function
CREATE OR REPLACE FUNCTION cleanup_custom_entity(batch_size integer)
RETURNS integer AS $$ ... $$ LANGUAGE plpgsql;

-- 4. Add to master function
-- Update run_ttl_cleanup() to include custom_entity
```

## Monitoring & Alerting

### Key Metrics
- Cleanup duration per entity
- Records deleted per run
- Time since last cleanup
- Error rate

### Sample Alert Rules
- Alert if cleanup duration > 30s
- Alert if cleanup fails
- Alert if cleanup hasn't run in 24h
- Alert if deletion count > 10,000

## Conclusion

**Yes, DischargeLoop can now handle complex TTL scenarios.**

The system provides:
- ✅ Multi-entity TTL support
- ✅ Configurable retention periods
- ✅ Automated cleanup with monitoring
- ✅ Safe defaults with batch processing
- ✅ Comprehensive logging and history
- ✅ Easy extensibility for new entities

See [TTL_MANAGEMENT.md](./TTL_MANAGEMENT.md) for complete documentation.

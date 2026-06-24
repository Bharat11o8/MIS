-- AutoForm MIS — Phase 4b Migration: track deletions in Sales sync
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase4b_sales_deleted.sql

ALTER TABLE sync_logs
  ADD COLUMN IF NOT EXISTS rows_deleted INTEGER DEFAULT 0;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'sync_logs'
ORDER BY ordinal_position;

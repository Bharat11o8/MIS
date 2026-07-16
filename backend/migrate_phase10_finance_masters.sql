-- AutoForm MIS — Phase 10 Migration: Finance v3 (shared master files, companies = tabs)
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase10_finance_masters.sql
--
-- The finance team now delivers TWO shared master spreadsheets (one monthly, one
-- yearly), each holding every company as a separate tab — instead of one sheet
-- per company. We keep `sheet_source = company` as the app's unit of identity and
-- add a thin master layer: masters are kind='master' rows admins register; each
-- company tab auto-creates a kind='company' row on sync, and its rows land under
-- that company's sheet_source_id (so analytics/permissions/schema are unchanged).
--
-- Company rows store the company key (slug of the tab title) in `sheet_id`, so the
-- existing UNIQUE(module, sheet_id) enforces one company per name. Master rows keep
-- the real Google spreadsheet id.

-- ─── 1. Discriminator column ────────────────────────────────────────────────
ALTER TABLE sheet_sources
    ADD COLUMN IF NOT EXISTS kind VARCHAR(10)
    CHECK (kind IS NULL OR kind IN ('master', 'company'));

CREATE INDEX IF NOT EXISTS idx_sheet_sources_kind ON sheet_sources(module, kind);

-- ─── 2. One-time cleanup of the old v2 per-company finance rows ──────────────
-- The v2 model registered one spreadsheet per company; that data is incompatible
-- with the master-driven model. Clear it so the first master sync starts clean.
-- (Cascades finance_lines via ON DELETE CASCADE; also clears user_sheet_source_access.)
DELETE FROM sheet_sources WHERE module = 'finance';

-- Verify
SELECT column_name FROM information_schema.columns
WHERE table_name = 'sheet_sources' AND column_name = 'kind';

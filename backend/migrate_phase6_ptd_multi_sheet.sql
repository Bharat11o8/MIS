-- AutoForm MIS — Phase 6 Migration: Plant-to-Depot multi-sheet registry
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase6_ptd_multi_sheet.sql
--
-- Changes:
--   1. Make sheet_sources.calendar_year nullable — P2D extracts year from tab
--      names automatically and doesn't need a manually-entered value.
--   2. Add sheet_source_id FK to plant_to_depot_sales so each row knows which
--      registered sheet it came from. Existing rows (synced via the old env-var
--      path) will have NULL here until the sheet is registered and re-synced
--      through the new per-source endpoint.

-- ─── 1. Loosen calendar_year constraint on sheet_sources ─────────────────────
ALTER TABLE sheet_sources
  ALTER COLUMN calendar_year DROP NOT NULL;

ALTER TABLE sheet_sources
  DROP CONSTRAINT IF EXISTS sheet_sources_calendar_year_check;

ALTER TABLE sheet_sources
  ADD CONSTRAINT sheet_sources_calendar_year_check
  CHECK (calendar_year IS NULL OR (calendar_year BETWEEN 2020 AND 2100));

-- ─── 2. Add sheet_source_id to plant_to_depot_sales ──────────────────────────
ALTER TABLE plant_to_depot_sales
  ADD COLUMN sheet_source_id UUID REFERENCES sheet_sources(id) ON DELETE SET NULL;

CREATE INDEX idx_p2d_sheet_source ON plant_to_depot_sales(sheet_source_id);

-- ─── 3. Grants ────────────────────────────────────────────────────────────────
GRANT ALL PRIVILEGES ON TABLE plant_to_depot_sales TO mis_user;
GRANT ALL PRIVILEGES ON TABLE sheet_sources TO mis_user;

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'plant_to_depot_sales'
ORDER BY ordinal_position;

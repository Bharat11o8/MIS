-- AutoForm MIS — Phase 10 Migration: Plant-to-Depot structured fiscal year
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase10_ptd_fy.sql
--
-- Replaces the free-text label (no calendar identity, nothing preventing a
-- duplicate/mistyped FY) with the existing generic `calendar_year` column
-- (already added for Depot-to-Distributor) — used here as a plain FY start
-- year, since one Plant-to-Depot sheet already spans a whole FY's month tabs
-- (unlike Depot-to-Distributor's one-sheet-per-quarter). No `quarter` value
-- for this module — stays NULL.

-- Backfill the existing sheet ("FY26 PLANT TO DEPOT" -> start year 2025, per
-- this module's start_year+1 FY-suffix convention).
UPDATE sheet_sources
SET calendar_year = 2025
WHERE module = 'sales_plant_to_depot' AND label = 'FY26 PLANT TO DEPOT' AND calendar_year IS NULL;

-- One sheet per fiscal year — Plant-to-Depot only.
CREATE UNIQUE INDEX idx_sheet_sources_ptd_fy
  ON sheet_sources (calendar_year)
  WHERE module = 'sales_plant_to_depot';

-- Verify
SELECT id, sheet_id, label, calendar_year, quarter
FROM sheet_sources WHERE module = 'sales_plant_to_depot';

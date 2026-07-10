-- AutoForm MIS — Phase 9 Migration: Depot-to-Distributor structured quarter
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase9_dd_quarter.sql
--
-- Replaces the free-text label (which had no way to enforce "one sheet per
-- quarter" or let the frontend reliably sort/compare quarters) with a
-- structured Q1-Q4 pick alongside the existing calendar_year. Column is
-- generic on sheet_sources (shared across modules) and left NULL for modules
-- without a quarter concept (Finance, Plant-to-Depot).

ALTER TABLE sheet_sources ADD COLUMN quarter VARCHAR(2)
  CHECK (quarter IS NULL OR quarter IN ('Q1','Q2','Q3','Q4'));

-- One sheet per (year, quarter) — Depot-to-Distributor only.
CREATE UNIQUE INDEX idx_sheet_sources_dd_quarter
  ON sheet_sources (calendar_year, quarter)
  WHERE module = 'sales_depot_to_distributor';

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'sheet_sources'
ORDER BY ordinal_position;

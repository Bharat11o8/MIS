-- AutoForm MIS — Phase 5b Migration: capture sheet-provided ASM/Grand Total rows
-- The sheet's own per-ASM TOTAL row can carry a manual adjustment that isn't
-- attributable to any single distributor (confirmed: a real ~12L adjustment on
-- ATUL DWIVEDI's group, not a data error). Goal is to mirror the sheet, not
-- audit it — so these rows are now ingested as their own entity types and used
-- as the authoritative group/company rollups, instead of being recomputed by
-- summing distributor rows.
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase5b_distributor_sales_totals.sql

ALTER TABLE distributor_sales DROP CONSTRAINT distributor_sales_entity_type_check;
ALTER TABLE distributor_sales ADD CONSTRAINT distributor_sales_entity_type_check
  CHECK (entity_type IN ('distributor','depot_direct','area_head_total','grand_total'));

-- Verify
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'distributor_sales'::regclass AND conname = 'distributor_sales_entity_type_check';

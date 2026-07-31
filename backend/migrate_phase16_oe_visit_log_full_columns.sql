-- Phase 16 — OE Network: ingest the remaining log-book sheet columns
-- parse_log_book (services/oe_network_sync.py) only ever read a subset of the
-- sheet's 24 columns; Contact Person, Contact No., Channel, Email address, and
-- the uploaded photo link were parsed by the visit-log form's submit path
-- (routers/visit_log.py) but never synced back into oe_visit_logs. The ASM
-- self-service portal (My Visits) needs every column the sheet has, in the
-- sheet's own order, so this closes that gap.
--
-- Timestamp and "Column 1" (a month abbreviation) are NOT added: both are
-- sheet metadata that duplicates visit_date, not visit data.

ALTER TABLE oe_visit_logs ADD COLUMN contact_person VARCHAR(150);
ALTER TABLE oe_visit_logs ADD COLUMN contact_number VARCHAR(30);
ALTER TABLE oe_visit_logs ADD COLUMN channel        VARCHAR(20);
ALTER TABLE oe_visit_logs ADD COLUMN email          VARCHAR(150);
ALTER TABLE oe_visit_logs ADD COLUMN photo_link     TEXT;

-- Also stop collapsing the 4 remark-category columns (Product Feedback /
-- Replacement / Sales / Others) into the single `remarks` text — the ASM
-- portal and OE Network table must show each category as its own column,
-- same as the sheet. `remarks` keeps ONLY the old single-blob value (rows
-- submitted before the visit-log form existed); it is never combined with
-- the 4 new columns.
ALTER TABLE oe_visit_logs ADD COLUMN remark_product_feedback TEXT;
ALTER TABLE oe_visit_logs ADD COLUMN remark_replacement      TEXT;
ALTER TABLE oe_visit_logs ADD COLUMN remark_sales            TEXT;
ALTER TABLE oe_visit_logs ADD COLUMN remark_others           TEXT;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'oe_visit_logs'
ORDER BY ordinal_position;

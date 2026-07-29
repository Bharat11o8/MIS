-- Phase 14 — OE Network: preserve sheet row order in the log book
-- remarks_activity and the log list both ordered "visit_date DESC, id DESC".
-- id is a random UUID assigned at insert, unrelated to the sheet's row order,
-- so same-day rows (very common — several visits/calls logged on one day)
-- displayed in an effectively random order that reshuffled on every re-sync.
--
-- sheet_row is the 1-indexed row number from the sheet (set by
-- services/oe_network_sync.py:parse_log_book), so "visit_date DESC, sheet_row
-- DESC" reproduces the sheet's own top-to-bottom order — later-added rows
-- (further down the sheet) sort first, same as the sheet itself and
-- consistently across re-syncs.

ALTER TABLE oe_visit_logs ADD COLUMN sheet_row INTEGER;

CREATE INDEX idx_oe_visit_logs_sheet_row ON oe_visit_logs (sheet_row);

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'oe_visit_logs'
ORDER BY ordinal_position;

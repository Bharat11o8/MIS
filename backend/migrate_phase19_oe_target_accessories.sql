-- AutoForm MIS — Phase 19: OE targets carry unattributed ACCESSORIES lines
--
-- The target workbook was reorganised: one tab per OEM, every OEM now split by
-- product, and ACCESSORIES booked two different ways.
--
--   • MAHINDRA / HYUNDAI / KIA give accessories their own block ("KIA ACC
--     (AMJ'26)") split across the same six salespeople — nothing new needed.
--   • MSIL and TATA put accessories on ONE row inside the seat-cover block,
--     between the people subtotal and the grand total. That number belongs to
--     the OEM, not to any salesperson. It is NOT a seventh salesperson.
--
-- So salesperson becomes NULLABLE: NULL means "this product line is not
-- attributed to anyone", which is the truth the sheet states. The alternative —
-- a sentinel name like 'ACCESSORIES' — would put a fake person into every
-- salesperson filter, ranking and per-head average, which is exactly the
-- misreading this migration exists to prevent.
--
-- Consequence downstream: SUM(by_salesperson) < SUM(all rows) whenever
-- unattributed lines are in scope. /oe-network/targets/summary therefore
-- returns those rows in their own "unattributed" bucket so the two still
-- reconcile on screen instead of silently disagreeing.
--
-- Before this change the parser stopped at the first TOTAL row, so the MSIL and
-- TATA accessories lines were never ingested at all and both OEMs under-reported
-- (MSIL AMJ'26: 32,095 target units instead of 42,614). Re-sync every registered
-- target sheet after running this.

-- ─── 1. salesperson may be absent ─────────────────────────────────────────────
ALTER TABLE oe_targets ALTER COLUMN salesperson DROP NOT NULL;

-- Product lines with no owner are read together often enough (and are the only
-- rows where salesperson IS NULL) to be worth their own partial index.
CREATE INDEX IF NOT EXISTS idx_oe_targets_unattributed
    ON oe_targets (fy_year, quarter, oem)
    WHERE salesperson IS NULL;

-- ─── 2. Verify ────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'oe_targets' AND column_name = 'salesperson';

-- After re-syncing, this should list MSIL/TATA ACC only:
SELECT oem, category, COUNT(*) AS rows, SUM(tgt_nos) AS tgt_nos
FROM oe_targets
WHERE salesperson IS NULL
GROUP BY oem, category
ORDER BY oem, category;

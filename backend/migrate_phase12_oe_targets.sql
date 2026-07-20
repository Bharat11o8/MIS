-- Phase 12 — OE Network: quarterly targets vs achievement
-- A third sheet type under the existing "oe_network" permission key:
--   • module 'oe_targets' — one spreadsheet per quarter. Each tab holds stacked
--     blocks (one per OEM/category), each block = header row + salespeople +
--     a TOTAL row. Blocks are found by header signature, never by tab name or
--     position, so a new OEM block needs no code change.
--
-- Quarter/FY are supplied at registration: the sheets carry month names in the
-- column headers but no year anywhere, and the quarter tag on block titles is
-- inconsistent ("TATA SC" has none while "MSIL AMJ" does).
--
-- Money is normalized to RUPEES here. The source mixes scales between tabs —
-- MSIL/TATA are full rupees, HYUNDAI/KIA/MAHINDRA are crores — with identical
-- column headers and no marker, so the parser detects the scale per block from
-- the implied unit price and records what it used in value_scale.

-- ─── 1. sheet_sources: quarter identity ──────────────────────────────────────
-- No new column needed: sheet_sources.quarter already exists as VARCHAR(2)
-- holding 'Q1'..'Q4' (Depot-to-Distributor uses it the same way), so OE targets
-- reuse it rather than introduce a second quarter column with a different type.
--
-- One target sheet per (FY year, quarter). calendar_year holds the FY START
-- year: FY26-27 => 2026, so Q4 (JFM) of it lands in calendar 2027.
CREATE UNIQUE INDEX idx_sheet_sources_oe_target_quarter
    ON sheet_sources (calendar_year, quarter)
    WHERE module = 'oe_targets';

-- ─── 2. Targets (one row per OEM × category × salesperson × month) ────────────
CREATE TABLE oe_targets (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    fy_year         INTEGER NOT NULL,          -- FY start year (2026 = FY26-27)
    quarter         INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    period_year     INTEGER NOT NULL,          -- calendar year of this month
    period_month    INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    oem             VARCHAR(50) NOT NULL,      -- from the block title, first word
    category        VARCHAR(30),               -- 'SC' | 'MAT' | as titled
    salesperson     VARCHAR(100) NOT NULL,
    region          VARCHAR(100),              -- column A carries "NAME- REGION"
    tgt_nos         NUMERIC(14, 2),
    tgt_value       NUMERIC(18, 2),            -- rupees, normalized at sync
    ach_nos         NUMERIC(14, 2),
    ach_value       NUMERIC(18, 2),            -- rupees, normalized at sync
    value_scale     VARCHAR(10),               -- 'rupees' | 'crores' — what the sheet used
    sync_log_id     UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_oe_targets_source ON oe_targets(sheet_source_id);
CREATE INDEX idx_oe_targets_period ON oe_targets(fy_year, quarter);
CREATE INDEX idx_oe_targets_month ON oe_targets(period_year, period_month);
CREATE INDEX idx_oe_targets_salesperson ON oe_targets(salesperson);
CREATE INDEX idx_oe_targets_oem ON oe_targets(oem);

-- ─── 3. Grants ────────────────────────────────────────────────────────────────
ALTER TABLE oe_targets OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE oe_targets TO mis_user;

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'oe_targets'
ORDER BY ordinal_position;

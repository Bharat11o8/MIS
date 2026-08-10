-- Phase 18 — OE Network: dealer OUTLETS become a real identity, with their
-- own sales history and targets.
--
-- Why: the module has been salesperson-centric. Leadership now wants it
-- dealer-centric (top/bottom 20, quarter-vs-quarter, per-dealer growth,
-- coverage, target vs achievement, car sales vs our sales). That needs a
-- dealer key every other table can hang off, and until now there wasn't one:
--
--   • oe_dealerships.city was NULL on all 1,523 rows and the unique index was
--     (oem, state, UPPER(name)), so the master physically could not hold two
--     outlets of one group. PREM MOTORS Narela and PREM MOTORS Wazirpur are
--     two dealers, not one.
--   • The OE team's own file ("Dealership view file.xlsx", MSIL tab) keys on
--     DEALER NAME + DEALER CITY: 335 distinct names across 403 distinct
--     name+city outlets, 38 names spanning 2–5 cities. Outlet is the grain
--     both sides must agree on.
--
-- One row of that file aggregates every MSIL code a group holds in that city
-- (Arena + Nexa + True Value — MY CAR PUNE carries 1907, 19NA, 1907191,
-- 1907192), so CHANNEL is NOT part of the key. We keep channel on the visit
-- log as detail, never as identity.

-- ─── 1. oe_dealerships becomes the outlet master ──────────────────────────────
ALTER TABLE oe_dealerships
    -- The rep this dealer is assigned to, per the OE team's own file. Not
    -- ownership — it is who handles them. Assignment can change; visit history
    -- keeps its own salesperson per row, so this is only ever "who has it now".
    ADD COLUMN IF NOT EXISTS salesperson  VARCHAR(100),
    -- The OEM's dealer codes for this outlet, comma-separated as supplied (up
    -- to 24 on one row). Kept verbatim for later joins against OEM-side data;
    -- we never parse them for identity.
    ADD COLUMN IF NOT EXISTS dealer_codes TEXT;

-- City joins the key. UPPER(COALESCE(city,'')) rather than plain city so the
-- OEMs whose dealer files have not arrived yet (TATA, HYUNDAI, KIA, MAHINDRA —
-- 1,155 rows, all city NULL) keep behaving exactly as they do today: they key
-- as '' and stay unique on (oem, state, name). This index is strictly more
-- permissive than the one it replaces, so nothing that fits today stops fitting.
DROP INDEX IF EXISTS idx_oe_dealerships_unique;
CREATE UNIQUE INDEX idx_oe_dealerships_unique
    ON oe_dealerships (oem, state, UPPER(name), UPPER(COALESCE(city, '')));

-- The form's dropdown now reads city too, and the Dealers tab looks dealers up
-- by outlet, so make that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_oe_dealerships_outlet
    ON oe_dealerships (oem, UPPER(name), UPPER(COALESCE(city, '')));

-- ─── 2. Visit logs point at the outlet they belong to ─────────────────────────
-- Resolved at sync by (oem, name, city). Nullable on purpose: a row that
-- cannot be resolved must stay visible and countable as an unresolved row,
-- never be dropped. ON DELETE SET NULL for the same reason.
ALTER TABLE oe_visit_logs
    ADD COLUMN IF NOT EXISTS dealer_id UUID REFERENCES oe_dealerships(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_oe_visit_logs_dealer ON oe_visit_logs (dealer_id, visit_date);

-- ─── 3. Per-dealer monthly sales ──────────────────────────────────────────────
-- The dealer file carries these as one column per month (JAN'26 … JULY'26 and
-- YSC JAN'26 … YSC JULY'26), which grows a column every month. We unpivot to
-- one row per dealer per month so that "quarter vs quarter", "growth of a
-- particular dealer" and an arbitrary date range are all just row filters.
--
-- car_sales = the dealer's own vehicle retails (their volume).
-- our_sales = our units at that dealer (the file's YSC columns).
-- Penetration is our_sales ÷ car_sales and is NEVER stored — storing it would
-- let it drift from its inputs, and it must be recomputed at whatever grain
-- it is asked for. Note the file's own AVG PENE is YSC TOTAL ÷ TOTAL, i.e.
-- ratio-of-sums, not the mean of monthly ratios. Match that when aggregating.
CREATE TABLE IF NOT EXISTS oe_dealer_monthly (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    dealer_id       UUID NOT NULL REFERENCES oe_dealerships(id) ON DELETE CASCADE,
    sheet_source_id UUID REFERENCES sheet_sources(id) ON DELETE CASCADE,
    month           DATE    NOT NULL,     -- always the 1st of the month
    car_sales       INTEGER,
    our_sales       INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oe_dealer_monthly_unique
    ON oe_dealer_monthly (dealer_id, month);
CREATE INDEX IF NOT EXISTS idx_oe_dealer_monthly_month  ON oe_dealer_monthly (month);
CREATE INDEX IF NOT EXISTS idx_oe_dealer_monthly_source ON oe_dealer_monthly (sheet_source_id);

-- ─── 4. Per-dealer quarterly targets ──────────────────────────────────────────
-- The file gives AMJ'26 TGT / AMJ'26 ACH / JAS'26 TGT. Quarters are the Indian
-- FY's: AMJ=Q1, JAS=Q2, OND=Q3, JFM=Q4, so fy_year is the year the FY STARTS
-- (AMJ'26 and JFM'27 both belong to fy_year 2026).
--
-- period_start/period_end are stored alongside the label because every filter
-- in this module is a date range; without them each query would have to
-- re-derive quarter boundaries. achievement is nullable — a quarter in progress
-- has a target and no achievement yet (JAS'26 today).
CREATE TABLE IF NOT EXISTS oe_dealer_targets (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    dealer_id       UUID NOT NULL REFERENCES oe_dealerships(id) ON DELETE CASCADE,
    sheet_source_id UUID REFERENCES sheet_sources(id) ON DELETE CASCADE,
    quarter         VARCHAR(2) NOT NULL,   -- 'Q1'..'Q4', matching sheet_sources.quarter
    fy_year         INTEGER    NOT NULL,
    period_start    DATE       NOT NULL,
    period_end      DATE       NOT NULL,
    target          INTEGER,
    achievement     INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oe_dealer_targets_unique
    ON oe_dealer_targets (dealer_id, fy_year, quarter);
CREATE INDEX IF NOT EXISTS idx_oe_dealer_targets_period ON oe_dealer_targets (period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_oe_dealer_targets_source ON oe_dealer_targets (sheet_source_id);

-- ─── Grants ───────────────────────────────────────────────────────────────────
ALTER TABLE oe_dealer_monthly OWNER TO mis_user;
ALTER TABLE oe_dealer_targets OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE oe_dealer_monthly TO mis_user;
GRANT ALL PRIVILEGES ON TABLE oe_dealer_targets TO mis_user;

-- Verify
SELECT 'oe_dealerships' AS t, column_name, data_type
FROM information_schema.columns WHERE table_name = 'oe_dealerships'
  AND column_name IN ('city', 'salesperson', 'dealer_codes')
UNION ALL
SELECT 'oe_visit_logs', column_name, data_type
FROM information_schema.columns WHERE table_name = 'oe_visit_logs'
  AND column_name = 'dealer_id'
UNION ALL
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('oe_dealer_monthly', 'oe_dealer_targets')
ORDER BY 1, 2;

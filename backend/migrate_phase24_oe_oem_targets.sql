-- Phase 24 — OE Network: the OEM-level target summary.
--
-- Source: "TGT SUMMARY SHEET ALL OEM 2026-27", one tab per OEM, one row per
-- product, and four columns per month (Qty/Value × Target/Actual) running the
-- whole financial year. It answers a question the existing oe_targets table
-- cannot: what did we commit to each BRAND for the year, and where are we
-- against it. oe_targets is the same money cut by SALESPERSON and published
-- one quarter at a time; the two are different commitments from different
-- files and must not be added together.
--
-- Four things about the source shape this schema exists to survive:
--
--   • Targets for all 12 months are published up front, actuals arrive month
--     by month. So ach_nos/ach_value are NULLABLE and a NULL means "not
--     published yet", never zero. The sheet's own quarter ACH columns say 0
--     for quarters that have not happened (OND'26 ACH QTY = 0 with every
--     underlying month blank), which is exactly the "absent arriving as 0" the
--     module forbids — so those columns are not ingested and every quarter is
--     summed from its months at read time.
--   • Annual and quarter TOTAL columns are all exactly the sum of their
--     months (verified across all five tabs), so storing them would only give
--     them room to drift. Not ingested either.
--   • Money scale is mixed WITHIN a tab, not just between tabs: MSIL months
--     are rupees while its quarter totals are crores, and TATA's Apr–Jun
--     ACTUAL value is crores while its Apr–Jun TARGET value in the very same
--     row is rupees. Values are normalised to rupees at sync and the detected
--     scale is kept per figure, so a wrong guess is auditable rather than
--     invisible.
--   • Quantities are fractional (HYUNDAI seat covers: 59896.49 for the year),
--     so nos is NUMERIC. INTEGER would round every one of them, which is the
--     Phase 22 mistake on the dealer targets.

-- ─── 1. Registry ──────────────────────────────────────────────────────────────
-- One workbook per financial year, so the FY start year is the identity:
-- 2026 = FY26-27. Partial index rather than a table-wide constraint, matching
-- how the other three OE sheet types register.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheet_sources_oe_oem_targets
    ON sheet_sources (calendar_year)
    WHERE module = 'oe_oem_targets';

-- ─── 2. One row per OEM × product × month ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS oe_oem_targets (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    fy_year         INTEGER NOT NULL,          -- FY start year (2026 = FY26-27)
    period_year     INTEGER NOT NULL,          -- calendar year of this month
    period_month    INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    -- Derived from the month (Apr–Jun = 1), stored so quarter grouping is a
    -- plain GROUP BY instead of a CASE repeated in every query. Jan–Mar of
    -- FY26-27 are quarter 4 and calendar year 2027.
    quarter         INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    oem             VARCHAR(50)  NOT NULL,     -- the tab name, verbatim
    -- Column A as that tab spells it ("Docket + Accessories", "SEAT COVERS
    -- (PASSANGER)"). Kept verbatim because it is the only place the sheet
    -- names the product, and MAHINDRA's commercial/passenger seat-cover split
    -- exists in no other OE table.
    product         VARCHAR(120) NOT NULL,
    -- A coarse bucket over `product` so the tab can compare like with like
    -- across OEMs: 'SC' | 'MAT' | 'ACC' | 'STEERING' | 'OTHER'. Never the
    -- filter's display label — that stays `product`.
    product_key     VARCHAR(20),
    tgt_nos         NUMERIC(14, 2),
    tgt_value       NUMERIC(18, 2),            -- rupees, normalised at sync
    ach_nos         NUMERIC(14, 2),            -- NULL = month not published yet
    ach_value       NUMERIC(18, 2),            -- rupees, normalised at sync
    -- What the sheet's own column used ('rupees' | 'crores'), kept separately
    -- for the two because one row can genuinely mix them. NULL when the column
    -- held nothing to gauge.
    tgt_value_scale VARCHAR(10),
    ach_value_scale VARCHAR(10),
    sync_log_id     UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Identity is the sheet's own grain. A tab that repeats a product row is a
-- source error we want to hear about at sync, not silently double.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oe_oem_targets_unique
    ON oe_oem_targets (sheet_source_id, oem, UPPER(product), period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_oe_oem_targets_source  ON oe_oem_targets (sheet_source_id);
CREATE INDEX IF NOT EXISTS idx_oe_oem_targets_period  ON oe_oem_targets (period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_oe_oem_targets_fy      ON oe_oem_targets (fy_year, quarter);
CREATE INDEX IF NOT EXISTS idx_oe_oem_targets_oem     ON oe_oem_targets (oem);

-- ─── 3. Last year's actuals, which are NOT monthly ────────────────────────────
-- The sheet's "25~26 Qty / Value" pair is a single full-year figure per
-- product. It gets its own table rather than a column on the month rows
-- precisely because it has no month: copied onto all twelve it would sum to
-- twelve times last year the first time anyone grouped by OEM, and that
-- mistake would look like a plausible number rather than a crash.
CREATE TABLE IF NOT EXISTS oe_oem_target_annual (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    fy_year         INTEGER NOT NULL,          -- the FY of the SHEET (2026), not of the figure
    oem             VARCHAR(50)  NOT NULL,
    product         VARCHAR(120) NOT NULL,
    product_key     VARCHAR(20),
    py_nos          NUMERIC(14, 2),            -- prior FY actual units
    py_value        NUMERIC(18, 2),            -- prior FY actual, rupees
    py_value_scale  VARCHAR(10),
    sync_log_id     UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oe_oem_target_annual_unique
    ON oe_oem_target_annual (sheet_source_id, oem, UPPER(product));
CREATE INDEX IF NOT EXISTS idx_oe_oem_target_annual_source ON oe_oem_target_annual (sheet_source_id);

-- ─── 4. Grants ────────────────────────────────────────────────────────────────
ALTER TABLE oe_oem_targets       OWNER TO mis_user;
ALTER TABLE oe_oem_target_annual OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE oe_oem_targets       TO mis_user;
GRANT ALL PRIVILEGES ON TABLE oe_oem_target_annual TO mis_user;

-- Verify
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name IN ('oe_oem_targets', 'oe_oem_target_annual')
ORDER BY table_name, ordinal_position;

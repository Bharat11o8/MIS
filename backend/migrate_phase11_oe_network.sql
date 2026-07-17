-- Phase 11 — OE Network Sales module
-- Two sheet types under one nav module ("oe_network" permission key):
--   • module 'oe_visit_plan' — one sheet per calendar month (6 salesperson tabs,
--     detected by header signature, never by tab name). Month/year are supplied
--     at registration because tab titles carry neither.
--   • module 'oe_log_book'   — one continuous Google-Form responses sheet
--     spanning months (and, until told otherwise, years).

-- ─── 1. sheet_sources: month identity for monthly-scoped sheets ───────────────
ALTER TABLE sheet_sources ADD COLUMN month INTEGER
    CHECK (month IS NULL OR month BETWEEN 1 AND 12);

-- One visit-plan sheet per (year, month) — OE visit plans only.
CREATE UNIQUE INDEX idx_sheet_sources_oe_plan_month
    ON sheet_sources (calendar_year, month)
    WHERE module = 'oe_visit_plan';

-- ─── 2. Visit plans (one row per planned dealer visit) ───────────────────────
CREATE TABLE oe_visit_plans (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    salesperson     VARCHAR(100) NOT NULL,
    visit_date      DATE,                    -- nullable: source dates are hand-typed and sometimes unparseable
    plan_year       INTEGER NOT NULL,        -- from the sheet registration, not the row
    plan_month      INTEGER NOT NULL,
    oem             VARCHAR(50),
    dealer_name     VARCHAR(200) NOT NULL,
    city            VARCHAR(100),
    state           VARCHAR(100),
    sync_log_id     UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_oe_plans_source ON oe_visit_plans(sheet_source_id);
CREATE INDEX idx_oe_plans_period ON oe_visit_plans(plan_year, plan_month);
CREATE INDEX idx_oe_plans_salesperson ON oe_visit_plans(salesperson);

-- ─── 3. Visit logs (one row per form submission) ──────────────────────────────
CREATE TABLE oe_visit_logs (
    id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id   UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    visit_date        DATE NOT NULL,
    log_year          INTEGER NOT NULL,      -- derived from visit_date, denormalized for filtering
    log_month         INTEGER NOT NULL,
    salesperson       VARCHAR(100),
    contact_mode      VARCHAR(30),           -- 'Visit' | 'Calling' (as the form defines them)
    oem               VARCHAR(50),
    dealership        VARCHAR(200) NOT NULL,
    address           VARCHAR(255),
    designation       VARCHAR(100),
    -- Dealer's own monthly figures reported during the visit (units) — NOT our
    -- sales to them. Never SUM these across rows; aggregate as averages.
    car_sales         NUMERIC(12, 2),
    seat_cover_sales  NUMERIC(12, 2),
    mats_sales        NUMERIC(12, 2),
    remarks           TEXT,
    city              VARCHAR(100),
    state             VARCHAR(100),          -- normalized at sync (UP → Uttar Pradesh etc.)
    sync_log_id       UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_oe_logs_source ON oe_visit_logs(sheet_source_id);
CREATE INDEX idx_oe_logs_period ON oe_visit_logs(log_year, log_month);
CREATE INDEX idx_oe_logs_salesperson ON oe_visit_logs(salesperson);

-- ─── 4. Grants ────────────────────────────────────────────────────────────────
ALTER TABLE oe_visit_plans OWNER TO mis_user;
ALTER TABLE oe_visit_logs OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE oe_visit_plans TO mis_user;
GRANT ALL PRIVILEGES ON TABLE oe_visit_logs TO mis_user;

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name IN ('oe_visit_plans', 'oe_visit_logs')
ORDER BY table_name, ordinal_position;

-- AutoForm MIS — Phase 8 Migration: Finance (Balance Sheet + P&L)
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase8_finance.sql
--
-- Reuses sheet_sources (module='finance', label=company name, calendar_year stays
-- NULL — periods are self-describing from the sheet's own headers) and sync_logs
-- unchanged. Two new fact tables, one per statement.

-- ─── 1. Balance Sheet lines (point-in-time "stock" figures) ─────────────────
CREATE TABLE balance_sheet_lines (
    id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id   UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    tab_title         VARCHAR(100) NOT NULL,
    section           VARCHAR(30)  NOT NULL CHECK (section IN ('sources_of_funds','application_of_funds')),
    entity_type       VARCHAR(20)  NOT NULL CHECK (entity_type IN ('line_item','detail','total')),
    item_no           INTEGER,
    line_key          VARCHAR(80)  NOT NULL,
    line_label        VARCHAR(150) NOT NULL,
    parent_key        VARCHAR(80),
    period_end_date   DATE NOT NULL,
    amount            NUMERIC(16,2) NOT NULL,
    percent           DOUBLE PRECISION,
    sync_log_id       UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (sheet_source_id, line_key, period_end_date)
);

-- ─── 2. Profit & Loss lines (period "flow" figures) ─────────────────────────
CREATE TABLE profit_loss_lines (
    id                 UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id    UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    tab_title          VARCHAR(100) NOT NULL,
    section            VARCHAR(30)  NOT NULL CHECK (section IN ('trading_account','income_statement')),
    entity_type        VARCHAR(20)  NOT NULL CHECK (entity_type IN ('line_item','detail','subtotal','total')),
    item_no            INTEGER,
    line_key           VARCHAR(80)  NOT NULL,
    line_label         VARCHAR(150) NOT NULL,
    parent_key         VARCHAR(80),
    period_start_date  DATE NOT NULL,
    period_end_date    DATE NOT NULL,
    period_type        VARCHAR(10)  NOT NULL CHECK (period_type IN ('monthly','annual')),
    amount             NUMERIC(16,2) NOT NULL,
    percent            DOUBLE PRECISION,
    sync_log_id        UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (sheet_source_id, line_key, period_start_date, period_end_date)
);

-- ─── 3. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX idx_bsl_sheet_source ON balance_sheet_lines(sheet_source_id);
CREATE INDEX idx_bsl_period       ON balance_sheet_lines(sheet_source_id, period_end_date);
CREATE INDEX idx_bsl_section      ON balance_sheet_lines(sheet_source_id, section);
CREATE INDEX idx_pll_sheet_source ON profit_loss_lines(sheet_source_id);
CREATE INDEX idx_pll_period       ON profit_loss_lines(sheet_source_id, period_end_date, period_type);
CREATE INDEX idx_pll_section      ON profit_loss_lines(sheet_source_id, section);

-- ─── 4. Ownership + grants ────────────────────────────────────────────────────
ALTER TABLE balance_sheet_lines OWNER TO mis_user;
ALTER TABLE profit_loss_lines   OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE balance_sheet_lines TO mis_user;
GRANT ALL PRIVILEGES ON TABLE profit_loss_lines   TO mis_user;

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('balance_sheet_lines','profit_loss_lines');

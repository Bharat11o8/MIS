-- AutoForm MIS — Phase 9 Migration: Finance v2 (whole-sheet, 14 sections, monthly+yearly)
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase9_finance_v2.sql
--
-- The finance team replaced the old Tally-style export with a new hand-built
-- 14-section template, delivered as a monthly sheet (FY26 on, columns grow over
-- time) and a single yearly sheet (FY history). One generic fact table replaces
-- the phase-8 balance_sheet_lines / profit_loss_lines split — the new sections
-- (ratios, units, aging, stock audit, …) don't fit a two-statement model. The
-- old tables are left in place, unused, and dropped in a later cleanup once v2
-- is verified live.
--
-- sheet_sources (module='finance', calendar_year stays NULL — periods are
-- self-describing from the sheet's own header row) and sync_logs are unchanged.

-- ─── Generic finance fact table ─────────────────────────────────────────────
CREATE TABLE finance_lines (
    id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id   UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    tab_title         VARCHAR(100) NOT NULL,
    cadence           VARCHAR(10)  NOT NULL CHECK (cadence IN ('monthly','yearly')),
    section_key       VARCHAR(50)  NOT NULL,   -- slug of the col-B section title
    section_label     VARCHAR(150) NOT NULL,
    sub_section       VARCHAR(50),             -- e.g. sources_of_funds, current_assets, current_liabilities
    entity_type       VARCHAR(20)  NOT NULL CHECK (entity_type IN ('header','line_item','detail','total','subtotal')),
    item_no           INTEGER,                 -- positional ordinal within the section (preserves sheet order)
    line_key          VARCHAR(120) NOT NULL,   -- section_key[/sub_section]/slug(label)
    line_label        VARCHAR(200) NOT NULL,
    parent_key        VARCHAR(120),
    period_start_date DATE NOT NULL,           -- first day of month / FY (Apr 1)
    period_end_date   DATE NOT NULL,           -- last day of month / FY (Mar 31)
    period_type       VARCHAR(10)  NOT NULL CHECK (period_type IN ('monthly','annual')),
    amount            NUMERIC(18,2),           -- nullable: empty-shell rows / ratio placeholders
    percent           DOUBLE PRECISION,
    metrics           JSONB,                   -- multi-metric ops rows (alteration/stock-audit) & ratios (Phase B)
    sync_log_id       UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (sheet_source_id, line_key, period_start_date, period_end_date)
);

CREATE INDEX idx_fl_sheet_source   ON finance_lines(sheet_source_id);
CREATE INDEX idx_fl_source_section ON finance_lines(sheet_source_id, section_key);
CREATE INDEX idx_fl_period         ON finance_lines(sheet_source_id, period_end_date, period_type);

ALTER TABLE finance_lines OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE finance_lines TO mis_user;

-- Verify
SELECT table_name FROM information_schema.tables WHERE table_name = 'finance_lines';

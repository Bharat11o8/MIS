-- AutoForm MIS — Phase 5 Migration: Sales (Depot to Distributor)
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase5_distributor_sales.sql

-- ─── 1. Sheet registry (generic across future Google-Sheet-backed modules) ───
CREATE TABLE sheet_sources (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    module        VARCHAR(50) NOT NULL,
    sheet_id      VARCHAR(100) NOT NULL,
    label         VARCHAR(100) NOT NULL,
    calendar_year INTEGER NOT NULL CHECK (calendar_year BETWEEN 2020 AND 2100),
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (module, sheet_id)
);

-- ─── 2. Depot-to-Distributor sales (one row per quarter-sheet/distributor/month/category) ───
CREATE TABLE distributor_sales (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sheet_source_id UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    entity_type     VARCHAR(20) NOT NULL CHECK (entity_type IN ('distributor','depot_direct')),
    distributor     VARCHAR(150) NOT NULL,
    area_head       VARCHAR(100),
    target          NUMERIC(14,2),
    sale_year       INTEGER NOT NULL CHECK (sale_year BETWEEN 2020 AND 2100),
    sale_month      INTEGER NOT NULL CHECK (sale_month BETWEEN 1 AND 12),
    category        VARCHAR(10) NOT NULL CHECK (category IN ('SAM','EV')),
    amount          NUMERIC(14,2) NOT NULL,
    sync_log_id     UUID REFERENCES sync_logs(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 3. Indexes ──────────────────────────────────────────
CREATE INDEX idx_dist_sales_sheet_source ON distributor_sales(sheet_source_id);
CREATE INDEX idx_dist_sales_year_month   ON distributor_sales(sale_year, sale_month);
CREATE INDEX idx_dist_sales_distributor  ON distributor_sales(distributor);
CREATE INDEX idx_dist_sales_area_head    ON distributor_sales(area_head);
CREATE INDEX idx_sheet_sources_module    ON sheet_sources(module);

-- ─── 4. Ownership + grants ───────────────────────────────
ALTER TABLE sheet_sources OWNER TO mis_user;
ALTER TABLE distributor_sales OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE sheet_sources TO mis_user;
GRANT ALL PRIVILEGES ON TABLE distributor_sales TO mis_user;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'distributor_sales'
ORDER BY ordinal_position;

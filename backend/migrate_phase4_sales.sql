-- AutoForm MIS — Phase 4 Migration: Sales (Plant to Depot)
-- Run as postgres superuser: psql -U postgres -d autoform_mis -f migrate_phase4_sales.sql

-- ─── 1. Drop dead scaffolding ────────────────────────────
DROP TABLE IF EXISTS sales_dispatches CASCADE;

-- ─── 2. Plant-to-Depot sales (one row per month/depot/brand/category) ───
CREATE TABLE plant_to_depot_sales (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sale_year     INTEGER NOT NULL CHECK (sale_year BETWEEN 2020 AND 2100),
    sale_month    INTEGER NOT NULL CHECK (sale_month BETWEEN 1 AND 12),
    depot         VARCHAR(50) NOT NULL CHECK (depot IN ('Janak Motors','United Auto')),
    brand         VARCHAR(20) NOT NULL CHECK (brand IN ('Autoform','Autocruze','Combined')),
    category      VARCHAR(30) NOT NULL CHECK (category IN ('Seat Cover','Accessories','Mats','Boot & Cabin Mat','Electronics')),
    qty           NUMERIC(12,2),
    rate          NUMERIC(12,2),
    amount        NUMERIC(14,2) NOT NULL,
    sync_log_id   UUID,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (sale_year, sale_month, depot, brand, category)
);

-- ─── 3. Sync logs (manual "Sync Now" runs) ───────────────
CREATE TABLE sync_logs (
    id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    module         VARCHAR(50) NOT NULL DEFAULT 'sales_plant_to_depot',
    source_label   VARCHAR(255),
    rows_total     INTEGER DEFAULT 0,
    rows_inserted  INTEGER DEFAULT 0,
    rows_updated   INTEGER DEFAULT 0,
    rows_failed    INTEGER DEFAULT 0,
    status         VARCHAR(30) DEFAULT 'Processing',
    error_details  TEXT,
    synced_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    synced_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE plant_to_depot_sales
  ADD CONSTRAINT plant_to_depot_sales_sync_log_id_fkey
  FOREIGN KEY (sync_log_id) REFERENCES sync_logs(id) ON DELETE SET NULL;

-- ─── 4. Indexes ──────────────────────────────────────────
CREATE INDEX idx_p2d_year_month ON plant_to_depot_sales(sale_year, sale_month);
CREATE INDEX idx_p2d_depot      ON plant_to_depot_sales(depot);
CREATE INDEX idx_p2d_category   ON plant_to_depot_sales(category);

-- ─── 5. Ownership + grants ───────────────────────────────
ALTER TABLE plant_to_depot_sales OWNER TO mis_user;
ALTER TABLE sync_logs OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE plant_to_depot_sales TO mis_user;
GRANT ALL PRIVILEGES ON TABLE sync_logs TO mis_user;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'plant_to_depot_sales'
ORDER BY ordinal_position;

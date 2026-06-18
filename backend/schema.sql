-- AutoForm MIS — Database Schema
-- Run this file against the autoform_mis database

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Grant schema permissions to mis_user
GRANT ALL ON SCHEMA public TO mis_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO mis_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO mis_user;

-- ─── Users & Auth ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(150) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          VARCHAR(50) NOT NULL CHECK (role IN ('superadmin','management','sales_head','leads_head','staff')),
    department    VARCHAR(100),
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Sales (Plant to Depot) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_dispatches (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    invoice_no      VARCHAR(50) UNIQUE NOT NULL,
    dispatch_date   DATE NOT NULL,
    plant_name      VARCHAR(100) NOT NULL,
    depot_name      VARCHAR(100) NOT NULL,
    sku             VARCHAR(100) NOT NULL,
    product_name    VARCHAR(200),
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    vehicle_no      VARCHAR(30),
    driver_name     VARCHAR(100),
    status          VARCHAR(30) DEFAULT 'Pending' CHECK (status IN ('Pending','In Transit','Delivered','Cancelled')),
    remarks         TEXT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Leads ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
    id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    lead_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    source           VARCHAR(50) NOT NULL CHECK (source IN ('IVR','WhatsApp','Instagram','Other')),
    name             VARCHAR(100) NOT NULL,
    phone            VARCHAR(20),
    city             VARCHAR(100),
    state            VARCHAR(100),
    product_interest VARCHAR(200),
    status           VARCHAR(30) DEFAULT 'New' CHECK (status IN ('New','Contacted','Interested','Converted','Lost')),
    assigned_to      UUID REFERENCES users(id) ON DELETE SET NULL,
    remarks          TEXT,
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Upload Logs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS upload_logs (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    module        VARCHAR(50) NOT NULL,
    filename      VARCHAR(255) NOT NULL,
    rows_total    INTEGER DEFAULT 0,
    rows_success  INTEGER DEFAULT 0,
    rows_failed   INTEGER DEFAULT 0,
    status        VARCHAR(30) DEFAULT 'Processing',
    error_details TEXT,
    uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Performance Indexes ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sales_depot    ON sales_dispatches(depot_name);
CREATE INDEX IF NOT EXISTS idx_sales_plant    ON sales_dispatches(plant_name);
CREATE INDEX IF NOT EXISTS idx_sales_date     ON sales_dispatches(dispatch_date);
CREATE INDEX IF NOT EXISTS idx_sales_status   ON sales_dispatches(status);
CREATE INDEX IF NOT EXISTS idx_leads_source   ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_date     ON leads(lead_date);
CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_city     ON leads(city);

-- ─── Seed: Default superadmin ────────────────────────────────────
-- Password: admin123 (bcrypt hash)
INSERT INTO users (name, email, password_hash, role)
VALUES (
    'Super Admin',
    'admin@autoformindia.com',
    '$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW',
    'superadmin'
)
ON CONFLICT (email) DO NOTHING;

-- Verify tables created
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

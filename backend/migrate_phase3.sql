-- AutoForm MIS — Phase 3 Migration
-- Run as postgres superuser: psql -U postgres -d autoform_mis -f migrate_phase3.sql

-- ─── 1. Transfer ownership to mis_user so ALTER works ───
ALTER TABLE users OWNER TO mis_user;
ALTER TABLE sales_dispatches OWNER TO mis_user;
ALTER TABLE upload_logs OWNER TO mis_user;
ALTER TABLE leads OWNER TO mis_user;

-- ─── 2. Users — add must_change_password & created_by ───
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- ─── 3. Users — add sales_rep to role check ─────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('superadmin','management','sales_head','leads_head','sales_rep','staff'));

-- ─── 4. Drop and recreate leads table (currently empty) ─
DROP TABLE IF EXISTS leads CASCADE;

CREATE TABLE leads (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    lead_date       DATE NOT NULL,
    source          VARCHAR(30) NOT NULL,
    customer_name   VARCHAR(200),
    mobile_number   VARCHAR(20),
    car_type        VARCHAR(100),
    product_type    VARCHAR(200),
    location        VARCHAR(200),
    state           VARCHAR(100),
    call_status     VARCHAR(50),
    reason          TEXT,
    reason_category VARCHAR(50),
    assigned_asm    VARCHAR(100),
    review_status   VARCHAR(50),
    review_reason   TEXT,
    upload_log_id   UUID REFERENCES upload_logs(id) ON DELETE SET NULL,
    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 5. Indexes ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leads_source        ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_date          ON leads(lead_date);
CREATE INDEX IF NOT EXISTS idx_leads_call_status   ON leads(call_status);
CREATE INDEX IF NOT EXISTS idx_leads_review_status ON leads(review_status);
CREATE INDEX IF NOT EXISTS idx_leads_state         ON leads(state);
CREATE INDEX IF NOT EXISTS idx_leads_asm           ON leads(assigned_asm);
CREATE INDEX IF NOT EXISTS idx_leads_uploaded_by   ON leads(uploaded_by);

-- ─── 6. Grant permissions to mis_user ────────────────────
GRANT ALL PRIVILEGES ON TABLE leads TO mis_user;
GRANT ALL PRIVILEGES ON TABLE users TO mis_user;
GRANT ALL PRIVILEGES ON TABLE upload_logs TO mis_user;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'leads'
ORDER BY ordinal_position;

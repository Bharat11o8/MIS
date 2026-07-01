-- AutoForm MIS — Phase 7 Migration: Per-User Module & Sheet-Source Access
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase7_permissions.sql
--
-- Replaces role-based module gating (superadmin/management/sales_head/...) with
-- per-user toggles. Two tables:
--   1. user_module_access      — which top-level modules (sales/leads/finance) a user can see
--   2. user_sheet_source_access — which specific sheet_sources rows (e.g. Finance companies)
--                                  a user can see within a module, generalized beyond Finance
-- Superadmin always bypasses both checks in application code (never needs explicit rows,
-- but gets them anyway below for UI-display consistency in the new access-toggle screen).

-- ─── 1. Module access ────────────────────────────────────────────────────────
CREATE TABLE user_module_access (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module      VARCHAR(50) NOT NULL,
    granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    granted_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, module)
);

-- ─── 2. Per-record-source access (generalized beyond Finance) ───────────────
CREATE TABLE user_sheet_source_access (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sheet_source_id UUID NOT NULL REFERENCES sheet_sources(id) ON DELETE CASCADE,
    granted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    granted_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, sheet_source_id)
);

-- ─── 3. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX idx_user_module_access_user       ON user_module_access(user_id);
CREATE INDEX idx_user_module_access_module     ON user_module_access(module);
CREATE INDEX idx_user_sheet_source_access_user ON user_sheet_source_access(user_id);
CREATE INDEX idx_user_sheet_source_access_sid  ON user_sheet_source_access(sheet_source_id);

-- ─── 4. Backfill so existing users aren't locked out ─────────────────────────

-- SALES — exact match of sales.py / distributor_sales.py's current ALLOWED_ROLES
INSERT INTO user_module_access (user_id, module)
SELECT id, 'sales' FROM users WHERE role IN ('superadmin','management','sales_head')
ON CONFLICT DO NOTHING;

-- LEADS — leads.py has NO server-side role gate today (any authenticated user can
-- already call every /leads/* endpoint; apply_user_scope only restricts row-visibility
-- to own uploads). Backfilling to all users preserves exactly this existing behavior.
INSERT INTO user_module_access (user_id, module)
SELECT id, 'leads' FROM users
ON CONFLICT DO NOTHING;

-- FINANCE — brand new, never shipped under role gating. Only superadmin gets a row.
-- management/sales_head do NOT auto-get finance — that's the point of this feature.
INSERT INTO user_module_access (user_id, module)
SELECT id, 'finance' FROM users WHERE role = 'superadmin'
ON CONFLICT DO NOTHING;

-- ─── 5. Ownership + grants ────────────────────────────────────────────────────
ALTER TABLE user_module_access OWNER TO mis_user;
ALTER TABLE user_sheet_source_access OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE user_module_access TO mis_user;
GRANT ALL PRIVILEGES ON TABLE user_sheet_source_access TO mis_user;

-- Verify
SELECT module, COUNT(*) FROM user_module_access GROUP BY module;

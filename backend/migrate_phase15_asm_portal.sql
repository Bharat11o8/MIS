-- Phase 15 — ASM self-service portal (read-only, own data only)
-- ASMs need to see and export their own visit-log rows without any of the main
-- MIS login/roles/permissions machinery — they are not MIS users, just field
-- reps checking their own submissions. This is a separate, lightweight,
-- OTP-only login: email in, 6-digit OTP out, a short-lived scoped token back.
-- No password ever exists for this flow, and the token this issues cannot
-- reach any other route in the app (routers/asm_portal.py checks a "scope"
-- claim, not a users-table row).
--
-- Identity is resolved by matching the login email against the ASM email map
-- already used by the visit-log form (SALESPERSON_EMAILS in
-- VisitLogFormPage.tsx) — kept in sync here rather than hardcoded twice, so
-- adding/removing an ASM is one place, not two.

CREATE TABLE asm_portal_users (
    id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    email        VARCHAR(150) NOT NULL UNIQUE,
    salesperson  VARCHAR(100) NOT NULL,   -- must match oe_visit_logs.salesperson exactly (upper-cased)
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE asm_portal_otps (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    email       VARCHAR(150) NOT NULL,
    otp         VARCHAR(6) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_asm_portal_otps_email ON asm_portal_otps (email, created_at DESC);

-- ─── Grants ───────────────────────────────────────────────────────────────────
ALTER TABLE asm_portal_users OWNER TO mis_user;
ALTER TABLE asm_portal_otps  OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE asm_portal_users TO mis_user;
GRANT ALL PRIVILEGES ON TABLE asm_portal_otps  TO mis_user;

-- Verify
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'asm_portal_users' ORDER BY ordinal_position;
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'asm_portal_otps' ORDER BY ordinal_position;

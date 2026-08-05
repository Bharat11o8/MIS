-- =====================================================================
-- AutoForm MIS — Phase 18: AI Chatbot database security layer
--
-- Creates the read-only `mis_chatbot` role used by the chat feature, and
-- enables row-level security so a free-text SQL tool cannot read rows the
-- asking user isn't entitled to. See AI_CHATBOT_PLAN.md §5.
--
-- Apply on the VPS (per DEPLOYMENT.md §6):
--   sudo -u postgres psql -d autoform_mis -f /home/deploy/MIS/backend/migrate_phase18_chatbot.sql
--
-- MUST run as `postgres`. Verified 2026-08-05: mis_user has CREATEROLE = false,
-- so it cannot execute the CREATE ROLE below. Running this over the local
-- SSH tunnel (which connects as mis_user) will abort — harmlessly, since
-- everything is in one transaction, but it will not apply.
--
-- BEFORE RUNNING: replace __CHANGE_ME__ below with a real password, and put
-- the same value in the backend .env as CHATBOT_DATABASE_URL.
--
-- This migration is idempotent and runs in a single transaction — if any
-- statement fails, nothing is applied.
--
-- Verified state of the target database, 2026-08-05 (PostgreSQL 18.4):
--   * mis_user OWNS all 18 public tables, and is NOT superuser/BYPASSRLS.
--   * No table has RLS enabled; no policies exist anywhere.
--   * Roles present: mis_user, postgres. mis_chatbot does not yet exist.
-- =====================================================================

BEGIN;

-- ENABLE ROW LEVEL SECURITY takes a brief ACCESS EXCLUSIVE lock per table.
-- On a live database, fail fast rather than queue behind a long-running
-- query and block application traffic behind us. If this aborts with
-- "canceling statement due to lock timeout", simply re-run it — the
-- migration is idempotent.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- 0. Pre-flight assertions
--
-- The app role must exist before we grant it a bypass policy (see §2).
-- Aborting here is far preferable to enabling RLS and locking the app out.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mis_user') THEN
        RAISE EXCEPTION
            'Role "mis_user" not found. This migration grants it an explicit '
            'RLS bypass policy; without it the application would read zero rows. '
            'Check the app role name in backend/.env DATABASE_URL and edit this file.';
    END IF;
END
$$;


-- ---------------------------------------------------------------------
-- 1. The chatbot role
--
-- Read-only at the role level: default_transaction_read_only makes every
-- transaction it opens read-only regardless of the SQL sent, so a write
-- fails at the database even if it slips past the application-side guard.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mis_chatbot') THEN
        CREATE ROLE mis_chatbot LOGIN PASSWORD '__CHANGE_ME__'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

ALTER ROLE mis_chatbot SET default_transaction_read_only = on;
ALTER ROLE mis_chatbot SET statement_timeout = '15s';
ALTER ROLE mis_chatbot SET idle_in_transaction_session_timeout = '30s';

-- Schema access, but no object creation.
GRANT USAGE ON SCHEMA public TO mis_chatbot;
REVOKE CREATE ON SCHEMA public FROM mis_chatbot;

-- Explicit allowlist. Anything not named here is unreadable — in particular
-- users, asm_portal_users, asm_portal_otps, user_module_access and
-- user_sheet_source_access are deliberately absent (AI_CHATBOT_PLAN.md §6).
GRANT SELECT ON
    leads,
    upload_logs,
    plant_to_depot_sales,
    distributor_sales,
    sheet_sources,
    sync_logs,
    finance_lines,
    balance_sheet_lines,
    profit_loss_lines,
    oe_visit_plans,
    oe_visit_logs,
    oe_targets,
    oe_dealerships
TO mis_chatbot;


-- ---------------------------------------------------------------------
-- 2. Row-level security
--
-- IMPORTANT — why every table gets an explicit `app_full_access` policy
-- for mis_user:
--
-- Postgres exempts a table's OWNER from RLS. Verification on 2026-08-05
-- confirmed mis_user owns all 18 public tables, so it would bypass these
-- policies anyway and the app is safe either way.
--
-- The policy is kept deliberately, as defence against a future change:
-- if ownership ever moves (a table rebuilt by a migration run as postgres,
-- a restore from a dump taken by another role, or FORCE ROW LEVEL SECURITY
-- being switched on), mis_user would silently start reading ZERO rows
-- across the whole MIS. The explicit policy makes that failure impossible
-- rather than merely unlikely. It costs nothing.
--
-- ⚠️ OPERATIONAL FOOTGUN: because mis_user owns these tables and therefore
-- bypasses RLS, pointing the chat feature at DATABASE_URL (mis_user)
-- instead of CHATBOT_DATABASE_URL (mis_chatbot) would silently disable all
-- per-user scoping — every user would see every company's data, with no
-- error. The chat router must assert on startup that its connection is
-- mis_chatbot: `SELECT current_user` and refuse to serve otherwise.
--
-- Policies are permissive and OR'd, but each names a single role in its
-- TO clause, so the two policies never interact: mis_user matches only
-- app_full_access, mis_chatbot matches only chatbot_scope.
--
-- Any *other* non-superuser role gets no matching policy and therefore
-- sees nothing. That is intended — it fails closed.
-- ---------------------------------------------------------------------

-- 2a. Tables scoped by sheet_source_id.
--
-- The allowed IDs arrive as a comma-separated GUC set per transaction by
-- the chat router (SET LOCAL app.sheet_sources = '...'), sourced from
-- services/permissions.py:get_user_sheet_source_ids().
--
-- If the GUC is unset, current_setting(..., true) returns NULL, the ANY()
-- comparison yields NULL, and no rows are visible. Fail-closed by default:
-- forgetting to set the GUC returns nothing rather than everything.
DO $$
DECLARE
    t text;
    scoped_tables text[] := ARRAY[
        'plant_to_depot_sales',
        'distributor_sales',
        'finance_lines',
        'balance_sheet_lines',
        'profit_loss_lines',
        'oe_visit_plans',
        'oe_visit_logs',
        'oe_targets'
    ];
BEGIN
    FOREACH t IN ARRAY scoped_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

        EXECUTE format('DROP POLICY IF EXISTS app_full_access ON %I', t);
        EXECUTE format(
            'CREATE POLICY app_full_access ON %I FOR ALL TO mis_user '
            'USING (true) WITH CHECK (true)', t);

        EXECUTE format('DROP POLICY IF EXISTS chatbot_scope ON %I', t);
        EXECUTE format(
            'CREATE POLICY chatbot_scope ON %I FOR SELECT TO mis_chatbot '
            'USING (sheet_source_id::text = ANY (string_to_array('
            '    current_setting(''app.sheet_sources'', true), '','')))', t);
    END LOOP;
END
$$;


-- 2b. sheet_sources — scoped on its own primary key.
-- The chatbot needs this table to resolve company labels and sheet metadata,
-- but must only see the sources the user has been granted.
ALTER TABLE sheet_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_full_access ON sheet_sources;
CREATE POLICY app_full_access ON sheet_sources FOR ALL TO mis_user
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS chatbot_scope ON sheet_sources;
CREATE POLICY chatbot_scope ON sheet_sources FOR SELECT TO mis_chatbot
    USING (id::text = ANY (string_to_array(current_setting('app.sheet_sources', true), ',')));


-- 2c. leads — has no sheet_source_id; scoped by uploader, mirroring
-- apply_user_scope() in routers/leads.py. Superadmins see everything, via a
-- separate GUC the router sets alongside app.user_id.
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_full_access ON leads;
CREATE POLICY app_full_access ON leads FOR ALL TO mis_user
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS chatbot_scope ON leads;
CREATE POLICY chatbot_scope ON leads FOR SELECT TO mis_chatbot
    USING (
        coalesce(current_setting('app.is_superadmin', true), 'off') = 'on'
        OR uploaded_by::text = current_setting('app.user_id', true)
    );


-- 2d. Unscoped operational / reference tables.
--
-- upload_logs, sync_logs and oe_dealerships carry no company-confidential
-- figures — filenames, row counts, sync timestamps and a master dealer list.
-- They are readable in full so the chatbot can answer "how fresh is this
-- data?" and resolve dealer names. RLS is still enabled so that the
-- fail-closed default applies to any future role.
--
-- Revisit if source_label / filename values ever become sensitive.
DO $$
DECLARE
    t text;
    open_tables text[] := ARRAY['upload_logs', 'sync_logs', 'oe_dealerships'];
BEGIN
    FOREACH t IN ARRAY open_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

        EXECUTE format('DROP POLICY IF EXISTS app_full_access ON %I', t);
        EXECUTE format(
            'CREATE POLICY app_full_access ON %I FOR ALL TO mis_user '
            'USING (true) WITH CHECK (true)', t);

        EXECUTE format('DROP POLICY IF EXISTS chatbot_read_all ON %I', t);
        EXECUTE format(
            'CREATE POLICY chatbot_read_all ON %I FOR SELECT TO mis_chatbot '
            'USING (true)', t);
    END LOOP;
END
$$;


COMMIT;


-- =====================================================================
-- Verification — run after COMMIT. Expected results noted inline.
-- =====================================================================

-- (a) RLS is on, with 2 policies per table, for the 13 granted tables only.
--     Expect 13 rows, each policies = 2.
--
-- SELECT c.relname,
--        c.relrowsecurity AS rls_on,
--        count(p.polname) AS policies
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE n.nspname = 'public' AND c.relrowsecurity
-- GROUP BY c.relname, c.relrowsecurity
-- ORDER BY c.relname;

-- (b) The app is unaffected. Run as mis_user — must match the count you
--     get as postgres.
--
-- SET ROLE mis_user;
-- SELECT count(*) FROM finance_lines;
-- RESET ROLE;

-- (c) The chatbot fails closed with no GUC set. Expect 0.
--
-- SET ROLE mis_chatbot;
-- SELECT count(*) FROM finance_lines;
-- RESET ROLE;

-- (d) The chatbot sees exactly the scoped rows once the GUC is set.
--     Expect a non-zero count matching that one source.
--
-- SET ROLE mis_chatbot;
-- SET LOCAL app.sheet_sources = '<paste a real sheet_sources.id here>';
-- SELECT count(*) FROM finance_lines;
-- RESET ROLE;

-- (e) The chatbot cannot read identity tables. Expect "permission denied".
--
-- SET ROLE mis_chatbot;
-- SELECT count(*) FROM users;
-- RESET ROLE;

-- (f) The chatbot cannot write. Expect "cannot execute ... in a read-only
--     transaction". Note: SET ROLE does not apply the role's
--     default_transaction_read_only setting, which is applied at login —
--     so test this from a real connection as mis_chatbot, not via SET ROLE.
--
-- DELETE FROM leads WHERE false;


-- =====================================================================
-- Rollback — undoes everything above.
-- =====================================================================
--
-- BEGIN;
-- DO $rollback$
-- DECLARE
--     t text;
--     all_tables text[] := ARRAY[
--         'leads','upload_logs','plant_to_depot_sales','distributor_sales',
--         'sheet_sources','sync_logs','finance_lines','balance_sheet_lines',
--         'profit_loss_lines','oe_visit_plans','oe_visit_logs','oe_targets',
--         'oe_dealerships'];
-- BEGIN
--     FOREACH t IN ARRAY all_tables LOOP
--         EXECUTE format('DROP POLICY IF EXISTS app_full_access ON %I', t);
--         EXECUTE format('DROP POLICY IF EXISTS chatbot_scope ON %I', t);
--         EXECUTE format('DROP POLICY IF EXISTS chatbot_read_all ON %I', t);
--         EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
--     END LOOP;
-- END
-- $rollback$;
-- REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mis_chatbot;
-- REVOKE USAGE ON SCHEMA public FROM mis_chatbot;
-- DROP ROLE IF EXISTS mis_chatbot;
-- COMMIT;

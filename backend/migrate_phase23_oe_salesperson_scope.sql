-- Phase 23 — Row-level OE scoping: a salesperson sees only their own data
-- Run as: psql -U mis_user -d autoform_mis -h localhost -f migrate_phase23_oe_salesperson_scope.sql
--
-- Until now module access was all-or-nothing: granting a user 'oe_network' in
-- user_module_access showed them EVERY rep's plans, visits, targets and
-- dealers. Field reps need the module, but only their own slice of it.
--
-- One nullable column rather than a join table, because this is exactly one
-- optional attribute per account. A join table would model "a user may be
-- several salespeople", which is not true and would quietly invite someone to
-- grant two names and widen a scope that exists to narrow.
--
--   NULL      → unscoped. Sees everything the module allows. Today's behaviour
--               for every existing account, so this migration changes nothing
--               until a name is set.
--   non-NULL  → hard-scoped to that person, in the backend, on every OE
--               endpoint. The value is the rep's canonical name; the four OE
--               tables spell the same person differently (plan tabs say
--               "PANKAJ", the log form says "PANKAJ VIG", the dealer master
--               says "PANKAJ"), so services/oe_scope.py token-matches this
--               name against the distinct names in each table rather than
--               comparing it literally.
--
-- Deliberately NOT a foreign key to any salesperson list: no such table exists.
-- The names live inside the synced sheet data (oe_visit_logs, oe_visit_plans,
-- oe_targets, oe_dealerships), which is delete-then-insert on every sync — an
-- FK there would break a sync the moment a rep had no rows that month. The UI
-- constrains this to a dropdown of names actually present in the data instead,
-- and a name matching nothing fails CLOSED (no rows), never open.

-- ─── 1. The scope column ──────────────────────────────────────────────────────
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS oe_salesperson VARCHAR(100);

COMMENT ON COLUMN users.oe_salesperson IS
    'OE Network row-level scope. NULL = sees all OE data. Non-NULL = hard-limited '
    'to this salesperson across every /oe-network endpoint (services/oe_scope.py). '
    'Token-matched, not compared literally, because the OE sheets spell one person '
    'several ways.';

-- Scoped users are a small minority of accounts, so the index only carries them.
CREATE INDEX IF NOT EXISTS idx_users_oe_salesperson
    ON users (oe_salesperson) WHERE oe_salesperson IS NOT NULL;

-- ─── 2. Verify ────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'oe_salesperson';

-- Should be 0 rows: nobody is scoped until a superadmin sets a name.
SELECT COUNT(*) AS scoped_users FROM users WHERE oe_salesperson IS NOT NULL;

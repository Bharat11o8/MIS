-- Phase 21 (EXPAND) — OE dealers: a second file format, and the two things it
-- needs that the schema cannot hold today.
--
-- ─── What arrived ─────────────────────────────────────────────────────────────
-- The OE team's dealer file has gained a TATA tab, and TATA does not publish
-- what MSIL publishes. Side by side:
--
--                     MSIL                          TATA
--   measures          a funnel:                     target vs achievement
--                     TOTAL MSIL ⊇ TOTAL YS ⊇ YSC
--   product           seat covers only              SPLIT: SC and MAT
--   target            quarter TGT + quarter ACH      quarter TGT, MONTHLY ACH
--   row grain         one row per OUTLET, with       one row per DEALER CODE
--                     every code merged onto it
--
-- TATA's columns are: TGT FOR JAS'26 SC | JULY'26 ACH SC | TGT FOR JAS'26 MAT |
-- JULY'26 ACH MAT. There is no "total sold by the dealer" figure at all, so
-- penetration, addressable % and everything read off them are not merely empty
-- for TATA — they are unavailable, and must render as "—" rather than as 0.
-- That is a code concern (see _funnel in routers/oe_network.py); what this
-- migration adds is the two DIMENSIONS the tables are missing.
--
-- ─── Run order ────────────────────────────────────────────────────────────────
-- This file is EXPAND-only: every column it adds is nullable or defaulted, and
-- the index it replaces is strictly more permissive, so an older backend keeps
-- working against the new schema throughout. Nothing is dropped that anything
-- still reads, so there is no matching contract step.
--
--   1. run this migration
--   2. deploy the phase-21 backend and frontend
--   3. establish the TATA outlets, per code — the parser and this script must
--      agree about who exists, or the sync creates a second set of dealers and
--      strands every visit log on the first:
--        python -m scripts.backfill_oe_dealer_outlets
--            --file "Dealership view file.xlsx" --oem TATA --per-code
--      (dry run first; it prints what it would UPDATE and INSERT)
--   4. re-sync the registered dealer file from the Data Source Sheets tab
--
-- Step 3 before step 4 is not optional. TATA's 1,000-odd master rows all carry
-- city NULL, so without the backfill every one of ADISHAKTI CARS' three cities
-- resolves to the same master row and the sync dies on the (dealer_id, month,
-- product) unique index — after having created nothing.

-- ─── 1. Product ───────────────────────────────────────────────────────────────
-- oe_dealer_monthly and oe_dealer_targets are both single-product today: their
-- unique indexes are (dealer_id, month) and (dealer_id, fy_year, quarter), so
-- one dealer cannot hold a seat-cover figure and a mat figure for the same
-- month. TATA sets a separate target for each and reports each separately, so
-- summing them at ingest would destroy the split the team works to.
--
-- Values are the ones oe_targets already uses, so one vocabulary covers the
-- module: 'SC' seat covers, 'MAT' mats, 'ACC' accessories.
--
-- Every existing row is seat covers. That is not an assumption: the MSIL tab
-- has no product columns and the whole funnel is stated in seat covers
-- ("TOTAL MSIL <month>" is every seat cover the dealer sold). So the DEFAULT is
-- correct for the backfill AND for any row an older backend inserts during the
-- rollout, which is what makes this safe to run before deploying.
ALTER TABLE oe_dealer_monthly
    ADD COLUMN IF NOT EXISTS product VARCHAR(8) NOT NULL DEFAULT 'SC';
ALTER TABLE oe_dealer_targets
    ADD COLUMN IF NOT EXISTS product VARCHAR(8) NOT NULL DEFAULT 'SC';

COMMENT ON COLUMN oe_dealer_monthly.product IS
    'SC | MAT | ACC — same vocabulary as oe_targets.category. Every MSIL row is SC: '
    'that tab has no product split and its funnel is stated in seat covers.';
COMMENT ON COLUMN oe_dealer_targets.product IS
    'SC | MAT | ACC. TATA sets a separate quarter target per product; MSIL sets one, on SC.';

-- New indexes first, old ones after, so the tables are never briefly unprotected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oe_dealer_monthly_unique_v2
    ON oe_dealer_monthly (dealer_id, month, product);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oe_dealer_targets_unique_v2
    ON oe_dealer_targets (dealer_id, fy_year, quarter, product);

DROP INDEX IF EXISTS idx_oe_dealer_monthly_unique;
DROP INDEX IF EXISTS idx_oe_dealer_targets_unique;

-- ─── 2. The dealer CODE becomes part of outlet identity ───────────────────────
-- MSIL's file merges every code a group holds in one city onto a single row —
-- MY CAR PUNE carries 1907, 19NA, 1907191, 1907192 — so for MSIL the outlet is
-- name + city and `dealer_codes` is a comma list kept for reference only.
--
-- TATA's file does the opposite: one row per code, and each code carries its
-- OWN target and achievement. ANANYA AUTO AGENCY / PATNA is code 300C002 with a
-- JAS target of 94 and code 3007180 with a target of 452. 43 name+city pairs are
-- split this way across 55 extra rows. Merging them would fold two targets the
-- team set separately into one number they never agreed.
--
-- So a nullable `dealer_code` joins the key. MSIL rows leave it NULL and key as
-- '' exactly as they do today, which makes this index strictly more permissive
-- than the one it replaces: nothing that fits now stops fitting.
--
-- Note the deliberate redundancy: for TATA the single code is written to BOTH
-- dealer_code (identity) and dealer_codes (display), so every screen that
-- already shows "codes" keeps working with no special case.
ALTER TABLE oe_dealerships
    ADD COLUMN IF NOT EXISTS dealer_code VARCHAR(30);

COMMENT ON COLUMN oe_dealerships.dealer_code IS
    'The ONE OEM dealer code that identifies this outlet, when the OEM''s file is '
    'keyed per code (TATA). NULL when the file merges all codes onto one outlet row '
    '(MSIL) — then dealer_codes holds the list and identity is name + city alone.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_oe_dealerships_unique_v2
    ON oe_dealerships (oem, state, UPPER(name), UPPER(COALESCE(city, '')),
                       UPPER(COALESCE(dealer_code, '')));
DROP INDEX IF EXISTS idx_oe_dealerships_unique;

-- Visit logs name a dealership and a city, never a code, so a contact at a
-- multi-code group cannot be attributed to one code. dealer_resolve picks the
-- group's lowest code as a stable anchor and the Dealers tab reads contacts at
-- the (oem, name, city) group level — this index serves that grouping.
CREATE INDEX IF NOT EXISTS idx_oe_dealerships_group
    ON oe_dealerships (oem, UPPER(name), UPPER(COALESCE(city, '')));

-- ─── 3. Verify ────────────────────────────────────────────────────────────────
SELECT table_name, column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE (table_name = 'oe_dealer_monthly' AND column_name = 'product')
   OR (table_name = 'oe_dealer_targets' AND column_name = 'product')
   OR (table_name = 'oe_dealerships'    AND column_name = 'dealer_code')
ORDER BY 1, 2;

-- Every pre-existing row is seat covers, and no MSIL outlet has taken a code
-- into its identity. Both should return 0.
SELECT COUNT(*) AS monthly_rows_not_sc FROM oe_dealer_monthly WHERE product <> 'SC';
SELECT COUNT(*) AS msil_outlets_with_code FROM oe_dealerships
 WHERE oem = 'MSIL' AND dealer_code IS NOT NULL;

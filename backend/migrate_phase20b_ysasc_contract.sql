-- Phase 20b (CONTRACT) — retire the old dealer-volume column names.
--
-- RUN THIS ONLY AFTER the phase-20 code is deployed everywhere, i.e. no
-- running backend still reads oe_dealer_monthly.car_sales / .our_sales.
-- Until then phase20's mirror trigger keeps both vocabularies in step and
-- there is no hurry — a stale column costs nothing but disk.
--
-- Order matters: deploy first, then contract. Contracting first breaks the
-- live Dealers tab with an undefined-column 500, which the browser reports as
-- a CORS error because a 500 never reaches the CORS middleware.
--
-- Check before running — expect zero rows:
--     SELECT COUNT(*) FROM oe_dealer_monthly
--      WHERE (car_sales IS DISTINCT FROM oem_total)
--         OR (our_sales IS DISTINCT FROM ys_sale);
-- A non-zero count means something is still writing the old names, so the old
-- code is still live. Stop and finish the rollout.

-- ─── 1. The transition scaffolding goes first ─────────────────────────────────
DROP TRIGGER IF EXISTS trg_oe_dealer_monthly_mirror ON oe_dealer_monthly;
DROP FUNCTION IF EXISTS oe_dealer_monthly_mirror_legacy();

-- ─── 2. The old names ─────────────────────────────────────────────────────────
-- NOTE: oe_visit_logs.car_sales is a DIFFERENT column — the visit form's
-- "TOTAL CAR SALES", which really is cars. It is NOT touched here.
ALTER TABLE oe_dealer_monthly DROP COLUMN IF EXISTS car_sales;
ALTER TABLE oe_dealer_monthly DROP COLUMN IF EXISTS our_sales;

-- ─── 3. Verify ────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'oe_dealer_monthly'
ORDER BY ordinal_position;

-- Phase 20 (EXPAND) — OE dealers: the addressable middle step (YSASC).
--
-- ─── What the dealer file actually holds ──────────────────────────────────────
-- The OE team's dealer file now publishes three series per dealer per month
-- instead of two, and it names them the way the team says them out loud:
--
--   TOTAL MSIL <month>  every seat cover that dealer sold, ours or anyone's
--   TOTAL YS <month>    of those, the ones fitted to a vehicle we hold a part
--                       number for — "YSASC", YS Available Seat Covers
--   YSC <month>         what we actually sold them — "YS Sale"
--
-- so TOTAL MSIL ⊇ YSASC ⊇ YS Sale.
--
-- The point of the middle step is that penetration against TOTAL MSIL blames a
-- rep for cars we make nothing for. Across the file: 497,817 total → 292,579
-- addressable (58.8%) → 58,924 ours. Our conversion is 20.1% of what we could
-- have won, not the 11.8% of everything that the old figure reported.
--
-- ─── Why this is additive and not a rename ────────────────────────────────────
-- The obvious migration is
--     ALTER TABLE oe_dealer_monthly RENAME COLUMN car_sales TO oem_total;
-- and it is wrong to run on its own, because the schema is shared with the
-- deployed backend. A rename breaks every running instance of the OLD code the
-- instant it commits — the dealer endpoints 500 on an undefined column, and
-- because a 500 never reaches the CORS middleware the browser reports it as a
-- CORS failure, which sends you looking in entirely the wrong place.
--
-- So: expand now, contract after the new code is deployed.
--   this file        add the new columns, backfill, keep the old ones working
--   phase20b         drop the old columns, once nothing reads them
--
-- Both old and new names stay live and in step in between, so it does not
-- matter whether a given backend is running old or new code.

-- ─── 1. The new vocabulary, alongside the old ─────────────────────────────────
ALTER TABLE oe_dealer_monthly
    ADD COLUMN IF NOT EXISTS oem_total INTEGER,
    ADD COLUMN IF NOT EXISTS ys_sale   INTEGER,
    ADD COLUMN IF NOT EXISTS ysasc     INTEGER;

COMMENT ON COLUMN oe_dealer_monthly.oem_total IS
    'TOTAL <OEM>: every seat cover this dealer sold that month, ours or not. NOT car retails.';
COMMENT ON COLUMN oe_dealer_monthly.ys_sale IS
    'YSC: seat covers we sold this dealer that month.';
COMMENT ON COLUMN oe_dealer_monthly.ysasc IS
    'TOTAL YS: of oem_total, the covers fitted to a vehicle we hold a part number for. NULL = the source file did not supply it.';

-- ─── 2. Backfill ──────────────────────────────────────────────────────────────
-- car_sales was never car sales. The old file's bare "JAN'26" column and the
-- new "TOTAL MSIL JAN'26" carry identical values (79,943 in Jan, and every
-- other month matches too), so the column always held the dealer's total SEAT
-- COVER sales. The module has been labelling it "Their volume — how many cars
-- the dealer retailed" and penetration as "our units ÷ the cars that dealer
-- retailed". Both statements are false, so the name goes — but the numbers
-- carry over unchanged, because they were always the right numbers.
--
-- NOTE the collision this avoids: oe_visit_logs.car_sales is a DIFFERENT
-- number — the visit form's "TOTAL CAR SALES", which really is cars — and is
-- deliberately left alone. Two columns of the same name meaning two different
-- things is how this got misread in the first place.
UPDATE oe_dealer_monthly
   SET oem_total = COALESCE(oem_total, car_sales),
       ys_sale   = COALESCE(ys_sale,   our_sales)
 WHERE oem_total IS NULL OR ys_sale IS NULL;

-- ysasc is deliberately NOT backfilled. Rows loaded from the two-series file
-- genuinely do not know their addressable figure, and inventing one (say,
-- oem_total) would silently report 100% coverage and make the new penetration
-- identical to the old. NULL means "not supplied", and every ratio dividing by
-- it must return NULL rather than fall back to a different denominator.

-- ─── 3. Keep the two vocabularies in step for the transition ──────────────────
-- Old code writes car_sales/our_sales; new code writes oem_total/ys_sale.
-- Without this, a re-sync from either side leaves the other side's columns
-- NULL and one of the two backends starts showing blanks. Dropped by phase20b.
CREATE OR REPLACE FUNCTION oe_dealer_monthly_mirror_legacy() RETURNS trigger AS $$
BEGIN
    IF NEW.oem_total IS NULL THEN NEW.oem_total := NEW.car_sales; END IF;
    IF NEW.car_sales IS NULL THEN NEW.car_sales := NEW.oem_total; END IF;
    IF NEW.ys_sale   IS NULL THEN NEW.ys_sale   := NEW.our_sales; END IF;
    IF NEW.our_sales IS NULL THEN NEW.our_sales := NEW.ys_sale;   END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_oe_dealer_monthly_mirror ON oe_dealer_monthly;
CREATE TRIGGER trg_oe_dealer_monthly_mirror
    BEFORE INSERT OR UPDATE ON oe_dealer_monthly
    FOR EACH ROW EXECUTE FUNCTION oe_dealer_monthly_mirror_legacy();

-- ─── 4. Verify ────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'oe_dealer_monthly'
ORDER BY ordinal_position;

-- Both should be 0 — every legacy row now carries the new names too.
SELECT COUNT(*) AS rows_missing_oem_total FROM oe_dealer_monthly
 WHERE car_sales IS NOT NULL AND oem_total IS NULL;
SELECT COUNT(*) AS rows_missing_ys_sale FROM oe_dealer_monthly
 WHERE our_sales IS NOT NULL AND ys_sale IS NULL;

-- After re-syncing the dealer file the funnel should hold. Any row here is a
-- data problem in the SOURCE FILE, not in this migration:
SELECT COUNT(*) AS rows_where_addressable_exceeds_total
FROM oe_dealer_monthly
WHERE ysasc IS NOT NULL AND oem_total IS NOT NULL AND ysasc > oem_total;

SELECT COUNT(*) AS rows_where_our_sale_exceeds_addressable
FROM oe_dealer_monthly
WHERE ysasc IS NOT NULL AND ys_sale IS NOT NULL AND ys_sale > ysasc;

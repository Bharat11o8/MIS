-- AutoForm MIS — Phase 22: dealer quarterly targets keep the sheet's precision
--
-- The OE dealer file's quarterly target is an OEM total split across dealers by
-- share, so it arrives FRACTIONAL: the MSIL tab's JAS'26 column holds 32.76036
-- for one dealer, 48.177 for the next, and only 84 of its 403 rows are whole
-- numbers at all. target/achievement were INTEGER, so every dealer was rounded
-- on the way in.
--
-- Rounding 403 dealers and then adding up is not the same number as adding up
-- and rounding once, and the gap is not a rounding-sized gap:
--
--     JAS'26 SC   sheet =SUM() 47,197.902 -> 47,198     we stored 47,171  (-27)
--     AMJ'26 SC   sheet =SUM() 32,094.573 -> 32,095     we stored 32,112  (+17)
--
-- It lands on either side depending on the fractional parts, which is why it
-- never looked like a systematic offset anyone could explain away. The sheet's
-- own total row is right and the MIS was wrong; the OE team reads that total.
--
-- NUMERIC, not a wider integer: the source value genuinely is fractional and
-- the honest thing is to store it and round at the point of DISPLAY, once, so
-- the per-dealer column and the headline total come from the same number.
--
-- Only this table is affected. Every other quantity in the dealer file is a
-- whole count in the source (checked column by column across both tabs: the
-- TATA tab has no fractional column at all, and oe_dealer_monthly's oem_total /
-- ys_sale / ysasc are whole everywhere), so INTEGER stays right for those.
--
-- Run order:  this migration -> deploy -> re-sync the OE Dealer Data sheet.
-- Until the re-sync the stored values are still the rounded ones; the migration
-- only widens the column, it cannot recover precision that was thrown away.

-- ─── 1. Widen ─────────────────────────────────────────────────────────────────
ALTER TABLE oe_dealer_targets
    ALTER COLUMN target      TYPE NUMERIC(14, 2),
    ALTER COLUMN achievement TYPE NUMERIC(14, 2);

COMMENT ON COLUMN oe_dealer_targets.target IS
    'Quarterly target as the sheet states it, fractional included — an OEM '
    'total split across dealers by share. Round at display, never at ingest: '
    'rounding per dealer then summing moved the MSIL JAS''26 total 27 units '
    'off the sheet''s own figure.';

-- ─── 2. Verify ────────────────────────────────────────────────────────────────
SELECT column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_name = 'oe_dealer_targets' AND column_name IN ('target', 'achievement');

-- After the re-sync this must read 47197.90 for MSIL SC Q2, not 47171:
SELECT d.oem, t.product, t.fy_year, t.quarter,
       COUNT(*) AS dealers, SUM(t.target) AS target, SUM(t.achievement) AS achievement
FROM oe_dealer_targets t JOIN oe_dealerships d ON d.id = t.dealer_id
GROUP BY 1, 2, 3, 4 ORDER BY 1, 4, 2;

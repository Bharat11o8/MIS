-- Phase 13 — OE Network: dealership master list
-- The visit-log form's dealership dropdown was a hardcoded TS constant
-- (DEALERSHIPS_BY_OEM_STATE in src/pages/VisitLogFormPage.tsx, 1,512 entries).
-- Field ASMs kept hitting dealers that were not in the list, so the list moves
-- here and the form gains an inline "+ Add new dealership" path.
--
-- This table is the dropdown's source of truth only. It does NOT change how a
-- visit-log submission is written: that still appends a row to the Google log
-- book sheet exactly as before (routers/visit_log.py), so the existing
-- oe_log_book sync keeps reading the same 24 columns untouched.
--
-- No sheet_source_id here, unlike the other oe_* tables: these rows are not
-- ingested from a sheet, they are master data owned by the app.

CREATE TABLE oe_dealerships (
    id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    oem          VARCHAR(50)  NOT NULL,
    state        VARCHAR(100) NOT NULL,
    city         VARCHAR(100),              -- nullable: the seeded list is name+state only for some rows
    name         VARCHAR(200) NOT NULL,
    -- Provenance, so a bad field entry can be found and fixed later:
    --   'seed'   — loaded from the original hardcoded list
    --   'form'   — added by an ASM through the public visit-log form
    source       VARCHAR(20)  NOT NULL DEFAULT 'form',
    added_by     VARCHAR(150),              -- salesperson name from the form; NULL for seeds
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- The dropdown is keyed on (oem, state) and shows names, so a dealer name may
-- legitimately repeat across states (POPULAR HYUNDAI in Kerala vs Karnataka)
-- but must be unique within one. Case-insensitive so "Popular Hyundai" cannot
-- be re-added alongside "POPULAR HYUNDAI".
CREATE UNIQUE INDEX idx_oe_dealerships_unique
    ON oe_dealerships (oem, state, UPPER(name));

CREATE INDEX idx_oe_dealerships_lookup ON oe_dealerships (oem, state) WHERE is_active;
CREATE INDEX idx_oe_dealerships_oem    ON oe_dealerships (oem);

-- ─── Grants ───────────────────────────────────────────────────────────────────
ALTER TABLE oe_dealerships OWNER TO mis_user;
GRANT ALL PRIVILEGES ON TABLE oe_dealerships TO mis_user;

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'oe_dealerships'
ORDER BY ordinal_position;

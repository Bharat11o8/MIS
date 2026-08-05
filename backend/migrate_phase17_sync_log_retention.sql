-- Phase 17 — sync_logs retention
--
-- Every sheet-backed module (Plant-to-Depot, Depot-to-Distributor, OE Network,
-- Finance) writes one sync_logs row per "Sync Now", into one shared table, and
-- nothing ever removed them. Past the newest handful those rows answer nothing:
-- the history views show only row counts, a status and a timestamp, and the one
-- diagnostic field (error_details) is not even returned by the endpoints.
--
-- services/sync_logs.py now prunes on every sync, keeping the newest 5 per
-- (module, source_label). That only takes effect for a source the next time it
-- syncs, so this migration clears the existing backlog in one pass.
--
-- SAFE FOR INGESTED DATA: every sync_log_id foreign key across the seven data
-- tables is ON DELETE SET NULL, so this drops the provenance pointer on old
-- rows and never the rows themselves. The newest row per source survives, which
-- is what each module's "Last synced <when> · <status>" caption reads.

-- Before
SELECT module, COUNT(*) AS logs_before FROM sync_logs GROUP BY module ORDER BY module;

DELETE FROM sync_logs
WHERE id IN (
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY module, source_label
                   ORDER BY synced_at DESC, id DESC
               ) AS rn
        FROM sync_logs
    ) ranked
    WHERE rn > 5
);

-- After — expect at most 5 per (module, source_label)
SELECT module, COUNT(*) AS logs_after FROM sync_logs GROUP BY module ORDER BY module;

SELECT module, source_label, COUNT(*) AS kept
FROM sync_logs
GROUP BY module, source_label
ORDER BY module, source_label;

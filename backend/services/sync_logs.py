"""AutoForm MIS — sync-log retention.

Every sheet-backed module (Plant-to-Depot, Depot-to-Distributor, OE Network,
Finance) writes one `sync_logs` row per "Sync Now", into one shared table. Those
rows accumulate forever, and past the most recent handful they answer nothing
anyone asks: the per-module history views show only row counts, a status and a
timestamp, so a forty-sync-old row says "17 rows updated on 14 July" and nothing
more. The one genuinely diagnostic field, `error_details`, isn't even returned by
the history endpoints.

What IS load-bearing is the NEWEST row per source — each module derives its
"Last synced <when> · <status>" caption from it. So logs are pruned, never
cleared: the newest SYNC_LOG_RETENTION rows per (module, source_label) survive.

Deleting is safe for ingested data: every `sync_log_id` foreign key across the
seven data tables is ON DELETE SET NULL, so pruning only drops the provenance
pointer on old rows, never the rows themselves.
"""
from sqlalchemy import text
from sqlalchemy.orm import Session

SYNC_LOG_RETENTION = 5


def prune_sync_logs(db: Session, module: str, source_label, keep: int = SYNC_LOG_RETENTION) -> int:
    """Drop all but the newest `keep` sync logs for one module + source.

    Call right after the new log row is committed, so the run in progress counts
    as one of the survivors. Housekeeping must never take a sync down with it —
    a failure here is rolled back and swallowed, because losing the ability to
    prune old logs is trivial next to losing the sync itself (and an unrolled
    failure would poison the session the sync is about to use).
    """
    try:
        result = db.execute(text("""
            DELETE FROM sync_logs
            WHERE id IN (
                SELECT id FROM sync_logs
                WHERE module = :module
                  AND source_label IS NOT DISTINCT FROM :source_label
                ORDER BY synced_at DESC, id DESC
                OFFSET :keep
            )
        """), {"module": module, "source_label": source_label, "keep": keep})
        db.commit()
        return result.rowcount or 0
    except Exception:
        db.rollback()
        return 0

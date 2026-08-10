"""
Stamp `oe_visit_logs.dealer_id` on rows that are already in the table.

New rows get resolved during sync (routers/oe_network.py). This is for the
history that was synced before outlets existed. Safe to re-run: it recomputes
every row, so it also picks up dealers added to the master since the last run.

    python -m scripts.resolve_visit_log_dealers            # report only
    python -m scripts.resolve_visit_log_dealers --apply
"""
import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text

from database import SessionLocal
from services.dealer_resolve import DealerIndex


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = SessionLocal()
    index = DealerIndex(db)
    print(f"outlet master: {len(index)} outlets\n")

    rows = db.execute(text("""
        SELECT id, oem, dealership, city,
               to_char(visit_date, 'YYYY-MM') AS ym
        FROM oe_visit_logs
    """)).mappings().all()

    hits: dict[str, str] = {}
    misses = collections.Counter()
    per_month = collections.defaultdict(lambda: [0, 0])          # ym -> [hit, total]
    per_oem = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        did = index.resolve(r["oem"], r["dealership"], r["city"])
        ym, oem = r["ym"] or "?", (r["oem"] or "?").upper()
        per_month[ym][1] += 1
        per_oem[oem][1] += 1
        if did:
            hits[r["id"]] = did
            per_month[ym][0] += 1
            per_oem[oem][0] += 1
        else:
            misses[(oem, r["dealership"], r["city"])] += 1

    print(f"resolved {len(hits)} / {len(rows)} rows ({len(hits) / max(len(rows), 1):.0%})\n")
    print("by month:")
    for ym in sorted(per_month):
        h, t = per_month[ym]
        print(f"   {ym}  {h:>5} / {t:<5} {h / t:.0%}")
    print("\nby OEM:")
    for oem in sorted(per_oem, key=lambda o: -per_oem[o][1]):
        h, t = per_oem[oem]
        print(f"   {oem:<10} {h:>5} / {t:<5} {h / t:.0%}")

    print(f"\ntop unresolved ({len(misses)} distinct):")
    for (oem, name, city), n in misses.most_common(20):
        print(f"   {oem:<9} {str(name)[:36]:<36} {str(city)[:18]:<18} n={n}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        db.close()
        return

    # One statement per distinct dealer rather than per row: 1,700 rows collapse
    # to a few hundred updates over the tunnel.
    by_dealer = collections.defaultdict(list)
    for row_id, did in hits.items():
        by_dealer[did].append(row_id)
    db.execute(text("UPDATE oe_visit_logs SET dealer_id = NULL"))
    for did, ids in by_dealer.items():
        db.execute(text("UPDATE oe_visit_logs SET dealer_id = :d WHERE id = ANY(:ids)"),
                   {"d": did, "ids": ids})
    db.commit()

    n = db.execute(text("SELECT COUNT(*) FROM oe_visit_logs WHERE dealer_id IS NOT NULL")).scalar()
    print(f"\nAPPLIED. rows now carrying a dealer_id: {n}")
    db.close()


if __name__ == "__main__":
    main()

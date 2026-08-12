"""
Load the OE team's dealer data file from a local .xlsx.

The normal path is to register the file as a Google Sheet and sync it like
every other sheet in this module (sheet_type "dealer_data"). This script exists
for the copies that arrive as email attachments, and it goes through exactly the
same parser and writer, so the two can't drift apart.

Rows loaded this way carry sheet_source_id = NULL, which is also how they are
identified for replacement — so re-running replaces the previous file load and
never touches rows that came from a registered sheet.

    python -m scripts.load_dealer_data_file --file "<path.xlsx>"
    python -m scripts.load_dealer_data_file --file "<path.xlsx>" --apply
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import openpyxl
from sqlalchemy import text

from database import SessionLocal
from routers.oe_network import sync_dealer_data
from services.oe_dealer_data_sync import parse_dealer_grids, SERIES


def _funnel_report(records: list) -> None:
    """Print the three series per month, so a bad column is visible before it lands.

    The check that matters is that the funnel narrows — every seat cover the
    dealer sold, then the ones we hold a part number for, then ours.

    The copied-column check is per dealer, not on the totals. When the March
    file arrived, its TOTAL MSIL column was a copy of February on 401 of 404
    rows, but the two months' totals still differed by 412 because three rows
    were genuinely updated — so comparing month totals would have waved it
    through. Adjacent months normally agree on a handful of rows (1-11 in the
    file as received); a few hundred means the column was never repointed.
    """
    months: dict = {}
    for rec in records:
        for m in rec["monthly"]:
            acc = months.setdefault(m["month"], {s: 0 for s in SERIES})
            for s in SERIES:
                acc[s] += m.get(s) or 0

    if not months:
        return

    # Per dealer per month, so an unchanged column can be counted row by row.
    by_month: dict = {}
    for rec in records:
        for m in rec["monthly"]:
            if m.get("oem_total") is not None:
                by_month.setdefault(m["month"], {})[id(rec)] = m["oem_total"]

    print(f"\n{'month':<10}{'total':>12}{'addressable':>14}{'ours':>10}"
          f"{'addr%':>8}{'pene%':>8}")
    prev_d = None
    for d in sorted(months):
        v = months[d]
        total, avail, ours = v["oem_total"], v["ysasc"], v["ys_sale"]
        addr = f"{100*avail/total:.1f}" if total else "-"
        pene = f"{100*ours/avail:.1f}" if avail else "-"

        flag = ""
        if prev_d is not None:
            cur, prv = by_month.get(d, {}), by_month.get(prev_d, {})
            shared = cur.keys() & prv.keys()
            same = sum(1 for k in shared if cur[k] == prv[k])
            if shared and same / len(shared) > 0.5:
                flag = (f"  <-- {same}/{len(shared)} dealers unchanged from "
                        f"{prev_d:%b} - copied column?")

        label = f"{d:%b %Y}"
        print(f"{label:<10}{total:>12,}{avail:>14,}{ours:>10,}"
              f"{addr:>8}{pene:>8}{flag}")
        prev_d = d


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    wb = openpyxl.load_workbook(args.file, data_only=True)
    grids = {ws.title: [list(r) for r in ws.iter_rows(values_only=True)]
             for ws in wb.worksheets}
    records, skipped, errors = parse_dealer_grids(grids)

    months = sorted({m["month"] for r in records for m in r["monthly"]})
    quarters = sorted({(t["quarter"], t["fy_year"]) for r in records for t in r["targets"]})
    print(f"tabs read     : {[t for t in grids if t not in skipped]}")
    print(f"tabs skipped  : {skipped}")
    print(f"dealers       : {len(records)}")
    print(f"months        : {months[0]} .. {months[-1]}  ({len(months)})" if months else "months: none")
    print(f"quarters      : {quarters}")
    print(f"monthly rows  : {sum(len(r['monthly']) for r in records)}")
    print(f"target rows   : {sum(len(r['targets']) for r in records)}")
    _funnel_report(records)
    if errors:
        print()
    for e in errors:
        print(f"  ! {e}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return

    db = SessionLocal()
    try:
        deleted = sum(
            db.execute(text(f"DELETE FROM {t} WHERE sheet_source_id IS NULL")).rowcount
            for t in ("oe_dealer_monthly", "oe_dealer_targets")
        )
        written = sync_dealer_data(db, None, records, errors)
        db.commit()
    except Exception:
        db.rollback()
        raise
    print(f"\nAPPLIED. replaced {deleted} rows with {written}.")
    for e in errors:
        print(f"  ! {e}")
    db.close()


if __name__ == "__main__":
    main()

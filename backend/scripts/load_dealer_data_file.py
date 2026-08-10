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
from services.oe_dealer_data_sync import parse_dealer_grids


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

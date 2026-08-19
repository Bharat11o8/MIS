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
    """Print the three series per OEM, month and product, so a bad column is
    visible before it lands.

    All three are part of the key, and each for its own reason:

      • OEM, because the tabs measure different things. MSIL publishes a funnel
        and TATA publishes only what we sold, so a shared row would add a total
        of 80,374 to a total of nothing and report a penetration for the pair
        that is true of neither.
      • PRODUCT, because folding mats into seat covers would hide a mat column
        that had been filled with the seat-cover figures.
      • MONTH, which is what the copied-column check compares along.

    The check that matters is that the funnel narrows — every seat cover the
    dealer sold, then the ones we hold a part number for, then ours.

    The copied-column check is per dealer, not on the totals. When the March
    file arrived, its TOTAL MSIL column was a copy of February on 401 of 404
    rows, but the two months' totals still differed by 412 because three rows
    were genuinely updated — so comparing month totals would have waved it
    through. Adjacent months normally agree on a handful of rows (1-11 in the
    file as received); a few hundred means the column was never repointed.
    """
    # {(oem, month, product): {series: total or None}} — None is kept distinct
    # from 0 throughout: "this OEM does not publish it" and "it was zero" are
    # different statements, and only the second is a number.
    acc: dict = {}
    # Per dealer per month, so an unchanged column can be counted row by row.
    by_key: dict = {}
    for rec in records:
        for m in rec["monthly"]:
            key = (rec["oem"], m["month"], m["product"])
            v = acc.setdefault(key, {s: None for s in SERIES})
            for s in SERIES:
                if m.get(s) is not None:
                    v[s] = (v[s] or 0) + m[s]
            if m.get("oem_total") is not None:
                by_key.setdefault(key, {})[id(rec)] = m["oem_total"]

    if not acc:
        return

    def num(n):
        return f"{n:,}" if n is not None else "-"

    print(f"\n{'oem':<8}{'month':<10}{'prod':<5}{'total':>12}{'addressable':>14}"
          f"{'ours':>10}{'addr%':>8}{'pene%':>8}")
    prev = None
    for key in sorted(acc, key=lambda k: (k[0], k[2], k[1])):
        oem, d, prod = key
        v = acc[key]
        total, avail, ours = v["oem_total"], v["ysasc"], v["ys_sale"]
        addr = f"{100*avail/total:.1f}" if total and avail is not None else "-"
        pene = f"{100*ours/avail:.1f}" if avail and ours is not None else "-"

        flag = ""
        # Only compare consecutive months of the same OEM and product; a mat
        # column matching last month's seat-cover column is not evidence.
        if prev is not None and prev[0] == oem and prev[2] == prod:
            cur, prv = by_key.get(key, {}), by_key.get(prev, {})
            shared = cur.keys() & prv.keys()
            same = sum(1 for k in shared if cur[k] == prv[k])
            if shared and same / len(shared) > 0.5:
                flag = (f"  <-- {same}/{len(shared)} dealers unchanged from "
                        f"{prev[1]:%b} - copied column?")

        label = f"{d:%b %Y}"
        print(f"{oem[:7]:<8}{label:<10}{prod:<5}{num(total):>12}{num(avail):>14}"
              f"{num(ours):>10}{addr:>8}{pene:>8}{flag}")
        prev = key


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
    quarters = sorted({(t["quarter"], t["fy_year"], t["product"])
                       for r in records for t in r["targets"]})
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

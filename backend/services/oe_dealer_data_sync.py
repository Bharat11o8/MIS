"""
AutoForm MIS — parser for the OE team's dealer data file.

One tab per OEM ("MSIL", and the rest as their files arrive). Each tab is one
row per dealer OUTLET with an identity block, then the dealer's own vehicle
sales month by month, then our units at that dealer month by month, then the
quarter targets:

    DEALER NAME | DEALER CITY | STATES | SALES PERSON | CODE
    JAN'26 … JULY'26 | TOTAL
    YSC JAN'26 … YSC JULY'26 | YSC TOTAL | YSC AVERAGE | AVG PENE
    AMJ'26 TGT | AMJ'26 ACH | JAS'26 TGT
    AUG'26 (VISIT)

Design notes:

  • The month columns GROW — a new pair appears every month, and the header is
    the only thing that says which month it is. So columns are discovered by
    matching their headers, never by position, and the parser needs no changes
    when August's columns land.
  • We unpivot to one row per dealer per month. "Quarter vs quarter", "growth
    of this dealer" and an arbitrary date range are then all just row filters
    instead of column arithmetic.
  • Derived columns are IGNORED, not ingested: TOTAL, YSC TOTAL, YSC AVERAGE
    and AVG PENE are all recomputable from the monthly rows, and a stored copy
    can only drift from them. Penetration is YSC TOTAL ÷ TOTAL — a ratio of
    sums, not the mean of the monthly ratios. Aggregate it the same way or our
    numbers won't tie back to theirs.

    That decision paid for itself immediately: in the file as received, AVG
    PENE is shifted up by one row from KHIVRAJ MOTORS (sheet row 174) to the
    end, so 216 of 404 dealers display the NEXT dealer's penetration. TOTAL and
    YSC TOTAL are both sound — it is only that one derived column. Recomputing
    means we are unaffected, and it is worth telling the OE team.
  • `AUG'26 (VISIT)` is ignored too. It is empty in the file: that column is
    what the MIS reports back to them, not something we read.
  • The trailing grand-total rows carry no dealer name, so requiring a name
    drops them without the parser having to know how many there are.
  • STATE IS NOT TAKEN FROM THIS FILE for existing dealers — see
    migrate_phase18_oe_dealer_outlets.sql. Its STATES column is a sales region
    (GHAZIABAD and NOIDA are filed under "DELHI NCR" though they are in Uttar
    Pradesh), and the master's spellings have to match the form's state
    dropdown. It is only used as a last resort for a dealer we have never seen.
"""
from __future__ import annotations

import calendar
import re
from datetime import date
from typing import Optional

from services.oe_network_sync import (
    _clean, _fetch_all_grids, _find_header_row, _norm_header, _to_number, normalize_state,
)

# Quarter tag -> (quarter number, first month). Indian FY, so AMJ is Q1.
QUARTER_MONTHS = {"AMJ": (1, 4), "JAS": (2, 7), "OND": (3, 10), "JFM": (4, 1)}

_MONTHS = {
    "JAN": 1, "JANUARY": 1, "FEB": 2, "FEBRUARY": 2, "MAR": 3, "MARCH": 3,
    "APR": 4, "APRIL": 4, "MAY": 5, "JUN": 6, "JUNE": 6, "JUL": 7, "JULY": 7,
    "AUG": 8, "AUGUST": 8, "SEP": 9, "SEPT": 9, "SEPTEMBER": 9, "OCT": 10,
    "OCTOBER": 10, "NOV": 11, "NOVEMBER": 11, "DEC": 12, "DECEMBER": 12,
}

REQUIRED_HEADERS = {"DEALER NAME", "DEALER CITY"}

# "JAN'26", "JULY'26", "JUNE 26". Anchored, so "AUG'26 (VISIT)" does NOT match —
# that column is ours to report, not to read.
_MONTH_RE = re.compile(r"^(?P<mon>[A-Z]+)\s*'?\s*(?P<yy>\d{2}|\d{4})$")
_YSC_RE = re.compile(r"^YSC\s+(?P<rest>.+)$")
# "AMJ'26 TGT", "JAS'26 ACH"
_QTR_RE = re.compile(r"^(?P<tag>AMJ|JAS|OND|JFM)\s*'?\s*(?P<yy>\d{2}|\d{4})\s*(?P<kind>TGT|ACH)$")


def _year(yy: str) -> int:
    return int(yy) if len(yy) == 4 else 2000 + int(yy)


def _month_from_header(h: str) -> Optional[date]:
    m = _MONTH_RE.match(h)
    if not m:
        return None
    mon = _MONTHS.get(m.group("mon"))
    return date(_year(m.group("yy")), mon, 1) if mon else None


def _quarter_from_header(h: str):
    """('Q1', 2026, date(2026,4,1), date(2026,6,30), 'TGT') or None."""
    m = _QTR_RE.match(h)
    if not m:
        return None
    tag, year = m.group("tag"), _year(m.group("yy"))
    q_no, first_month = QUARTER_MONTHS[tag]
    # JFM is the last quarter of an FY that started the PREVIOUS April, so
    # JFM'27 belongs to fy_year 2026 alongside AMJ'26.
    fy_year = year - 1 if tag == "JFM" else year
    start = date(year, first_month, 1)
    end_month = first_month + 2
    end = date(year, end_month, calendar.monthrange(year, end_month)[1])
    return f"Q{q_no}", fy_year, start, end, m.group("kind")


def _int(v) -> Optional[int]:
    n = _to_number(v)
    return None if n is None else int(round(n))


def parse_dealer_grids(grids: dict) -> tuple[list, list, list]:
    """(records, skipped_tabs, errors). Split out from parse_dealer_data so the
    same logic can be run against a downloaded copy of the file."""
    records, skipped, errors = [], [], []

    for title, grid in grids.items():
        header = _find_header_row(grid, REQUIRED_HEADERS)
        if not header:
            skipped.append(title)
            continue
        h_row, cols = header
        oem = _norm_header(title)

        months = {c: d for h, c in cols.items()
                  if (d := _month_from_header(h)) is not None}
        ysc = {}
        for h, c in cols.items():
            m = _YSC_RE.match(h)
            if m and (d := _month_from_header(m.group("rest").strip())) is not None:
                ysc[c] = d
        quarters = {c: q for h, c in cols.items()
                    if (q := _quarter_from_header(h)) is not None}

        if not months and not ysc:
            errors.append(f"'{title}': no month columns recognised — headers were "
                          f"{sorted(cols)[:12]}")
            skipped.append(title)
            continue
        if not ysc:
            errors.append(f"'{title}': found car-sales months but no YSC columns, so "
                          f"penetration cannot be computed for this OEM")

        name_c, city_c = cols["DEALER NAME"], cols["DEALER CITY"]
        state_c = cols.get("STATES", cols.get("STATE"))
        sp_c, code_c = cols.get("SALES PERSON"), cols.get("CODE")

        seen: dict[tuple, dict] = {}
        for line in grid[h_row + 1:]:
            def g(idx):
                return line[idx] if idx is not None and idx < len(line) else None

            name = _clean(g(name_c))
            if not name:
                continue                      # grand-total rows have no dealer
            city = _clean(g(city_c)) or ""

            monthly = {}
            for c, d in months.items():
                monthly.setdefault(d, {})["car_sales"] = _int(g(c))
            for c, d in ysc.items():
                monthly.setdefault(d, {})["our_sales"] = _int(g(c))

            targets: dict[tuple, dict] = {}
            for c, (q, fy, start, end, kind) in quarters.items():
                t = targets.setdefault((q, fy), {"quarter": q, "fy_year": fy,
                                                 "period_start": start, "period_end": end,
                                                 "target": None, "achievement": None})
                t["target" if kind == "TGT" else "achievement"] = _int(g(c))

            rec = {
                "oem": oem,
                "name": name,
                "city": city,
                "state": normalize_state(_clean(g(state_c))) if state_c is not None else None,
                "salesperson": _clean(g(sp_c)) if sp_c is not None else None,
                "dealer_codes": _clean(g(code_c)) if code_c is not None else None,
                "monthly": [{"month": d, **v} for d, v in sorted(monthly.items())],
                "targets": sorted(targets.values(), key=lambda t: t["period_start"]),
            }

            # One outlet listed twice (BHANDARI / KOLKATA appears on two rows).
            # Sum the volumes rather than let the second row overwrite the first
            # or create a phantom second outlet.
            key = (oem, name.upper(), city.upper())
            if key in seen:
                errors.append(f"'{title}': {name} / {city} is listed more than once — "
                              f"the rows were added together")
                _merge(seen[key], rec)
            else:
                seen[key] = rec
                records.append(rec)

    return records, skipped, errors


def _merge(into: dict, other: dict) -> None:
    """Fold a duplicate outlet row into the one we already have."""
    by_month = {m["month"]: m for m in into["monthly"]}
    for m in other["monthly"]:
        tgt = by_month.get(m["month"])
        if tgt is None:
            into["monthly"].append(m)
            continue
        for k in ("car_sales", "our_sales"):
            if m.get(k) is not None:
                tgt[k] = (tgt.get(k) or 0) + m[k]
    into["monthly"].sort(key=lambda m: m["month"])

    by_q = {(t["quarter"], t["fy_year"]): t for t in into["targets"]}
    for t in other["targets"]:
        tgt = by_q.get((t["quarter"], t["fy_year"]))
        if tgt is None:
            into["targets"].append(t)
            continue
        for k in ("target", "achievement"):
            if t.get(k) is not None:
                tgt[k] = (tgt.get(k) or 0) + t[k]

    codes = [c.strip() for c in
             f"{into.get('dealer_codes') or ''},{other.get('dealer_codes') or ''}".split(",")
             if c.strip()]
    into["dealer_codes"] = ", ".join(dict.fromkeys(codes)) or None


def parse_dealer_data(sheet_id: str):
    """Returns (records, skipped_tabs, errors)."""
    return parse_dealer_grids(_fetch_all_grids(sheet_id))

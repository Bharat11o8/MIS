"""
AutoForm MIS — parser for the OE team's dealer data file.

One tab per OEM ("MSIL", and the rest as their files arrive). Each tab is one
row per dealer OUTLET with an identity block, then THREE monthly series, then
the quarter targets:

    DEALER NAME | DEALER CITY | STATES | SALES PERSON | CODE
    TOTAL MSIL JAN'26 | TOTAL YS JAN'26 | … (interleaved, one pair per month)
    TOTAL MSIL | TOTAL YS NOS.
    YSC JAN'26 … YSC JULY'26 | YSC TOTAL | YSC AVERAGE | AVG PENE
    AMJ'26 TGT | AMJ'26 ACH | JAS'26 TGT
    AUG'26 (VISIT)

The three series are a funnel, in the team's own words:

    TOTAL <OEM>   every seat cover that dealer sold, ours or anyone's
    TOTAL YS      of those, the ones on a vehicle we hold a part number for
                  — "YSASC", YS Available Seat Covers
    YSC           what we actually sold them — "YS Sale"

so oem_total ⊇ ysasc ⊇ ys_sale. Penetration is now ys_sale ÷ ysasc: measuring
against oem_total charges a rep for cars we make nothing for.

Design notes:

  • The month columns GROW — a new set appears every month, and the header is
    the only thing that says which month it is. So columns are discovered by
    matching their headers, never by position, and the parser needs no changes
    when August's columns land. The first two series are INTERLEAVED and the
    third is a separate block; because nothing keys off position, that costs
    nothing here.
  • The OEM's own name is in the header ("TOTAL MSIL JAN'26"), so the pattern
    matches TOTAL <anything except YS> <month> rather than hardcoding MSIL.
    A TATA tab writing "TOTAL TATA JAN'26" needs no code change.
  • We unpivot to one row per dealer per month. "Quarter vs quarter", "growth
    of this dealer" and an arbitrary date range are then all just row filters
    instead of column arithmetic.
  • Derived columns are IGNORED, not ingested: TOTAL MSIL, TOTAL YS NOS.,
    YSC TOTAL, YSC AVERAGE and AVG PENE are all recomputable from the monthly
    rows, and a stored copy can only drift from them. Note that the totals and
    the monthly columns share a prefix, so the patterns are anchored — a bare
    "TOTAL MSIL" must not be read as a month.

    That decision has now paid for itself twice. In the two-series file, AVG
    PENE was shifted up a row from sheet row 174, so 216 of 404 dealers showed
    the NEXT dealer's number. In the three-series file, AVG PENE still divides
    by TOTAL MSIL rather than the new denominator (182 of 403 rows match the
    old formula, 13 match the new, the rest match neither). We recompute, so
    neither has ever reached a screen.
  • `AUG'26 (VISIT)` is ignored too. It is empty in the file: that column is
    what the MIS reports back to them, not something we read.
  • The trailing grand-total rows carry no dealer name, so requiring a name
    drops them without the parser having to know how many there are.
  • STATE IS NOT TAKEN FROM THIS FILE for existing dealers — see
    migrate_phase18_oe_dealer_outlets.sql. Its STATES column is a sales region
    (GHAZIABAD and NOIDA are filed under "DELHI NCR" though they are in Uttar
    Pradesh), and the master's spellings have to match the form's state
    dropdown. It is only used as a last resort for a dealer we have never seen.

The funnel is CHECKED, not assumed: a month where ysasc > oem_total, or
ys_sale > ysasc, is reported as an error rather than stored quietly. That check
caught a real one on arrival — "TOTAL MSIL MAR'26" had been filled with
February's values on 401 of 404 rows.
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

# The three monthly series. Each is anchored and ends in a month, so the derived
# grand-total columns that share their prefixes — "TOTAL MSIL", "TOTAL YS NOS.",
# "YSC TOTAL" — cannot match: none of them ends in something _MONTH_RE accepts.
#
# _OEM_TOTAL_RE deliberately does not name the OEM. The header carries it
# ("TOTAL MSIL JAN'26"), and a TATA tab saying "TOTAL TATA JAN'26" must work
# untouched. YS is excluded by the negative lookahead so the two interleaved
# series can't be confused for one another.
_OEM_TOTAL_RE = re.compile(r"^TOTAL\s+(?!YS\b)(?P<oem>.+?)\s+(?P<month>\S.*)$")
_YSASC_RE = re.compile(r"^TOTAL\s+YS\s+(?P<month>\S.*)$")
_YS_SALE_RE = re.compile(r"^YSC\s+(?P<month>\S.*)$")

# "AMJ'26 TGT", "JAS'26 ACH"
_QTR_RE = re.compile(r"^(?P<tag>AMJ|JAS|OND|JFM)\s*'?\s*(?P<yy>\d{2}|\d{4})\s*(?P<kind>TGT|ACH)$")

# What a month's three figures are called, in the order the funnel narrows.
SERIES = ("oem_total", "ysasc", "ys_sale")


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

        # {series_name: {column_index: month}} — one pass, driven by the header
        # text alone. _YSASC_RE is tried before _OEM_TOTAL_RE only for clarity;
        # the negative lookahead already keeps them disjoint.
        series: dict[str, dict[int, date]] = {s: {} for s in SERIES}
        for h, c in cols.items():
            for name, rx in (("ysasc", _YSASC_RE), ("oem_total", _OEM_TOTAL_RE),
                             ("ys_sale", _YS_SALE_RE)):
                m = rx.match(h)
                if m and (d := _month_from_header(m.group("month").strip())) is not None:
                    series[name][c] = d
                    break

        quarters = {c: q for h, c in cols.items()
                    if (q := _quarter_from_header(h)) is not None}

        if not any(series.values()):
            errors.append(f"'{title}': no month columns recognised — headers were "
                          f"{sorted(cols)[:12]}")
            skipped.append(title)
            continue
        if not series["ys_sale"]:
            errors.append(f"'{title}': no YSC columns, so nothing of ours is recorded "
                          f"for this OEM and no penetration can be computed")
        # A tab still in the two-series format parses fine and simply carries no
        # addressable figure; say so once rather than let every penetration come
        # back empty with no explanation.
        if not series["ysasc"]:
            errors.append(f"'{title}': no 'TOTAL YS' columns — this tab is still in the "
                          f"two-series format, so YSASC penetration is unavailable for it")

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
            for s in SERIES:
                for c, d in series[s].items():
                    monthly.setdefault(d, {})[s] = _int(g(c))

            # The funnel has to narrow. Where it doesn't, the source is wrong,
            # and saying so beats storing a penetration over 100% and letting
            # someone find it on a dashboard.
            for d, v in sorted(monthly.items()):
                tot, avail, ours = v.get("oem_total"), v.get("ysasc"), v.get("ys_sale")
                where = f"{name} / {city or '?'} — {d:%b %Y}"
                if avail is not None and tot is not None and avail > tot:
                    errors.append(
                        f"'{title}': {where} has YSASC {avail:,} above TOTAL {tot:,}; "
                        f"the addressable figure cannot exceed the total")
                if ours is not None and avail is not None and ours > avail:
                    errors.append(
                        f"'{title}': {where} has YS Sale {ours:,} above YSASC {avail:,}; "
                        f"we cannot have sold more than was addressable")

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
        for k in SERIES:
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

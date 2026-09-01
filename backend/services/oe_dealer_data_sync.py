"""
AutoForm MIS — parser for the OE team's dealer data file.

One tab per OEM. Every tab opens with the same identity block —

    DEALER NAME | DEALER CITY | STATES | SALES PERSON | CODE

— and then the OEMs disagree about what they publish. Two shapes are supported,
recognised by their column headers alone, so a new tab in either shape needs no
code change.

─── Shape A: the funnel (MSIL) ───────────────────────────────────────────────
    TOTAL MSIL JAN'26 | TOTAL YS JAN'26 | … (interleaved, one pair per month)
    TOTAL MSIL | TOTAL YS NOS.
    YSC JAN'26 … YSC JULY'26 | YSC TOTAL | YSC AVERAGE | AVG PENE
    AMJ'26 TGT | AMJ'26 ACH | JAS'26 TGT
    AUG'26 (VISIT)

Three monthly series, a funnel in the team's own words:

    TOTAL <OEM>   every seat cover that dealer sold, ours or anyone's
    TOTAL YS      of those, the ones on a vehicle we hold a part number for
                  — "YSASC", YS Available Seat Covers
    YSC           what we actually sold them — "YS Sale"

so oem_total ⊇ ysasc ⊇ ys_sale. Penetration is ys_sale ÷ ysasc: measuring
against oem_total charges a rep for cars we make nothing for.

─── Shape B: target vs achievement, split by product (TATA) ──────────────────
    TGT FOR JAS'26 SC | JULY'26 ACH SC | TGT FOR JAS'26 MAT | JULY'26 ACH MAT

No funnel at all. TATA does not tell us how much the dealer sold, only what we
targeted and what we achieved, and it does so per PRODUCT — seat covers and
mats have separate targets and separate results. So for a shape-B tab:

  • the monthly ACH figure is OUR sale, the same quantity YSC carries, and is
    stored as ys_sale with the row's product;
  • oem_total and ysasc stay NULL — not zero. Penetration, share and
    addressable % are unavailable for this OEM, and the module must say "—"
    rather than invent a denominator;
  • the quarter target is per product; there is no quarter ACH column, so
    achievement for a quarter is summed from its months at read time. Storing a
    copy would let it drift.

─── Row grain differs too, and it is part of identity ────────────────────────
Shape A merges every dealer code a group holds in one city onto ONE row (MY CAR
PUNE carries 1907, 19NA, 1907191, 1907192), so its outlet is name + city and
CODE is reference data.

Shape B lists one row PER CODE, and each code carries its own target and its own
achievement — ANANYA AUTO AGENCY / PATNA is code 300C002 with a JAS target of 94
and code 3007180 with 452. 43 name+city pairs are split this way. Merging them
would fold two targets the team set separately into one number nobody agreed to,
so on a shape-B tab the code joins the key and each code is its own outlet.

The shape decides this, not the OEM name: a per-product tab is code-keyed, a
funnel tab is outlet-keyed. Consequence worth knowing — a visit log names a
dealership and a city and never a code, so contacts cannot be attributed to one
code; see services/dealer_resolve.py, which anchors them to the group's lowest
code, and the Dealers tab, which reads contacts at the group level.

─── Design notes, both shapes ────────────────────────────────────────────────
  • The month columns GROW — a new set appears every month, and the header is
    the only thing that says which month it is. So columns are discovered by
    matching their headers, never by position, and the parser needs no changes
    when August's columns land.
  • The OEM's own name is in the shape-A header ("TOTAL MSIL JAN'26"), so the
    pattern matches TOTAL <anything except YS> <month> rather than hardcoding
    MSIL.
  • We unpivot to one row per dealer per month per product. "Quarter vs
    quarter", "growth of this dealer" and an arbitrary date range are then all
    just row filters instead of column arithmetic.
  • Derived columns are IGNORED, not ingested: TOTAL MSIL, TOTAL YS NOS.,
    YSC TOTAL, YSC AVERAGE and AVG PENE are all recomputable from the monthly
    rows, and a stored copy can only drift from them. Note that the totals and
    the monthly columns share a prefix, so the patterns are anchored — a bare
    "TOTAL MSIL" must not be read as a month.

    That decision has now paid for itself three times. In the two-series file,
    AVG PENE was shifted up a row from sheet row 174, so 216 of 404 dealers
    showed the NEXT dealer's number. In the three-series file, AVG PENE still
    divides by TOTAL MSIL rather than the new denominator. And the TATA tab's
    own grand-total row disagrees with its columns in both directions —
    it says 59,429 SC target where the column sums to 59,433, and 17,841 MAT
    where the column sums to 17,839. We recompute, so none has reached a screen.
  • `AUG'26 (VISIT)` is ignored. It is empty in the file: that column is what
    the MIS reports back to them, not something we read.
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

# The three monthly series of shape A. Each is anchored and ends in a month, so
# the derived grand-total columns that share their prefixes — "TOTAL MSIL",
# "TOTAL YS NOS.", "YSC TOTAL" — cannot match: none of them ends in something
# _MONTH_RE accepts.
#
# _OEM_TOTAL_RE deliberately does not name the OEM. The header carries it
# ("TOTAL MSIL JAN'26"). YS is excluded by the negative lookahead so the two
# interleaved series can't be confused for one another.
_OEM_TOTAL_RE = re.compile(r"^TOTAL\s+(?!YS\b)(?P<oem>.+?)\s+(?P<month>\S.*)$")
_YSASC_RE = re.compile(r"^TOTAL\s+YS\s+(?P<month>\S.*)$")
_YS_SALE_RE = re.compile(r"^YSC\s+(?P<month>\S.*)$")

# "AMJ'26 TGT", "JAS'26 ACH" — shape A's quarter columns, no product on them.
_QTR_RE = re.compile(r"^(?P<tag>AMJ|JAS|OND|JFM)\s*'?\s*(?P<yy>\d{2}|\d{4})\s*(?P<kind>TGT|ACH)$")

# ── Shape B ───────────────────────────────────────────────────────────────────
# Product codes are oe_targets' own vocabulary, so one word means one thing
# across the module: SC seat covers, MAT mats, ACC accessories.
PRODUCTS = ("SC", "MAT", "ACC")
DEFAULT_PRODUCT = "SC"
_PROD = "|".join(PRODUCTS)

# "TGT FOR JAS'26 SC"
_QTR_PROD_RE = re.compile(
    rf"^TGT\s+FOR\s+(?P<tag>AMJ|JAS|OND|JFM)\s*'?\s*(?P<yy>\d{{2}}|\d{{4}})\s+(?P<prod>{_PROD})$")
# "JULY'26 ACH SC", and "JULY'26 ACH SC AMATO" since Aug 2026.
#
# The trailing owner word appeared when the TATA tab gained a "JULY'26 SC TATA"
# column — the dealer's whole SC volume — and our achievement column was renamed
# to say whose number it is. Anchored to AMATO specifically, not to a wildcard
# trailing word: on this tab a name is exactly what distinguishes our units from
# the OEM's total, so "ACH SC TATA" must NOT quietly land in ys_sale.
_ACH_PROD_RE = re.compile(
    rf"^(?P<month>[A-Z]+\s*'?\s*(?:\d{{2}}|\d{{4}}))\s+ACH\s+(?P<prod>{_PROD})"
    rf"(?:\s+AMATO)?$")
# "JULY'26 SC TATA" — the dealer's OWN volume of that product, the shape-B
# equivalent of shape A's "TOTAL MSIL JAN'26". Arrived on the TATA tab in
# Aug 2026; before that the tab published no total at all.
#
# The trailing name is REQUIRED to be the tab's own OEM (checked at the call
# site, not here). On this tab a name is the only thing separating the OEM's
# total from ours — "JULY'26 ACH SC AMATO" is our sale — so a column naming
# anyone else is left unread rather than guessed at.
_OEM_PROD_TOTAL_RE = re.compile(
    rf"^(?P<month>[A-Z]+\s*'?\s*(?:\d{{2}}|\d{{4}}))\s+(?P<prod>{_PROD})\s+(?P<who>.+)$")

# OEMs where we hold a part number for EVERY vehicle they sell.
#
# YSASC ("available seat covers") is the slice of a dealer's volume we could
# possibly have won. On MSIL that is a real constraint and the file measures it.
# On TATA there is nothing to measure: we carry the whole range, so the
# addressable pool IS the dealer's total, and penetration is our share of
# everything they sold.
#
# So a missing YSASC means two different things on the two tabs, and treating
# TATA's as absent would blank the one ratio the tab exists to show. It is
# filled in from oem_total at parse time — see the funnel check below, which
# still has to hold — and Available Part Number % then reads a truthful 100%.
FULL_PART_COVERAGE_OEMS = {"TATA"}

# "AUG SC" — next month's column, opened before its numbers exist and before
# anyone has put the year on it. Empty it is harmless; filled it is a month we
# cannot place, so it is reported rather than guessed at (see _placeholder_error).
_PLACEHOLDER_RE = re.compile(rf"^(?P<mon>[A-Z]+)\s+(?P<prod>{_PROD})$")

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


def _quarter_bounds(tag: str, year: int):
    """('Q1', fy_year, period_start, period_end) for a quarter tag and its year."""
    q_no, first_month = QUARTER_MONTHS[tag]
    # JFM is the last quarter of an FY that started the PREVIOUS April, so
    # JFM'27 belongs to fy_year 2026 alongside AMJ'26.
    fy_year = year - 1 if tag == "JFM" else year
    start = date(year, first_month, 1)
    end_month = first_month + 2
    end = date(year, end_month, calendar.monthrange(year, end_month)[1])
    return f"Q{q_no}", fy_year, start, end


def _quarter_from_header(h: str):
    """('Q1', 2026, date(2026,4,1), date(2026,6,30), 'TGT') or None."""
    m = _QTR_RE.match(h)
    if not m:
        return None
    return (*_quarter_bounds(m.group("tag"), _year(m.group("yy"))), m.group("kind"))


def _quarter_prod_from_header(h: str):
    """('Q2', 2026, date(2026,7,1), date(2026,9,30), 'SC') or None."""
    m = _QTR_PROD_RE.match(h)
    if not m:
        return None
    return (*_quarter_bounds(m.group("tag"), _year(m.group("yy"))), m.group("prod"))


def _int(v) -> Optional[int]:
    """A whole count. Every monthly series in both tabs is whole at source."""
    n = _to_number(v)
    return None if n is None else int(round(n))


def _num(v) -> Optional[float]:
    """A quantity kept at the source's own precision.

    Quarterly targets are an OEM total split across dealers by share, so they
    arrive fractional -- the MSIL tab's JAS'26 column holds 32.76036 for one
    dealer and 48.177 for the next. Rounding each of 403 dealers and THEN adding
    up is a different number from adding up and rounding once: that read 47,171
    against the sheet's own 47,198, and 32,112 against its 32,095 -- landing on
    either side depending on the fractional parts, which is what made it look
    like a data disagreement rather than an arithmetic one. Store what the sheet
    stores and round at the point of display.
    """
    return _to_number(v)


def _code(v) -> Optional[str]:
    """A dealer code as text. Sheets hands back whole-number codes as numbers
    (3007720) and alphanumeric ones as strings (300B350); left alone, the first
    kind would key as '3007720.0' one sync and '3007720' the next."""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return _clean(v)


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
        # Shape B: {column_index: (month, product)} and {column_index: quarter}
        ach_cols: dict[int, tuple] = {}
        oem_tot_cols: dict[int, tuple] = {}
        qtr_prod_cols: dict[int, tuple] = {}
        placeholder_cols: dict[int, str] = {}

        for h, c in cols.items():
            if (q := _quarter_prod_from_header(h)) is not None:
                qtr_prod_cols[c] = q
                continue
            if (m := _ACH_PROD_RE.match(h)) is not None:
                if (d := _month_from_header(m.group("month").replace(" ", ""))) is not None:
                    ach_cols[c] = (d, m.group("prod"))
                    continue
            if (m := _OEM_PROD_TOTAL_RE.match(h)) is not None:
                # Only when the column names THIS tab's OEM; see the pattern.
                if (_norm_header(m.group("who")) == oem
                        and (d := _month_from_header(m.group("month").replace(" ", ""))) is not None):
                    oem_tot_cols[c] = (d, m.group("prod"))
                    continue
            if (m := _PLACEHOLDER_RE.match(h)) is not None and m.group("mon") in _MONTHS:
                placeholder_cols[c] = h
                continue
            for name, rx in (("ysasc", _YSASC_RE), ("oem_total", _OEM_TOTAL_RE),
                             ("ys_sale", _YS_SALE_RE)):
                mm = rx.match(h)
                if mm and (d := _month_from_header(mm.group("month").strip())) is not None:
                    series[name][c] = d
                    break

        quarters = {c: q for h, c in cols.items()
                    if (q := _quarter_from_header(h)) is not None}

        # NOT widened by oem_tot_cols. has_funnel means "shape A", and it is
        # what decides code_keyed below: a shape-B tab lists one row PER CODE
        # with its own target, and folding those onto name+city would merge
        # targets the OE team set separately. A per-product total column is a
        # shape-B column, so it counts towards has_products instead.
        has_funnel = any(series.values())
        full_coverage = oem in FULL_PART_COVERAGE_OEMS
        has_products = bool(ach_cols or qtr_prod_cols or oem_tot_cols)
        # Which column identifies an outlet. A per-product tab lists one row per
        # dealer code and gives each its own target, so the code is identity
        # there; a funnel tab merges every code onto one outlet row, so it isn't.
        code_keyed = has_products and not has_funnel

        # A product that has a quarter target but no achievement column at all.
        #
        # This is how the SC rename got through: "JULY'26 ACH SC" became
        # "JULY'26 ACH SC AMATO", stopped matching, and 498 rows simply stopped
        # arriving. Nothing failed — the tab still had its MAT columns, so it
        # parsed, synced "Done", and the Dealers tab showed a 0 that looked like
        # a real measurement. A target the OE team set is a firm statement that
        # the product is being sold, so the missing counterpart is reportable.
        tgt_prods = {q[-1] for q in qtr_prod_cols.values()}
        ach_prods = {p for _, p in ach_cols.values()}
        for prod in sorted(tgt_prods - ach_prods):
            errors.append(
                f"'{title}': there is a {prod} target but no {prod} achievement column "
                f"was recognised, so no {prod} sales were read for this OEM. Expected a "
                f"header like \"JULY'26 ACH {prod}\"; the headers present are "
                f"{sorted(cols)[:12]}")

        if not (has_funnel or has_products):
            errors.append(f"'{title}': no month or target columns recognised — headers were "
                          f"{sorted(cols)[:12]}")
            skipped.append(title)
            continue
        if has_funnel:
            if not series["ys_sale"]:
                errors.append(f"'{title}': no YSC columns, so nothing of ours is recorded "
                              f"for this OEM and no penetration can be computed")
            # A tab still in the two-series format parses fine and simply carries
            # no addressable figure; say so once rather than let every
            # penetration come back empty with no explanation.
            if not series["ysasc"]:
                errors.append(f"'{title}': no 'TOTAL YS' columns — this tab is still in the "
                              f"two-series format, so YSASC penetration is unavailable for it")

        name_c, city_c = cols["DEALER NAME"], cols["DEALER CITY"]
        state_c = cols.get("STATES", cols.get("STATE"))
        sp_c, code_c = cols.get("SALES PERSON"), cols.get("CODE")

        data_rows = grid[h_row + 1:]

        def cell(line, idx):
            return line[idx] if idx is not None and idx < len(line) else None

        # A code-keyed tab carries a few blank-CODE rows that repeat a name+city
        # already listed WITH a code, all figures zero — padding left behind by
        # editing (KEY MOTOR / BANGALORE appears three extra times). Ingesting
        # them would put a phantom zero-target outlet beside the real one in
        # every list. Blank-CODE rows whose name+city appears nowhere else are a
        # different thing entirely — a real outlet not yet coded — and are kept.
        coded_keys = set()
        if code_keyed:
            for line in data_rows:
                nm, ct = _clean(cell(line, name_c)), _clean(cell(line, city_c))
                if nm and _code(cell(line, code_c)):
                    coded_keys.add((nm.upper(), (ct or "").upper()))

        # A placeholder column with numbers in it is data we would silently drop.
        for c, h in placeholder_cols.items():
            if any(_to_number(cell(line, c)) not in (None, 0)
                   for line in data_rows if _clean(cell(line, name_c))):
                errors.append(
                    f"'{title}': column '{h}' has figures in it but no year, so the month "
                    f"cannot be placed and the column was NOT read. Rename it to "
                    f"\"{h.split()[0]}'YY ACH {h.split()[-1]}\" in the sheet.")

        seen: dict[tuple, dict] = {}
        padding = 0
        for line in data_rows:
            name = _clean(cell(line, name_c))
            if not name:
                continue                      # grand-total rows have no dealer
            city = _clean(cell(line, city_c)) or ""
            code = _code(cell(line, code_c)) if code_c is not None else None

            if code_keyed and not code and (name.upper(), city.upper()) in coded_keys:
                padding += 1
                continue

            # {(month, product): {series: value}}
            monthly: dict[tuple, dict] = {}
            for s in SERIES:
                for c, d in series[s].items():
                    monthly.setdefault((d, DEFAULT_PRODUCT), {})[s] = _int(cell(line, c))
            for c, (d, prod) in oem_tot_cols.items():
                # The dealer's whole volume of that product.
                slot = monthly.setdefault((d, prod), {})
                slot["oem_total"] = _int(cell(line, c))
                if full_coverage and slot["oem_total"] is not None:
                    # Not a derived copy of a number the sheet also publishes —
                    # this OEM publishes no YSASC because for them there is
                    # nothing to measure. See FULL_PART_COVERAGE_OEMS.
                    slot["ysasc"] = slot["oem_total"]
            for c, (d, prod) in ach_cols.items():
                # The achievement IS our sale for that month — the same quantity
                # shape A calls YSC. oem_total and ysasc are left absent, not
                # zeroed: this OEM does not publish them.
                monthly.setdefault((d, prod), {})["ys_sale"] = _int(cell(line, c))

            # The funnel has to narrow. Where it doesn't, the source is wrong,
            # and saying so beats storing a penetration over 100% and letting
            # someone find it on a dashboard.
            for (d, _prod), v in sorted(monthly.items()):
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

            def target_slot(q, fy, start, end, prod):
                return targets.setdefault((q, fy, prod), {
                    "quarter": q, "fy_year": fy, "period_start": start,
                    "period_end": end, "product": prod,
                    "target": None, "achievement": None})

            for c, (q, fy, start, end, kind) in quarters.items():
                t = target_slot(q, fy, start, end, DEFAULT_PRODUCT)
                t["target" if kind == "TGT" else "achievement"] = _num(cell(line, c))
            for c, (q, fy, start, end, prod) in qtr_prod_cols.items():
                # No quarter ACH column on this shape. Achievement is summed
                # from the quarter's months at read time rather than stored,
                # so the two can never disagree.
                target_slot(q, fy, start, end, prod)["target"] = _num(cell(line, c))

            rec = {
                "oem": oem,
                "name": name,
                "city": city,
                "state": normalize_state(_clean(cell(line, state_c))) if state_c is not None else None,
                "salesperson": _clean(cell(line, sp_c)) if sp_c is not None else None,
                # Identity, and only on a code-keyed tab. Elsewhere the outlet is
                # name + city and this stays NULL, exactly as the master expects.
                "dealer_code": code if code_keyed else None,
                "dealer_codes": code,
                "monthly": [{"month": d, "product": p, **v}
                            for (d, p), v in sorted(monthly.items(), key=lambda kv: kv[0])],
                "targets": sorted(targets.values(),
                                  key=lambda t: (t["period_start"], t["product"])),
            }

            # One outlet listed twice (BHANDARI / KOLKATA appears on two rows).
            # Sum the volumes rather than let the second row overwrite the first
            # or create a phantom second outlet. On a code-keyed tab the code is
            # part of the key, so two codes stay two outlets and only a genuine
            # repeat of the same code merges.
            key = (oem, name.upper(), city.upper(), (code or "").upper() if code_keyed else "")
            if key in seen:
                errors.append(f"'{title}': {name} / {city}"
                              + (f" (code {code})" if code_keyed and code else "")
                              + " is listed more than once — the rows were added together")
                _merge(seen[key], rec)
            else:
                seen[key] = rec
                records.append(rec)

        if padding:
            errors.append(
                f"'{title}': {padding} row(s) with no CODE repeat a dealer already listed "
                f"with one and carry no figures — treated as leftover blank rows and skipped")

    return records, skipped, errors


def _merge(into: dict, other: dict) -> None:
    """Fold a duplicate outlet row into the one we already have."""
    by_month = {(m["month"], m["product"]): m for m in into["monthly"]}
    for m in other["monthly"]:
        tgt = by_month.get((m["month"], m["product"]))
        if tgt is None:
            into["monthly"].append(m)
            continue
        for k in SERIES:
            if m.get(k) is not None:
                tgt[k] = (tgt.get(k) or 0) + m[k]
    into["monthly"].sort(key=lambda m: (m["month"], m["product"]))

    by_q = {(t["quarter"], t["fy_year"], t["product"]): t for t in into["targets"]}
    for t in other["targets"]:
        tgt = by_q.get((t["quarter"], t["fy_year"], t["product"]))
        if tgt is None:
            into["targets"].append(t)
            continue
        for k in ("target", "achievement"):
            if t.get(k) is not None:
                tgt[k] = (tgt.get(k) or 0) + t[k]
    into["targets"].sort(key=lambda t: (t["period_start"], t["product"]))

    codes = [c.strip() for c in
             f"{into.get('dealer_codes') or ''},{other.get('dealer_codes') or ''}".split(",")
             if c.strip()]
    into["dealer_codes"] = ", ".join(dict.fromkeys(codes)) or None


def parse_dealer_data(sheet_id: str):
    """Returns (records, skipped_tabs, errors)."""
    return parse_dealer_grids(_fetch_all_grids(sheet_id))

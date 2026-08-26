"""
AutoForm MIS — OE OEM-level target summary sync.

One workbook per financial year ("TGT SUMMARY SHEET ALL OEM 2026-27"), one tab
per OEM, one row per product, and four columns per month:

    A2='PRODUCT'  B2='25~26 Qty'  C2='25~26 Value'  D2='26~27 Target Qty' …
                  H2='April Qty Target'  I2='April Value Target'
                  J2='Apr Qty Actual'    K2='Apr Value Actual'  …
                  T2="TOTAL AMJ'26 TGT QTY" …
    A3='Seat Covers'   A6='TOTAL'   ← TOTAL is not ingested

This is NOT the same thing as services/oe_targets_sync.py. That file reads the
quarterly workbook where the same money is split across SALESPEOPLE. This one
is the commitment made to each BRAND for the year. Different files, different
grain, and the two must never be added together.

What is deliberately NOT ingested, and why:

  • The annual columns ("26~27 Target Qty", "Total Qty"). Verified across all
    five tabs to be exactly the sum of the twelve monthly columns, so storing
    them would only give them room to drift from their own inputs.
  • The quarter TOTAL blocks. Same reason — and worse, their ACH columns read
    0 for quarters that have not started while every underlying month is
    blank. Ingesting that would turn "not published yet" into a measured zero,
    which is the one thing this module refuses to do. Quarters are summed from
    months at read time, so an unstarted quarter stays absent.

Two shape hazards the parser is built around:

  • MONEY SCALE IS MIXED WITHIN A TAB. MSIL's monthly columns are full rupees
    (39,000,000) while its quarter totals are crores (11.7); TATA's Apr–Jun
    ACTUAL value is crores (3.58) while the TARGET value in the very same row
    is rupees (37,008,000), and in July both flip to rupees. So the scale is
    detected per COLUMN, not per tab or per block, from the implied unit price
    — rupees and crores sit 10^7 apart and cannot be confused. Values are
    stored in rupees and the detected scale is kept per figure.
  • HEADERS DRIFT. The same month is 'Jun Qty' on MSIL, 'Jun Qty Target' on
    TATA and 'Jun Qty TGT' on MAHINDRA; September is 'Sept' for the target and
    'Sep' for the actual. Columns are therefore matched by regex on the header
    text and never by position — matching by position is what would silently
    drop MAHINDRA's June and make its year look 8,029 units short.

Quantities are fractional on purpose (HYUNDAI seat covers: 59,896.49 for the
year) and are never rounded.
"""
import re
from statistics import median
from typing import Optional

from services.oe_network_sync import (
    _clean, _cut, _fetch_all_grids, _norm_header, _to_number,
)
from services.oe_targets_sync import (
    MONTH_TOKENS, QUARTER_MONTHS, _SCALES, _MIN_UNIT_PRICE, _MAX_UNIT_PRICE,
    _period_year,
)

_MONTH_QUARTER = {m: q for q, months in QUARTER_MONTHS.items() for m in months}

# Row labels that are the sheet adding up its own rows. Never ingested.
_TOTAL_LABELS = {"TOTAL", "GRAND TOTAL", "SUB TOTAL", "SUBTOTAL", "G TOTAL"}

# "April Qty Target" / "Jun Qty" / "Jun Qty TGT" / "Sep Value Actual".
# The suffix is what separates a target column from an actual one; its ABSENCE
# means target, because four of the five tabs drop the word on most months.
_MONTH_COL_RE = re.compile(
    r"^(?P<month>[A-Z]+)\s+(?P<measure>QTY|VALUE)"
    r"(?:\s+(?P<kind>TARGET|TGT|ACTUAL))?$"
)
# "25~26 Qty" — last year's actual. The lookalike "26~27 Target Qty" carries
# TARGET and is skipped by the same pattern refusing to match it.
_PRIOR_FY_RE = re.compile(r"^(?P<a>\d{2})\s*~\s*(?P<b>\d{2})\s+(?P<measure>QTY|VALUE)$")

_PRODUCT_KEYS = (
    ("SC", re.compile(r"SEAT\s*COVER")),
    ("MAT", re.compile(r"\bMATS?\b")),
    ("STEERING", re.compile(r"STEERING")),
    ("ACC", re.compile(r"ACCESSOR|DOCKET")),
)


def _product_key(product: str) -> str:
    """Coarse bucket so products can be compared across OEMs that name them
    differently ('Seat Covers', 'SEAT COVERS (PASSANGER)', 'Seat Cover').

    Order matters: 'Docket + Accessories' must land on ACC, and MAHINDRA's
    'SEAT COVERS (COMMERCIAL)' and 'SEAT COVERS (PASSANGER)' must both land on
    SC while staying two separate rows — the bucket is for comparison, never
    for identity. Anything the sheet invents next (Pet Barrier, Tire Table)
    falls through to OTHER rather than being forced into a bucket.
    """
    up = product.upper()
    for key, pattern in _PRODUCT_KEYS:
        if pattern.search(up):
            return key
    return "OTHER"


def _detect_scale(ratios: list):
    """(scale_name, multiplier, problem). Same implied-unit-price test as the
    quarterly sync, applied one column at a time because this workbook changes
    scale between two adjacent columns of one row.
    """
    if not ratios:
        return None, None, None          # nothing to scale — see _column_scale
    med = median(ratios)
    fits = [(name, mult) for name, mult in _SCALES
            if _MIN_UNIT_PRICE <= med * mult <= _MAX_UNIT_PRICE]
    if len(fits) == 1:
        name, mult = fits[0]
        return name, mult, None
    return None, None, (
        f"value/qty = {med:.6g}, which implies ₹{med:,.2f}/unit as rupees"
    )


def _column_scale(rows: list, nos_col: Optional[int], val_col: Optional[int]):
    """(scale_name, multiplier, problem) for one money column, gauged against
    the quantity column beside it.

    A column with nothing to gauge is not a failure: if no row has both a
    quantity and a value, every value in it is blank or zero, and zero is the
    same number in every scale. That case returns a multiplier of 1.0 with no
    scale recorded, so the sync does not raise a complaint nobody can act on.
    """
    ratios = []
    if nos_col is not None and val_col is not None:
        for row in rows:
            nos, val = _cell(row, nos_col), _cell(row, val_col)
            if nos and val and nos > 0 and val > 0:
                ratios.append(val / nos)
    name, mult, problem = _detect_scale(ratios)
    if name is None and problem is None:
        return None, 1.0, None
    return name, (mult if mult is not None else 1.0), problem


def _cell(row: list, idx: Optional[int]) -> Optional[float]:
    if idx is None or idx >= len(row):
        return None
    return _to_number(row[idx])


def _header_row(grid: list) -> Optional[int]:
    """The row that names the columns. Found by content: the tab opens with a
    title row, and inserting another one above it must not shift the parse.
    """
    for r_idx, line in enumerate(grid[:10]):
        if not line:
            continue
        if _norm_header(line[0]) == "PRODUCT":
            return r_idx
    # No PRODUCT cell — fall back to whichever early row looks most like a
    # header, so a renamed corner cell degrades to a warning rather than a
    # silently empty tab.
    best, best_hits = None, 0
    for r_idx, line in enumerate(grid[:10]):
        hits = sum(1 for v in line or [] if _MONTH_COL_RE.match(_norm_header(v)))
        if hits > best_hits:
            best, best_hits = r_idx, hits
    return best if best_hits >= 4 else None


def _month_columns(header: list):
    """{month_no: {'tgt_nos', 'tgt_value', 'ach_nos', 'ach_value'}}.

    Driven entirely by header text. The quarter TOTAL columns carry a "TOTAL "
    prefix and so cannot match, which is what keeps them out without naming
    them — a new quarter block needs no code change.
    """
    out: dict = {}
    for c_idx, raw in enumerate(header):
        m = _MONTH_COL_RE.match(_norm_header(raw))
        if not m:
            continue
        month = MONTH_TOKENS.get(m.group("month"))
        if month is None:
            continue
        prefix = "ach" if m.group("kind") == "ACTUAL" else "tgt"
        field = f"{prefix}_{'nos' if m.group('measure') == 'QTY' else 'value'}"
        # First match wins: a duplicated header is a source mistake, and taking
        # the earlier column keeps a re-sync of the same sheet stable.
        out.setdefault(month, {}).setdefault(field, c_idx)
    return out


def _prior_fy_columns(header: list):
    """(nos_col, value_col, label) for the "25~26 Qty / Value" pair."""
    nos_col = val_col = label = None
    for c_idx, raw in enumerate(header):
        m = _PRIOR_FY_RE.match(_norm_header(raw))
        if not m:
            continue
        label = f"{m.group('a')}~{m.group('b')}"
        if m.group("measure") == "QTY":
            nos_col = c_idx if nos_col is None else nos_col
        else:
            val_col = c_idx if val_col is None else val_col
    return nos_col, val_col, label


def _data_rows(grid: list, header_idx: int):
    """Product rows, stopping at the sheet's own TOTAL row.

    Rows below TOTAL are not read at all. That is a real rule, not tidiness:
    the tabs are 1,000 rows tall with only formatting below the block, and a
    stray note typed under the total must not become a product.
    """
    rows = []
    for line in grid[header_idx + 1:]:
        label = _clean(line[0]) if line else None
        if not label:
            continue
        if label.strip().upper() in _TOTAL_LABELS:
            break
        rows.append(line)
    return rows


def parse_oem_targets(sheet_id: str, fy_year: int):
    """Fetch the workbook and parse it. See parse_oem_grids for the rules."""
    return parse_oem_grids(_fetch_all_grids(sheet_id), fy_year)


def parse_oem_grids(grids: dict, fy_year: int):
    """(month_records, annual_records, skipped_tabs, errors).

    month_records are one per OEM × product × month; annual_records are one per
    OEM × product carrying last year's actual, which has no month and therefore
    cannot live on the monthly rows without multiplying by twelve.

    Split from the fetch so the shape rules — scale detection, absent vs zero,
    the drifting headers — can be tested on a grid without a network call.
    """
    month_records: list = []
    annual_records: list = []
    skipped_tabs: list = []
    errors: list = []

    for title, grid in grids.items():
        oem = _clean(title)
        if not oem or not grid:
            skipped_tabs.append(title)
            continue

        header_idx = _header_row(grid)
        if header_idx is None:
            skipped_tabs.append(title)
            errors.append(f"{title}: no header row found — tab skipped.")
            continue

        header = grid[header_idx]
        months = _month_columns(header)
        rows = _data_rows(grid, header_idx)
        if not months or not rows:
            skipped_tabs.append(title)
            errors.append(
                f"{title}: found {len(months)} month columns and {len(rows)} product "
                f"rows — tab skipped.")
            continue

        # Every month of the year should be present. Say so when one is missing
        # rather than quietly reporting a smaller year: a month lost to a
        # header typo looks exactly like a month nobody set a target for.
        missing = sorted(set(range(1, 13)) - set(months))
        if missing:
            errors.append(
                f"{title}: no target columns for month(s) "
                f"{', '.join(str(m) for m in missing)} — that month is absent from "
                f"the year, check the column headers.")

        # Scales, one column at a time — see the module docstring.
        scales: dict = {}
        for month, cols in months.items():
            for prefix in ("tgt", "ach"):
                name, mult, problem = _column_scale(
                    rows, cols.get(f"{prefix}_nos"), cols.get(f"{prefix}_value"))
                scales[(month, prefix)] = (name, mult)
                if problem:
                    errors.append(
                        f"{title}: could not tell what money scale the "
                        f"month-{month} {'target' if prefix == 'tgt' else 'actual'} "
                        f"value column uses ({problem}) — stored as written.")

        py_nos_col, py_val_col, py_label = _prior_fy_columns(header)
        py_name, py_mult, py_problem = _column_scale(rows, py_nos_col, py_val_col)
        if py_problem:
            errors.append(
                f"{title}: could not tell what money scale the {py_label or 'prior year'} "
                f"value column uses ({py_problem}) — stored as written.")

        seen: set = set()
        for line in rows:
            product = _cut(_clean(line[0]), 120)
            if not product:
                continue
            key = product.upper()
            if key in seen:
                errors.append(
                    f"{title}: product {product!r} appears more than once — only the "
                    f"first row was read.")
                continue
            seen.add(key)
            pkey = _product_key(product)

            for month, cols in sorted(months.items()):
                tgt_scale, tgt_mult = scales[(month, "tgt")]
                ach_scale, ach_mult = scales[(month, "ach")]
                tgt_nos = _cell(line, cols.get("tgt_nos"))
                tgt_val = _cell(line, cols.get("tgt_value"))
                ach_nos = _cell(line, cols.get("ach_nos"))
                ach_val = _cell(line, cols.get("ach_value"))
                # A month with nothing at all is not written. Writing a row of
                # NULLs would make "this OEM publishes nothing for March"
                # indistinguishable from "March is in the table with no
                # numbers", and the tab decides what to draw from what exists.
                if tgt_nos is None and tgt_val is None and ach_nos is None and ach_val is None:
                    continue
                month_records.append({
                    "fy_year": fy_year,
                    "period_year": _period_year(fy_year, month),
                    "period_month": month,
                    "quarter": _MONTH_QUARTER[month],
                    "oem": _cut(oem, 50),
                    "product": product,
                    "product_key": pkey,
                    "tgt_nos": tgt_nos,
                    "tgt_value": None if tgt_val is None else tgt_val * tgt_mult,
                    "ach_nos": ach_nos,
                    "ach_value": None if ach_val is None else ach_val * ach_mult,
                    "tgt_value_scale": tgt_scale,
                    "ach_value_scale": ach_scale,
                })

            py_nos = _cell(line, py_nos_col)
            py_val = _cell(line, py_val_col)
            if py_nos is not None or py_val is not None:
                annual_records.append({
                    "fy_year": fy_year,
                    "oem": _cut(oem, 50),
                    "product": product,
                    "product_key": pkey,
                    "py_nos": py_nos,
                    "py_value": None if py_val is None else py_val * py_mult,
                    "py_value_scale": py_name,
                })

    if not month_records:
        errors.append("No OEM target rows were found in this workbook.")
    return month_records, annual_records, skipped_tabs, errors

"""
AutoForm MIS — OE Quarterly Targets Sync

One spreadsheet per quarter; each tab holds stacked blocks, one per OEM and
product. A block is:

    A1="TATA SEAT COVER (AMJ'26)"  B1='APR TGT NOS'  C1='APR TGT VALUE' ...
    A2='UMESH- WEST/CENTRAL'       B2=4291           C2=13233585 ...
    A8='TOTAL'                     ← ignored, we add up the rows ourselves
    A9='ACCESSORIES'               ← a PRODUCT LINE, not a seventh salesperson
    A10='TOTAL'                    ← grand total (people + accessories), ignored

Everything is found by shape, not by name:
  • Blocks are located by header signature ("<PREFIX> TGT NOS"), so tab titles,
    block order and the number of blocks are all free to change.
  • Month columns come from the header prefixes (APR/MAY/JUNE), which is the
    only reliable source — block titles tag the quarter inconsistently ("MSIL
    AMJ" has a bare tag, "TATA SEAT COVER (AMJ'26)" a parenthesised one, "TATA
    SC" none at all). The registered quarter supplies the year and is
    cross-checked against both the months found and any tag in the title.
  • The sheet's TOTAL rows and TOTAL columns are deliberately not ingested.
    They drift from the underlying rows (±1 rounding on every block, and an
    earlier copy of this sheet had TOTAL pointed at the wrong column entirely),
    so the MIS adds up its own numbers.

ACCESSORIES are booked two different ways by the same workbook, and both are
real:
  • MSIL and TATA put accessories on ONE unattributed row inside the seat-cover
    block, between the people subtotal and the grand total. Nobody owns that
    number — it is an OEM-level product line. It is stored with category 'ACC'
    and salesperson NULL, never as a person.
  • MAHINDRA / HYUNDAI / KIA give accessories their own block ("KIA ACC
    (AMJ'26)") split across the same six salespeople, so those rows are stored
    with category 'ACC' and a real salesperson.
Because a block is scanned to its full extent (up to the next block header)
rather than stopping at the first TOTAL, both shapes fall out of the same walk.

Money scale is DETECTED per block, because the source mixes scales with
identical headers and no marker: MSIL/TATA are full rupees (₹13,233,585) while
HYUNDAI/KIA/MAHINDRA are crores (0.42). See _detect_scale.
"""
import re
from statistics import median
from typing import Optional

from services.oe_network_sync import (
    _clean, _cut, _fetch_all_grids, _norm_header, _to_number,
)

# Indian FY quarters: Q1 = Apr-May-Jun.
QUARTER_MONTHS = {1: (4, 5, 6), 2: (7, 8, 9), 3: (10, 11, 12), 4: (1, 2, 3)}
QUARTER_TAGS = {1: "AMJ", 2: "JAS", 3: "OND", 4: "JFM"}

MONTH_TOKENS = {
    "JAN": 1, "JANUARY": 1, "FEB": 2, "FEBRUARY": 2, "MAR": 3, "MARCH": 3,
    "APR": 4, "APRIL": 4, "MAY": 5, "JUN": 6, "JUNE": 6, "JUL": 7, "JULY": 7,
    "AUG": 8, "AUGUST": 8, "SEP": 9, "SEPT": 9, "SEPTEMBER": 9,
    "OCT": 10, "OCTOBER": 10, "NOV": 11, "NOVEMBER": 11, "DEC": 12, "DECEMBER": 12,
}

# Product categories as the block titles spell them. Unknown suffixes pass
# through uppercased rather than being forced into this list.
ACC_CATEGORY = "ACC"
CATEGORY_ALIASES = {
    "SC": "SC", "SEAT COVER": "SC", "SEAT COVERS": "SC", "SEATCOVER": "SC",
    "MAT": "MAT", "MATS": "MAT",
    "ACC": ACC_CATEGORY, "ACCESSORY": ACC_CATEGORY, "ACCESSORIES": ACC_CATEGORY,
}
# Blocks with no category suffix are seat covers — confirmed with the business.
# Only MSIL still titles its block that way ("MSIL AMJ"); every other OEM now
# names the product ("TATA MAT (AMJ'26)").
DEFAULT_CATEGORY = "SC"

# Row labels inside a block that are not salespeople. TOTAL rows are never
# ingested (see module docstring); ACCESSORIES rows are, as an unattributed
# product line.
_TOTAL_LABELS = {"TOTAL", "GRAND TOTAL", "SUB TOTAL", "SUBTOTAL", "TOTAL ", "G TOTAL"}
_ACC_ROW_LABELS = {"ACC", "ACCESSORY", "ACCESSORIES", "ACC TOTAL", "ACCESSORIES TOTAL"}

_TGT_NOS_RE = re.compile(r"^(?P<prefix>.+?)\s+TGT\s+NOS$")

# The quarter tag in a block title, in every form the workbook uses: bare
# ("MSIL AMJ"), or parenthesised with a two-digit year ("TATA MAT (AMJ'26)").
# The year is the CALENDAR year of the quarter's first month, so JFM'27 is Q4
# of FY26-27 — that is how it gets cross-checked against the registration.
_QTAG_RE = re.compile(
    r"\(?\s*\b(?P<tag>AMJ|JAS|OND|JFM)\b(?:\s*['’]?\s*(?P<yy>\d{2,4}))?\s*\)?"
)

# A block's money column is in one of these scales. We pick the one whose
# implied unit price (value / nos) lands in a plausible band — this separates
# rupees from crores by a factor of 10^7 and can't confuse crores with lakhs.
_SCALES = [("rupees", 1.0), ("lakhs", 1e5), ("crores", 1e7)]
_MIN_UNIT_PRICE = 100.0
_MAX_UNIT_PRICE = 20000.0


def _period_year(fy_year: int, month: int) -> int:
    """Indian FY: Apr-Dec sit in the FY start year, Jan-Mar in the next one."""
    return fy_year if month >= 4 else fy_year + 1


def _split_name_region(v):
    """'UMESH- WEST/CENTRAL' -> ('UMESH', 'WEST/CENTRAL'). Region is optional."""
    s = _clean(v)
    if not s:
        return None, None
    name, _, region = s.partition("-")
    name = " ".join(name.split())
    region = " ".join(region.split())
    return (name or None), (region or None)


def _split_oem_category(title: str):
    """(oem, category, quarter_tag, year_2digit) from a block title.

    "TATA SEAT COVER (AMJ'26)" -> ('TATA', 'SC',  'AMJ', 26)
    "MSIL AMJ"                 -> ('MSIL', 'SC',  'AMJ', None)
    "KIA ACC (AMJ'26)"         -> ('KIA',  'ACC', 'AMJ', 26)
    "TATA SC"                  -> ('TATA', 'SC',  None,  None)

    The quarter tag is stripped wherever it sits and whatever punctuation it
    wears; the first remaining word is the OEM and the rest is the category.
    Nothing is matched against a list of OEM names.
    """
    norm = _norm_header(title)
    tag = yy = None
    m = _QTAG_RE.search(norm)
    if m:
        tag = m.group("tag")
        yy = int(m.group("yy")) % 100 if m.group("yy") else None
        norm = (norm[:m.start()] + " " + norm[m.end():])

    words = norm.split()
    if not words:
        return None, None, tag, yy
    oem = words[0]
    rest = " ".join(words[1:]).strip()
    if not rest:
        return oem, DEFAULT_CATEGORY, tag, yy
    return oem, CATEGORY_ALIASES.get(rest, rest), tag, yy


def _classify_row(label: str) -> str:
    """'total' | 'accessories' | 'person' for a block's column-A label."""
    key = _norm_header(label)
    if key in _TOTAL_LABELS:
        return "total"
    if key in _ACC_ROW_LABELS:
        return "accessories"
    return "person"


def _detect_scale(rows: list, tgt_nos_cols: list, tgt_val_cols: list):
    """(scale_name, multiplier, note). Uses the implied unit price so a block
    can't be misread by 100x — the source mixes rupees and crores between tabs
    under identical headers.

    Every data row in the block feeds this, accessories included: they share the
    block's columns and therefore its scale by construction. Accessories carry a
    ~10x lower unit price than seat covers, which cannot reach across the 10^5
    gap between two scales, so the median stays unambiguous either way.
    """
    ratios = []
    for row in rows:
        for nc, vc in zip(tgt_nos_cols, tgt_val_cols):
            nos, val = _cell(row, nc), _cell(row, vc)
            if nos and val and nos > 0 and val > 0:
                ratios.append(val / nos)
    if not ratios:
        return "rupees", 1.0, "no target values to gauge the money scale — assumed rupees"

    med = median(ratios)
    fits = [(name, mult) for name, mult in _SCALES
            if _MIN_UNIT_PRICE <= med * mult <= _MAX_UNIT_PRICE]
    if len(fits) == 1:
        name, mult = fits[0]
        return name, mult, None
    return None, None, (
        f"could not tell what scale the money columns use "
        f"(value/nos = {med:.6g}, implies ₹{med:,.2f}/unit as rupees)"
    )


def _cell(row: list, idx: Optional[int]) -> Optional[float]:
    if idx is None or idx >= len(row):
        return None
    return _to_number(row[idx])


def _find_blocks(grid: list) -> list:
    """Row indexes of every block header row in a tab: any row that names at
    least one '<PREFIX> TGT NOS' column and carries a title in column A."""
    out = []
    for r_idx, line in enumerate(grid):
        if not line or not _clean(line[0]):
            continue
        if any(_TGT_NOS_RE.match(_norm_header(v)) for v in line[1:]):
            out.append(r_idx)
    return out


def _month_groups(header: list):
    """[(month_no, tgt_nos_col, tgt_val_col, ach_nos_col, ach_val_col)].

    Driven entirely by the header text, so TOTAL groups (whether they read
    'TOTAL TGT NOS' or 'AMJ TOTAL TGT NOS') fall out naturally: their prefix
    isn't a month. The bare 'ACH %' columns the sheet repeats after every month
    are ignored for the same reason — nothing keys off them.
    """
    cols = {}
    for c_idx, v in enumerate(header):
        h = _norm_header(v)
        if h:
            cols.setdefault(h, c_idx)

    groups = []
    for h, c_idx in cols.items():
        m = _TGT_NOS_RE.match(h)
        if not m:
            continue
        prefix = m.group("prefix").strip()
        month = MONTH_TOKENS.get(prefix)
        if month is None:              # TOTAL / AMJ TOTAL / anything not a month
            continue
        groups.append((
            month, c_idx,
            cols.get(f"{prefix} TGT VALUE"),
            cols.get(f"{prefix} ACH NOS"),
            cols.get(f"{prefix} ACH VALUE"),
        ))
    return sorted(groups)


def _check_title_quarter(where, tag, yy, fy_year, quarter, errors):
    """A block title that names its own quarter is free cross-checking against
    what was registered — picking the wrong quarter at registration is the
    easiest mistake to make here and is otherwise silent."""
    if tag and tag != QUARTER_TAGS[quarter]:
        errors.append(
            f"{where}: block is titled {tag} but the sheet was registered as "
            f"{QUARTER_TAGS[quarter]} — rows were stored under the registered quarter"
        )
    if yy is not None:
        expect = _period_year(fy_year, QUARTER_MONTHS[quarter][0]) % 100
        if yy != expect:
            errors.append(
                f"{where}: block is titled '{yy:02d} but the registered quarter "
                f"falls in 20{expect:02d} — rows were stored under the registration"
            )


def parse_targets(sheet_id: str, fy_year: int, quarter: int):
    """(records, skipped_tabs, errors) for one quarter's spreadsheet."""
    grids = _fetch_all_grids(sheet_id)
    records, skipped_tabs, errors = [], [], []
    expected = set(QUARTER_MONTHS[quarter])

    for title, grid in grids.items():
        block_rows = _find_blocks(grid)
        if not block_rows:
            skipped_tabs.append(title)
            continue

        for b_idx, hdr_idx in enumerate(block_rows):
            header = grid[hdr_idx]
            block_title = _clean(header[0]) or "?"
            where = f"{title} · {block_title}"

            oem, category, tag, yy = _split_oem_category(block_title)
            if not oem:
                errors.append(f"{where}: block has no OEM title — skipped")
                continue
            _check_title_quarter(where, tag, yy, fy_year, quarter, errors)

            groups = _month_groups(header)
            if not groups:
                errors.append(f"{where}: no month columns found — skipped")
                continue

            found_months = {g[0] for g in groups}
            if not found_months <= expected:
                stray = sorted(found_months - expected)
                errors.append(
                    f"{where}: has month column(s) {stray} outside "
                    f"{QUARTER_TAGS[quarter]} — those columns were ignored"
                )
                groups = [g for g in groups if g[0] in expected]
            missing = expected - found_months
            if missing:
                errors.append(f"{where}: no columns for month(s) {sorted(missing)}")

            # The block runs to the next block header (or the end of the tab)
            # rather than to the first TOTAL — MSIL and TATA park an
            # ACCESSORIES row *after* their people subtotal, and stopping at
            # TOTAL silently dropped it along with the whole product line.
            end = block_rows[b_idx + 1] if b_idx + 1 < len(block_rows) else len(grid)

            data_rows, seen_total = [], False
            for r in range(hdr_idx + 1, end):
                line = grid[r] if r < len(grid) else None
                label = _clean(line[0]) if line else None
                if not label:
                    continue
                kind = _classify_row(label)
                if kind == "total":
                    seen_total = True
                    continue
                if kind == "person" and seen_total:
                    # Everything below the subtotal should be a product line.
                    # A name down here is more likely a stray note than a
                    # seventh salesperson, so say so rather than book it quietly.
                    errors.append(
                        f"{where}: row '{label}' sits below a TOTAL row and was read as "
                        f"a salesperson — check it is not a product line the parser "
                        f"doesn't recognise"
                    )
                data_rows.append((kind, line))

            if not data_rows:
                errors.append(f"{where}: no data rows — skipped")
                continue

            scale_name, mult, note = _detect_scale(
                [line for _, line in data_rows], [g[1] for g in groups], [g[2] for g in groups]
            )
            if mult is None:
                errors.append(f"{where}: {note} — block skipped")
                continue
            if note:
                errors.append(f"{where}: {note}")

            for kind, line in data_rows:
                if kind == "accessories":
                    # An OEM-level product line nobody owns: category ACC and
                    # NO salesperson, so it never becomes a person in a filter,
                    # a ranking or a per-head average.
                    row_category, salesperson, region = ACC_CATEGORY, None, None
                else:
                    salesperson, region = _split_name_region(line[0])
                    if not salesperson:
                        continue
                    row_category = category

                for month, nc, vc, anc, avc in groups:
                    tgt_nos, ach_nos = _cell(line, nc), _cell(line, anc)
                    tgt_val, ach_val = _cell(line, vc), _cell(line, avc)
                    if tgt_nos is None and ach_nos is None and tgt_val is None and ach_val is None:
                        continue
                    records.append({
                        "fy_year": fy_year,
                        "quarter": quarter,
                        "period_year": _period_year(fy_year, month),
                        "period_month": month,
                        "oem": _cut(oem, 50),
                        "category": _cut(row_category, 30),
                        "salesperson": _cut(salesperson, 100),
                        "region": _cut(region, 100),
                        "tgt_nos": tgt_nos,
                        "tgt_value": tgt_val * mult if tgt_val is not None else None,
                        "ach_nos": ach_nos,
                        "ach_value": ach_val * mult if ach_val is not None else None,
                        "value_scale": scale_name,
                    })

    return records, skipped_tabs, errors

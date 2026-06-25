"""
AutoForm MIS — Depot to Distributor Sales Sync
Parses one quarterly Google Sheet (Distributor | Area Head | TARGET |
<MON> SAM | <MON> EV | ... | <pct>) into clean per-month/per-category facts.

One registered sheet = one quarter. The sheet's own per-ASM TOTAL and final
GRAND TOTAL rows are captured as their own entity types (area_head_total,
grand_total) and used as-is — the goal is to mirror the sheet, not audit it.
A TOTAL row can carry a manual adjustment with no corresponding distributor
row (confirmed: a real business adjustment on one ASM's group, not a typo),
so group/company rollups must come from these rows directly rather than from
summing the distributor rows underneath them.

Month columns are discovered by regexing the month abbreviation straight out
of the header row's own text (e.g. "APR SAM", "JUN EV") rather than hardcoded
column positions, so the same parser works for any quarter's 3-month window —
only the calendar year is a manual input (the header text never carries one).
"""
import re
from typing import Optional, Tuple

from services.google_sheets import get_sheets_service

REQUIRED_HEADERS = {"DISTRIBUTOR", "AREA HEAD", "TARGET"}

_MONTH_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}
_MONTH_COL_RE = re.compile(
    r"^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(SAM|EV)$", re.IGNORECASE
)


# ── Grid helpers ──────────────────────────────────────────────────────────────

def _cell(grid, row: int, col: int):
    """1-indexed cell access, tolerant of short/missing rows (Sheets API rows are ragged)."""
    r, c = row - 1, col - 1
    if r < 0 or r >= len(grid):
        return None
    line = grid[r]
    if c < 0 or c >= len(line):
        return None
    v = line[c]
    return v if v not in ("", None) else None


def _to_number(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _normalize_name(v) -> Optional[str]:
    if v is None:
        return None
    s = " ".join(str(v).split())
    return s or None


def _find_header_row(grid) -> Optional[Tuple[int, dict]]:
    """Find the row containing DISTRIBUTOR / AREA HEAD / TARGET exactly; returns (row, {label: col})."""
    for r_idx, line in enumerate(grid, start=1):
        found = {}
        for c_idx, v in enumerate(line, start=1):
            if isinstance(v, str):
                vv = v.strip().upper()
                if vv in REQUIRED_HEADERS:
                    found[vv] = c_idx
        if REQUIRED_HEADERS.issubset(found.keys()):
            return r_idx, found
    return None


def _find_month_columns(grid, header_row: int) -> list:
    """Scan the header row for '<MON> SAM'/'<MON> EV' cells; returns [(col_idx, category, month_num), ...]."""
    cols = []
    line = grid[header_row - 1] if 0 <= header_row - 1 < len(grid) else []
    for c_idx, v in enumerate(line, start=1):
        if not isinstance(v, str):
            continue
        m = _MONTH_COL_RE.match(v.strip())
        if m:
            month = _MONTH_NUM[m.group(1).upper()]
            category = m.group(2).upper()
            cols.append((c_idx, category, month))
    return cols


# ── Pure grid parser (no network — directly testable) ───────────────────────

def parse_distributor_grid(grid, calendar_year: int) -> Tuple[list, list]:
    """Parse one already-fetched sheet grid. Returns (records, errors)."""
    errors: list = []
    found = _find_header_row(grid)
    if found is None:
        return [], ["Header row (Distributor / Area Head / TARGET) not found"]
    header_row, cols = found
    dist_col, area_col, target_col = cols["DISTRIBUTOR"], cols["AREA HEAD"], cols["TARGET"]

    month_cols = _find_month_columns(grid, header_row)
    if not month_cols:
        errors.append("No <MON> SAM / <MON> EV columns found in header row")

    records = []
    current_area_head: Optional[str] = None
    for r in range(header_row + 1, len(grid) + 1):
        label = _cell(grid, r, dist_col)
        if label is None:
            continue
        label_norm = str(label).strip().upper()

        if label_norm == "GRAND TOTAL":
            target = _to_number(_cell(grid, r, target_col))
            for col_idx, category, month in month_cols:
                amount = _to_number(_cell(grid, r, col_idx))
                if amount is None:
                    continue
                records.append({
                    "entity_type": "grand_total", "distributor": "GRAND TOTAL", "area_head": None,
                    "target": target, "sale_year": calendar_year, "sale_month": month,
                    "category": category, "amount": amount,
                })
            continue

        if label_norm == "TOTAL":
            target = _to_number(_cell(grid, r, target_col))
            for col_idx, category, month in month_cols:
                amount = _to_number(_cell(grid, r, col_idx))
                if amount is None:
                    continue
                records.append({
                    "entity_type": "area_head_total", "distributor": "TOTAL", "area_head": current_area_head,
                    "target": target, "sale_year": calendar_year, "sale_month": month,
                    "category": category, "amount": amount,
                })
            continue

        distributor = _normalize_name(label)
        area_head = _normalize_name(_cell(grid, r, area_col))
        target = _to_number(_cell(grid, r, target_col))
        entity_type = "distributor" if (area_head or target is not None) else "depot_direct"
        if entity_type == "distributor":
            current_area_head = area_head

        for col_idx, category, month in month_cols:
            amount = _to_number(_cell(grid, r, col_idx))
            if amount is None:
                continue
            records.append({
                "entity_type": entity_type,
                "distributor": distributor,
                "area_head": area_head if entity_type == "distributor" else None,
                "target": target if entity_type == "distributor" else None,
                "sale_year": calendar_year,
                "sale_month": month,
                "category": category,
                "amount": amount,
            })
    return records, errors


# ── Network wrapper ───────────────────────────────────────────────────────────

def fetch_distributor_grid(sheet_id: str):
    """Fetches the grid of a quarterly Depot-to-Distributor sheet's single tab."""
    service = get_sheets_service()
    meta = service.spreadsheets().get(spreadsheetId=sheet_id).execute()
    tabs = meta.get("sheets", [])
    if not tabs:
        return []
    tab_title = tabs[0]["properties"]["title"]
    resp = service.spreadsheets().values().get(
        spreadsheetId=sheet_id, range=f"'{tab_title}'!A1:J200"
    ).execute()
    return resp.get("values", [])


def parse_distributor_sheet(sheet_id: str, calendar_year: int) -> Tuple[list, list]:
    """Fetch + parse a registered Depot-to-Distributor sheet. Returns (records, errors)."""
    grid = fetch_distributor_grid(sheet_id)
    return parse_distributor_grid(grid, calendar_year)

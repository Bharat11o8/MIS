"""
AutoForm MIS — Plant-to-Depot Sales Sync
Reads the team's existing hand-maintained "Plant to Depot" Google Sheet as-is
(one messy pivot-style tab per month) and extracts clean records, with no
template change and no re-entry required from the team.

Design: the 4 category blocks (Seat Cover, Accessories, Mats, Electronics)
drift in absolute row/column position month to month, but the *relative*
offset from each block's label cell to its header/depot rows is identical
every month (verified against 6 real dummy month tabs). A label-anchored,
offset-relative parser therefore works regardless of where the block sits,
and never reads anything outside its own anchored window — which is also
why the stray junk columns and leftover one-off blocks that show up in some
months never need to be cleaned up by the team.
"""
import os
import json
import base64
import re
from typing import Optional, Tuple

from google.oauth2 import service_account
from googleapiclient.discovery import build

SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# ── Fixed vocab ──────────────────────────────────────────────────────────────
DEPOT_CANON = {
    "JANAK MOTORS": "Janak Motors",
    "UNITED AUTO-CHANDIGARH": "United Auto",
    "UNITED AUTO-LUDHIANA DEPO": "United Auto",
}

_MONTH_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}
_TAB_TITLE_RE = re.compile(
    r"(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\D{0,3}(\d{2,4})",
    re.IGNORECASE,
)

_TERMINATOR_LABELS = {"GRAND TOTAL", "TOTAL"}


# ── Google Sheets access ─────────────────────────────────────────────────────

def _load_service_account_info() -> dict:
    raw = (os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON") or "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON is not set")
    if raw.startswith("{"):
        return json.loads(raw)
    return json.loads(base64.b64decode(raw))


def _get_sheets_service():
    info = _load_service_account_info()
    creds = service_account.Credentials.from_service_account_info(info, scopes=SHEETS_SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def parse_tab_title(title: str) -> Optional[Tuple[int, int]]:
    """Extract (year, month) from a free-form tab title like 'JAN-26' or 'MAR 26'."""
    m = _TAB_TITLE_RE.search(title.upper())
    if not m:
        return None
    month = _MONTH_NUM[m.group(1)[:3]]
    year = int(m.group(2))
    if year < 100:
        year += 2000
    return year, month


def fetch_workbook_grids(sheet_id: str):
    """
    Returns (grids, skipped_tabs):
      grids        — {tab_title: (year, month, grid)}, grid = list of rows (ragged, 1-indexed via _cell)
      skipped_tabs — titles that didn't match a recognizable month/year
    """
    service = _get_sheets_service()
    meta = service.spreadsheets().get(spreadsheetId=sheet_id).execute()
    titles = [s["properties"]["title"] for s in meta.get("sheets", [])]

    recognized = []
    skipped_tabs = []
    for title in titles:
        ym = parse_tab_title(title)
        (recognized if ym else skipped_tabs).append((title, ym) if ym else title)

    grids = {}
    if recognized:
        ranges = [f"'{title}'!A1:AB120" for title, _ in recognized]
        resp = service.spreadsheets().values().batchGet(spreadsheetId=sheet_id, ranges=ranges).execute()
        for (title, (year, month)), value_range in zip(recognized, resp.get("valueRanges", [])):
            grids[title] = (year, month, value_range.get("values", []))

    return grids, skipped_tabs


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
        return None  # e.g. '#DIV/0!' in a Grand Total cell we don't care about


def _match_depot(label: str) -> Optional[str]:
    """
    Prefix match, not exact: depot-total rows are sometimes labelled with a
    trailing word (e.g. 'JANAK MOTORS ELECTRONICS') and — confirmed in the FEB-26
    dummy data — a depot's real amount can end up typed onto one of the ad hoc
    product-name sub-rows above it (e.g. 'JANAK MOTORS FOG LAMP') instead of the
    summary row. Summing every row whose label starts with a known depot name
    captures the value regardless of which exact row a human put it on, and is
    safe because nothing else in this workbook starts with these prefixes.
    """
    norm = label.strip().upper()
    for prefix, canon in DEPOT_CANON.items():
        if norm.startswith(prefix):
            return canon
    return None


def _find_label_row(grid, labels: list, required: set):
    """Find a row containing all `required` exact labels; returns (row, {label: col}) or None."""
    wanted = {l.upper() for l in labels}
    req = {l.upper() for l in required}
    for r_idx, line in enumerate(grid, start=1):
        found = {}
        for c_idx, v in enumerate(line, start=1):
            if isinstance(v, str):
                vv = v.strip().upper()
                if vv in wanted and vv not in found:
                    found[vv] = c_idx
        if req.issubset(found.keys()):
            return r_idx, found
    return None


def _find_terminator(grid, col: int, start_row: int, max_scan: int = 20) -> int:
    """First row >= start_row whose cell in `col` is 'Grand Total'/'TOTAL'. Falls back to start_row+max_scan."""
    for r in range(start_row, start_row + max_scan):
        v = _cell(grid, r, col)
        if isinstance(v, str) and v.strip().upper() in _TERMINATOR_LABELS:
            return r
    return start_row + max_scan


# ── Depot accumulation (sums United Auto-Chandigarh + United Auto-Ludhiana) ──

def _accumulate(acc: dict, depot: str, qty: Optional[float], amount: float):
    cur = acc.setdefault(depot, {"qty": 0.0, "has_qty": False, "amount": 0.0})
    cur["amount"] += amount
    if qty is not None:
        cur["qty"] += qty
        cur["has_qty"] = True


def _finalize(acc: dict, year: int, month: int, brand: str, category: str) -> list:
    records = []
    for depot, cur in acc.items():
        amount = round(cur["amount"], 2)
        qty = round(cur["qty"], 2) if cur["has_qty"] else None
        rate = round(amount / qty, 2) if qty else None
        records.append({
            "sale_year": year, "sale_month": month, "depot": depot,
            "brand": brand, "category": category,
            "qty": qty, "rate": rate, "amount": amount,
        })
    return records


# ── Per-category block extraction ────────────────────────────────────────────

def _extract_seat_cover(grid, year, month, tab, errors) -> list:
    found = _find_label_row(grid, ["AUTOCRUZE", "AUTOFORM"], {"AUTOCRUZE", "AUTOFORM"})
    if found is None:
        errors.append(f"{tab}: Seat Cover block not found")
        return []
    label_row, cols = found
    scan_start = label_row + 4  # label -> brand title; +3 header row; +1 first depot row
    records = []
    for brand_name, brand_col in (("Autocruze", cols["AUTOCRUZE"]), ("Autoform", cols["AUTOFORM"])):
        depot_col = brand_col - 1
        terminator = _find_terminator(grid, depot_col, scan_start)
        acc = {}
        for r in range(scan_start, terminator):
            label = _cell(grid, r, depot_col)
            if not isinstance(label, str):
                continue
            depot = _match_depot(label)
            if depot is None:
                errors.append(f"INFO: {tab} Seat Cover ({brand_name}): unrecognized row '{label}' at row {r}, skipped")
                continue
            amount = _to_number(_cell(grid, r, brand_col + 2))
            if amount is None:
                continue
            qty = _to_number(_cell(grid, r, brand_col))
            _accumulate(acc, depot, qty, amount)
        records += _finalize(acc, year, month, brand_name, "Seat Cover")
    return records


def _extract_accessories(grid, year, month, tab, errors) -> list:
    found = _find_label_row(grid, ["AFAC ACCESSORIES"], {"AFAC ACCESSORIES"})
    if found is None:
        errors.append(f"{tab}: Accessories block not found")
        return []
    label_row, cols = found
    label_col = cols["AFAC ACCESSORIES"]
    scan_start = label_row + 1  # no header row, depot rows start immediately
    terminator = _find_terminator(grid, label_col, scan_start)
    acc = {}
    for r in range(scan_start, terminator):
        label = _cell(grid, r, label_col)
        if not isinstance(label, str):
            continue
        depot = _match_depot(label)
        if depot is None:
            errors.append(f"INFO: {tab} Accessories: unrecognized row '{label}' at row {r}, skipped")
            continue
        amount = _to_number(_cell(grid, r, label_col + 3))
        if amount is None:
            continue
        _accumulate(acc, depot, None, amount)
    return _finalize(acc, year, month, "Combined", "Accessories")


def _extract_mats(grid, year, month, tab, errors) -> list:
    found = _find_label_row(
        grid,
        ["AUTOCRUZE MATS", "AUTOFORM MATS", "AUTOFORM BOOT & CABIN MAT"],
        {"AUTOCRUZE MATS", "AUTOFORM MATS"},
    )
    if found is None:
        errors.append(f"{tab}: Mats block not found")
        return []
    label_row, cols = found
    scan_start = label_row + 4
    records = []
    sub_blocks = [
        ("Autocruze", "Mats", cols.get("AUTOCRUZE MATS")),
        ("Autoform", "Mats", cols.get("AUTOFORM MATS")),
        ("Autoform", "Boot & Cabin Mat", cols.get("AUTOFORM BOOT & CABIN MAT")),
    ]
    for brand_name, category, label_col in sub_blocks:
        if label_col is None:
            if category == "Boot & Cabin Mat":
                errors.append(f"INFO: {tab}: Boot & Cabin Mat sub-block not found, skipped")
            continue
        terminator = _find_terminator(grid, label_col, scan_start)
        acc = {}
        for r in range(scan_start, terminator):
            label = _cell(grid, r, label_col)
            if not isinstance(label, str):
                continue
            depot = _match_depot(label)
            if depot is None:
                errors.append(f"INFO: {tab} Mats ({category}/{brand_name}): unrecognized row '{label}' at row {r}, skipped")
                continue
            amount = _to_number(_cell(grid, r, label_col + 3))
            if amount is None:
                continue
            qty = _to_number(_cell(grid, r, label_col + 1))
            _accumulate(acc, depot, qty, amount)
        records += _finalize(acc, year, month, brand_name, category)
    return records


def _extract_electronics(grid, year, month, tab, errors) -> list:
    found = _find_label_row(
        grid, ["AUTOCRUZE ELECTRONICS", "AUTOFORM ELECTRONICS"],
        {"AUTOCRUZE ELECTRONICS", "AUTOFORM ELECTRONICS"},
    )
    if found is None:
        errors.append(f"{tab}: Electronics block not found")
        return []
    label_row, cols = found
    scan_start = label_row + 4
    records = []
    for brand_name, label_col in (
        ("Autocruze", cols["AUTOCRUZE ELECTRONICS"]),
        ("Autoform", cols["AUTOFORM ELECTRONICS"]),
    ):
        terminator = _find_terminator(grid, label_col, scan_start)
        acc = {}
        for r in range(scan_start, terminator):
            label = _cell(grid, r, label_col)
            if not isinstance(label, str):
                continue
            depot = _match_depot(label)
            if depot is None:
                continue  # ad hoc product-name sub-row (LED/Android/Perfume/...) — expected noise here
            amount = _to_number(_cell(grid, r, label_col + 3))
            if amount is None:
                continue
            qty = _to_number(_cell(grid, r, label_col + 1))
            _accumulate(acc, depot, qty, amount)
        records += _finalize(acc, year, month, brand_name, "Electronics")
    return records


# ── Tab / workbook orchestration ─────────────────────────────────────────────

def parse_month_tab(year: int, month: int, grid, tab_title: str = "") -> Tuple[list, list]:
    """Parse one month tab's grid. Returns (records, errors)."""
    errors: list = []
    records: list = []
    records += _extract_seat_cover(grid, year, month, tab_title, errors)
    records += _extract_accessories(grid, year, month, tab_title, errors)
    records += _extract_mats(grid, year, month, tab_title, errors)
    records += _extract_electronics(grid, year, month, tab_title, errors)
    return records, errors


def parse_workbook(sheet_id: str) -> Tuple[list, list, list, list]:
    """
    Fetch + parse every recognized month tab.
    Returns (records, errors, skipped_tabs, covered_months).

    covered_months is every (year, month) that currently has a recognized tab in
    the sheet — including a month that parsed to zero records. The caller uses
    it to reconcile the DB against the sheet's current state: a month removed
    from the sheet (tab deleted) should disappear from the DB too, not just stop
    growing. Driven off this list rather than `records` alone so a tab that's
    still present but now fully blank doesn't get its stale rows left behind.
    """
    grids, skipped_tabs = fetch_workbook_grids(sheet_id)
    all_records: list = []
    all_errors: list = []
    covered_months: list = []
    for title, (year, month, grid) in grids.items():
        recs, errs = parse_month_tab(year, month, grid, tab_title=title)
        all_records += recs
        all_errors += errs
        covered_months.append((year, month))
    return all_records, all_errors, skipped_tabs, covered_months

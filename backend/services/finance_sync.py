"""
AutoForm MIS — Finance (Balance Sheet + P&L) Sync
Parses one company's Finance Google Sheet — one tab per financial year, each
tab holding a Balance Sheet block and a Profit & Loss block with however many
"as at"/date-range period columns the team currently has (a real FY tab will
have ~12 monthly columns; a dummy tab may have as few as 3) — never assumes a
fixed period count, everything is discovered via regex against the sheet's
own header text.

Mirrors the sheet, never audits it: the sheet's own "Total" rows (Balance
Sheet) and unlabeled subtotal / "Gross Profit :" / "Nett Profit:" rows (P&L)
are captured as their own entities and used as-is, never recomputed by
summing the line items above them — same principle already locked in for
Depot-to-Distributor's ASM totals.

Column layout is fixed across the whole sheet (col A = item number when the
row is a numbered line item, col B = label, then Amount/% column pairs from
col D onward) — this is a generated accounting export, not a hand-typed
pivot table, so unlike Plant-to-Depot's drifting blocks there's no need to
anchor column positions per block.
"""
import re
from datetime import date, datetime
from typing import Optional, Tuple

from services.google_sheets import get_sheets_service

ITEM_COL = 1
LABEL_COL = 2

_BS_ASAT_RE = re.compile(r"^AS AT\s+(.+)$", re.IGNORECASE)
_PL_RANGE_RE = re.compile(r"^(.+?)\s+TO\s+(.+)$", re.IGNORECASE)
_OUT_OF_SCOPE_TERMINATORS = {"SALES ACCOUNTS (BREAK UP)", "WORKING CAPITAL", "KEY FINANCIAL RATIOS"}
_HEADLINE_PL_LABELS = {"GROSS PROFIT", "NETT PROFIT"}


# ── Grid helpers (same idioms as every other sync service) ───────────────────

def _cell(grid, row: int, col: int):
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


def _to_item_no(v) -> Optional[int]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        if s.replace(".", "", 1).isdigit():
            return int(float(s))
    return None


def _slugify(label: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "_", label.strip().lower())
    return s.strip("_")


def _parse_sheet_date(s: str) -> Optional[date]:
    s = s.strip()
    for fmt in ("%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _find_row_with_label(grid, label: str, start_row: int = 1) -> Optional[int]:
    target = label.strip().upper()
    for r_idx in range(start_row, len(grid) + 1):
        v = _cell(grid, r_idx, LABEL_COL)
        if isinstance(v, str) and v.strip().upper() == target:
            return r_idx
    return None


# ── Period-column detection (count-agnostic — however many exist) ────────────

def _find_bs_period_columns(grid, header_row: int) -> list:
    cols = []
    line = grid[header_row - 1] if 0 <= header_row - 1 < len(grid) else []
    for c_idx, v in enumerate(line, start=1):
        if not isinstance(v, str):
            continue
        m = _BS_ASAT_RE.match(v.strip())
        if m:
            period_end = _parse_sheet_date(m.group(1))
            if period_end:
                cols.append((c_idx, c_idx + 1, period_end))
    return cols


def _find_pl_period_columns(grid, header_row: int) -> list:
    cols = []
    line = grid[header_row - 1] if 0 <= header_row - 1 < len(grid) else []
    for c_idx, v in enumerate(line, start=1):
        if not isinstance(v, str):
            continue
        m = _PL_RANGE_RE.match(v.strip())
        if m:
            start = _parse_sheet_date(m.group(1))
            end = _parse_sheet_date(m.group(2))
            if start and end:
                span_days = (end - start).days + 1
                period_type = "annual" if span_days > 60 else "monthly"
                cols.append((c_idx, c_idx + 1, start, end, period_type))
    return cols


# ── Balance Sheet ──────────────────────────────────────────────────────────────

def _walk_bs_section(grid, start_row: int, section_key: str, period_cols: list, max_scan: int = 30) -> Tuple[list, int]:
    records = []
    current_parent_key = None
    for r in range(start_row, start_row + max_scan):
        label_raw = _cell(grid, r, LABEL_COL)
        if label_raw is None:
            continue  # tolerate blank separator rows within the section
        label = str(label_raw).strip()
        label_norm = label.upper().rstrip(":").strip()

        if label_norm == "TOTAL":
            for amount_col, percent_col, period_end in period_cols:
                amount = _to_number(_cell(grid, r, amount_col))
                if amount is None:
                    continue
                records.append({
                    "section": section_key, "entity_type": "total", "item_no": None,
                    "line_key": f"{section_key}_total", "line_label": "Total", "parent_key": None,
                    "period_end_date": period_end, "amount": amount,
                    "percent": _to_number(_cell(grid, r, percent_col)),
                })
            return records, r + 1

        item_no = _to_item_no(_cell(grid, r, ITEM_COL))
        line_key = f"{section_key}_{_slugify(label)}"
        if item_no is not None:
            entity_type, parent_key = "line_item", None
            current_parent_key = line_key
        else:
            entity_type, parent_key = "detail", current_parent_key

        for amount_col, percent_col, period_end in period_cols:
            amount = _to_number(_cell(grid, r, amount_col))
            if amount is None:
                continue
            records.append({
                "section": section_key, "entity_type": entity_type, "item_no": item_no,
                "line_key": line_key, "line_label": label, "parent_key": parent_key,
                "period_end_date": period_end, "amount": amount,
                "percent": _to_number(_cell(grid, r, percent_col)),
            })
    return records, start_row + max_scan


def parse_balance_sheet_tab(grid, tab_title: str) -> Tuple[list, list]:
    errors: list = []
    sof_row = _find_row_with_label(grid, "Sources of Funds:")
    if sof_row is None:
        return [], [f"{tab_title}: 'Sources of Funds:' row not found"]

    period_cols = _find_bs_period_columns(grid, sof_row - 1)
    if not period_cols:
        errors.append(f"{tab_title}: no 'as at' period columns found for Balance Sheet")

    sources_records, next_row = _walk_bs_section(grid, sof_row + 1, "sources_of_funds", period_cols)

    aof_row = _find_row_with_label(grid, "Application of Funds:", start_row=next_row)
    application_records = []
    if aof_row is None:
        errors.append(f"{tab_title}: 'Application of Funds:' row not found")
    else:
        application_records, _ = _walk_bs_section(grid, aof_row + 1, "application_of_funds", period_cols)

    records = sources_records + application_records
    for rec in records:
        rec["tab_title"] = tab_title
    return records, errors


# ── Profit & Loss ──────────────────────────────────────────────────────────────

def _walk_pl_section(grid, start_row: int, period_cols: list, max_scan: int = 40) -> list:
    records = []
    section_key = "trading_account"
    current_parent_key = None
    last_seen_key = None
    last_seen_label = None

    for r in range(start_row, start_row + max_scan):
        label_raw = _cell(grid, r, LABEL_COL)

        if isinstance(label_raw, str):
            label_norm = label_raw.strip().upper().rstrip(":").strip()
            if label_norm in _OUT_OF_SCOPE_TERMINATORS:
                break
            if label_norm == "INCOME STATEMENT":
                section_key = "income_statement"
                current_parent_key = None
                continue
            if label_norm == "TRADING ACCOUNT":
                continue

        item_no = _to_item_no(_cell(grid, r, ITEM_COL))
        label = str(label_raw).strip() if isinstance(label_raw, str) else None

        if item_no is None and label is None:
            # Possible unlabeled subtotal row — the sheet's own computed total
            # for whatever comes above it (never recomputed by us).
            any_amount = any(_to_number(_cell(grid, r, ac)) is not None for ac, *_ in period_cols)
            if any_amount and last_seen_key:
                key = f"{section_key}_subtotal_after_{last_seen_key}"
                lbl = f"Subtotal (after {last_seen_label})"
                for amount_col, percent_col, p_start, p_end, p_type in period_cols:
                    amount = _to_number(_cell(grid, r, amount_col))
                    if amount is None:
                        continue
                    records.append({
                        "section": section_key, "entity_type": "subtotal", "item_no": None,
                        "line_key": key, "line_label": lbl, "parent_key": None,
                        "period_start_date": p_start, "period_end_date": p_end, "period_type": p_type,
                        "amount": amount, "percent": _to_number(_cell(grid, r, percent_col)),
                    })
                last_seen_key, last_seen_label = key, lbl
            continue

        if label is None:
            continue  # fully blank row, nothing to anchor

        line_key = f"{section_key}_{_slugify(label)}"
        if item_no is not None:
            label_key_norm = label.upper().rstrip(":").strip()
            entity_type = "total" if label_key_norm in _HEADLINE_PL_LABELS else "line_item"
            parent_key = None
            current_parent_key = line_key
        else:
            entity_type = "detail"
            parent_key = current_parent_key

        for amount_col, percent_col, p_start, p_end, p_type in period_cols:
            amount = _to_number(_cell(grid, r, amount_col))
            if amount is None:
                continue
            records.append({
                "section": section_key, "entity_type": entity_type, "item_no": item_no,
                "line_key": line_key, "line_label": label, "parent_key": parent_key,
                "period_start_date": p_start, "period_end_date": p_end, "period_type": p_type,
                "amount": amount, "percent": _to_number(_cell(grid, r, percent_col)),
            })
        last_seen_key, last_seen_label = line_key, label

    return records


def parse_profit_loss_tab(grid, tab_title: str) -> Tuple[list, list]:
    errors: list = []
    particulars_row = _find_row_with_label(grid, "Particulars")
    if particulars_row is None:
        return [], [f"{tab_title}: 'Particulars' row not found (P&L)"]

    period_cols = _find_pl_period_columns(grid, particulars_row)
    if not period_cols:
        errors.append(f"{tab_title}: no period-range columns found for P&L")

    trading_row = _find_row_with_label(grid, "Trading Account:", start_row=particulars_row)
    if trading_row is None:
        errors.append(f"{tab_title}: 'Trading Account:' row not found")
        return [], errors

    records = _walk_pl_section(grid, trading_row + 1, period_cols)
    for rec in records:
        rec["tab_title"] = tab_title
    return records, errors


# ── Per-tab / multi-tab orchestration ─────────────────────────────────────────

def parse_finance_tab(grid, tab_title: str) -> Tuple[dict, list]:
    bs_records, bs_errors = parse_balance_sheet_tab(grid, tab_title)
    pl_records, pl_errors = parse_profit_loss_tab(grid, tab_title)
    return {"balance_sheet": bs_records, "profit_loss": pl_records}, bs_errors + pl_errors


def fetch_finance_grids(sheet_id: str) -> dict:
    """Fetches every tab in the sheet — a Finance sheet has one tab per FY, all valid."""
    service = get_sheets_service()
    meta = service.spreadsheets().get(spreadsheetId=sheet_id).execute()
    titles = [s["properties"]["title"] for s in meta.get("sheets", [])]
    if not titles:
        return {}
    ranges = [f"'{t}'!A1:AF200" for t in titles]
    resp = service.spreadsheets().values().batchGet(spreadsheetId=sheet_id, ranges=ranges).execute()
    grids = {}
    for title, value_range in zip(titles, resp.get("valueRanges", [])):
        grids[title] = value_range.get("values", [])
    return grids


def parse_finance_workbook_grids(grids: dict) -> Tuple[dict, list, dict]:
    """Pure — no network. Unions every tab's records; returns covered periods for reconciliation."""
    all_records = {"balance_sheet": [], "profit_loss": []}
    all_errors: list = []
    covered = {"bs_period_ends": set(), "pl_periods": set()}

    for title, grid in grids.items():
        parsed, errors = parse_finance_tab(grid, title)
        all_errors += errors
        for rec in parsed["balance_sheet"]:
            all_records["balance_sheet"].append(rec)
            covered["bs_period_ends"].add(rec["period_end_date"])
        for rec in parsed["profit_loss"]:
            all_records["profit_loss"].append(rec)
            covered["pl_periods"].add((rec["period_start_date"], rec["period_end_date"]))

    return all_records, all_errors, covered


def fetch_and_parse_finance_workbook(sheet_id: str) -> Tuple[dict, list, dict]:
    grids = fetch_finance_grids(sheet_id)
    return parse_finance_workbook_grids(grids)

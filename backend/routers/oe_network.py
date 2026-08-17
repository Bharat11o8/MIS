"""
AutoForm MIS — OE Network Sales Router
Three sheet types under one module ("oe_network" permission key):
  • oe_visit_plan — one spreadsheet per calendar month, one tab per salesperson
  • oe_log_book   — one continuous Form-responses spreadsheet
  • oe_targets    — one spreadsheet per quarter, stacked OEM blocks per tab
Registry + manual sync follow the standard sheet_sources pattern; data endpoints
are filter-first (plans list, logs list, log analytics, plan-vs-actual coverage,
dealer directory, dealer-level plan adherence). Target analytics live in
routers/oe_targets.py; this file owns the registry and sync for all three.
"""
import calendar
import re
import uuid
from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError
from database import get_db
from models import SheetSource, SyncLog, User
from routers.auth import get_current_user
from services.dealer_resolve import DealerIndex
from services.google_sheets import extract_sheet_id
from services.oe_dealer_data_sync import parse_dealer_data, SERIES as DEALER_SERIES
from services.oe_network_sync import parse_visit_plan, parse_log_book
from services.oe_targets_sync import parse_targets, QUARTER_TAGS
from services.period_filters import parse_date as _parse_date, snap_to_months
from services.permissions import require_module
from services.sync_logs import SYNC_LOG_RETENTION, prune_sync_logs
from services.remark_themes import classify as classify_remark, THEMES, is_theme

router = APIRouter(prefix="/oe-network", tags=["OE Network"])

MODULE_KEY = "oe_network"
MODULE_PLAN = "oe_visit_plan"
MODULE_LOG = "oe_log_book"
MODULE_TGT = "oe_targets"
# The OE team's dealer file: one tab per OEM, one row per dealer outlet, with
# their vehicle sales and ours month by month plus the quarter targets. Unlike
# the other three this one feeds TWO tables (oe_dealer_monthly and
# oe_dealer_targets) and can create dealers, so it has its own sync path.
MODULE_DD = "oe_dealer_data"
OE_MODULES = (MODULE_PLAN, MODULE_LOG, MODULE_TGT, MODULE_DD)

# sheet_sources.quarter is VARCHAR(2) holding 'Q1'..'Q4' (Depot-to-Distributor
# set that convention); OE targets reuse it rather than add a second column.
QUARTERS = ("Q1", "Q2", "Q3", "Q4")

_MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"]

_SHEET_TYPES = {MODULE_PLAN: "visit_plan", MODULE_LOG: "log_book",
                MODULE_TGT: "targets", MODULE_DD: "dealer_data"}


def _require_access(db: Session, current_user: User):
    require_module(db, current_user, MODULE_KEY)


def _sheet_type(module: str) -> str:
    return _SHEET_TYPES.get(module, module)


# ── Salesperson matching (plan tabs say "PANKAJ", the form says "PANKAJ VIG") ──
# Two names refer to the same person when they share any token of 3+ letters,
# so initials ("D" in "D PRASHANTH KUMAR") never cause a false match.
def _name_tokens(name: Optional[str]) -> set:
    if not name:
        return set()
    return {t for t in re.split(r"[^A-Za-z]+", name.upper()) if len(t) >= 3}


def _names_match(a: Optional[str], b: Optional[str]) -> bool:
    return bool(_name_tokens(a) & _name_tokens(b))


# ── Dealer-name matching (plan says "Pratham", the form says "Pratham Motors") ──
# Generic trade words appear in almost every dealership name, so they can't be
# evidence that two names refer to the same dealer. Only if a name is NOTHING
# BUT generic words do we fall back to using them.
_DEALER_STOPWORDS = {
    "MOTORS", "MOTOR", "AUTO", "AUTOS", "AUTOMOBILES", "AUTOMOBILE", "AUTOMOTIVE",
    "CARS", "CAR", "WHEELS", "VEHICLES", "VEHICLE", "AGENCY", "AGENCIES",
    "ENTERPRISES", "ENTERPRISE", "TRADERS", "TRADING", "SALES", "SERVICE",
    "SERVICES", "PVT", "LTD", "PRIVATE", "LIMITED", "THE", "AND", "INDIA", "NEW",
}


def _dealer_tokens(name: Optional[str]) -> set:
    if not name:
        return set()
    toks = {t for t in re.split(r"[^A-Za-z0-9]+", name.upper()) if len(t) >= 3}
    return (toks - _DEALER_STOPWORDS) or toks


def _dealer_match_score(a_tokens: set, b_tokens: set) -> int:
    return len(a_tokens & b_tokens)


# ── Sheet registry ─────────────────────────────────────────────────────────────

class SheetSourceIn(BaseModel):
    sheet_url_or_id: str
    sheet_type: str                      # 'visit_plan' | 'log_book' | 'targets'
    year: Optional[int] = None           # visit_plan: calendar year; targets: FY start year
    month: Optional[int] = None          # visit_plan only
    quarter: Optional[str] = None        # targets only — 'Q1'..'Q4'


@router.post("/sheet-sources")
def add_sheet_source(
    body: SheetSourceIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    quarter = None
    if body.sheet_type == "visit_plan":
        if body.year is None or body.month is None:
            raise HTTPException(status_code=400, detail="Visit plan sheets need a month and a year")
        if not (1 <= body.month <= 12):
            raise HTTPException(status_code=400, detail="month must be 1–12")
        if not (2020 <= body.year <= 2100):
            raise HTTPException(status_code=400, detail="year must be between 2020 and 2100")
        module = MODULE_PLAN
        # Label is derived, never typed, so the month identity can't drift.
        label = f"Visit Plan — {_MONTH_NAMES[body.month - 1]} {body.year}"
        calendar_year, month = body.year, body.month
    elif body.sheet_type == "log_book":
        module = MODULE_LOG
        label = "OE Log Book"
        calendar_year, month = None, None
    elif body.sheet_type == "targets":
        if body.year is None or body.quarter is None:
            raise HTTPException(status_code=400, detail="Target sheets need a quarter and a financial year")
        if body.quarter not in QUARTERS:
            raise HTTPException(status_code=400, detail="quarter must be one of Q1, Q2, Q3, Q4")
        if not (2020 <= body.year <= 2100):
            raise HTTPException(status_code=400, detail="year must be between 2020 and 2100")
        module = MODULE_TGT
        q_no = int(body.quarter[1])
        # year is the FY START year: FY26-27 => 2026. Label carries the quarter
        # tag the team actually says out loud ("AMJ"), not just "Q1".
        label = f"Targets — {QUARTER_TAGS[q_no]} FY{body.year % 100:02d}-{(body.year + 1) % 100:02d}"
        calendar_year, month, quarter = body.year, None, body.quarter
    elif body.sheet_type == "dealer_data":
        # No period: the file is continuous and grows a column each month, so
        # re-syncing it always brings the latest picture — same as the log book.
        module = MODULE_DD
        label = "OE Dealer Data"
        calendar_year, month = None, None
    else:
        raise HTTPException(
            status_code=400,
            detail="sheet_type must be visit_plan, log_book, targets or dealer_data")

    source = SheetSource(
        id=uuid.uuid4(),
        module=module,
        sheet_id=extract_sheet_id(body.sheet_url_or_id),
        label=label,
        calendar_year=calendar_year,
        month=month,
        quarter=quarter,
        created_by=current_user.id,
    )
    db.add(source)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"{label} is already registered")
    db.refresh(source)
    return _source_out(db, source)


def _source_out(db: Session, s: SheetSource) -> dict:
    last_log = (
        db.query(SyncLog)
        .filter(SyncLog.module == s.module, SyncLog.source_label == s.sheet_id)
        .order_by(SyncLog.synced_at.desc())
        .first()
    )
    return {
        "id": str(s.id), "sheet_id": s.sheet_id, "label": s.label,
        "sheet_type": _sheet_type(s.module),
        "calendar_year": s.calendar_year, "month": s.month, "quarter": s.quarter,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "last_synced_at": last_log.synced_at.isoformat() if last_log and last_log.synced_at else None,
        "last_sync_status": last_log.status if last_log else None,
    }


@router.get("/sheet-sources")
def list_sheet_sources(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    sources = (
        db.query(SheetSource)
        .filter(SheetSource.module.in_(OE_MODULES))
        .order_by(SheetSource.module, SheetSource.calendar_year.desc(),
                  SheetSource.month.desc(), SheetSource.quarter.desc())
        .all()
    )
    return [_source_out(db, s) for s in sources]


@router.delete("/sheet-sources/{source_id}")
def delete_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    source = db.query(SheetSource).filter(
        SheetSource.id == source_id, SheetSource.module.in_(OE_MODULES)
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    rows_deleted = sum(
        db.execute(text(f"SELECT COUNT(*) FROM {t} WHERE sheet_source_id = :sid"),
                   {"sid": str(source.id)}).scalar()
        for t in _DATA_TABLES[source.module]
    )
    # ON DELETE CASCADE wipes the data rows.
    db.delete(source)
    db.commit()
    return {"deleted": True, "rows_deleted": rows_deleted}


# ── Sync ───────────────────────────────────────────────────────────────────────

# Column lists, not whole statements: every module's rows go through
# _bulk_insert, which builds one multi-row INSERT per chunk. Written one
# statement per row, the log book's ~2,300 rows meant ~2,300 round trips to a
# database reached over an SSH tunnel — minutes of wall clock with a write
# transaction held open the whole time, which is what made it look hung.
_PLAN_COLS = ("id", "sheet_source_id", "salesperson", "visit_date", "plan_year",
              "plan_month", "oem", "dealer_name", "city", "state", "sync_log_id")

_LOG_COLS = ("id", "sheet_source_id", "visit_date", "log_year", "log_month", "salesperson",
             "contact_mode", "oem", "dealership", "address", "contact_person",
             "contact_number", "designation", "car_sales", "seat_cover_sales",
             "mats_sales", "remarks", "remark_product_feedback", "remark_replacement",
             "remark_sales", "remark_others", "channel", "email", "photo_link",
             "city", "state", "sheet_row", "sync_log_id", "dealer_id")

_TGT_COLS = ("id", "sheet_source_id", "fy_year", "quarter", "period_year", "period_month",
             "oem", "category", "salesperson", "region",
             "tgt_nos", "tgt_value", "ach_nos", "ach_value", "value_scale", "sync_log_id")

# A module can own more than one table: the dealer file writes the monthly
# sales and the quarterly targets, and both are replaced together on sync.
_DATA_TABLES = {
    MODULE_PLAN: ("oe_visit_plans",),
    MODULE_LOG: ("oe_visit_logs",),
    MODULE_TGT: ("oe_targets",),
    MODULE_DD: ("oe_dealer_monthly", "oe_dealer_targets"),
}
_INSERT_COLS = {MODULE_PLAN: _PLAN_COLS, MODULE_LOG: _LOG_COLS, MODULE_TGT: _TGT_COLS}

_DEALER_MONTHLY_COLS = ("id", "dealer_id", "sheet_source_id", "month",
                        "oem_total", "ysasc", "ys_sale")
_DEALER_TARGET_COLS = ("id", "dealer_id", "sheet_source_id", "quarter", "fy_year",
                       "period_start", "period_end", "target", "achievement")

# How many rows go in one INSERT. These files run to thousands of rows and the
# database is reached over an SSH tunnel, so the cost is dominated by round
# trips, not by the inserts themselves: one statement per row took minutes and
# held a write transaction open the whole time, which is what let a double-click
# on Sync overlap two runs.
#
# 500 keeps every statement inside Postgres's 65535 bind-parameter ceiling with
# room to spare — the widest table here is oe_visit_logs at 29 columns, so
# 500 x 29 = 14,500.
_INSERT_CHUNK = 500


def _bulk_insert(db: Session, table: str, cols: tuple, rows: list) -> int:
    """Insert rows in multi-row statements. Returns the number written.

    Rows must carry every column in `cols`. Indexed, not `.get()`: a parser that
    stops emitting a field should fail here rather than quietly write NULLs into
    a column nobody notices for a month. This matches what the per-row named
    statements did before — SQLAlchemy raised on a missing bind parameter.
    """
    if not rows:
        return 0
    collist = ", ".join(cols)
    for i in range(0, len(rows), _INSERT_CHUNK):
        chunk = rows[i:i + _INSERT_CHUNK]
        # Parameters stay bound — the only thing interpolated is the column
        # list and the placeholder names, both of which come from the _*_COLS
        # tuples above and never from the sheet.
        values = ", ".join(
            "(" + ", ".join(f":{c}_{n}" for c in cols) + ")"
            for n in range(len(chunk))
        )
        params = {f"{c}_{n}": row[c] for n, row in enumerate(chunk) for c in cols}
        db.execute(text(f"INSERT INTO {table} ({collist}) VALUES {values}"), params)
    return len(rows)


def sync_dealer_data(db: Session, source_id: Optional[str],
                     records: list, errors: list) -> int:
    """Write the dealer file's rows, creating dealers we have never seen.

    Returns the number of rows written across both tables.

    The file is the authority on which dealers exist, so a name we don't hold
    is added rather than dropped — but only as a last resort, and its state
    comes from the file, which is the one field the file gets wrong (its STATES
    column is a sales region). Those are surfaced as errors so someone checks
    them, because a dealer in the wrong state disappears from the visit form's
    dropdown.
    """
    index = DealerIndex(db)
    created = []
    # Accumulated and flushed in batches at the end rather than written one row
    # at a time — see _bulk_insert.
    monthly_rows: list = []
    target_rows: list = []
    refresh: list = []

    for rec in records:
        dealer_id = index.resolve(rec["oem"], rec["name"], rec["city"])
        if dealer_id is None:
            dealer_id = db.execute(text("""
                INSERT INTO oe_dealerships
                    (oem, state, city, name, salesperson, dealer_codes, source)
                VALUES (:oem, :state, NULLIF(:city, ''), :name,
                        NULLIF(:sp, ''), NULLIF(:codes, ''), 'oe_file')
                ON CONFLICT (oem, state, UPPER(name), UPPER(COALESCE(city, '')))
                DO UPDATE SET updated_at = NOW()
                RETURNING id
            """), {"oem": rec["oem"], "state": rec["state"] or "Unknown",
                   "city": rec["city"], "name": rec["name"],
                   "sp": rec["salesperson"] or "", "codes": rec["dealer_codes"] or ""}).scalar()
            created.append(f"{rec['name']} / {rec['city']}")
        else:
            # Refresh the fields the file owns. City, name and state are left
            # alone: the master already holds a matched outlet, and the file's
            # state cannot be trusted over it. Collected and applied in one
            # statement below rather than one UPDATE per dealer.
            refresh.append({"id": dealer_id, "sp": rec["salesperson"] or "",
                            "codes": rec["dealer_codes"] or ""})

        for m in rec["monthly"]:
            if all(m.get(k) is None for k in DEALER_SERIES):
                continue
            monthly_rows.append({
                "id": str(uuid.uuid4()), "dealer_id": dealer_id,
                "sheet_source_id": source_id, "month": m["month"],
                **{k: m.get(k) for k in DEALER_SERIES},
            })
        for t in rec["targets"]:
            if t.get("target") is None and t.get("achievement") is None:
                continue
            target_rows.append({
                "id": str(uuid.uuid4()), "dealer_id": dealer_id,
                "sheet_source_id": source_id, **t,
            })

    # One UPDATE ... FROM (VALUES ...) for every matched dealer, in place of one
    # statement each. COALESCE/NULLIF semantics are unchanged.
    for i in range(0, len(refresh), _INSERT_CHUNK):
        chunk = refresh[i:i + _INSERT_CHUNK]
        # CAST(...), not a ::uuid suffix — text() does not recognise a bind
        # parameter that is immediately followed by another colon, so
        # ":id_0::uuid" reaches Postgres as literal text and the whole
        # statement fails on a syntax error.
        values = ", ".join(f"(CAST(:id_{n} AS uuid), :sp_{n}, :codes_{n})"
                           for n in range(len(chunk)))
        params = {f"{k}_{n}": r[k] for n, r in enumerate(chunk) for k in ("id", "sp", "codes")}
        db.execute(text(f"""
            UPDATE oe_dealerships d
               SET salesperson  = COALESCE(NULLIF(v.sp, ''), d.salesperson),
                   dealer_codes = COALESCE(NULLIF(v.codes, ''), d.dealer_codes),
                   updated_at   = NOW()
              FROM (VALUES {values}) AS v(id, sp, codes)
             WHERE d.id = v.id
        """), params)

    written = (_bulk_insert(db, "oe_dealer_monthly", _DEALER_MONTHLY_COLS, monthly_rows)
               + _bulk_insert(db, "oe_dealer_targets", _DEALER_TARGET_COLS, target_rows))

    if created:
        errors.append(
            f"{len(created)} dealer(s) in the file were not in the master list and were "
            f"added with the file's own state, which is a sales region and may be wrong — "
            f"check them: {', '.join(created[:8])}"
            + (f" and {len(created) - 8} more" if len(created) > 8 else "")
        )
    return written


def _sync_result(log: SyncLog, db: Session, written: int, deleted: int,
                 skipped_tabs: list, errors: list) -> dict:
    """Close out a sync log and shape the response. Shared so the dealer file,
    which returns early because it writes two tables, reports identically."""
    log.rows_total = written
    log.rows_inserted = written
    log.rows_updated = 0
    log.rows_failed = 0
    log.rows_deleted = deleted
    log.status = "Done"
    log.error_details = "\n".join(errors) if errors else None
    db.commit()

    return {
        "sync_id": str(log.id),
        "rows_total": written,
        "rows_inserted": written,
        "rows_updated": 0,
        "rows_failed": 0,
        "rows_deleted": deleted,
        "skipped_tabs": skipped_tabs,
        "errors": errors[:20],
        "status": "Done",
    }


def _do_sync(db: Session, source: SheetSource, current_user: User) -> dict:
    log = SyncLog(
        id=uuid.uuid4(),
        module=source.module,
        source_label=source.sheet_id,
        status="Processing",
        synced_by=current_user.id,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    prune_sync_logs(db, source.module, source.sheet_id)

    try:
        if source.module == MODULE_PLAN:
            records, skipped_tabs, errors = parse_visit_plan(
                source.sheet_id, source.calendar_year, source.month
            )
        elif source.module == MODULE_TGT:
            records, skipped_tabs, errors = parse_targets(
                source.sheet_id, source.calendar_year, int(source.quarter[1])
            )
        elif source.module == MODULE_DD:
            records, skipped_tabs, errors = parse_dealer_data(source.sheet_id)
        else:
            records, skipped_tabs, errors = parse_log_book(source.sheet_id)
    except Exception as e:
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=502, detail=f"Could not sync from Google Sheets: {e}")

    tables = _DATA_TABLES[source.module]

    # Claim this source before touching any data, and hold it to the commit.
    # Every sync is delete-then-insert, so two overlapping runs are not merely
    # wasteful: the second one's DELETE can land while the first one's INSERTs
    # are still uncommitted, so it deletes nothing, and both sets of rows end up
    # in the table — every figure on the tab doubles. NOWAIT makes the second
    # caller fail at once rather than queue behind the lock for minutes and then
    # do exactly that. Taken here, after the log bookkeeping has committed, so
    # that commit cannot release it.
    try:
        db.execute(
            text("SELECT 1 FROM sheet_sources WHERE id = :id FOR UPDATE NOWAIT"),
            {"id": str(source.id)},
        )
    except OperationalError:
        db.rollback()
        log.status = "Failed"
        log.error_details = "A sync for this sheet was already running."
        db.commit()
        raise HTTPException(
            status_code=409,
            detail="This sheet is already syncing — wait for that run to finish.",
        )

    # Full-replace in ONE transaction: rows removed from the sheet disappear
    # here too, and a mid-sync failure can never leave the table half-wiped.
    try:
        deleted = sum(
            db.execute(text(f"DELETE FROM {t} WHERE sheet_source_id = :sid"),
                       {"sid": str(source.id)}).rowcount
            for t in tables
        )

        if source.module == MODULE_DD:
            written = sync_dealer_data(db, str(source.id), records, errors)
            db.commit()
            return _sync_result(log, db, written, deleted, skipped_tabs, errors)

        cols = _INSERT_COLS[source.module]

        # Log rows carry the outlet they belong to, so visits, remarks, dealer
        # sales and targets all hang off one key. Resolved here rather than at
        # read time because it is the same answer every time and the dealer
        # views would otherwise redo it on every request. Unresolved stays NULL
        # and is reported below — never guessed at.
        index = DealerIndex(db) if source.module == MODULE_LOG else None
        unresolved = 0
        rows: list = []
        for rec in records:
            extra = {}
            if index is not None:
                did = index.resolve(rec.get("oem"), rec.get("dealership"), rec.get("city"))
                extra["dealer_id"] = did
                unresolved += did is None
            rows.append({
                **rec,
                **extra,
                "id": str(uuid.uuid4()),
                "sheet_source_id": str(source.id),
                "sync_log_id": str(log.id),
            })
        # Batched, not one statement per row — see _bulk_insert. Each of these
        # modules writes exactly one table.
        _bulk_insert(db, _DATA_TABLES[source.module][0], cols, rows)
        db.commit()
        if unresolved:
            errors.append(
                f"{unresolved} of {len(records)} log rows could not be matched to a "
                f"dealership in the master list and will not appear in dealer views."
            )
    except Exception as e:
        db.rollback()
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Could not store synced rows: {e}")

    return _sync_result(log, db, len(records), deleted, skipped_tabs, errors)


@router.post("/sheet-sources/{source_id}/sync")
def sync_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    source = db.query(SheetSource).filter(
        SheetSource.id == source_id, SheetSource.module.in_(OE_MODULES)
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    return _do_sync(db, source, current_user)


@router.post("/sync-latest")
def sync_latest(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One-click refresh for the Overview: the log book and the dealer file both
    keep growing, and only the newest visit-plan month and target quarter still
    change, so those are the sheets worth re-pulling — earlier periods are
    frozen history."""
    _require_access(db, current_user)
    sources = db.query(SheetSource).filter(
        SheetSource.module.in_((MODULE_LOG, MODULE_DD))).all()
    newest_plan = (
        db.query(SheetSource)
        .filter(SheetSource.module == MODULE_PLAN)
        .order_by(SheetSource.calendar_year.desc(), SheetSource.month.desc())
        .first()
    )
    if newest_plan:
        sources.append(newest_plan)
    newest_targets = (
        db.query(SheetSource)
        .filter(SheetSource.module == MODULE_TGT)
        .order_by(SheetSource.calendar_year.desc(), SheetSource.quarter.desc())
        .first()
    )
    if newest_targets:
        sources.append(newest_targets)
    if not sources:
        raise HTTPException(status_code=400, detail="No sheets registered yet")

    results = []
    for source in sources:
        try:
            out = _do_sync(db, source, current_user)
            results.append({"label": source.label, "status": out["status"],
                            "rows_inserted": out["rows_inserted"]})
        except HTTPException as e:
            results.append({"label": source.label, "status": "Failed",
                            "rows_inserted": 0, "error": str(e.detail)})
    return {"results": results}


# ── Shared filter plumbing ────────────────────────────────────────────────────

# oe_visit_logs keeps `remarks` (the old single-blob column, from before the
# visit-log form existed) and the 4 new-form categories
# (remark_product_feedback / remark_replacement / remark_sales /
# remark_others) as fully separate fields everywhere — never merged. A row
# submitted through the new form leaves `remarks` NULL; its text lives only
# in whichever category columns the rep filled in.


def _add_filters(where: list, params: dict, mapping: dict):
    """mapping: {sql_column: value} — adds an equality clause per non-empty value."""
    for col, val in mapping.items():
        if val:
            key = col.replace(".", "_")
            where.append(f"{col} = :{key}")
            params[key] = val


_YM_RE = re.compile(r"^(\d{4})-(\d{1,2})$")


_snap_to_months = snap_to_months


def _ym_value(token: str) -> int:
    m = _YM_RE.match(token or "")
    if not m or not (1 <= int(m.group(2)) <= 12):
        raise HTTPException(status_code=400, detail=f"Invalid period token: {token!r} (expected YYYY-MM)")
    return int(m.group(1)) * 100 + int(m.group(2))


def _add_period(where: list, params: dict, year_col: str, month_col: str,
                year: Optional[int], month: Optional[int],
                from_ym: Optional[str], to_ym: Optional[str],
                date_col: Optional[str] = None,
                from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Scopes to a single month (year+month), an inclusive month range
    (from_ym..to_ym, 'YYYY-MM'), or an exact day range (from_date..to_date).

    A day range is applied to `date_col` when the table has one. Tables that
    only carry a year and a month — the visit plans — cannot be cut finer than
    a month, so there the range widens to every month it touches. Callers that
    compare the two kinds of table against each other must snap BOTH sides to
    months themselves; a like-for-like comparison is the whole point of those
    endpoints, and silently cutting one side finer than the other would make
    the ratio wrong rather than merely imprecise.
    """
    d1, d2 = _parse_date(from_date, "from_date"), _parse_date(to_date, "to_date")
    if d1 and d2:
        if d1 > d2:
            raise HTTPException(status_code=400, detail="from_date is after to_date")
        if date_col:
            where.append(f"{date_col} BETWEEN :p_dfrom AND :p_dto")
            params["p_dfrom"], params["p_dto"] = d1, d2
        else:
            where.append(f"({year_col} * 100 + {month_col}) BETWEEN :p_from AND :p_to")
            params["p_from"] = d1.year * 100 + d1.month
            params["p_to"] = d2.year * 100 + d2.month
        return
    if from_ym and to_ym:
        where.append(f"({year_col} * 100 + {month_col}) BETWEEN :p_from AND :p_to")
        params["p_from"] = _ym_value(from_ym)
        params["p_to"] = _ym_value(to_ym)
        return
    if year is not None:
        where.append(f"{year_col} = :p_year")
        params["p_year"] = year
    if month is not None:
        where.append(f"{month_col} = :p_month")
        params["p_month"] = month


# ── Visit plans list ──────────────────────────────────────────────────────────

@router.get("/plans")
def list_plans(
    year: Optional[int] = None,
    month: Optional[int] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealer name search"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    where = ["1=1"]
    params: dict = {}
    if year is not None:
        where.append("plan_year = :year")
        params["year"] = year
    if month is not None:
        where.append("plan_month = :month")
        params["month"] = month
    _add_filters(where, params, {"salesperson": salesperson, "oem": oem, "state": state, "city": city})
    if q:
        where.append("dealer_name ILIKE :q")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    total = db.execute(text(f"SELECT COUNT(*) FROM oe_visit_plans WHERE {where_sql}"), params).scalar()
    summary = db.execute(text(f"""
        SELECT COUNT(*) AS planned,
               COUNT(DISTINCT salesperson) AS salespersons,
               COUNT(DISTINCT dealer_name) AS dealers,
               COUNT(DISTINCT city) AS cities
        FROM oe_visit_plans WHERE {where_sql}
    """), params).fetchone()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT id, salesperson, visit_date, plan_year, plan_month, oem, dealer_name, city, state
        FROM oe_visit_plans WHERE {where_sql}
        ORDER BY salesperson, visit_date NULLS LAST, dealer_name
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "total": total, "page": page, "per_page": per_page,
        "summary": {
            "planned_visits": summary.planned, "salespersons": summary.salespersons,
            "dealers": summary.dealers, "cities": summary.cities,
        },
        "data": [
            {
                "id": str(r.id), "salesperson": r.salesperson,
                "visit_date": r.visit_date.isoformat() if r.visit_date else None,
                "plan_year": r.plan_year, "plan_month": r.plan_month,
                "oem": r.oem, "dealer_name": r.dealer_name, "city": r.city, "state": r.state,
            }
            for r in rows
        ],
    }


# ── Log book list ─────────────────────────────────────────────────────────────

@router.get("/logs")
def list_logs(
    year: Optional[int] = None,
    month: Optional[int] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    contact_mode: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership name search"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    where = ["1=1"]
    params: dict = {}
    if year is not None:
        where.append("log_year = :year")
        params["year"] = year
    if month is not None:
        where.append("log_month = :month")
        params["month"] = month
    _add_filters(where, params, {
        "salesperson": salesperson, "oem": oem, "state": state,
        "city": city, "contact_mode": contact_mode,
    })
    if q:
        where.append("dealership ILIKE :q")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    total = db.execute(text(f"SELECT COUNT(*) FROM oe_visit_logs WHERE {where_sql}"), params).scalar()
    summary = db.execute(text(f"""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
               COUNT(DISTINCT dealership) AS dealerships
        FROM oe_visit_logs WHERE {where_sql}
    """), params).fetchone()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT id, visit_date, salesperson, contact_mode, oem, dealership, address, designation,
               car_sales, seat_cover_sales, mats_sales, remarks, city, state
        FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "total": total, "page": page, "per_page": per_page,
        "summary": {
            "total_logs": summary.total, "visits": summary.visits,
            "calls": summary.calls, "dealerships": summary.dealerships,
        },
        "data": [
            {
                "id": str(r.id), "visit_date": r.visit_date.isoformat(),
                "salesperson": r.salesperson, "contact_mode": r.contact_mode, "oem": r.oem,
                "dealership": r.dealership, "address": r.address, "designation": r.designation,
                "car_sales": float(r.car_sales) if r.car_sales is not None else None,
                "seat_cover_sales": float(r.seat_cover_sales) if r.seat_cover_sales is not None else None,
                "mats_sales": float(r.mats_sales) if r.mats_sales is not None else None,
                "remarks": r.remarks, "city": r.city, "state": r.state,
            }
            for r in rows
        ],
    }


# ── Remarks / field activity ──────────────────────────────────────────────────
# "What is everyone up to?" — the log book's free-text REMARKS are the field
# team's own account of every visit and call. We tag each remark with themes
# (order booked, order pushed, follow-up, catalogue shared…) so leadership can
# read the gist across hundreds of notes, roll it up per salesperson, and still
# drop into the raw feed. Theme tagging is done in Python (services/remark_themes),
# so the whole filtered slice is pulled once and summarised in memory — the log
# book is a few hundred rows a month, so this stays cheap.

def _theme_list(counter: dict) -> list:
    """Counter keyed by theme -> ordered [{key,label,count}] in THEMES order,
    dropping themes with no hits."""
    return [
        {"key": key, "label": label, "count": counter[key]}
        for key, label in THEMES if counter.get(key)
    ]


# The rep now classifies their own note at source: the visit-log form makes them
# tick one or more of four categories and write a separate remark in each, and
# each lands in its own column. That hand-classification beats anything the
# keyword classifier can infer, so it is the PRIMARY axis here and the themes
# nest inside it — "of the 176 Sales notes, 112 are pushing for an order".
#
# `general` is the pre-form world: one blob in `remarks`, no category. Rows
# written before 29 Jul 2026 have only that; rows since have only the four. The
# two are never merged (see the note above _add_filters), so a row contributes
# one entry per non-empty remark field and a single row can appear under several
# categories at once.
REMARK_CATEGORIES = [
    ("sales", "Sales", "remark_sales"),
    ("product_feedback", "Product Feedback", "remark_product_feedback"),
    ("replacement", "Replacement", "remark_replacement"),
    ("others", "Others", "remark_others"),
    ("general", "General (pre-form)", "remarks"),
]
_CATEGORY_KEYS = {key for key, _, _ in REMARK_CATEGORIES}
_CATEGORY_COLUMNS = [col for _, _, col in REMARK_CATEGORIES]


def _notes(found: list) -> list:
    """The per-category notes of one row, shaped for the client."""
    return [
        {"category": key, "label": label, "text": body, "themes": ts}
        for key, label, body, ts in found
    ]


@router.get("/remarks")
def remarks_activity(
    year: Optional[int] = None,
    month: Optional[int] = None,
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    contact_mode: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership or remark text search"),
    category: Optional[str] = Query(None, description="Restrict the feed to one remark category"),
    theme: Optional[str] = Query(None, description="Restrict the feed to one theme key"),
    page: int = Query(1, ge=1),
    per_page: int = Query(30, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Categories + nested themes + per-salesperson rollup + remark feed, in one call.

    The KPIs, category/theme tallies and per-salesperson rollup are computed over
    the whole filtered slice; only the feed narrows to `category`/`theme` and
    paginates. That keeps the chips stable when one is clicked to filter the feed
    beneath them.
    """
    _require_access(db, current_user)
    if theme and not is_theme(theme):
        raise HTTPException(status_code=400, detail=f"Unknown theme: {theme!r}")
    if category and category not in _CATEGORY_KEYS:
        raise HTTPException(status_code=400, detail=f"Unknown remark category: {category!r}")

    # "Has a remark" now means any of the five fields, not just the legacy blob —
    # every row written since 29 Jul 2026 leaves `remarks` NULL.
    any_remark = " OR ".join(f"COALESCE({c}, '') <> ''" for c in _CATEGORY_COLUMNS)
    where = [f"({any_remark})"]
    params: dict = {}
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym,
                date_col="visit_date", from_date=from_date, to_date=to_date)
    _add_filters(where, params, {
        "salesperson": salesperson, "oem": oem, "state": state,
        "city": city, "contact_mode": contact_mode,
    })
    if q:
        text_cols = " OR ".join(f"{c} ILIKE :q" for c in _CATEGORY_COLUMNS)
        where.append(f"(dealership ILIKE :q OR {text_cols})")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    rows = db.execute(text(f"""
        SELECT id, visit_date, salesperson, contact_mode, oem, dealership,
               city, state, {", ".join(_CATEGORY_COLUMNS)}
        FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
    """), params).fetchall()

    # One row fans out into one entry per non-empty remark field. Classify each
    # separately: a Sales note and a Product Feedback note on the same visit are
    # different statements and must not share tags.
    #   entries[row_id] -> [(category_key, label, text, [theme keys]), …]
    entries: dict = {}
    for r in rows:
        found = []
        for key, label, col in REMARK_CATEGORIES:
            body = (getattr(r, col) or "").strip()
            if body:
                found.append((key, label, body, classify_remark(body)))
        entries[r.id] = found

    # Row-level tags = the union across its categories, for the salesperson rollup.
    tags = {rid: sorted({t for _, _, _, ts in e for t in ts}) for rid, e in entries.items()}

    # Category tallies, each with its own nested theme breakdown.
    cat_counts: dict = {}
    cat_themes: dict = {}
    for e in entries.values():
        for key, _, _, ts in e:
            cat_counts[key] = cat_counts.get(key, 0) + 1
            bucket = cat_themes.setdefault(key, {})
            for t in ts:
                bucket[t] = bucket.get(t, 0) + 1

    categories = [
        {
            "key": key,
            "label": label,
            "count": cat_counts[key],
            "themes": _theme_list(cat_themes.get(key, {})),
        }
        for key, label, _ in REMARK_CATEGORIES if cat_counts.get(key)
    ]

    theme_counter: dict = {}
    for r in rows:
        for t in tags[r.id]:
            theme_counter[t] = theme_counter.get(t, 0) + 1

    # Per-salesperson rollup — the spine of "what everyone is up to".
    people: dict = {}
    for r in rows:
        sp = r.salesperson or "—"
        p = people.get(sp)
        if p is None:
            p = people[sp] = {
                "salesperson": sp, "remarks": 0, "visits": 0, "calls": 0,
                "dealers": set(), "themes": {}, "categories": {}, "latest": None,
            }
        p["remarks"] += 1
        if r.contact_mode == "Visit":
            p["visits"] += 1
        elif r.contact_mode == "Calling":
            p["calls"] += 1
        if r.dealership:
            p["dealers"].add(r.dealership.strip().lower())
        for t in tags[r.id]:
            p["themes"][t] = p["themes"].get(t, 0) + 1
        for key, _, _, _ in entries[r.id]:
            p["categories"][key] = p["categories"].get(key, 0) + 1
        # rows are date-desc, so the first one seen per person is the latest.
        if p["latest"] is None:
            p["latest"] = {
                "visit_date": r.visit_date.isoformat(),
                "dealership": r.dealership, "oem": r.oem,
                "contact_mode": r.contact_mode,
                "notes": _notes(entries[r.id]),
                "themes": tags[r.id],
            }

    by_salesperson = sorted(
        (
            {
                "salesperson": p["salesperson"],
                "remarks": p["remarks"], "visits": p["visits"], "calls": p["calls"],
                "dealers": len(p["dealers"]),
                "top_themes": _theme_list(p["themes"])[:3],
                "categories": [
                    {"key": key, "label": label, "count": p["categories"][key]}
                    for key, label, _ in REMARK_CATEGORIES if p["categories"].get(key)
                ],
                "latest": p["latest"],
            }
            for p in people.values()
        ),
        key=lambda x: x["remarks"], reverse=True,
    )

    # Feed — narrow to the chosen category/theme, then paginate in memory. When
    # both are set the SAME note must satisfy both, so "Sales + complaint" means
    # a complaint written under Sales, not a row that happens to have each
    # somewhere.
    def keeps(r) -> bool:
        return any(
            (not category or key == category) and (not theme or theme in ts)
            for key, _, _, ts in entries[r.id]
        )

    feed_rows = [r for r in rows if keeps(r)] if (category or theme) else list(rows)
    total = len(feed_rows)
    start = (page - 1) * per_page
    page_rows = feed_rows[start:start + per_page]

    return {
        "kpis": {
            # `remarks` counts ROWS with at least one note; `notes` counts the
            # notes themselves, which is higher whenever a rep ticks 2+ categories.
            "remarks": len(rows),
            "notes": sum(cat_counts.values()),
            "dealers": len({r.dealership.strip().lower() for r in rows if r.dealership}),
            "salespersons": len(people),
            "visits": sum(1 for r in rows if r.contact_mode == "Visit"),
            "calls": sum(1 for r in rows if r.contact_mode == "Calling"),
        },
        "categories": categories,
        "themes": _theme_list(theme_counter),
        "by_salesperson": by_salesperson,
        "feed": {
            "total": total, "page": page, "per_page": per_page,
            "data": [
                {
                    "id": str(r.id), "visit_date": r.visit_date.isoformat(),
                    "salesperson": r.salesperson, "contact_mode": r.contact_mode,
                    "oem": r.oem, "dealership": r.dealership,
                    "city": r.city, "state": r.state,
                    "notes": _notes(entries[r.id]),
                    "themes": tags[r.id],
                }
                for r in page_rows
            ],
        },
    }


# ── Filter options ────────────────────────────────────────────────────────────

@router.get("/filter-options")
def filter_options(
    scope: str = Query(..., description="plans | logs | dealer_sales"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    if scope == "plans":
        table = "oe_visit_plans"
        extra = {}
    elif scope == "logs":
        table = "oe_visit_logs"
        extra = {"contact_modes": "contact_mode"}
    elif scope == "dealer_sales":
        # Only the OEMs we actually hold dealer sales for. The Dealers tab is
        # built on oe_dealer_monthly, so offering an OEM that has visit logs but
        # no sales file (every OEM except MSIL today) is a filter that can only
        # ever return an empty tab. Derived, not listed: the day a TATA dealer
        # file is synced, TATA appears here on its own.
        table = ("oe_dealerships d JOIN oe_dealer_monthly m ON m.dealer_id = d.id")
        extra = {}
    else:
        raise HTTPException(
            status_code=400, detail="scope must be plans, logs or dealer_sales")

    # dealer_sales reads from a join, so its columns need qualifying.
    p = "d." if scope == "dealer_sales" else ""

    def distinct(col: str):
        rows = db.execute(text(
            f"SELECT DISTINCT {p}{col} FROM {table} "
            f"WHERE {p}{col} IS NOT NULL ORDER BY {p}{col}"
        )).fetchall()
        return [r[0] for r in rows]

    out = {
        "salespersons": distinct("salesperson"),
        "oems": distinct("oem"),
        "states": distinct("state"),
        "cities": distinct("city"),
    }
    for key, col in extra.items():
        out[key] = distinct(col)
    return out


# ── Available periods ─────────────────────────────────────────────────────────

@router.get("/periods")
def available_periods(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    plan_months = db.execute(text("""
        SELECT DISTINCT plan_year AS year, plan_month AS month FROM oe_visit_plans ORDER BY 1, 2
    """)).fetchall()
    log_months = db.execute(text("""
        SELECT DISTINCT log_year AS year, log_month AS month FROM oe_visit_logs ORDER BY 1, 2
    """)).fetchall()
    # The months the dealer sales file covers. The Dealers tab needs these
    # BEFORE its first request: its period picker defaults to a month, and it
    # cannot pick one out of a response it has not fetched yet.
    dealer_months = db.execute(text("""
        SELECT DISTINCT EXTRACT(YEAR FROM month)::int  AS year,
                        EXTRACT(MONTH FROM month)::int AS month
        FROM oe_dealer_monthly ORDER BY 1, 2
    """)).fetchall()
    return {
        "plan_months": [{"year": r.year, "month": r.month} for r in plan_months],
        "log_months": [{"year": r.year, "month": r.month} for r in log_months],
        "dealer_months": [{"year": r.year, "month": r.month} for r in dealer_months],
    }


# ── Log analytics ─────────────────────────────────────────────────────────────

@router.get("/log-analytics")
def log_analytics(
    year: Optional[int] = None,
    month: Optional[int] = None,
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    contact_mode: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership name search"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    where = ["1=1"]
    params: dict = {}
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym,
                date_col="visit_date", from_date=from_date, to_date=to_date)
    _add_filters(where, params, {
        "salesperson": salesperson, "oem": oem, "state": state,
        "city": city, "contact_mode": contact_mode,
    })
    if q:
        where.append("dealership ILIKE :q")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    kpis = db.execute(text(f"""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
               COUNT(DISTINCT dealership) AS dealerships,
               COUNT(DISTINCT salesperson) AS salespersons,
               AVG(car_sales) AS avg_car_sales,
               AVG(seat_cover_sales) AS avg_seat_cover_sales,
               AVG(mats_sales) AS avg_mats_sales
        FROM oe_visit_logs WHERE {where_sql}
    """), params).fetchone()

    def grouped(col: str):
        rows = db.execute(text(f"""
            SELECT {col} AS key,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
                   COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
                   COUNT(DISTINCT dealership) AS dealerships
            FROM oe_visit_logs WHERE {where_sql} AND {col} IS NOT NULL
            GROUP BY {col} ORDER BY total DESC
        """), params).fetchall()
        return [
            {"key": r.key, "total": r.total, "visits": r.visits, "calls": r.calls, "dealerships": r.dealerships}
            for r in rows
        ]

    trend = db.execute(text(f"""
        SELECT log_year AS year, log_month AS month,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls
        FROM oe_visit_logs WHERE {where_sql}
        GROUP BY log_year, log_month ORDER BY 1, 2
    """), params).fetchall()

    return {
        "kpis": {
            "total_logs": kpis.total, "visits": kpis.visits, "calls": kpis.calls,
            "dealerships": kpis.dealerships, "salespersons": kpis.salespersons,
            # Dealer-reported monthly figures — averages by design (summing
            # would double-count the same dealership across repeat contacts).
            "avg_car_sales": round(float(kpis.avg_car_sales), 1) if kpis.avg_car_sales is not None else None,
            "avg_seat_cover_sales": round(float(kpis.avg_seat_cover_sales), 1) if kpis.avg_seat_cover_sales is not None else None,
            "avg_mats_sales": round(float(kpis.avg_mats_sales), 1) if kpis.avg_mats_sales is not None else None,
        },
        "by_salesperson": grouped("salesperson"),
        "by_oem": grouped("oem"),
        "by_state": grouped("state"),
        "monthly_trend": [
            {"year": r.year, "month": r.month, "total": r.total, "visits": r.visits, "calls": r.calls}
            for r in trend
        ],
    }


# ── Plan vs actual ────────────────────────────────────────────────────────────

@router.get("/plan-vs-actual")
def plan_vs_actual(
    year: Optional[int] = None,
    month: Optional[int] = Query(None, ge=1, le=12),
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealer name search"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    # Plans carry no day, so a day range widens to whole months on BOTH sides
    # rather than cutting the logs finer than the plan they are measured against.
    if from_date and to_date:
        from_ym, to_ym = _snap_to_months(from_date, to_date)
    if not ((from_ym and to_ym) or (year is not None and month is not None)):
        raise HTTPException(status_code=400, detail="Provide year+month or from_ym+to_ym")

    # oem/state/city/dealer-search exist on both tables and filter both sides in
    # SQL. Salesperson can't — the two sheets spell names differently — so it's
    # applied after grouping, via the same token matching used to pair rows.
    def side_where(year_col: str, month_col: str, dealer_col: str) -> tuple:
        where = ["1=1"]
        params: dict = {}
        _add_period(where, params, year_col, month_col, year, month, from_ym, to_ym)
        _add_filters(where, params, {"oem": oem, "state": state, "city": city})
        if q:
            where.append(f"{dealer_col} ILIKE :q")
            params["q"] = f"%{q}%"
        return " AND ".join(where), params

    plan_where, plan_params = side_where("plan_year", "plan_month", "dealer_name")
    planned = db.execute(text(f"""
        SELECT salesperson, COUNT(*) AS planned, COUNT(DISTINCT dealer_name) AS dealers_planned
        FROM oe_visit_plans WHERE {plan_where}
        GROUP BY salesperson ORDER BY salesperson
    """), plan_params).fetchall()

    log_where, log_params = side_where("log_year", "log_month", "dealership")
    logged = db.execute(text(f"""
        SELECT salesperson,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
               COUNT(DISTINCT dealership) AS dealerships
        FROM oe_visit_logs WHERE {log_where}
        GROUP BY salesperson
    """), log_params).fetchall()

    if salesperson:
        planned = [p for p in planned if _names_match(p.salesperson, salesperson)]
        logged = [r for r in logged if _names_match(r.salesperson, salesperson)]

    unmatched_logs = {r.salesperson: r for r in logged if r.salesperson}
    rows = []
    for p in planned:
        matches = [name for name in unmatched_logs if _names_match(p.salesperson, name)]
        visits = calls = total = dealerships = 0
        for name in matches:
            r = unmatched_logs.pop(name)
            visits += r.visits
            calls += r.calls
            total += r.total
            dealerships += r.dealerships
        rows.append({
            "salesperson": p.salesperson,
            "log_name": ", ".join(matches) if matches else None,
            "planned": p.planned,
            "dealers_planned": p.dealers_planned,
            "visits": visits,
            "calls": calls,
            "total_logged": total,
            "dealerships_contacted": dealerships,
            "coverage_pct": round(visits / p.planned * 100, 1) if p.planned else None,
        })

    # Salespeople who logged activity but had no plan tab this month.
    for name, r in unmatched_logs.items():
        rows.append({
            "salesperson": name, "log_name": name,
            "planned": 0, "dealers_planned": 0,
            "visits": r.visits, "calls": r.calls, "total_logged": r.total,
            "dealerships_contacted": r.dealerships, "coverage_pct": None,
        })

    total_planned = sum(r["planned"] for r in rows)
    total_visits = sum(r["visits"] for r in rows)
    total_calls = sum(r["calls"] for r in rows)
    return {
        "year": year, "month": month, "from_ym": from_ym, "to_ym": to_ym,
        "rows": rows,
        "totals": {
            "planned": total_planned, "visits": total_visits, "calls": total_calls,
            "coverage_pct": round(total_visits / total_planned * 100, 1) if total_planned else None,
        },
    }


# ── Dealer directory ──────────────────────────────────────────────────────────
# The network itself, not the activity: one row per dealership (case-folded),
# with recency, contact mix and the dealer's own reported figures.

_DEALER_SORTS = {
    "recent": "last_contact DESC",
    "stale": "last_contact ASC",
    "most": "total DESC",
    "name": "dealer_name ASC",
}


@router.get("/dealers")
def dealer_directory(
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership name search"),
    sort: str = Query("recent", description="recent | stale | most | name"),
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    order = _DEALER_SORTS.get(sort, _DEALER_SORTS["recent"])

    where = ["1=1"]
    params: dict = {}
    _add_filters(where, params, {"salesperson": salesperson, "oem": oem, "state": state})
    if q:
        where.append("dealership ILIKE :q")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    summary = db.execute(text(f"""
        SELECT COUNT(*) AS dealers,
               COUNT(*) FILTER (WHERE last_contact >= CURRENT_DATE - 30) AS active_30,
               COUNT(*) FILTER (WHERE last_contact < CURRENT_DATE - 45) AS stale_45
        FROM (
            SELECT MAX(visit_date) AS last_contact
            FROM oe_visit_logs WHERE {where_sql}
            GROUP BY LOWER(dealership)
        ) t
    """), params).fetchone()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT
            (ARRAY_AGG(dealership ORDER BY visit_date DESC, sheet_row DESC NULLS LAST))[1] AS dealer_name,
            (ARRAY_AGG(oem ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE oem IS NOT NULL))[1] AS oem,
            (ARRAY_AGG(city ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE city IS NOT NULL))[1] AS city,
            (ARRAY_AGG(state ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE state IS NOT NULL))[1] AS state,
            (ARRAY_AGG(salesperson ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE salesperson IS NOT NULL))[1] AS last_salesperson,
            (ARRAY_AGG(contact_mode ORDER BY visit_date DESC, sheet_row DESC NULLS LAST))[1] AS last_mode,
            (ARRAY_AGG(remarks ORDER BY visit_date DESC, sheet_row DESC NULLS LAST) FILTER (WHERE remarks IS NOT NULL AND remarks <> ''))[1] AS last_remark,
            MAX(visit_date) AS last_contact,
            (CURRENT_DATE - MAX(visit_date)) AS days_since,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
            COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
            AVG(car_sales) AS avg_car_sales,
            AVG(seat_cover_sales) AS avg_seat_cover_sales,
            AVG(seat_cover_sales / NULLIF(car_sales, 0))
                FILTER (WHERE car_sales > 0 AND seat_cover_sales IS NOT NULL) AS attach
        FROM oe_visit_logs
        WHERE {where_sql}
        GROUP BY LOWER(dealership)
        ORDER BY {order}
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "summary": {
            "dealers": summary.dealers,
            "active_30": summary.active_30,
            "stale_45": summary.stale_45,
        },
        "total": summary.dealers, "page": page, "per_page": per_page,
        "data": [
            {
                "dealer_name": r.dealer_name, "oem": r.oem, "city": r.city, "state": r.state,
                "last_salesperson": r.last_salesperson, "last_mode": r.last_mode,
                "last_remark": r.last_remark,
                "last_contact": r.last_contact.isoformat() if r.last_contact else None,
                "days_since": r.days_since,
                "total": r.total, "visits": r.visits, "calls": r.calls,
                "avg_car_sales": round(float(r.avg_car_sales), 1) if r.avg_car_sales is not None else None,
                "avg_seat_cover_sales": round(float(r.avg_seat_cover_sales), 1) if r.avg_seat_cover_sales is not None else None,
                "attach_pct": round(float(r.attach) * 100, 1) if r.attach is not None else None,
            }
            for r in rows
        ],
    }


@router.get("/dealers/history")
def dealer_history(
    name: str = Query(..., description="Dealership name as shown in the directory"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    rows = db.execute(text("""
        SELECT visit_date, salesperson, contact_mode, oem, designation,
               car_sales, seat_cover_sales, mats_sales, remarks, city, state
        FROM oe_visit_logs
        WHERE LOWER(dealership) = LOWER(:name)
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
        LIMIT 100
    """), {"name": name}).fetchall()
    return {
        "dealer_name": name,
        "contacts": [
            {
                "visit_date": r.visit_date.isoformat(),
                "salesperson": r.salesperson, "contact_mode": r.contact_mode,
                "oem": r.oem, "designation": r.designation,
                "car_sales": float(r.car_sales) if r.car_sales is not None else None,
                "seat_cover_sales": float(r.seat_cover_sales) if r.seat_cover_sales is not None else None,
                "mats_sales": float(r.mats_sales) if r.mats_sales is not None else None,
                "remarks": r.remarks, "city": r.city, "state": r.state,
            }
            for r in rows
        ],
    }


# ── Plan adherence (dealer-level) ─────────────────────────────────────────────
# Plan-vs-actual above compares COUNTS; this compares NAMES: was each planned
# dealership actually contacted by that salesperson, and which contacted
# dealers were never on the plan at all.

@router.get("/plan-adherence")
def plan_adherence(
    year: Optional[int] = None,
    month: Optional[int] = Query(None, ge=1, le=12),
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    # Plans carry no day, so a day range widens to whole months on BOTH sides
    # rather than cutting the logs finer than the plan they are measured against.
    if from_date and to_date:
        from_ym, to_ym = _snap_to_months(from_date, to_date)
    if not ((from_ym and to_ym) or (year is not None and month is not None)):
        raise HTTPException(status_code=400, detail="Provide year+month or from_ym+to_ym")

    def side_where(year_col: str, month_col: str) -> tuple:
        where = ["1=1"]
        params: dict = {}
        _add_period(where, params, year_col, month_col, year, month, from_ym, to_ym)
        _add_filters(where, params, {"oem": oem, "state": state})
        return " AND ".join(where), params

    plan_where, plan_params = side_where("plan_year", "plan_month")
    plans = db.execute(text(f"""
        SELECT salesperson, dealer_name,
               MIN(oem) AS oem, MIN(city) AS city, COUNT(*) AS planned_visits
        FROM oe_visit_plans WHERE {plan_where}
        GROUP BY salesperson, dealer_name
        ORDER BY salesperson, dealer_name
    """), plan_params).fetchall()

    log_where, log_params = side_where("log_year", "log_month")
    logs = db.execute(text(f"""
        SELECT salesperson, dealership, MIN(oem) AS oem,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls
        FROM oe_visit_logs WHERE {log_where}
        GROUP BY salesperson, dealership
    """), log_params).fetchall()

    plan_by_sp: dict = {}
    for p in plans:
        plan_by_sp.setdefault(p.salesperson, []).append(p)
    log_by_sp: dict = {}
    for l in logs:
        log_by_sp.setdefault(l.salesperson, []).append(l)

    if salesperson:
        plan_by_sp = {sp: v for sp, v in plan_by_sp.items() if _names_match(sp, salesperson)}
        log_by_sp = {sp: v for sp, v in log_by_sp.items() if _names_match(sp, salesperson)}

    unmatched_log_sps = dict(log_by_sp)
    out_rows = []
    for sp, planned_dealers in plan_by_sp.items():
        # Same consumption logic as plan-vs-actual: each log name pairs with
        # at most one plan name.
        matched_names = [n for n in unmatched_log_sps if _names_match(sp, n)]
        logged: list = []
        for n in matched_names:
            logged.extend(unmatched_log_sps.pop(n))
        logged_tokens = [(l, _dealer_tokens(l.dealership)) for l in logged]
        consumed = set()

        dealers = []
        visited = called = missed = 0
        for p in planned_dealers:
            p_tokens = _dealer_tokens(p.dealer_name)
            best, best_score = None, 0
            p_visits = p_calls = 0
            for l, l_tokens in logged_tokens:
                score = _dealer_match_score(p_tokens, l_tokens)
                if score > 0:
                    consumed.add(l.dealership)
                    p_visits += l.visits
                    p_calls += l.calls
                    if score > best_score:
                        best, best_score = l, score
            if p_visits > 0:
                status = "visited"
                visited += 1
            elif p_calls > 0:
                status = "called"
                called += 1
            else:
                status = "missed"
                missed += 1
            dealers.append({
                "dealer_name": p.dealer_name, "oem": p.oem, "city": p.city,
                "planned_visits": p.planned_visits, "status": status,
                "log_dealership": best.dealership if best else None,
                "visits": p_visits, "calls": p_calls,
            })

        unplanned = [
            {"dealership": l.dealership, "oem": l.oem, "visits": l.visits, "calls": l.calls}
            for l, _t in logged_tokens if l.dealership not in consumed
        ]
        unplanned.sort(key=lambda u: -(u["visits"] + u["calls"]))
        planned_n = len(planned_dealers)
        out_rows.append({
            "salesperson": sp,
            "log_name": ", ".join(matched_names) if matched_names else None,
            "planned": planned_n, "visited": visited, "called_only": called, "missed": missed,
            "adherence_pct": round(visited / planned_n * 100, 1) if planned_n else None,
            "touch_pct": round((visited + called) / planned_n * 100, 1) if planned_n else None,
            "unplanned_count": len(unplanned),
            "dealers": dealers,
            "unplanned": unplanned[:50],
        })

    # Salespeople with logs but no plan this period.
    for sp, logged in unmatched_log_sps.items():
        if sp is None:
            continue
        unplanned = [
            {"dealership": l.dealership, "oem": l.oem, "visits": l.visits, "calls": l.calls}
            for l in logged
        ]
        unplanned.sort(key=lambda u: -(u["visits"] + u["calls"]))
        out_rows.append({
            "salesperson": sp, "log_name": sp,
            "planned": 0, "visited": 0, "called_only": 0, "missed": 0,
            "adherence_pct": None, "touch_pct": None,
            "unplanned_count": len(unplanned),
            "dealers": [], "unplanned": unplanned[:50],
        })

    out_rows.sort(key=lambda r: (r["planned"] == 0, r["salesperson"] or ""))
    tp = sum(r["planned"] for r in out_rows)
    tv = sum(r["visited"] for r in out_rows)
    tc = sum(r["called_only"] for r in out_rows)
    tm = sum(r["missed"] for r in out_rows)
    return {
        "rows": out_rows,
        "totals": {
            "planned": tp, "visited": tv, "called_only": tc, "missed": tm,
            "unplanned": sum(r["unplanned_count"] for r in out_rows),
            "adherence_pct": round(tv / tp * 100, 1) if tp else None,
            "touch_pct": round((tv + tc) / tp * 100, 1) if tp else None,
        },
    }


# ── Attach rates ──────────────────────────────────────────────────────────────
# The dealer-reported figures turned into a real metric: seat-cover sales as a
# share of the dealer's car sales. Averaged per dealer FIRST, then across
# dealers — repeat contacts with the same dealer must not weight the average.

@router.get("/attach-rates")
def attach_rates(
    year: Optional[int] = None,
    month: Optional[int] = Query(None, ge=1, le=12),
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    salesperson: Optional[str] = None,
    state: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    where = ["car_sales > 0", "seat_cover_sales IS NOT NULL"]
    params: dict = {}
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym,
                date_col="visit_date", from_date=from_date, to_date=to_date)
    _add_filters(where, params, {"salesperson": salesperson, "state": state})
    where_sql = " AND ".join(where)

    inner = f"""
        SELECT LOWER(dealership) AS dkey, oem,
               AVG(seat_cover_sales / NULLIF(car_sales, 0)) AS attach,
               AVG(mats_sales / NULLIF(car_sales, 0)) AS mats_attach,
               AVG(car_sales) AS cars
        FROM oe_visit_logs
        WHERE {where_sql}
        GROUP BY LOWER(dealership), oem
    """
    by_oem = db.execute(text(f"""
        SELECT oem, COUNT(*) AS dealers,
               AVG(attach) * 100 AS attach_pct,
               AVG(mats_attach) * 100 AS mats_attach_pct,
               AVG(cars) AS avg_car_sales
        FROM ({inner}) t WHERE oem IS NOT NULL
        GROUP BY oem ORDER BY attach_pct DESC
    """), params).fetchall()
    overall = db.execute(text(f"""
        SELECT COUNT(*) AS dealers, AVG(attach) * 100 AS attach_pct
        FROM ({inner}) t
    """), params).fetchone()

    return {
        "overall": {
            "dealers": overall.dealers,
            "attach_pct": round(float(overall.attach_pct), 1) if overall.attach_pct is not None else None,
        },
        "by_oem": [
            {
                "oem": r.oem, "dealers": r.dealers,
                "attach_pct": round(float(r.attach_pct), 1) if r.attach_pct is not None else None,
                "mats_attach_pct": round(float(r.mats_attach_pct), 1) if r.mats_attach_pct is not None else None,
                "avg_car_sales": round(float(r.avg_car_sales), 1) if r.avg_car_sales is not None else None,
            }
            for r in by_oem
        ],
    }


# ── Sync history ──────────────────────────────────────────────────────────────

@router.get("/sync-history")
def sync_history(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    # Map sheet_id → label so history rows say "Visit Plan — July 2026", not an opaque ID.
    sources = db.query(SheetSource).filter(SheetSource.module.in_(OE_MODULES)).all()
    labels = {s.sheet_id: s.label for s in sources}
    logs = (
        db.query(SyncLog)
        .filter(SyncLog.module.in_(OE_MODULES))
        .order_by(SyncLog.synced_at.desc())
        .limit(SYNC_LOG_RETENTION)
        .all()
    )
    return [
        {
            "id": str(l.id),
            "sheet_type": _sheet_type(l.module),
            "source_label": labels.get(l.source_label, l.source_label),
            "rows_total": l.rows_total, "rows_inserted": l.rows_inserted,
            "rows_failed": l.rows_failed, "rows_deleted": l.rows_deleted,
            "status": l.status,
            "synced_at": l.synced_at.isoformat() if l.synced_at else None,
        }
        for l in logs
    ]


# ── Dealer performance ────────────────────────────────────────────────────────
# The dealer-centric half of the module. Everything above answers "what is each
# rep doing"; this answers "how is each dealership doing" — which is what the OE
# team's own dealer file is keyed on, and what leadership asks about.
#
# TWO PERIOD GRAINS, deliberately. Dealer sales arrive as one figure per month,
# so a range like 12 Jul – 5 Aug cannot be cut finer than whole months for
# sales, while visits and calls are dated to the day and are cut exactly. Both
# are returned so the UI can say so, rather than quietly implying the sales
# figures were filtered to the day.

def _last_day(m: date) -> date:
    return date(m.year, m.month, calendar.monthrange(m.year, m.month)[1])


def _ym_to_date(token: str) -> date:
    v = _ym_value(token)
    return date(v // 100, v % 100, 1)


def _period_bounds(year: Optional[int], month: Optional[int],
                   from_ym: Optional[str], to_ym: Optional[str],
                   from_date: Optional[str], to_date: Optional[str]):
    """(month_from, month_to, date_from, date_to). Any may be None for all time.

    A custom day range wins when given; otherwise this reads exactly the period
    params every other endpoint here takes, so the shared filter bar keeps
    working unchanged.
    """
    d1, d2 = _parse_date(from_date, "from_date"), _parse_date(to_date, "to_date")
    if d1 and d2:
        if d1 > d2:
            raise HTTPException(status_code=400, detail="from_date is after to_date")
        return d1.replace(day=1), d2.replace(day=1), d1, d2
    if from_ym and to_ym:
        m1, m2 = _ym_to_date(from_ym), _ym_to_date(to_ym)
        if m1 > m2:
            raise HTTPException(status_code=400, detail="from_ym is after to_ym")
        return m1, m2, m1, _last_day(m2)
    if year is not None and month is not None:
        m = date(year, month, 1)
        return m, m, m, _last_day(m)
    if year is not None:
        return date(year, 1, 1), date(year, 12, 1), date(year, 1, 1), date(year, 12, 31)
    return None, None, None, None


def _dealer_scope(where: list, params: dict, oem: Optional[str],
                  salesperson: Optional[str], state: Optional[str]):
    """Entity filters applied to the DEALER, not to the visit.

    salesperson here is the rep the dealer is assigned to in the OE file, not
    whoever happened to log a contact. The question this tab answers is "how is
    this rep's patch doing", and that has to include the dealers they never
    touched — otherwise filtering by rep would hide exactly the gap worth
    seeing.
    """
    if oem:
        where.append("d.oem = :f_oem")
        params["f_oem"] = oem
    if salesperson:
        where.append("UPPER(d.salesperson) = UPPER(:f_sp)")
        params["f_sp"] = salesperson
    if state:
        where.append("d.state = :f_state")
        params["f_state"] = state


# Reused by every query below: the activity slice, the sales slice, and the
# dealer filter are the same three ideas each time.
# CAST(:p AS date), never :p::date — SQLAlchemy's text() does not recognise a
# bind parameter followed by the :: cast operator and leaves it as literal SQL.
_ACT_WINDOW = """
    dealer_id IS NOT NULL
    AND (CAST(:d_from AS date) IS NULL OR visit_date >= CAST(:d_from AS date))
    AND (CAST(:d_to   AS date) IS NULL OR visit_date <= CAST(:d_to   AS date))
"""
_SALES_WINDOW = """
    (CAST(:m_from AS date) IS NULL OR month >= CAST(:m_from AS date))
    AND (CAST(:m_to AS date) IS NULL OR month <= CAST(:m_to AS date))
"""

_DEALER_AGG_SQL = """
WITH sales AS (
    -- SUM(ysasc) is NULL only when no month in range supplied one, which is
    -- what makes penetration honestly unavailable rather than wrong.
    SELECT dealer_id, SUM(oem_total) AS oem_total,
           SUM(ysasc) AS ysasc, SUM(ys_sale) AS ys_sale
    FROM oe_dealer_monthly WHERE {sales_window} GROUP BY 1
),
acts AS (
    SELECT dealer_id,
           COUNT(*) AS contacts,
           COUNT(*) FILTER (WHERE contact_mode = 'Visit')   AS visits,
           COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
           MAX(visit_date) AS last_contact
    FROM oe_visit_logs WHERE {act_window} GROUP BY 1
),
tgts AS (
    -- A quarter counts if it OVERLAPS the period at all, and its target is NOT
    -- pro-rated: the target was agreed for the whole quarter, and slicing it
    -- would invent a number the OE team never signed up to.
    SELECT dealer_id, SUM(target) AS target, SUM(achievement) AS achievement
    FROM oe_dealer_targets
    WHERE (CAST(:m_from AS date) IS NULL OR period_end   >= CAST(:m_from AS date))
      AND (CAST(:m_to   AS date) IS NULL OR period_start <= CAST(:m_to   AS date))
    GROUP BY 1
)
SELECT d.id, d.oem, d.name, d.city, d.state, d.salesperson, d.dealer_codes,
       COALESCE(s.oem_total, 0) AS oem_total,
       s.ysasc                  AS ysasc,
       COALESCE(s.ys_sale, 0)   AS ys_sale,
       COALESCE(a.contacts, 0)  AS contacts,
       COALESCE(a.visits, 0)    AS visits,
       COALESCE(a.calls, 0)     AS calls,
       a.last_contact, t.target, t.achievement,
       (s.dealer_id IS NOT NULL) AS has_sales
FROM oe_dealerships d
LEFT JOIN sales s ON s.dealer_id = d.id
LEFT JOIN acts  a ON a.dealer_id = d.id
LEFT JOIN tgts  t ON t.dealer_id = d.id
WHERE d.is_active
  AND (s.dealer_id IS NOT NULL OR a.dealer_id IS NOT NULL)
  {extra}
ORDER BY COALESCE(s.ys_sale, 0) DESC, d.name
"""


def _ratio(num, den) -> Optional[float]:
    """A percentage as a RATIO OF SUMS, never the mean of monthly percentages.
    Averaging the monthly figures would weight a 12-unit month like a 1,200-unit
    one and quietly disagree with the OE team's own sheet."""
    return round(100.0 * num / den, 2) if den else None


def _funnel(oem_total, ysasc, ys_sale) -> dict:
    """The dealer file's three figures and the three ratios read off them.

    The funnel narrows: oem_total (every seat cover the dealer sold) ⊇ ysasc
    (those on a vehicle we hold a part number for) ⊇ ys_sale (ours).

      penetration     ys_sale ÷ ysasc — the headline. What we converted of what
                      we could have won.
      share           ys_sale ÷ oem_total — our slice of the dealer's whole
                      seat-cover business. This is what "penetration" used to
                      mean here, kept because it is the number that says how
                      big the dealer is to us overall.
      addressable_pct ysasc ÷ oem_total — how much of that dealer's business we
                      even make a part for. A low value is a product gap, NOT a
                      selling failure, and must never be read as one.

    penetration is NULL when ysasc is absent rather than falling back to
    oem_total: a silent fallback would report the old, much lower number
    (11.8% network-wide vs 20.1%) under the new name.
    """
    total, avail, ours = oem_total or 0, ysasc, ys_sale or 0
    return {
        "oem_total": total,
        "ysasc": avail,
        "ys_sale": ours,
        "penetration": _ratio(ours, avail) if avail is not None else None,
        "share": _ratio(ours, total),
        "addressable_pct": _ratio(avail, total) if avail is not None else None,
    }


def _dealer_months(db: Session, extra: str, params: dict) -> list:
    """Network trend: total sold, YSASC, YS Sale and our activity, by month.

    Contacts are bucketed into the month they happened in so the line can be
    read against the sales bars on one axis.
    """
    sales = db.execute(text(f"""
        SELECT m.month, SUM(m.oem_total) AS oem_total,
               SUM(m.ysasc) AS ysasc, SUM(m.ys_sale) AS ys_sale
        FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
        WHERE {_SALES_WINDOW.replace('month', 'm.month')} {extra}
        GROUP BY 1 ORDER BY 1
    """), params).mappings().all()
    acts = db.execute(text(f"""
        SELECT date_trunc('month', l.visit_date)::date AS month,
               COUNT(*) FILTER (WHERE l.contact_mode = 'Visit')   AS visits,
               COUNT(*) FILTER (WHERE l.contact_mode = 'Calling') AS calls
        FROM oe_visit_logs l JOIN oe_dealerships d ON d.id = l.dealer_id
        WHERE {_ACT_WINDOW.replace('dealer_id', 'l.dealer_id').replace('visit_date', 'l.visit_date')} {extra}
        GROUP BY 1 ORDER BY 1
    """), params).mappings().all()

    empty = {"oem_total": None, "ysasc": None, "ys_sale": None,
             "penetration": None, "share": None, "addressable_pct": None}

    by_month: dict = {}
    for r in sales:
        by_month[r["month"]] = {
            "month": r["month"].isoformat(), "visits": 0, "calls": 0,
            **_funnel(r["oem_total"], r["ysasc"], r["ys_sale"]),
        }
    for r in acts:
        b = by_month.setdefault(r["month"], {"month": r["month"].isoformat(),
                                             "visits": 0, "calls": 0, **empty})
        b["visits"], b["calls"] = r["visits"], r["calls"]
    return [by_month[k] for k in sorted(by_month)]


def _dealer_quarters(db: Session, extra: str, params: dict) -> list:
    """Quarter vs quarter: target, achievement, and the sales that fell inside
    each quarter's own months. Quarters are returned whole even if the period
    only clips them, for the same reason targets are not pro-rated."""
    rows = db.execute(text(f"""
        SELECT t.quarter, t.fy_year, MIN(t.period_start) AS period_start,
               MAX(t.period_end) AS period_end,
               SUM(t.target) AS target, SUM(t.achievement) AS achievement
        FROM oe_dealer_targets t JOIN oe_dealerships d ON d.id = t.dealer_id
        WHERE (CAST(:m_from AS date) IS NULL OR t.period_end   >= CAST(:m_from AS date))
          AND (CAST(:m_to   AS date) IS NULL OR t.period_start <= CAST(:m_to   AS date))
          {extra}
        GROUP BY 1, 2 ORDER BY 2, 1
    """), params).mappings().all()

    out = []
    for r in rows:
        sales = db.execute(text(f"""
            SELECT SUM(m.oem_total) AS oem_total,
                   SUM(m.ysasc) AS ysasc, SUM(m.ys_sale) AS ys_sale
            FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
            WHERE m.month >= :q_start AND m.month <= :q_end {extra}
        """), {**params, "q_start": r["period_start"], "q_end": r["period_end"]}).mappings().first()
        tag = {1: "AMJ", 2: "JAS", 3: "OND", 4: "JFM"}[int(r["quarter"][1])]
        out.append({
            "quarter": r["quarter"],
            "fy_year": r["fy_year"],
            "label": f"{tag} '{str(r['period_start'].year)[2:]}",
            "period_start": r["period_start"].isoformat(),
            "period_end": r["period_end"].isoformat(),
            "target": r["target"],
            "achievement": r["achievement"],
            **_funnel(sales["oem_total"], sales["ysasc"], sales["ys_sale"]),
        })
    return out


def _contact_effect(db: Session, extra: str, params: dict) -> dict:
    """Does contacting a dealer more actually shift what we sell there?

    Compared WITHIN A MONTH — contacts made in a month against that same
    month's penetration. Totalling contacts over one window and sales over
    another would let contacts made in August "explain" sales from January,
    which is backwards.

    This is an association, not proof: reps go where they already do well.
    `months` is returned so the caller can say how thin the evidence is —
    dealer sales and visit logs currently overlap in very few months.
    """
    rows = db.execute(text(f"""
        WITH dm AS (
            SELECT m.dealer_id, m.month, m.oem_total, m.ysasc, m.ys_sale,
                   COALESCE(c.n, 0) AS contacts
            FROM oe_dealer_monthly m
            JOIN oe_dealerships d ON d.id = m.dealer_id
            LEFT JOIN (
                SELECT dealer_id, date_trunc('month', visit_date)::date AS mth, COUNT(*) AS n
                FROM oe_visit_logs WHERE dealer_id IS NOT NULL GROUP BY 1, 2
            ) c ON c.dealer_id = m.dealer_id AND c.mth = m.month
            WHERE {_SALES_WINDOW.replace('month', 'm.month')}
              AND m.month IN (SELECT DISTINCT date_trunc('month', visit_date)::date
                              FROM oe_visit_logs WHERE dealer_id IS NOT NULL)
              {extra}
        )
        SELECT CASE WHEN contacts = 0 THEN '0'
                    WHEN contacts = 1 THEN '1'
                    WHEN contacts = 2 THEN '2'
                    WHEN contacts <= 4 THEN '3-4'
                    ELSE '5+' END AS bucket,
               COUNT(*) AS dealer_months,
               SUM(oem_total) AS oem_total, SUM(ysasc) AS ysasc,
               SUM(ys_sale) AS ys_sale
        FROM dm GROUP BY 1
    """), params).mappings().all()

    order = ["0", "1", "2", "3-4", "5+"]
    buckets = {r["bucket"]: r for r in rows}
    months = db.execute(text(f"""
        SELECT COUNT(DISTINCT m.month) FROM oe_dealer_monthly m
        JOIN oe_dealerships d ON d.id = m.dealer_id
        WHERE {_SALES_WINDOW.replace('month', 'm.month')}
          AND m.month IN (SELECT DISTINCT date_trunc('month', visit_date)::date
                          FROM oe_visit_logs WHERE dealer_id IS NOT NULL)
          {extra}
    """), params).scalar()

    return {
        "months": months or 0,
        "buckets": [{
            "bucket": b,
            "dealer_months": buckets[b]["dealer_months"],
            **_funnel(buckets[b]["oem_total"], buckets[b]["ysasc"], buckets[b]["ys_sale"]),
        } for b in order if b in buckets],
    }


@router.get("/dealer-performance/{dealer_id}")
def dealer_detail(
    dealer_id: str,
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    from_ym: Optional[str] = Query(None),
    to_ym: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One dealership, whole: who they are, their month-by-month trend with our
    contacts on the same timeline, their quarter targets, and every contact we
    have logged with the remarks the rep wrote.

    Returns BOTH scopes, because the drawer needs both and conflating them is a
    trap either way:

      • `totals`   — the same period the tab is filtered to, so the headline
                     figures reconcile with the table row that was clicked.
                     Opening a dealer from an August table and reading lifetime
                     totals made the drawer look like it disagreed with the row.
      • `lifetime` — every month on record, shown as context underneath.

    `by_month`, `targets` and `history` stay unfiltered on purpose: a trend
    chart clipped to one month is not a trend, and the contact log is a dated
    list where the reader can see the dates for themselves.
    """
    _require_access(db, current_user)
    m_from, m_to, d_from, d_to = _period_bounds(year, month, from_ym, to_ym,
                                                from_date, to_date)
    d = db.execute(text("""
        SELECT id, oem, name, city, state, salesperson, dealer_codes, source
        FROM oe_dealerships WHERE id = :id
    """), {"id": dealer_id}).mappings().first()
    if not d:
        raise HTTPException(status_code=404, detail="Dealer not found")

    sales = db.execute(text("""
        SELECT month, oem_total, ysasc, ys_sale FROM oe_dealer_monthly
        WHERE dealer_id = :id ORDER BY month
    """), {"id": dealer_id}).mappings().all()
    acts = db.execute(text("""
        SELECT date_trunc('month', visit_date)::date AS month,
               COUNT(*) FILTER (WHERE contact_mode = 'Visit')   AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls
        FROM oe_visit_logs WHERE dealer_id = :id GROUP BY 1 ORDER BY 1
    """), {"id": dealer_id}).mappings().all()

    empty = {"oem_total": None, "ysasc": None, "ys_sale": None,
             "penetration": None, "share": None, "addressable_pct": None}

    months: dict = {}
    for r in sales:
        months[r["month"]] = {
            "month": r["month"].isoformat(), "visits": 0, "calls": 0,
            **_funnel(r["oem_total"], r["ysasc"], r["ys_sale"]),
        }
    for r in acts:
        b = months.setdefault(r["month"], {"month": r["month"].isoformat(),
                                           "visits": 0, "calls": 0, **empty})
        b["visits"], b["calls"] = r["visits"], r["calls"]

    # period_start/period_end travel with each quarter so the drawer can scope
    # these to the selected period the same way the tab's Quarter panel does —
    # a quarter counts if it OVERLAPS the period, and is never pro-rated.
    targets = [{
        "quarter": t["quarter"], "fy_year": t["fy_year"],
        "label": f"{ {1: 'AMJ', 2: 'JAS', 3: 'OND', 4: 'JFM'}[int(t['quarter'][1])] } "
                 f"'{str(t['period_start'].year)[2:]}",
        "period_start": t["period_start"].isoformat(),
        "period_end": t["period_end"].isoformat(),
        "target": t["target"], "achievement": t["achievement"],
    } for t in db.execute(text("""
        SELECT quarter, fy_year, period_start, period_end, target, achievement
        FROM oe_dealer_targets WHERE dealer_id = :id ORDER BY period_start
    """), {"id": dealer_id}).mappings().all()]

    # Contact history, newest first, with each remark category kept separate —
    # same rule as the Field Activity tab: the legacy blob and the four
    # form categories are never merged.
    log_rows = db.execute(text(f"""
        SELECT id, visit_date, salesperson, contact_mode, channel, contact_person,
               designation, car_sales, seat_cover_sales, mats_sales,
               {", ".join(_CATEGORY_COLUMNS)}
        FROM oe_visit_logs WHERE dealer_id = :id
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
    """), {"id": dealer_id}).mappings().all()

    history = []
    for r in log_rows:
        notes = []
        for key, label, col in REMARK_CATEGORIES:
            body = (r[col] or "").strip()
            if body:
                notes.append({"category": key, "label": label, "text": body,
                              "themes": classify_remark(body)})
        history.append({
            "id": str(r["id"]),
            "visit_date": r["visit_date"].isoformat() if r["visit_date"] else None,
            "salesperson": r["salesperson"], "contact_mode": r["contact_mode"],
            "channel": r["channel"], "contact_person": r["contact_person"],
            "designation": r["designation"],
            "car_sales": r["car_sales"], "seat_cover_sales": r["seat_cover_sales"],
            "mats_sales": r["mats_sales"], "notes": notes,
        })

    last_visit = next((h for h in history if h["contact_mode"] == "Visit" and h["notes"]), None)

    def totals_for(keys, contacts) -> dict:
        """Summed from the months already loaded rather than re-queried, and
        ysasc stays None unless at least one month in scope supplied it — so a
        dealer whose history predates the three-series file reports no
        penetration instead of a made-up one."""
        rows = [months[k] for k in keys]
        avail = [m["ysasc"] for m in rows if m["ysasc"] is not None]
        return {
            **_funnel(sum(m["oem_total"] or 0 for m in rows),
                      sum(avail) if avail else None,
                      sum(m["ys_sale"] or 0 for m in rows)),
            "visits": sum(h["contact_mode"] == "Visit" for h in contacts),
            "calls": sum(h["contact_mode"] == "Calling" for h in contacts),
            "months": len(rows),
        }

    in_months = [k for k in months
                 if (m_from is None or k >= m_from) and (m_to is None or k <= m_to)]
    in_contacts = [h for h in history
                   if h["visit_date"] and (d_from is None or h["visit_date"] >= d_from.isoformat())
                   and (d_to is None or h["visit_date"] <= d_to.isoformat())]

    return {
        "dealer": {
            "id": str(d["id"]), "oem": d["oem"], "name": d["name"],
            "city": d["city"] or "", "state": d["state"],
            "salesperson": d["salesperson"], "codes": d["dealer_codes"],
            "source": d["source"],
        },
        # The tab's period — reconciles with the row that was clicked.
        "totals": totals_for(sorted(in_months), in_contacts),
        # Every month on record, shown alongside as context.
        "lifetime": totals_for(sorted(months), history),
        "period": {
            "month_from": m_from.isoformat() if m_from else None,
            "month_to": m_to.isoformat() if m_to else None,
            "date_from": d_from.isoformat() if d_from else None,
            "date_to": d_to.isoformat() if d_to else None,
            # True when the tab is on "all time", in which case the two scopes
            # are the same figures and the UI shows only one.
            "all_time": m_from is None and m_to is None,
        },
        "by_month": [months[k] for k in sorted(months)],
        "targets": targets,
        "last_field_note": last_visit,
        "history": history,
    }


@router.get("/dealer-performance")
def dealer_performance(
    oem: Optional[str] = Query(None),
    salesperson: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    from_ym: Optional[str] = Query(None),
    to_ym: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Everything the Dealers tab needs, in one call.

    The per-dealer rows come back whole — a few hundred at most — so the client
    can rank, filter and plot them without a round trip per view. Top 20,
    bottom 20 and the volume-vs-penetration map are the same list read three
    ways, and they must agree with each other.
    """
    _require_access(db, current_user)
    m_from, m_to, d_from, d_to = _period_bounds(year, month, from_ym, to_ym,
                                                from_date, to_date)
    params = {"m_from": m_from, "m_to": m_to, "d_from": d_from, "d_to": d_to}
    where: list = []
    _dealer_scope(where, params, oem, salesperson, state)
    extra = (" AND " + " AND ".join(where)) if where else ""

    rows = db.execute(text(_DEALER_AGG_SQL.format(
        sales_window=_SALES_WINDOW, act_window=_ACT_WINDOW, extra=extra)),
        params).mappings().all()

    dealers = [{
        "id": str(r["id"]), "oem": r["oem"], "name": r["name"],
        "city": r["city"] or "", "state": r["state"],
        "salesperson": r["salesperson"], "codes": r["dealer_codes"],
        **_funnel(r["oem_total"], r["ysasc"], r["ys_sale"]),
        "contacts": r["contacts"], "visits": r["visits"], "calls": r["calls"],
        "last_contact": r["last_contact"].isoformat() if r["last_contact"] else None,
        "target": r["target"], "achievement": r["achievement"],
        "has_sales": r["has_sales"],
    } for r in rows]

    tot_total = sum(d["oem_total"] for d in dealers)
    tot_ours = sum(d["ys_sale"] for d in dealers)
    avail = [d["ysasc"] for d in dealers if d["ysasc"] is not None]
    tot_avail = sum(avail) if avail else None
    contacted = sum(1 for d in dealers if d["contacts"])

    # The yardstick "opportunity" is measured against, and it must NOT move when
    # the view is sliced. Scoped to the OEM (penetration is not comparable
    # across OEMs) and to the period, but deliberately ignoring salesperson and
    # state: benchmarking a rep's dealers against that same rep's own average
    # makes a weak territory look like it has the least to gain, which is
    # exactly backwards.
    bench_where: list = []
    _dealer_scope(bench_where, params, oem, None, None)
    bench_extra = (" AND " + " AND ".join(bench_where)) if bench_where else ""
    bench = db.execute(text(f"""
        SELECT SUM(m.oem_total) AS oem_total, SUM(m.ysasc) AS ysasc,
               SUM(m.ys_sale) AS ys_sale
        FROM oe_dealer_monthly m JOIN oe_dealerships d ON d.id = m.dealer_id
        WHERE {_SALES_WINDOW.replace('month', 'm.month')} {bench_extra}
    """), params).mappings().first()
    bench_f = _funnel(bench["oem_total"], bench["ysasc"], bench["ys_sale"])

    kpis = {
        "dealers": len(dealers),
        "contacted": contacted,
        "coverage": round(100.0 * contacted / len(dealers), 1) if dealers else None,
        **_funnel(tot_total, tot_avail, tot_ours),
        # Whole-OEM figures for this period, unaffected by the other filters.
        # Opportunity is measured against `benchmark`, so it has to be the same
        # KIND of ratio as each dealer's own penetration — ys_sale ÷ ysasc.
        "benchmark": bench_f["penetration"],
        "benchmark_share": bench_f["share"],
        "visits": sum(d["visits"] for d in dealers),
        "calls": sum(d["calls"] for d in dealers),
        "target": sum(d["target"] or 0 for d in dealers),
        "achievement": sum(d["achievement"] or 0 for d in dealers),
    }

    by_sp: dict = {}
    for d in dealers:
        sp = d["salesperson"] or "Unassigned"
        b = by_sp.setdefault(sp, {"salesperson": sp, "assigned": 0, "contacted": 0,
                                  "oem_total": 0, "ysasc": None, "ys_sale": 0,
                                  "visits": 0, "calls": 0, "target": 0, "achievement": 0})
        b["assigned"] += 1
        b["contacted"] += 1 if d["contacts"] else 0
        for k in ("oem_total", "ys_sale", "visits", "calls"):
            b[k] += d[k]
        # Stays None until some dealer in the group actually has one.
        if d["ysasc"] is not None:
            b["ysasc"] = (b["ysasc"] or 0) + d["ysasc"]
        b["target"] += d["target"] or 0
        b["achievement"] += d["achievement"] or 0
    for b in by_sp.values():
        b["coverage"] = round(100.0 * b["contacted"] / b["assigned"], 1) if b["assigned"] else None
        b.update(_funnel(b["oem_total"], b["ysasc"], b["ys_sale"]))

    return {
        "period": {
            "month_from": m_from.isoformat() if m_from else None,
            "month_to": m_to.isoformat() if m_to else None,
            "date_from": d_from.isoformat() if d_from else None,
            "date_to": d_to.isoformat() if d_to else None,
        },
        "kpis": kpis,
        "dealers": dealers,
        "by_salesperson": sorted(by_sp.values(), key=lambda b: -b["ys_sale"]),
        "by_month": _dealer_months(db, extra, params),
        "by_quarter": _dealer_quarters(db, extra, params),
        "contact_effect": _contact_effect(db, extra, params),
    }

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
import re
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from database import get_db
from models import SheetSource, SyncLog, User
from routers.auth import get_current_user
from services.google_sheets import extract_sheet_id
from services.oe_network_sync import parse_visit_plan, parse_log_book
from services.oe_targets_sync import parse_targets, QUARTER_TAGS
from services.permissions import require_module
from services.remark_themes import classify as classify_remark, THEMES, is_theme

router = APIRouter(prefix="/oe-network", tags=["OE Network"])

MODULE_KEY = "oe_network"
MODULE_PLAN = "oe_visit_plan"
MODULE_LOG = "oe_log_book"
MODULE_TGT = "oe_targets"
OE_MODULES = (MODULE_PLAN, MODULE_LOG, MODULE_TGT)

# sheet_sources.quarter is VARCHAR(2) holding 'Q1'..'Q4' (Depot-to-Distributor
# set that convention); OE targets reuse it rather than add a second column.
QUARTERS = ("Q1", "Q2", "Q3", "Q4")

_MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"]

_SHEET_TYPES = {MODULE_PLAN: "visit_plan", MODULE_LOG: "log_book", MODULE_TGT: "targets"}


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
    else:
        raise HTTPException(status_code=400, detail="sheet_type must be visit_plan, log_book or targets")

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
    table = _DATA_TABLES[source.module]
    rows_deleted = db.execute(
        text(f"SELECT COUNT(*) FROM {table} WHERE sheet_source_id = :sid"), {"sid": str(source.id)}
    ).scalar()
    # ON DELETE CASCADE wipes the data rows.
    db.delete(source)
    db.commit()
    return {"deleted": True, "rows_deleted": rows_deleted}


# ── Sync ───────────────────────────────────────────────────────────────────────

_PLAN_INSERT = text("""
    INSERT INTO oe_visit_plans
        (id, sheet_source_id, salesperson, visit_date, plan_year, plan_month,
         oem, dealer_name, city, state, sync_log_id)
    VALUES
        (:id, :sheet_source_id, :salesperson, :visit_date, :plan_year, :plan_month,
         :oem, :dealer_name, :city, :state, :sync_log_id)
""")

_LOG_INSERT = text("""
    INSERT INTO oe_visit_logs
        (id, sheet_source_id, visit_date, log_year, log_month, salesperson,
         contact_mode, oem, dealership, address, designation,
         car_sales, seat_cover_sales, mats_sales, remarks, city, state, sheet_row, sync_log_id)
    VALUES
        (:id, :sheet_source_id, :visit_date, :log_year, :log_month, :salesperson,
         :contact_mode, :oem, :dealership, :address, :designation,
         :car_sales, :seat_cover_sales, :mats_sales, :remarks, :city, :state, :sheet_row, :sync_log_id)
""")

_TGT_INSERT = text("""
    INSERT INTO oe_targets
        (id, sheet_source_id, fy_year, quarter, period_year, period_month,
         oem, category, salesperson, region,
         tgt_nos, tgt_value, ach_nos, ach_value, value_scale, sync_log_id)
    VALUES
        (:id, :sheet_source_id, :fy_year, :quarter, :period_year, :period_month,
         :oem, :category, :salesperson, :region,
         :tgt_nos, :tgt_value, :ach_nos, :ach_value, :value_scale, :sync_log_id)
""")

_DATA_TABLES = {
    MODULE_PLAN: "oe_visit_plans",
    MODULE_LOG: "oe_visit_logs",
    MODULE_TGT: "oe_targets",
}
_INSERTS = {MODULE_PLAN: _PLAN_INSERT, MODULE_LOG: _LOG_INSERT, MODULE_TGT: _TGT_INSERT}


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

    try:
        if source.module == MODULE_PLAN:
            records, skipped_tabs, errors = parse_visit_plan(
                source.sheet_id, source.calendar_year, source.month
            )
        elif source.module == MODULE_TGT:
            records, skipped_tabs, errors = parse_targets(
                source.sheet_id, source.calendar_year, int(source.quarter[1])
            )
        else:
            records, skipped_tabs, errors = parse_log_book(source.sheet_id)
    except Exception as e:
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=502, detail=f"Could not sync from Google Sheets: {e}")

    table = _DATA_TABLES[source.module]
    insert_sql = _INSERTS[source.module]

    # Full-replace in ONE transaction: rows removed from the sheet disappear
    # here too, and a mid-sync failure can never leave the table half-wiped.
    try:
        deleted = db.execute(
            text(f"DELETE FROM {table} WHERE sheet_source_id = :sid"), {"sid": str(source.id)}
        ).rowcount
        for rec in records:
            db.execute(insert_sql, {
                **rec,
                "id": str(uuid.uuid4()),
                "sheet_source_id": str(source.id),
                "sync_log_id": str(log.id),
            })
        db.commit()
    except Exception as e:
        db.rollback()
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Could not store synced rows: {e}")

    log.rows_total = len(records)
    log.rows_inserted = len(records)
    log.rows_updated = 0
    log.rows_failed = 0
    log.rows_deleted = deleted
    log.status = "Done"
    log.error_details = "\n".join(errors) if errors else None
    db.commit()

    return {
        "sync_id": str(log.id),
        "rows_total": len(records),
        "rows_inserted": len(records),
        "rows_updated": 0,
        "rows_failed": 0,
        "rows_deleted": deleted,
        "skipped_tabs": skipped_tabs,
        "errors": errors[:20],
        "status": "Done",
    }


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
    """One-click refresh for the Overview: the log book keeps growing daily and
    only the newest visit-plan month and target quarter still change, so those
    are the sheets worth re-pulling — earlier periods are frozen history."""
    _require_access(db, current_user)
    sources = db.query(SheetSource).filter(SheetSource.module == MODULE_LOG).all()
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

def _add_filters(where: list, params: dict, mapping: dict):
    """mapping: {sql_column: value} — adds an equality clause per non-empty value."""
    for col, val in mapping.items():
        if val:
            key = col.replace(".", "_")
            where.append(f"{col} = :{key}")
            params[key] = val


_YM_RE = re.compile(r"^(\d{4})-(\d{1,2})$")


def _ym_value(token: str) -> int:
    m = _YM_RE.match(token or "")
    if not m or not (1 <= int(m.group(2)) <= 12):
        raise HTTPException(status_code=400, detail=f"Invalid period token: {token!r} (expected YYYY-MM)")
    return int(m.group(1)) * 100 + int(m.group(2))


def _add_period(where: list, params: dict, year_col: str, month_col: str,
                year: Optional[int], month: Optional[int],
                from_ym: Optional[str], to_ym: Optional[str]):
    """Scopes to a single month (year+month) or an inclusive month range
    (from_ym..to_ym, 'YYYY-MM') — ranges are how quarter/FY views arrive."""
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


@router.get("/remarks")
def remarks_activity(
    year: Optional[int] = None,
    month: Optional[int] = None,
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    contact_mode: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealership or remark text search"),
    theme: Optional[str] = Query(None, description="Restrict the feed to one theme key"),
    page: int = Query(1, ge=1),
    per_page: int = Query(30, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Themes + per-salesperson rollup + paginated remark feed, in one call.

    The KPIs, theme tallies and per-salesperson rollup are computed over the whole
    filtered slice; only the feed narrows to `theme` and paginates. That keeps the
    theme chips stable when one is clicked to filter the feed beneath them.
    """
    _require_access(db, current_user)
    if theme and not is_theme(theme):
        raise HTTPException(status_code=400, detail=f"Unknown theme: {theme!r}")

    where = ["remarks IS NOT NULL", "remarks <> ''"]
    params: dict = {}
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym)
    _add_filters(where, params, {
        "salesperson": salesperson, "oem": oem, "state": state,
        "city": city, "contact_mode": contact_mode,
    })
    if q:
        where.append("(dealership ILIKE :q OR remarks ILIKE :q)")
        params["q"] = f"%{q}%"
    where_sql = " AND ".join(where)

    rows = db.execute(text(f"""
        SELECT id, visit_date, salesperson, contact_mode, oem, dealership,
               city, state, remarks
        FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
    """), params).fetchall()

    # Classify once; reuse the tags for every downstream tally.
    tags = {r.id: classify_remark(r.remarks) for r in rows}

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
                "dealers": set(), "themes": {}, "latest": None,
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
        # rows are date-desc, so the first one seen per person is the latest.
        if p["latest"] is None:
            p["latest"] = {
                "visit_date": r.visit_date.isoformat(),
                "dealership": r.dealership, "oem": r.oem,
                "contact_mode": r.contact_mode, "remarks": r.remarks,
                "themes": tags[r.id],
            }

    by_salesperson = sorted(
        (
            {
                "salesperson": p["salesperson"],
                "remarks": p["remarks"], "visits": p["visits"], "calls": p["calls"],
                "dealers": len(p["dealers"]),
                "top_themes": _theme_list(p["themes"])[:3],
                "latest": p["latest"],
            }
            for p in people.values()
        ),
        key=lambda x: x["remarks"], reverse=True,
    )

    # Feed — narrow to the chosen theme, then paginate in memory.
    feed_rows = [r for r in rows if not theme or theme in tags[r.id]]
    total = len(feed_rows)
    start = (page - 1) * per_page
    page_rows = feed_rows[start:start + per_page]

    return {
        "kpis": {
            "remarks": len(rows),
            "dealers": len({r.dealership.strip().lower() for r in rows if r.dealership}),
            "salespersons": len(people),
            "visits": sum(1 for r in rows if r.contact_mode == "Visit"),
            "calls": sum(1 for r in rows if r.contact_mode == "Calling"),
        },
        "themes": _theme_list(theme_counter),
        "by_salesperson": by_salesperson,
        "feed": {
            "total": total, "page": page, "per_page": per_page,
            "data": [
                {
                    "id": str(r.id), "visit_date": r.visit_date.isoformat(),
                    "salesperson": r.salesperson, "contact_mode": r.contact_mode,
                    "oem": r.oem, "dealership": r.dealership,
                    "city": r.city, "state": r.state, "remarks": r.remarks,
                    "themes": tags[r.id],
                }
                for r in page_rows
            ],
        },
    }


# ── Filter options ────────────────────────────────────────────────────────────

@router.get("/filter-options")
def filter_options(
    scope: str = Query(..., description="plans | logs"),
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
    else:
        raise HTTPException(status_code=400, detail="scope must be plans or logs")

    def distinct(col: str):
        rows = db.execute(text(
            f"SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL ORDER BY {col}"
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
    return {
        "plan_months": [{"year": r.year, "month": r.month} for r in plan_months],
        "log_months": [{"year": r.year, "month": r.month} for r in log_months],
    }


# ── Log analytics ─────────────────────────────────────────────────────────────

@router.get("/log-analytics")
def log_analytics(
    year: Optional[int] = None,
    month: Optional[int] = None,
    from_ym: Optional[str] = None,
    to_ym: Optional[str] = None,
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
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym)
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
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    q: Optional[str] = Query(None, description="Dealer name search"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
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
    salesperson: Optional[str] = None,
    oem: Optional[str] = None,
    state: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
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
    salesperson: Optional[str] = None,
    state: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)
    where = ["car_sales > 0", "seat_cover_sales IS NOT NULL"]
    params: dict = {}
    _add_period(where, params, "log_year", "log_month", year, month, from_ym, to_ym)
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
        .limit(50)
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

"""
AutoForm MIS — Sales (Plant to Depot) Router
Sheet-source registry (multi-sheet, one per fiscal year), manual "Sync Now"
per registered sheet, unified cross-sheet analytics, filter options, paginated
list, sync history.
"""
import os
import re
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from database import get_db
from models import SheetSource, PlantToDepotSale, SyncLog, User
from routers.auth import get_current_user
from services.google_sheets import extract_sheet_id
from services.sales_sync import parse_workbook
from services.permissions import require_module

router = APIRouter(prefix="/sales", tags=["Sales"])

MODULE = "sales_plant_to_depot"
MODULE_KEY = "sales"
DEPOTS = ["Janak Motors", "United Auto"]
BRANDS = ["Autoform", "Autocruze", "Combined"]
CATEGORIES = ["Seat Cover", "Accessories", "Mats", "Boot & Cabin Mat", "Electronics"]
_MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _require_access(db: Session, current_user: User):
    require_module(db, current_user, MODULE_KEY)


# ── Filter helpers ─────────────────────────────────────────────────────────────
def _apply_filters_sql(where_clauses: list, params: dict, filters: dict):
    if filters.get("year"):
        where_clauses.append("sale_year = :year")
        params["year"] = filters["year"]
    if filters.get("months"):
        month_clauses = []
        for i, (y, m) in enumerate(filters["months"]):
            month_clauses.append(f"(sale_year = :_my{i} AND sale_month = :_mm{i})")
            params[f"_my{i}"] = y
            params[f"_mm{i}"] = m
        where_clauses.append("(" + " OR ".join(month_clauses) + ")")
    if filters.get("depot"):
        where_clauses.append("depot = :depot")
        params["depot"] = filters["depot"]
    if filters.get("brand"):
        where_clauses.append("brand = :brand")
        params["brand"] = filters["brand"]
    if filters.get("category"):
        where_clauses.append("category = :category")
        params["category"] = filters["category"]


def _parse_months_param(months: Optional[str]) -> list:
    if not months:
        return []
    pairs = []
    for token in months.split(","):
        token = token.strip()
        if not token:
            continue
        y, m = token.split("-")
        pairs.append((int(y), int(m)))
    return pairs


# ── Period selector (Monthly / Quarterly / Yearly chip tokens) ─────────────────
# Same token grammar as Depot-to-Distributor's period selector (YYYY-MM,
# YYYY-Qn, YYYY where YYYY is FY-start-year) so both tabs' selectors behave
# identically — but resolution here is pure calendar math, no DB lookup: unlike
# D2D (one sheet = one quarter, needs a sheet_sources join), a Plant-to-Depot
# sheet is a whole FY's worth of month tabs and every row already carries its
# own sale_year/sale_month directly.
_MONTH_TOKEN_RE = re.compile(r"^(\d{4})-(\d{2})$")
_QUARTER_TOKEN_RE = re.compile(r"^(\d{4})-Q([1-4])$")
_YEAR_TOKEN_RE = re.compile(r"^(\d{4})$")


def _quarter_months(fy: int, qn: int) -> list:
    m3 = {1: [4, 5, 6], 2: [7, 8, 9], 3: [10, 11, 12], 4: [1, 2, 3]}[qn]
    yrs = [fy + 1] * 3 if qn == 4 else [fy] * 3
    return list(zip(yrs, m3))


def _fy_months(fy: int) -> list:
    return [(fy, m) for m in range(4, 13)] + [(fy + 1, m) for m in range(1, 4)]


def _resolve_period(mode: str, token: str) -> dict:
    if mode == "monthly":
        m = _MONTH_TOKEN_RE.match(token)
        if not m:
            raise HTTPException(status_code=400, detail=f"Invalid month token: {token!r} (expected YYYY-MM)")
        y, mo = int(m.group(1)), int(m.group(2))
        return {"key": token, "label": f"{_MN[mo - 1]} {y}", "months": [(y, mo)]}
    if mode == "quarterly":
        m = _QUARTER_TOKEN_RE.match(token)
        if not m:
            raise HTTPException(status_code=400, detail=f"Invalid quarter token: {token!r} (expected YYYY-Qn)")
        fy, qn = int(m.group(1)), int(m.group(2))
        return {"key": token, "label": f"Q{qn} FY{(fy + 1) % 100:02d}", "months": _quarter_months(fy, qn)}
    if mode == "yearly":
        m = _YEAR_TOKEN_RE.match(token)
        if not m:
            raise HTTPException(status_code=400, detail=f"Invalid year token: {token!r} (expected YYYY)")
        fy = int(m.group(1))
        return {"key": token, "label": f"FY{str(fy)[-2:]}-{str(fy + 1)[-2:]}", "months": _fy_months(fy)}
    raise HTTPException(status_code=400, detail="mode must be one of monthly, quarterly, yearly")


# ── Sheet registry ─────────────────────────────────────────────────────────────
# One Google Sheet = one fiscal year here (a tab per month, year auto-detected
# per tab by parse_workbook) — unlike Depot-to-Distributor, where one sheet is
# one quarter. So the structured identity that fits this data shape is a single
# Fiscal Year picker, not a Quarter+Year pair. This replaces the old free-text
# label (no calendar identity, nothing stopping a duplicate or mistyped FY).
class SheetSourceIn(BaseModel):
    sheet_url_or_id: str
    fy_start_year: int


@router.post("/sheet-sources")
def add_sheet_source(
    body: SheetSourceIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    # Label is derived, not typed — "FY26 Plant to Depot" — using this file's
    # own start_year+1 FY-suffix convention (see fyRangeLabel/_fy_months usage
    # above), so it can never drift from what the sheet actually covers.
    label = f"FY{(body.fy_start_year + 1) % 100:02d} Plant to Depot"
    sid = extract_sheet_id(body.sheet_url_or_id)
    source = SheetSource(
        id=uuid.uuid4(),
        module=MODULE,
        sheet_id=sid,
        label=label,
        calendar_year=body.fy_start_year,
        created_by=current_user.id,
    )
    db.add(source)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"{label} is already registered")
    db.refresh(source)
    return {
        "id": str(source.id), "sheet_id": source.sheet_id, "label": source.label,
        "calendar_year": source.calendar_year,
        "created_at": source.created_at.isoformat(),
    }


@router.get("/sheet-sources")
def list_sheet_sources(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    sources = db.query(SheetSource).filter(SheetSource.module == MODULE).order_by(SheetSource.created_at.desc()).all()
    result = []
    for s in sources:
        last_log = (
            db.query(SyncLog)
            .filter(SyncLog.module == MODULE, SyncLog.source_label == s.sheet_id)
            .order_by(SyncLog.synced_at.desc())
            .first()
        )
        result.append({
            "id": str(s.id), "sheet_id": s.sheet_id, "label": s.label,
            "calendar_year": s.calendar_year,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "last_synced_at": last_log.synced_at.isoformat() if last_log and last_log.synced_at else None,
            "last_sync_status": last_log.status if last_log else None,
        })
    return result


@router.delete("/sheet-sources/{source_id}")
def delete_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    source = db.query(SheetSource).filter(SheetSource.id == source_id, SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    result = db.execute(
        text("DELETE FROM plant_to_depot_sales WHERE sheet_source_id = :sid"),
        {"sid": str(source.id)},
    )
    rows_deleted = result.rowcount
    db.delete(source)
    db.commit()
    return {"deleted": True, "rows_deleted": rows_deleted}


# ── Sync (per registered sheet) ────────────────────────────────────────────────
@router.post("/sheet-sources/{source_id}/sync")
def sync_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    source = db.query(SheetSource).filter(SheetSource.id == source_id, SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")

    log = SyncLog(
        id=uuid.uuid4(),
        module=MODULE,
        source_label=source.sheet_id,
        status="Processing",
        synced_by=current_user.id,
    )
    db.add(log)
    db.commit()
    db.refresh(log)

    try:
        records, errors, skipped_tabs, _ = parse_workbook(source.sheet_id)
    except Exception as e:
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=502, detail=f"Could not sync from Google Sheets: {e}")

    # Replace all data belonging to this sheet source atomically.
    result = db.execute(
        text("DELETE FROM plant_to_depot_sales WHERE sheet_source_id = :sid"),
        {"sid": str(source.id)},
    )
    deleted = result.rowcount
    db.commit()

    inserted = 0
    updated = 0
    failed = 0
    row_errors = [e for e in errors if not e.startswith("INFO:")]

    for rec in records:
        try:
            result = db.execute(text("""
                INSERT INTO plant_to_depot_sales
                    (id, sheet_source_id, sale_year, sale_month, depot, brand, category,
                     qty, rate, amount, sync_log_id)
                VALUES
                    (:id, :sid, :sale_year, :sale_month, :depot, :brand, :category,
                     :qty, :rate, :amount, :sync_log_id)
                ON CONFLICT (sale_year, sale_month, depot, brand, category)
                DO UPDATE SET
                    qty             = EXCLUDED.qty,
                    rate            = EXCLUDED.rate,
                    amount          = EXCLUDED.amount,
                    sheet_source_id = EXCLUDED.sheet_source_id,
                    sync_log_id     = EXCLUDED.sync_log_id,
                    updated_at      = NOW()
                RETURNING (xmax = 0) AS inserted
            """), {
                "id": str(uuid.uuid4()), "sid": str(source.id),
                "sale_year": rec["sale_year"], "sale_month": rec["sale_month"],
                "depot": rec["depot"], "brand": rec["brand"], "category": rec["category"],
                "qty": rec["qty"], "rate": rec["rate"], "amount": rec["amount"],
                "sync_log_id": str(log.id),
            })
            was_inserted = result.scalar()
            db.commit()
            if was_inserted:
                inserted += 1
            else:
                updated += 1
        except Exception as e:
            db.rollback()
            failed += 1
            row_errors.append(f"{rec['sale_year']}-{rec['sale_month']:02d} {rec['depot']}/{rec['brand']}/{rec['category']}: {e}")

    log.rows_total = len(records)
    log.rows_inserted = inserted
    log.rows_updated = updated
    log.rows_failed = failed
    log.rows_deleted = deleted
    log.status = "Done"
    all_msgs = row_errors + ([f"Skipped unrecognized tab: {t}" for t in skipped_tabs] if skipped_tabs else [])
    log.error_details = "\n".join(all_msgs) if all_msgs else None
    db.commit()

    return {
        "sync_id": str(log.id),
        "rows_total": len(records),
        "rows_inserted": inserted,
        "rows_updated": updated,
        "rows_failed": failed,
        "rows_deleted": deleted,
        "skipped_tabs": skipped_tabs,
        "errors": row_errors[:20],
        "status": "Done",
    }


# ── Legacy sync (env-var sheet, kept for backward compat) ─────────────────────
# Scoped to sheet_source_id IS NULL rows so it never touches data that was
# synced through the new per-source endpoint (prevents cross-FY data loss).
@router.post("/sync")
def sync_now(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    sheet_id = os.getenv("SALES_SHEET_ID")
    if not sheet_id:
        raise HTTPException(status_code=500, detail="SALES_SHEET_ID is not configured")

    log = SyncLog(
        id=uuid.uuid4(),
        module=MODULE,
        source_label=sheet_id,
        status="Processing",
        synced_by=current_user.id,
    )
    db.add(log)
    db.commit()
    db.refresh(log)

    try:
        records, errors, skipped_tabs, covered_months = parse_workbook(sheet_id)
    except Exception as e:
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=502, detail=f"Could not sync from Google Sheets: {e}")

    inserted = 0
    updated = 0
    failed = 0
    deleted = 0
    row_errors = [e for e in errors if not e.startswith("INFO:")]
    info_msgs = [e for e in errors if e.startswith("INFO:")]

    # Reconcile only legacy (unattributed) rows to avoid wiping data from
    # sheets registered through the new per-source endpoint.
    covered_set = set(covered_months)
    existing_months = db.execute(
        text("SELECT DISTINCT sale_year, sale_month FROM plant_to_depot_sales WHERE sheet_source_id IS NULL")
    ).fetchall()
    for r in existing_months:
        if (r.sale_year, r.sale_month) not in covered_set:
            result = db.execute(
                text("DELETE FROM plant_to_depot_sales WHERE sale_year = :y AND sale_month = :m AND sheet_source_id IS NULL"),
                {"y": r.sale_year, "m": r.sale_month},
            )
            deleted += result.rowcount
    db.commit()

    new_keys_by_month: dict = {}
    for rec in records:
        new_keys_by_month.setdefault((rec["sale_year"], rec["sale_month"]), set()).add(
            (rec["depot"], rec["brand"], rec["category"])
        )
    for (y, m) in covered_set:
        existing_rows = db.execute(
            text("SELECT depot, brand, category FROM plant_to_depot_sales WHERE sale_year = :y AND sale_month = :m AND sheet_source_id IS NULL"),
            {"y": y, "m": m},
        ).fetchall()
        new_keys = new_keys_by_month.get((y, m), set())
        for row in existing_rows:
            if (row.depot, row.brand, row.category) not in new_keys:
                db.execute(text("""
                    DELETE FROM plant_to_depot_sales
                    WHERE sale_year = :y AND sale_month = :m AND depot = :d AND brand = :b
                      AND category = :c AND sheet_source_id IS NULL
                """), {"y": y, "m": m, "d": row.depot, "b": row.brand, "c": row.category})
                deleted += 1
    db.commit()

    for rec in records:
        try:
            result = db.execute(text("""
                INSERT INTO plant_to_depot_sales
                    (id, sale_year, sale_month, depot, brand, category, qty, rate, amount, sync_log_id)
                VALUES
                    (:id, :sale_year, :sale_month, :depot, :brand, :category, :qty, :rate, :amount, :sync_log_id)
                ON CONFLICT (sale_year, sale_month, depot, brand, category)
                DO UPDATE SET qty = EXCLUDED.qty, rate = EXCLUDED.rate, amount = EXCLUDED.amount,
                              sync_log_id = EXCLUDED.sync_log_id, updated_at = NOW()
                RETURNING (xmax = 0) AS inserted
            """), {
                "id": str(uuid.uuid4()),
                "sale_year": rec["sale_year"], "sale_month": rec["sale_month"],
                "depot": rec["depot"], "brand": rec["brand"], "category": rec["category"],
                "qty": rec["qty"], "rate": rec["rate"], "amount": rec["amount"],
                "sync_log_id": str(log.id),
            })
            was_inserted = result.scalar()
            db.commit()
            if was_inserted:
                inserted += 1
            else:
                updated += 1
        except Exception as e:
            db.rollback()
            failed += 1
            row_errors.append(f"{rec['sale_year']}-{rec['sale_month']:02d} {rec['depot']}/{rec['brand']}/{rec['category']}: {e}")

    log.rows_total = len(records)
    log.rows_inserted = inserted
    log.rows_updated = updated
    log.rows_failed = failed
    log.rows_deleted = deleted
    log.status = "Done"
    all_msgs = row_errors + info_msgs + ([f"Skipped unrecognized tab: {t}" for t in skipped_tabs] if skipped_tabs else [])
    log.error_details = "\n".join(all_msgs) if all_msgs else None
    db.commit()

    return {
        "sync_id": str(log.id),
        "rows_total": len(records),
        "rows_inserted": inserted,
        "rows_updated": updated,
        "rows_failed": failed,
        "rows_deleted": deleted,
        "skipped_tabs": skipped_tabs,
        "errors": (row_errors + info_msgs)[:20],
        "status": "Done",
    }


# ── Filter options ────────────────────────────────────────────────────────────
@router.get("/filter-options")
def filter_options(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    months = db.execute(text("""
        SELECT DISTINCT sale_year AS year, sale_month AS month,
               TO_CHAR(TO_DATE(sale_month::text, 'MM'), 'Mon') || ' ' || sale_year AS label
        FROM plant_to_depot_sales
        GROUP BY sale_year, sale_month
        ORDER BY sale_year, sale_month
    """)).fetchall()

    return {
        "months": [{"year": r.year, "month": r.month, "label": r.label} for r in months],
        "depots": DEPOTS,
        "brands": BRANDS,
        "categories": CATEGORIES,
    }


# ── Period analytics ─────────────────────────────────────────────────────────
# Replaces the old single-filter /analytics + rotating MoM/QoQ/YoY growth card
# with the same selector-driven model Depot-to-Distributor uses: pick a mode
# and 1+ periods, get back a per-period comparison row for the top-of-dashboard
# cards plus one blended breakdown (trend/depot/category/brand) summed across
# the whole selection for everything below. No target field here, so no dedup
# hazard — amount sums safely no matter how the selected periods overlap.
def _period_breakdown(db: Session, months: list, depot: Optional[str], brand: Optional[str], category: Optional[str]) -> dict:
    filters = {"months": months, "depot": depot, "brand": brand, "category": category}
    where_clauses = ["1=1"]
    params: dict = {}
    _apply_filters_sql(where_clauses, params, filters)
    where_sql = " AND ".join(where_clauses)

    total_amount = db.execute(text(f"""
        SELECT COALESCE(SUM(amount), 0) AS total FROM plant_to_depot_sales WHERE {where_sql}
    """), params).scalar()

    trend_rows = db.execute(text(f"""
        SELECT sale_year, sale_month, SUM(amount) AS amount
        FROM plant_to_depot_sales WHERE {where_sql}
        GROUP BY sale_year, sale_month ORDER BY sale_year, sale_month
    """), params).fetchall()

    depot_rows = db.execute(text(f"""
        SELECT depot, SUM(amount) AS amount
        FROM plant_to_depot_sales WHERE {where_sql}
        GROUP BY depot ORDER BY amount DESC
    """), params).fetchall()

    category_rows = db.execute(text(f"""
        SELECT category, SUM(amount) AS amount
        FROM plant_to_depot_sales WHERE {where_sql}
        GROUP BY category ORDER BY amount DESC
    """), params).fetchall()

    brand_rows = db.execute(text(f"""
        SELECT brand, SUM(amount) AS amount
        FROM plant_to_depot_sales WHERE {where_sql}
        GROUP BY brand ORDER BY amount DESC
    """), params).fetchall()

    depot_category_rows = db.execute(text(f"""
        SELECT depot, category, SUM(amount) AS amount
        FROM plant_to_depot_sales WHERE {where_sql}
        GROUP BY depot, category ORDER BY depot, category
    """), params).fetchall()

    return {
        "kpis": {"total_amount": float(total_amount or 0)},
        "trends": [{"year": r.sale_year, "month": r.sale_month, "amount": float(r.amount)} for r in trend_rows],
        "depots": [{"depot": r.depot, "amount": float(r.amount)} for r in depot_rows],
        "categories": [{"category": r.category, "amount": float(r.amount)} for r in category_rows],
        "brands": [{"brand": r.brand, "amount": float(r.amount)} for r in brand_rows],
        "depot_category": [{"depot": r.depot, "category": r.category, "amount": float(r.amount)} for r in depot_category_rows],
    }


@router.get("/period-analytics")
def period_analytics(
    mode: str = Query(...),
    periods: str = Query(..., description="Comma-separated tokens; shape depends on mode"),
    depot: Optional[str] = None,
    brand: Optional[str] = None,
    category: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    tokens = [t.strip() for t in periods.split(",") if t.strip()]
    if not tokens:
        raise HTTPException(status_code=400, detail="Provide at least 1 period")

    resolved = [_resolve_period(mode, t) for t in tokens]

    period_rows = []
    for p in resolved:
        breakdown = _period_breakdown(db, p["months"], depot, brand, category)
        period_rows.append({"key": p["key"], "label": p["label"], "amount": breakdown["kpis"]["total_amount"]})

    all_months = sorted({ym for p in resolved for ym in p["months"]})
    blended = _period_breakdown(db, all_months, depot, brand, category)

    return {"mode": mode, "periods": period_rows, **blended}


# ── Paginated list ────────────────────────────────────────────────────────────
@router.get("/list")
def sales_list(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    year: Optional[int] = None,
    months: Optional[str] = None,
    depot: Optional[str] = None,
    brand: Optional[str] = None,
    category: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    filters = {"year": year, "months": _parse_months_param(months), "depot": depot, "brand": brand, "category": category}
    where_clauses = ["1=1"]
    params: dict = {}
    _apply_filters_sql(where_clauses, params, filters)
    where_sql = " AND ".join(where_clauses)

    total = db.execute(text(f"SELECT COUNT(*) FROM plant_to_depot_sales WHERE {where_sql}"), params).scalar()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT id, sale_year, sale_month, depot, brand, category, qty, rate, amount
        FROM plant_to_depot_sales WHERE {where_sql}
        ORDER BY sale_year DESC, sale_month DESC, depot, brand, category
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "data": [
            {
                "id": str(r.id), "sale_year": r.sale_year, "sale_month": r.sale_month,
                "depot": r.depot, "brand": r.brand, "category": r.category,
                "qty": float(r.qty) if r.qty is not None else None,
                "rate": float(r.rate) if r.rate is not None else None,
                "amount": float(r.amount),
            }
            for r in rows
        ],
    }


# ── Sync history ──────────────────────────────────────────────────────────────
@router.get("/sync-history")
def sync_history(
    sheet_source_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    query = db.query(SyncLog).filter(SyncLog.module == MODULE)
    if sheet_source_id:
        source = db.query(SheetSource).filter(SheetSource.id == sheet_source_id, SheetSource.module == MODULE).first()
        if source:
            query = query.filter(SyncLog.source_label == source.sheet_id)
    logs = query.order_by(SyncLog.synced_at.desc()).limit(50).all()
    return [
        {
            "id": str(l.id),
            "rows_total": l.rows_total, "rows_inserted": l.rows_inserted,
            "rows_updated": l.rows_updated, "rows_failed": l.rows_failed,
            "rows_deleted": l.rows_deleted, "status": l.status,
            "synced_at": l.synced_at.isoformat() if l.synced_at else None,
        }
        for l in logs
    ]

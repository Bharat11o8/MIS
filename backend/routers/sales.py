"""
AutoForm MIS — Sales (Plant to Depot) Router
Sheet-source registry (multi-sheet, one per fiscal year), manual "Sync Now"
per registered sheet, unified cross-sheet analytics, filter options, paginated
list, sync history.
"""
import os
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text
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


# ── Sheet registry ─────────────────────────────────────────────────────────────
class SheetSourceIn(BaseModel):
    sheet_url_or_id: str
    label: str


@router.post("/sheet-sources")
def add_sheet_source(
    body: SheetSourceIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    sid = extract_sheet_id(body.sheet_url_or_id)
    source = SheetSource(
        id=uuid.uuid4(),
        module=MODULE,
        sheet_id=sid,
        label=body.label.strip(),
        calendar_year=None,
        created_by=current_user.id,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return {
        "id": str(source.id), "sheet_id": source.sheet_id, "label": source.label,
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


# ── Analytics ──────────────────────────────────────────────────────────────────
@router.get("/analytics")
def sales_analytics(
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

    mom_growth = None
    mom_period = None
    if len(trend_rows) >= 2:
        pr, cr = trend_rows[-2], trend_rows[-1]
        if pr.amount and float(pr.amount) > 0:
            mom_growth = round((float(cr.amount) - float(pr.amount)) / float(pr.amount) * 100, 1)
        mom_period = f"{_MN[pr.sale_month - 1]} → {_MN[cr.sale_month - 1]}"

    # Non-time filters for YoY / QoQ (so they always compare full-period data)
    nt_where = ["1=1"]
    nt_params: dict = {}
    if depot:
        nt_where.append("depot = :depot"); nt_params["depot"] = depot
    if brand:
        nt_where.append("brand = :brand"); nt_params["brand"] = brand
    if category:
        nt_where.append("category = :category"); nt_params["category"] = category
    nt_sql = " AND ".join(nt_where)

    # YoY: compare latest month in current view to same month prior year
    yoy_growth = None
    yoy_period = None
    if trend_rows:
        latest = trend_rows[-1]
        ly = db.execute(text(f"""
            SELECT COALESCE(SUM(amount), 0) FROM plant_to_depot_sales
            WHERE {nt_sql} AND sale_year = :y AND sale_month = :m
        """), {**nt_params, "y": latest.sale_year - 1, "m": latest.sale_month}).scalar()
        if float(ly) > 0:
            yoy_growth = round((float(latest.amount) - float(ly)) / float(ly) * 100, 1)
        yoy_period = f"{_MN[latest.sale_month - 1]} {latest.sale_year - 1} → {_MN[latest.sale_month - 1]} {latest.sale_year}"

    # QoQ: aggregate all available data into Indian FY quarters, compare last two
    def _fyq(y: int, m: int):
        return (y, (m - 4) // 3 + 1) if m >= 4 else (y - 1, 4)

    all_trend = db.execute(text(f"""
        SELECT sale_year, sale_month, SUM(amount) AS amount
        FROM plant_to_depot_sales WHERE {nt_sql}
        GROUP BY sale_year, sale_month ORDER BY sale_year, sale_month
    """), nt_params).fetchall()

    q_totals: dict = {}
    for r in all_trend:
        qk = _fyq(r.sale_year, r.sale_month)
        q_totals[qk] = q_totals.get(qk, 0.0) + float(r.amount)

    qoq_growth = None
    qoq_period = None
    sqs = sorted(q_totals)
    if len(sqs) >= 2:
        p_qk, c_qk = sqs[-2], sqs[-1]
        p_amt, c_amt = q_totals[p_qk], q_totals[c_qk]
        if p_amt > 0:
            qoq_growth = round((c_amt - p_amt) / p_amt * 100, 1)
        qn = {1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"}
        qoq_period = f"{qn[p_qk[1]]} FY{str(p_qk[0] + 1)[-2:]} → {qn[c_qk[1]]} FY{str(c_qk[0] + 1)[-2:]}"

    # YoY at FY level (compare two most recent complete FYs in full dataset)
    yoy_fy_growth = None
    yoy_fy_period = None
    fy_totals: dict = {}
    for r in all_trend:
        fy_s = r.sale_year if r.sale_month >= 4 else r.sale_year - 1
        fy_totals[fy_s] = fy_totals.get(fy_s, 0.0) + float(r.amount)
    sorted_fys = sorted(fy_totals)
    if len(sorted_fys) >= 2:
        p_fy, c_fy = sorted_fys[-2], sorted_fys[-1]
        if fy_totals[p_fy] > 0:
            yoy_fy_growth = round((fy_totals[c_fy] - fy_totals[p_fy]) / fy_totals[p_fy] * 100, 1)
        yoy_fy_period = f"FY{str(p_fy + 1)[-2:]} → FY{str(c_fy + 1)[-2:]}"

    return {
        "kpis": {
            "total_amount": float(total_amount or 0),
            "mom_growth": mom_growth,
            "mom_period": mom_period,
            "yoy_growth": yoy_growth,
            "yoy_period": yoy_period,
            "qoq_growth": qoq_growth,
            "qoq_period": qoq_period,
            "yoy_fy_growth": yoy_fy_growth,
            "yoy_fy_period": yoy_fy_period,
        },
        "trends": [
            {"year": r.sale_year, "month": r.sale_month, "amount": float(r.amount)} for r in trend_rows
        ],
        "depots": [{"depot": r.depot, "amount": float(r.amount)} for r in depot_rows],
        "categories": [{"category": r.category, "amount": float(r.amount)} for r in category_rows],
        "brands": [{"brand": r.brand, "amount": float(r.amount)} for r in brand_rows],
    }


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

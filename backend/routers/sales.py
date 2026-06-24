"""
AutoForm MIS — Sales (Plant to Depot) Router
Manual "Sync Now" against the team's existing Google Sheet, unified analytics,
filter options, paginated list, sync history.
"""
import os
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import text
from database import get_db
from models import PlantToDepotSale, SyncLog, User
from routers.auth import get_current_user
from services.sales_sync import parse_workbook

router = APIRouter(prefix="/sales", tags=["Sales"])

ALLOWED_ROLES = {"superadmin", "management", "sales_head"}
DEPOTS = ["Janak Motors", "United Auto"]
BRANDS = ["Autoform", "Autocruze", "Combined"]
CATEGORIES = ["Seat Cover", "Accessories", "Mats", "Boot & Cabin Mat", "Electronics"]


def _require_access(current_user: User):
    if current_user.role not in ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail="Not authorized to access Sales data")


# ── Filter helper ─────────────────────────────────────────────────────────────
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


# ── Sync ───────────────────────────────────────────────────────────────────────
@router.post("/sync")
def sync_now(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

    sheet_id = os.getenv("SALES_SHEET_ID")
    if not sheet_id:
        raise HTTPException(status_code=500, detail="SALES_SHEET_ID is not configured")

    log = SyncLog(
        id=uuid.uuid4(),
        module="sales_plant_to_depot",
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

    # ── Reconcile: the DB should mirror the sheet's current state, so a month
    # removed entirely (tab deleted) or a row removed from a still-present
    # month must disappear here too, not just stop being refreshed.
    covered_set = set(covered_months)
    existing_months = db.execute(text("SELECT DISTINCT sale_year, sale_month FROM plant_to_depot_sales")).fetchall()
    for r in existing_months:
        if (r.sale_year, r.sale_month) not in covered_set:
            result = db.execute(text("DELETE FROM plant_to_depot_sales WHERE sale_year = :y AND sale_month = :m"),
                                 {"y": r.sale_year, "m": r.sale_month})
            deleted += result.rowcount
    db.commit()

    new_keys_by_month: dict = {}
    for rec in records:
        new_keys_by_month.setdefault((rec["sale_year"], rec["sale_month"]), set()).add(
            (rec["depot"], rec["brand"], rec["category"])
        )
    for (y, m) in covered_set:
        existing_rows = db.execute(
            text("SELECT depot, brand, category FROM plant_to_depot_sales WHERE sale_year = :y AND sale_month = :m"),
            {"y": y, "m": m},
        ).fetchall()
        new_keys = new_keys_by_month.get((y, m), set())
        for row in existing_rows:
            if (row.depot, row.brand, row.category) not in new_keys:
                db.execute(text("""
                    DELETE FROM plant_to_depot_sales
                    WHERE sale_year = :y AND sale_month = :m AND depot = :d AND brand = :b AND category = :c
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
    _require_access(current_user)

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
    _require_access(current_user)

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
    if len(trend_rows) >= 2:
        prev, curr = trend_rows[-2].amount, trend_rows[-1].amount
        if prev:
            mom_growth = round((float(curr) - float(prev)) / float(prev) * 100, 1)

    return {
        "kpis": {
            "total_amount": float(total_amount or 0),
            "mom_growth": mom_growth,
            "top_depot": depot_rows[0].depot if depot_rows else None,
            "top_category": category_rows[0].category if category_rows else None,
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
    _require_access(current_user)

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
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

    logs = db.query(SyncLog).filter(SyncLog.module == "sales_plant_to_depot").order_by(SyncLog.synced_at.desc()).limit(50).all()
    return [
        {
            "id": str(l.id),
            "rows_total": l.rows_total,
            "rows_inserted": l.rows_inserted,
            "rows_updated": l.rows_updated,
            "rows_failed": l.rows_failed,
            "rows_deleted": l.rows_deleted,
            "status": l.status,
            "synced_at": l.synced_at.isoformat() if l.synced_at else None,
        }
        for l in logs
    ]

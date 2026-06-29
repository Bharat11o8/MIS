"""
AutoForm MIS — Sales (Depot to Distributor) Router
Register a quarterly Google Sheet, manually "Sync Now" against it, ASM-grouped
analytics with our own recomputed attainment %, filter options, paginated
list, sync history.
"""
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text
from database import get_db
from models import SheetSource, DistributorSale, SyncLog, User
from routers.auth import get_current_user
from services.google_sheets import extract_sheet_id
from services.distributor_sales_sync import parse_distributor_sheet

router = APIRouter(prefix="/distributor-sales", tags=["Distributor Sales"])

MODULE = "sales_depot_to_distributor"
ALLOWED_ROLES = {"superadmin", "management", "sales_head"}


def _require_access(current_user: User):
    if current_user.role not in ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail="Not authorized to access Sales data")


class SheetSourceIn(BaseModel):
    sheet_url_or_id: str
    label: str
    calendar_year: int


# ── Sheet registry ─────────────────────────────────────────────────────────────
@router.post("/sheet-sources")
def add_sheet_source(
    body: SheetSourceIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

    sheet_id = extract_sheet_id(body.sheet_url_or_id)
    source = SheetSource(
        id=uuid.uuid4(),
        module=MODULE,
        sheet_id=sheet_id,
        label=body.label.strip(),
        calendar_year=body.calendar_year,
        created_by=current_user.id,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return {
        "id": str(source.id), "sheet_id": source.sheet_id, "label": source.label,
        "calendar_year": source.calendar_year, "created_at": source.created_at.isoformat(),
    }


@router.delete("/sheet-sources/{source_id}")
def delete_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

    source = db.query(SheetSource).filter(SheetSource.id == source_id, SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    # ON DELETE CASCADE — all distributor_sales rows for this quarter are removed.
    rows_deleted = db.execute(
        text("SELECT COUNT(*) FROM distributor_sales WHERE sheet_source_id = :sid"),
        {"sid": str(source.id)},
    ).scalar()
    db.delete(source)
    db.commit()
    return {"deleted": True, "rows_deleted": rows_deleted}


@router.get("/sheet-sources")
def list_sheet_sources(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

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
            "id": str(s.id), "sheet_id": s.sheet_id, "label": s.label, "calendar_year": s.calendar_year,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "last_synced_at": last_log.synced_at.isoformat() if last_log and last_log.synced_at else None,
            "last_sync_status": last_log.status if last_log else None,
        })
    return result


# ── Sync ───────────────────────────────────────────────────────────────────────
@router.post("/sheet-sources/{source_id}/sync")
def sync_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

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
        records, errors = parse_distributor_sheet(source.sheet_id, source.calendar_year)
    except Exception as e:
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=502, detail=f"Could not sync from Google Sheets: {e}")

    result = db.execute(
        text("DELETE FROM distributor_sales WHERE sheet_source_id = :sid"), {"sid": str(source.id)}
    )
    deleted = result.rowcount
    db.commit()

    inserted = 0
    failed = 0
    row_errors = list(errors)
    for rec in records:
        try:
            db.execute(text("""
                INSERT INTO distributor_sales
                    (id, sheet_source_id, entity_type, distributor, area_head, target,
                     sale_year, sale_month, category, amount, sync_log_id)
                VALUES
                    (:id, :sheet_source_id, :entity_type, :distributor, :area_head, :target,
                     :sale_year, :sale_month, :category, :amount, :sync_log_id)
            """), {
                "id": str(uuid.uuid4()), "sheet_source_id": str(source.id),
                "entity_type": rec["entity_type"], "distributor": rec["distributor"],
                "area_head": rec["area_head"], "target": rec["target"],
                "sale_year": rec["sale_year"], "sale_month": rec["sale_month"],
                "category": rec["category"], "amount": rec["amount"],
                "sync_log_id": str(log.id),
            })
            db.commit()
            inserted += 1
        except Exception as e:
            db.rollback()
            failed += 1
            row_errors.append(f"{rec['distributor']} {rec['sale_month']:02d}/{rec['category']}: {e}")

    log.rows_total = len(records)
    log.rows_inserted = inserted
    log.rows_updated = 0
    log.rows_failed = failed
    log.rows_deleted = deleted
    log.status = "Done"
    log.error_details = "\n".join(row_errors) if row_errors else None
    db.commit()

    return {
        "sync_id": str(log.id),
        "rows_total": len(records),
        "rows_inserted": inserted,
        "rows_updated": 0,
        "rows_failed": failed,
        "rows_deleted": deleted,
        "errors": row_errors[:20],
        "status": "Done",
    }


# ── Filter options ────────────────────────────────────────────────────────────
@router.get("/filter-options")
def filter_options(
    sheet_source_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

    where = "1=1"
    params: dict = {}
    if sheet_source_id:
        where = "sheet_source_id = :sid"
        params["sid"] = sheet_source_id

    area_heads = db.execute(
        text(f"SELECT DISTINCT area_head FROM distributor_sales WHERE {where} AND area_head IS NOT NULL ORDER BY area_head"),
        params,
    ).fetchall()

    return {"area_heads": [r.area_head for r in area_heads], "categories": ["SAM", "EV"]}


# ── Analytics ──────────────────────────────────────────────────────────────────
@router.get("/analytics")
def distributor_analytics(
    sheet_source_id: str = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

    source = db.query(SheetSource).filter(SheetSource.id == sheet_source_id, SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")

    # We mirror the sheet rather than audit it: a per-ASM TOTAL row can carry a
    # manual adjustment with no corresponding distributor row (confirmed real,
    # not a sheet error), so group/company rollups are read from the sheet's own
    # TOTAL/GRAND TOTAL rows directly — never recomputed by summing distributors.
    def rows_for(entity_type: str):
        return db.execute(text("""
            SELECT distributor, area_head, MAX(target) AS target, sale_month, category, SUM(amount) AS amount
            FROM distributor_sales
            WHERE sheet_source_id = :sid AND entity_type = :etype
            GROUP BY distributor, area_head, sale_month, category
            ORDER BY area_head, distributor, sale_month, category
        """), {"sid": sheet_source_id, "etype": entity_type}).fetchall()

    def fold_monthly(rows, key_fields):
        """Groups flat (key..., sale_month, category, amount) rows into {key: {..., monthly: [...], achieved}}."""
        by_key: dict = {}
        for r in rows:
            key = tuple(getattr(r, f) for f in key_fields)
            entry = by_key.setdefault(key, {f: getattr(r, f) for f in key_fields})
            months = entry.setdefault("_months", {})
            months.setdefault(r.sale_month, {"sam": 0.0, "ev": 0.0})
            months[r.sale_month][r.category.lower()] = float(r.amount)
        out = []
        for key, entry in by_key.items():
            months = entry.pop("_months")
            entry["monthly"] = [
                {"month": m, "sam": v["sam"], "ev": v["ev"]} for m, v in sorted(months.items())
            ]
            entry["achieved"] = round(sum(v["sam"] + v["ev"] for v in months.values()), 2)
            out.append(entry)
        return out

    distributors = fold_monthly(rows_for("distributor"), ["distributor", "area_head", "target"])
    for d in distributors:
        d["target"] = float(d["target"]) if d["target"] is not None else None
        d["attainment_pct"] = round(d["achieved"] / d["target"] * 100, 2) if d["target"] else None
    distributors_by_head: dict = {}
    for d in distributors:
        distributors_by_head.setdefault(d["area_head"], []).append(d)

    depot_direct = fold_monthly(rows_for("depot_direct"), ["distributor"])

    area_totals = fold_monthly(rows_for("area_head_total"), ["area_head", "target"])
    area_head_list = []
    for grp in area_totals:
        grp["target"] = float(grp["target"]) if grp["target"] is not None else None
        grp["attainment_pct"] = round(grp["achieved"] / grp["target"] * 100, 2) if grp["target"] else None
        grp["distributors"] = distributors_by_head.get(grp["area_head"], [])
        area_head_list.append(grp)
    area_head_list.sort(key=lambda g: g["area_head"] or "")

    grand_total = fold_monthly(rows_for("grand_total"), ["target"])
    company_target = float(grand_total[0]["target"]) if grand_total and grand_total[0]["target"] is not None else 0.0
    achieved_total = grand_total[0]["achieved"] if grand_total else 0.0
    achieved_depot_direct = round(sum(d["achieved"] for d in depot_direct), 2)
    achieved_distributors = round(achieved_total - achieved_depot_direct, 2)
    attainment_pct = round(achieved_total / company_target * 100, 2) if company_target else None

    top_area_head = max(area_head_list, key=lambda g: g["attainment_pct"] or 0, default=None)

    return {
        "kpis": {
            "total_target": company_target,
            "total_achieved": achieved_total,
            "attainment_pct": attainment_pct,
            "top_area_head": top_area_head["area_head"] if top_area_head else None,
        },
        "area_heads": area_head_list,
        "depot_direct": depot_direct,
        "company_total": {
            "target": company_target,
            "achieved_distributors": achieved_distributors,
            "achieved_depot_direct": achieved_depot_direct,
            "achieved_total": achieved_total,
            "attainment_pct": attainment_pct,
            "monthly": grand_total[0]["monthly"] if grand_total else [],
        },
    }


# ── Paginated list ────────────────────────────────────────────────────────────
@router.get("/list")
def distributor_list(
    sheet_source_id: str = Query(...),
    area_head: Optional[str] = None,
    category: Optional[str] = None,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(current_user)

    where_clauses = ["sheet_source_id = :sid"]
    params: dict = {"sid": sheet_source_id}
    if area_head:
        where_clauses.append("area_head = :area_head")
        params["area_head"] = area_head
    if category:
        where_clauses.append("category = :category")
        params["category"] = category
    where_sql = " AND ".join(where_clauses)

    total = db.execute(text(f"SELECT COUNT(*) FROM distributor_sales WHERE {where_sql}"), params).scalar()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT id, entity_type, distributor, area_head, target, sale_year, sale_month, category, amount
        FROM distributor_sales WHERE {where_sql}
        ORDER BY area_head, distributor, sale_month, category
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "total": total, "page": page, "per_page": per_page,
        "data": [
            {
                "id": str(r.id), "entity_type": r.entity_type, "distributor": r.distributor,
                "area_head": r.area_head, "target": float(r.target) if r.target is not None else None,
                "sale_year": r.sale_year, "sale_month": r.sale_month, "category": r.category,
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
    _require_access(current_user)

    query = db.query(SyncLog).filter(SyncLog.module == MODULE)
    if sheet_source_id:
        source = db.query(SheetSource).filter(SheetSource.id == sheet_source_id, SheetSource.module == MODULE).first()
        if source:
            query = query.filter(SyncLog.source_label == source.sheet_id)
    logs = query.order_by(SyncLog.synced_at.desc()).limit(50).all()
    return [
        {
            "id": str(l.id),
            "rows_total": l.rows_total, "rows_inserted": l.rows_inserted, "rows_updated": l.rows_updated,
            "rows_failed": l.rows_failed, "rows_deleted": l.rows_deleted,
            "status": l.status, "synced_at": l.synced_at.isoformat() if l.synced_at else None,
        }
        for l in logs
    ]

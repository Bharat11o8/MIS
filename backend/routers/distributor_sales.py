"""
AutoForm MIS — Sales (Depot to Distributor) Router
Register a quarterly Google Sheet, manually "Sync Now" against it, ASM-grouped
analytics with our own recomputed attainment %, filter options, paginated
list, sync history.
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
from models import SheetSource, DistributorSale, SyncLog, User
from routers.auth import get_current_user
from services.google_sheets import extract_sheet_id
from services.distributor_sales_sync import parse_distributor_sheet
from services.permissions import require_module
from services.sync_logs import SYNC_LOG_RETENTION, prune_sync_logs

router = APIRouter(prefix="/distributor-sales", tags=["Distributor Sales"])

MODULE = "sales_depot_to_distributor"
MODULE_KEY = "sales"


def _require_access(db: Session, current_user: User):
    require_module(db, current_user, MODULE_KEY)


_MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
QUARTERS = ("Q1", "Q2", "Q3", "Q4")

_MONTH_TOKEN_RE = re.compile(r"^(\d{4})-(\d{2})$")
_QUARTER_TOKEN_RE = re.compile(r"^(\d{4})-(Q[1-4])$")
_YEAR_TOKEN_RE = re.compile(r"^(\d{4})$")


# ── Period resolution ────────────────────────────────────────────────────────
# Turns a period-selector token (one per selected chip) into the set of
# sheet_source_id(s) + month restriction it actually covers. Quarterly/Yearly
# resolve via the registered sheet_sources' own calendar_year/quarter — this
# module already has an authoritative quarter identity, so there's no need to
# re-derive fiscal quarters from raw month numbers (unlike sales.py's _fyq,
# which exists there only because plant_to_depot_sales has no sheet-level
# quarter identity at all).
def _resolve_month_token(db: Session, token: str) -> dict:
    m = _MONTH_TOKEN_RE.match(token)
    if not m:
        raise HTTPException(status_code=400, detail=f"Invalid month token: {token!r} (expected YYYY-MM)")
    year, month = int(m.group(1)), int(m.group(2))
    rows = db.execute(text("""
        SELECT DISTINCT ds.sheet_source_id
        FROM distributor_sales ds
        JOIN sheet_sources s ON s.id = ds.sheet_source_id
        WHERE s.module = :mod AND ds.sale_year = :y AND ds.sale_month = :m
    """), {"mod": MODULE, "y": year, "m": month}).fetchall()
    return {
        "key": token, "label": f"{_MN[month - 1]} {year}", "is_partial": True,
        "sheet_sources": [(str(r.sheet_source_id), [month]) for r in rows],
    }


def _resolve_quarter_token(db: Session, token: str) -> dict:
    m = _QUARTER_TOKEN_RE.match(token)
    if not m:
        raise HTTPException(status_code=400, detail=f"Invalid quarter token: {token!r} (expected YYYY-Qn)")
    year, quarter = int(m.group(1)), m.group(2)
    source = db.query(SheetSource).filter(
        SheetSource.module == MODULE, SheetSource.calendar_year == year, SheetSource.quarter == quarter,
    ).first()
    if not source:
        return {
            "key": token, "label": f"{quarter} FY{year % 100:02d} (not registered)",
            "is_partial": False, "sheet_sources": [],
        }
    return {"key": token, "label": source.label, "is_partial": False, "sheet_sources": [(str(source.id), None)]}


def _resolve_year_token(db: Session, token: str) -> dict:
    m = _YEAR_TOKEN_RE.match(token)
    if not m:
        raise HTTPException(status_code=400, detail=f"Invalid year token: {token!r} (expected YYYY)")
    year = int(m.group(1))
    sources = db.query(SheetSource).filter(SheetSource.module == MODULE, SheetSource.calendar_year == year).all()
    return {
        "key": token, "label": f"FY{year % 100:02d}", "is_partial": False,
        "sheet_sources": [(str(s.id), None) for s in sources],
    }


_RESOLVERS = {"monthly": _resolve_month_token, "quarterly": _resolve_quarter_token, "yearly": _resolve_year_token}


def _resolve_periods(db: Session, mode: str, tokens: list) -> list:
    resolver = _RESOLVERS.get(mode)
    if resolver is None:
        raise HTTPException(status_code=400, detail="mode must be one of monthly, quarterly, yearly")
    return [resolver(db, t) for t in tokens]


# Merges resolved periods' (sheet_source_id, months) pairs into one map for the
# blended (whole-selection) view. None ("all months of this sheet") always wins
# over a partial subset for the same sheet_source_id.
def _flatten_periods(periods: list) -> dict:
    merged: dict = {}
    for p in periods:
        for sid, months in p["sheet_sources"]:
            if sid not in merged:
                merged[sid] = months
            elif merged[sid] is None or months is None:
                merged[sid] = None
            else:
                merged[sid] = sorted(set(merged[sid]) | set(months))
    return merged


# ── Aggregation ──────────────────────────────────────────────────────────────
# We mirror the sheet rather than audit it: a per-ASM TOTAL row can carry a
# manual adjustment with no corresponding distributor row (confirmed real, not
# a sheet error), so group/company rollups are read from the sheet's own
# TOTAL/GRAND TOTAL rows directly — never recomputed by summing distributors.
# Those rows carry a REAL independent value per (sale_month, category) cell
# (confirmed against the parser and a live sheet), so summing any subset of
# months from them — even discontinuous, even across different quarter-sheets
# — stays 100% sheet-trusted.
def _rows_for(db: Session, entity_type: str, sheet_month_map: dict):
    """sheet_month_map: {sheet_source_id: [months] | None (= all months)}."""
    if not sheet_month_map:
        return []
    clauses = []
    params: dict = {"etype": entity_type}
    for i, (sid, months) in enumerate(sheet_month_map.items()):
        sid_key = f"sid{i}"
        params[sid_key] = sid
        if months is None:
            clauses.append(f"sheet_source_id = :{sid_key}")
        else:
            month_keys = []
            for j, mth in enumerate(months):
                mk = f"{sid_key}_m{j}"
                params[mk] = mth
                month_keys.append(f":{mk}")
            clauses.append(f"(sheet_source_id = :{sid_key} AND sale_month IN ({', '.join(month_keys)}))")
    where_sql = " OR ".join(clauses)
    return db.execute(text(f"""
        SELECT sheet_source_id, distributor, area_head, target, sale_year, sale_month, category, amount
        FROM distributor_sales
        WHERE entity_type = :etype AND ({where_sql})
    """), params).fetchall()


# target is denormalized — the same quarterly figure repeats on every
# (sale_month, category) row of one sheet_source_id. Dedupe to one value per
# (key, sheet_source_id) FIRST, then sum across sheet_source_ids — never sum
# target across months/categories of the same sheet_source_id, or a single
# quarterly target gets counted once per selected month.
def _blend(rows, key_fields: list):
    by_key: dict = {}
    for r in rows:
        key = tuple(getattr(r, f) for f in key_fields) if key_fields else ("__all__",)
        entry = by_key.setdefault(key, {f: getattr(r, f) for f in key_fields})
        months = entry.setdefault("_months", {})
        months.setdefault((r.sale_year, r.sale_month), {"sam": 0.0, "ev": 0.0})
        months[(r.sale_year, r.sale_month)][r.category.lower()] += float(r.amount)
        targets = entry.setdefault("_targets", {})
        if r.sheet_source_id not in targets and r.target is not None:
            targets[r.sheet_source_id] = float(r.target)

    out = []
    for entry in by_key.values():
        months = entry.pop("_months")
        targets = entry.pop("_targets")
        entry["monthly"] = [
            {"year": y, "month": m, "sam": v["sam"], "ev": v["ev"]}
            for (y, m), v in sorted(months.items())
        ]
        entry["achieved"] = round(sum(v["sam"] + v["ev"] for v in months.values()), 2)
        entry["target"] = round(sum(targets.values()), 2) if targets else None
        out.append(entry)
    return out


def _aggregate(db: Session, sheet_month_map: dict) -> dict:
    distributors = _blend(_rows_for(db, "distributor", sheet_month_map), ["distributor", "area_head"])
    for d in distributors:
        d["attainment_pct"] = round(d["achieved"] / d["target"] * 100, 2) if d["target"] else None
    distributors_by_head: dict = {}
    for d in distributors:
        distributors_by_head.setdefault(d["area_head"], []).append(d)

    depot_direct = _blend(_rows_for(db, "depot_direct", sheet_month_map), ["distributor"])

    area_totals = _blend(_rows_for(db, "area_head_total", sheet_month_map), ["area_head"])
    area_head_list = []
    for grp in area_totals:
        grp["attainment_pct"] = round(grp["achieved"] / grp["target"] * 100, 2) if grp["target"] else None
        grp["distributors"] = distributors_by_head.get(grp["area_head"], [])
        area_head_list.append(grp)
    area_head_list.sort(key=lambda g: g["area_head"] or "")

    grand_total = _blend(_rows_for(db, "grand_total", sheet_month_map), [])
    company_target = grand_total[0]["target"] if grand_total and grand_total[0]["target"] is not None else 0.0
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


def _period_company_totals(db: Session, period: dict) -> dict:
    sheet_month_map = dict(period["sheet_sources"])
    grand_total = _blend(_rows_for(db, "grand_total", sheet_month_map), [])
    target = grand_total[0]["target"] if grand_total and grand_total[0]["target"] is not None else 0.0
    achieved = grand_total[0]["achieved"] if grand_total else 0.0
    attainment_pct = round(achieved / target * 100, 2) if target else None
    return {"target": target, "achieved": achieved, "attainment_pct": attainment_pct}


class SheetSourceIn(BaseModel):
    sheet_url_or_id: str
    calendar_year: int
    quarter: str


# ── Sheet registry ─────────────────────────────────────────────────────────────
@router.post("/sheet-sources")
def add_sheet_source(
    body: SheetSourceIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    if body.quarter not in QUARTERS:
        raise HTTPException(status_code=400, detail="quarter must be one of Q1, Q2, Q3, Q4")

    # Label is derived, not typed — "Q1 FY26" — so quarter identity never drifts
    # from what the sheet actually is, and quarters sort/compare reliably.
    label = f"{body.quarter} FY{body.calendar_year % 100:02d}"
    sheet_id = extract_sheet_id(body.sheet_url_or_id)
    source = SheetSource(
        id=uuid.uuid4(),
        module=MODULE,
        sheet_id=sheet_id,
        label=label,
        calendar_year=body.calendar_year,
        quarter=body.quarter,
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
        "calendar_year": source.calendar_year, "quarter": source.quarter,
        "created_at": source.created_at.isoformat(),
    }


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
    _require_access(db, current_user)

    sources = (
        db.query(SheetSource).filter(SheetSource.module == MODULE)
        .order_by(SheetSource.calendar_year.desc(), SheetSource.quarter.desc())
        .all()
    )
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
            "calendar_year": s.calendar_year, "quarter": s.quarter,
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
    prune_sync_logs(db, MODULE, source.sheet_id)

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
    _require_access(db, current_user)

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


# ── Period analytics ─────────────────────────────────────────────────────────
# Replaces the old single-quarter /analytics + manual /compare with one
# selector-driven endpoint: pick a mode and 1+ periods (months, quarters, or
# years — mixing years within a mode is allowed), get back a per-period
# comparison row for the top-of-dashboard cards plus one blended breakdown
# (area heads / distributors / company total) summed across the whole
# selection for everything below.
@router.get("/period-analytics")
def period_analytics(
    mode: str = Query(...),
    periods: str = Query(..., description="Comma-separated tokens; shape depends on mode"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    tokens = [t.strip() for t in periods.split(",") if t.strip()]
    if not tokens:
        raise HTTPException(status_code=400, detail="Provide at least 1 period")

    resolved = _resolve_periods(db, mode, tokens)

    period_rows = [
        {"key": p["key"], "label": p["label"], "is_partial": p["is_partial"], **_period_company_totals(db, p)}
        for p in resolved
    ]

    sheet_month_map = _flatten_periods(resolved)
    aggregate = _aggregate(db, sheet_month_map)

    return {
        "mode": mode,
        "is_partial": any(p["is_partial"] for p in resolved),
        "periods": period_rows,
        **aggregate,
    }


# ── Available periods (selector chip options) ───────────────────────────────
@router.get("/periods")
def available_periods(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_access(db, current_user)

    months = db.execute(text("""
        SELECT DISTINCT ds.sale_year AS year, ds.sale_month AS month
        FROM distributor_sales ds
        JOIN sheet_sources s ON s.id = ds.sheet_source_id
        WHERE s.module = :mod
        ORDER BY 1, 2
    """), {"mod": MODULE}).fetchall()

    sources = (
        db.query(SheetSource)
        .filter(SheetSource.module == MODULE, SheetSource.quarter.isnot(None))
        .order_by(SheetSource.calendar_year, SheetSource.quarter)
        .all()
    )

    return {
        "months": [{"year": r.year, "month": r.month} for r in months],
        "quarters": [
            {"year": s.calendar_year, "quarter": s.quarter, "label": s.label, "sheet_source_id": str(s.id)}
            for s in sources
        ],
        "years": sorted({s.calendar_year for s in sources if s.calendar_year is not None}),
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
    _require_access(db, current_user)

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
    _require_access(db, current_user)

    query = db.query(SyncLog).filter(SyncLog.module == MODULE)
    if sheet_source_id:
        source = db.query(SheetSource).filter(SheetSource.id == sheet_source_id, SheetSource.module == MODULE).first()
        if source:
            query = query.filter(SyncLog.source_label == source.sheet_id)
    logs = query.order_by(SyncLog.synced_at.desc()).limit(SYNC_LOG_RETENTION).all()
    return [
        {
            "id": str(l.id),
            "rows_total": l.rows_total, "rows_inserted": l.rows_inserted, "rows_updated": l.rows_updated,
            "rows_failed": l.rows_failed, "rows_deleted": l.rows_deleted,
            "status": l.status, "synced_at": l.synced_at.isoformat() if l.synced_at else None,
        }
        for l in logs
    ]

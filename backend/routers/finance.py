"""
AutoForm MIS — Finance (Balance Sheet + P&L) Router
Per-company sheet registry (one Google Sheet per company, one tab per FY),
manual "Sync Now" per registered sheet, statement-scoped analytics with
stock-vs-flow-aware KPI math, sync history.

Gated by the per-user module/company permission system (services/permissions.py)
— never role-based ALLOWED_ROLES, unlike the older Sales routers.
"""
import uuid
from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text, bindparam
from database import get_db
from models import SheetSource, SyncLog, User
from routers.auth import get_current_user
from services.google_sheets import extract_sheet_id
from services.finance_sync import fetch_and_parse_finance_workbook
from services.permissions import require_module, require_sheet_source_access, get_user_sheet_source_ids

router = APIRouter(prefix="/finance", tags=["Finance"])

MODULE = "finance"
MODULE_KEY = "finance"
_MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _fyq(y: int, m: int):
    return (y, (m - 4) // 3 + 1) if m >= 4 else (y - 1, 4)


def _growth_kpis(monthly: list) -> dict:
    """MoM/QoQ/YoY/YoY-FY growth off a flat [{year, month, amount}] series — same
    Indian-FY-quarter math as sales.py's analytics, generalized off any series."""
    monthly = sorted(monthly, key=lambda x: (x["year"], x["month"]))
    out = {
        "mom_growth": None, "mom_period": None,
        "qoq_growth": None, "qoq_period": None,
        "yoy_growth": None, "yoy_period": None,
        "yoy_fy_growth": None, "yoy_fy_period": None,
    }
    if len(monthly) >= 2:
        pr, cr = monthly[-2], monthly[-1]
        if pr["amount"]:
            out["mom_growth"] = round((cr["amount"] - pr["amount"]) / pr["amount"] * 100, 1)
        out["mom_period"] = f"{_MN[pr['month'] - 1]} → {_MN[cr['month'] - 1]}"
    if monthly:
        latest = monthly[-1]
        ly = next((m["amount"] for m in monthly if m["year"] == latest["year"] - 1 and m["month"] == latest["month"]), None)
        if ly:
            out["yoy_growth"] = round((latest["amount"] - ly) / ly * 100, 1)
        out["yoy_period"] = f"{_MN[latest['month'] - 1]} {latest['year'] - 1} → {_MN[latest['month'] - 1]} {latest['year']}"
    q_totals: dict = {}
    for r in monthly:
        qk = _fyq(r["year"], r["month"])
        q_totals[qk] = q_totals.get(qk, 0.0) + r["amount"]
    sqs = sorted(q_totals)
    qn = {1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"}
    if len(sqs) >= 2:
        p_qk, c_qk = sqs[-2], sqs[-1]
        p_amt, c_amt = q_totals[p_qk], q_totals[c_qk]
        if p_amt:
            out["qoq_growth"] = round((c_amt - p_amt) / p_amt * 100, 1)
        out["qoq_period"] = f"{qn[p_qk[1]]} FY{str(p_qk[0] + 1)[-2:]} → {qn[c_qk[1]]} FY{str(c_qk[0] + 1)[-2:]}"
    fy_totals: dict = {}
    for r in monthly:
        fy_s = r["year"] if r["month"] >= 4 else r["year"] - 1
        fy_totals[fy_s] = fy_totals.get(fy_s, 0.0) + r["amount"]
    sorted_fys = sorted(fy_totals)
    if len(sorted_fys) >= 2:
        p_fy, c_fy = sorted_fys[-2], sorted_fys[-1]
        if fy_totals[p_fy]:
            out["yoy_fy_growth"] = round((fy_totals[c_fy] - fy_totals[p_fy]) / fy_totals[p_fy] * 100, 1)
        out["yoy_fy_period"] = f"FY{str(p_fy + 1)[-2:]} → FY{str(c_fy + 1)[-2:]}"
    return out


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
    require_module(db, current_user, MODULE_KEY)

    sheet_id = extract_sheet_id(body.sheet_url_or_id)
    source = SheetSource(
        id=uuid.uuid4(),
        module=MODULE,
        sheet_id=sheet_id,
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
    require_module(db, current_user, MODULE_KEY)

    allowed_ids = set(get_user_sheet_source_ids(db, current_user, module=MODULE))
    sources = db.query(SheetSource).filter(SheetSource.module == MODULE).order_by(SheetSource.created_at.desc()).all()
    result = []
    for s in sources:
        if str(s.id) not in allowed_ids:
            continue
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
    require_module(db, current_user, MODULE_KEY)

    source = db.query(SheetSource).filter(SheetSource.id == source_id, SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    require_sheet_source_access(db, current_user, source.id)

    bs_count = db.execute(text("SELECT COUNT(*) FROM balance_sheet_lines WHERE sheet_source_id = :sid"), {"sid": str(source.id)}).scalar()
    pl_count = db.execute(text("SELECT COUNT(*) FROM profit_loss_lines WHERE sheet_source_id = :sid"), {"sid": str(source.id)}).scalar()
    db.delete(source)  # ON DELETE CASCADE removes both fact tables' rows
    db.commit()
    return {"deleted": True, "rows_deleted": (bs_count or 0) + (pl_count or 0)}


# ── Sync ───────────────────────────────────────────────────────────────────────
@router.post("/sheet-sources/{source_id}/sync")
def sync_sheet_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    source = db.query(SheetSource).filter(SheetSource.id == source_id, SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    require_sheet_source_access(db, current_user, source.id)

    log = SyncLog(id=uuid.uuid4(), module=MODULE, source_label=source.sheet_id, status="Processing", synced_by=current_user.id)
    db.add(log)
    db.commit()
    db.refresh(log)

    try:
        records, errors, covered = fetch_and_parse_finance_workbook(source.sheet_id)
    except Exception as e:
        log.status = "Failed"
        log.error_details = str(e)
        db.commit()
        raise HTTPException(status_code=502, detail=f"Could not sync from Google Sheets: {e}")

    sid = str(source.id)
    deleted = 0
    inserted = 0
    updated = 0
    failed = 0
    row_errors = [e for e in errors]

    # ── Balance sheet reconciliation (period-removed, then line-removed) ────
    bs_dates = list(covered["bs_period_ends"])
    if bs_dates:
        stmt = text("DELETE FROM balance_sheet_lines WHERE sheet_source_id = :sid AND period_end_date NOT IN :dates") \
            .bindparams(bindparam("dates", expanding=True))
        deleted += db.execute(stmt, {"sid": sid, "dates": bs_dates}).rowcount
    else:
        deleted += db.execute(text("DELETE FROM balance_sheet_lines WHERE sheet_source_id = :sid"), {"sid": sid}).rowcount
    db.commit()

    bs_keys_by_date: dict = {}
    for rec in records["balance_sheet"]:
        bs_keys_by_date.setdefault(rec["period_end_date"], set()).add(rec["line_key"])
    for d, keys in bs_keys_by_date.items():
        existing = db.execute(
            text("SELECT line_key FROM balance_sheet_lines WHERE sheet_source_id = :sid AND period_end_date = :d"),
            {"sid": sid, "d": d},
        ).fetchall()
        for row in existing:
            if row.line_key not in keys:
                deleted += db.execute(
                    text("DELETE FROM balance_sheet_lines WHERE sheet_source_id = :sid AND period_end_date = :d AND line_key = :lk"),
                    {"sid": sid, "d": d, "lk": row.line_key},
                ).rowcount
    db.commit()

    for rec in records["balance_sheet"]:
        try:
            result = db.execute(text("""
                INSERT INTO balance_sheet_lines
                    (id, sheet_source_id, tab_title, section, entity_type, item_no, line_key, line_label,
                     parent_key, period_end_date, amount, percent, sync_log_id)
                VALUES
                    (:id, :sid, :tab_title, :section, :entity_type, :item_no, :line_key, :line_label,
                     :parent_key, :period_end_date, :amount, :percent, :sync_log_id)
                ON CONFLICT (sheet_source_id, line_key, period_end_date)
                DO UPDATE SET
                    tab_title = EXCLUDED.tab_title, section = EXCLUDED.section, entity_type = EXCLUDED.entity_type,
                    item_no = EXCLUDED.item_no, line_label = EXCLUDED.line_label, parent_key = EXCLUDED.parent_key,
                    amount = EXCLUDED.amount, percent = EXCLUDED.percent, sync_log_id = EXCLUDED.sync_log_id,
                    updated_at = NOW()
                RETURNING (xmax = 0) AS inserted
            """), {
                "id": str(uuid.uuid4()), "sid": sid, "tab_title": rec["tab_title"],
                "section": rec["section"], "entity_type": rec["entity_type"], "item_no": rec["item_no"],
                "line_key": rec["line_key"], "line_label": rec["line_label"], "parent_key": rec["parent_key"],
                "period_end_date": rec["period_end_date"], "amount": rec["amount"], "percent": rec["percent"],
                "sync_log_id": str(log.id),
            })
            db.commit()
            if result.scalar():
                inserted += 1
            else:
                updated += 1
        except Exception as e:
            db.rollback()
            failed += 1
            row_errors.append(f"BS {rec['tab_title']} {rec['line_key']} {rec['period_end_date']}: {e}")

    # ── P&L reconciliation (period-removed, then line-removed) ──────────────
    pl_periods = list(covered["pl_periods"])
    if pl_periods:
        existing_periods = db.execute(
            text("SELECT DISTINCT period_start_date, period_end_date FROM profit_loss_lines WHERE sheet_source_id = :sid"),
            {"sid": sid},
        ).fetchall()
        covered_set = set(pl_periods)
        for row in existing_periods:
            if (row.period_start_date, row.period_end_date) not in covered_set:
                deleted += db.execute(
                    text("DELETE FROM profit_loss_lines WHERE sheet_source_id = :sid AND period_start_date = :s AND period_end_date = :e"),
                    {"sid": sid, "s": row.period_start_date, "e": row.period_end_date},
                ).rowcount
    else:
        deleted += db.execute(text("DELETE FROM profit_loss_lines WHERE sheet_source_id = :sid"), {"sid": sid}).rowcount
    db.commit()

    pl_keys_by_period: dict = {}
    for rec in records["profit_loss"]:
        pl_keys_by_period.setdefault((rec["period_start_date"], rec["period_end_date"]), set()).add(rec["line_key"])
    for (s, e), keys in pl_keys_by_period.items():
        existing = db.execute(
            text("SELECT line_key FROM profit_loss_lines WHERE sheet_source_id = :sid AND period_start_date = :s AND period_end_date = :e"),
            {"sid": sid, "s": s, "e": e},
        ).fetchall()
        for row in existing:
            if row.line_key not in keys:
                deleted += db.execute(
                    text("DELETE FROM profit_loss_lines WHERE sheet_source_id = :sid AND period_start_date = :s AND period_end_date = :e AND line_key = :lk"),
                    {"sid": sid, "s": s, "e": e, "lk": row.line_key},
                ).rowcount
    db.commit()

    for rec in records["profit_loss"]:
        try:
            result = db.execute(text("""
                INSERT INTO profit_loss_lines
                    (id, sheet_source_id, tab_title, section, entity_type, item_no, line_key, line_label,
                     parent_key, period_start_date, period_end_date, period_type, amount, percent, sync_log_id)
                VALUES
                    (:id, :sid, :tab_title, :section, :entity_type, :item_no, :line_key, :line_label,
                     :parent_key, :period_start_date, :period_end_date, :period_type, :amount, :percent, :sync_log_id)
                ON CONFLICT (sheet_source_id, line_key, period_start_date, period_end_date)
                DO UPDATE SET
                    tab_title = EXCLUDED.tab_title, section = EXCLUDED.section, entity_type = EXCLUDED.entity_type,
                    item_no = EXCLUDED.item_no, line_label = EXCLUDED.line_label, parent_key = EXCLUDED.parent_key,
                    period_type = EXCLUDED.period_type, amount = EXCLUDED.amount, percent = EXCLUDED.percent,
                    sync_log_id = EXCLUDED.sync_log_id, updated_at = NOW()
                RETURNING (xmax = 0) AS inserted
            """), {
                "id": str(uuid.uuid4()), "sid": sid, "tab_title": rec["tab_title"],
                "section": rec["section"], "entity_type": rec["entity_type"], "item_no": rec["item_no"],
                "line_key": rec["line_key"], "line_label": rec["line_label"], "parent_key": rec["parent_key"],
                "period_start_date": rec["period_start_date"], "period_end_date": rec["period_end_date"],
                "period_type": rec["period_type"], "amount": rec["amount"], "percent": rec["percent"],
                "sync_log_id": str(log.id),
            })
            db.commit()
            if result.scalar():
                inserted += 1
            else:
                updated += 1
        except Exception as e:
            db.rollback()
            failed += 1
            row_errors.append(f"P&L {rec['tab_title']} {rec['line_key']} {rec['period_start_date']}–{rec['period_end_date']}: {e}")

    log.rows_total = len(records["balance_sheet"]) + len(records["profit_loss"])
    log.rows_inserted = inserted
    log.rows_updated = updated
    log.rows_failed = failed
    log.rows_deleted = deleted
    log.status = "Done"
    log.error_details = "\n".join(row_errors) if row_errors else None
    db.commit()

    return {
        "sync_id": str(log.id),
        "rows_total": log.rows_total,
        "rows_inserted": inserted,
        "rows_updated": updated,
        "rows_failed": failed,
        "rows_deleted": deleted,
        "errors": row_errors[:20],
        "status": "Done",
    }


# ── Analytics ──────────────────────────────────────────────────────────────────
def _balance_sheet_analytics(db: Session, sheet_source_id: str) -> dict:
    rows = db.execute(text("""
        SELECT section, entity_type, item_no, line_key, line_label, period_end_date, amount, percent
        FROM balance_sheet_lines WHERE sheet_source_id = :sid
        ORDER BY period_end_date
    """), {"sid": sheet_source_id}).fetchall()

    sections = {
        "sources_of_funds": {"line_items": {}, "total": {"line_key": None, "series": []}},
        "application_of_funds": {"line_items": {}, "total": {"line_key": None, "series": []}},
    }
    for r in rows:
        sec = sections.get(r.section)
        if sec is None:
            continue
        point = {"period_end_date": r.period_end_date.isoformat(), "amount": float(r.amount), "percent": r.percent}
        if r.entity_type == "total":
            sec["total"]["line_key"] = r.line_key
            sec["total"]["series"].append(point)
        else:
            item = sec["line_items"].setdefault(r.line_key, {
                "line_key": r.line_key, "line_label": r.line_label, "item_no": r.item_no,
                "entity_type": r.entity_type, "series": [],
            })
            item["series"].append(point)

    for sec in sections.values():
        sec["line_items"] = sorted(sec["line_items"].values(), key=lambda x: (x["item_no"] is None, x["item_no"] or 0))

    kpis = {
        "sources_total_latest": None, "application_total_latest": None,
        "mom_delta_pct": None, "mom_period": None,
        "qoq_delta_pct": None, "qoq_period": None,
        "yoy_delta_pct": None, "yoy_period": None,
    }
    total_series = sections["sources_of_funds"]["total"]["series"]
    if total_series:
        app_series = sections["application_of_funds"]["total"]["series"]
        kpis["sources_total_latest"] = total_series[-1]["amount"]
        kpis["application_total_latest"] = app_series[-1]["amount"] if app_series else None

        if len(total_series) >= 2:
            prev, curr = total_series[-2], total_series[-1]
            if prev["amount"]:
                kpis["mom_delta_pct"] = round((curr["amount"] - prev["amount"]) / prev["amount"] * 100, 1)
            kpis["mom_period"] = f"{prev['period_end_date']} → {curr['period_end_date']}"

        # QoQ (stock rule): last available value within each Indian FY quarter bucket
        q_latest: dict = {}
        for p in total_series:
            d = date.fromisoformat(p["period_end_date"])
            qk = _fyq(d.year, d.month)
            if qk not in q_latest or d > date.fromisoformat(q_latest[qk]["period_end_date"]):
                q_latest[qk] = p
        sqs = sorted(q_latest)
        qn = {1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"}
        if len(sqs) >= 2:
            p_qk, c_qk = sqs[-2], sqs[-1]
            p_amt, c_amt = q_latest[p_qk]["amount"], q_latest[c_qk]["amount"]
            if p_amt:
                kpis["qoq_delta_pct"] = round((c_amt - p_amt) / p_amt * 100, 1)
            kpis["qoq_period"] = f"{qn[p_qk[1]]} FY{str(p_qk[0] + 1)[-2:]} → {qn[c_qk[1]]} FY{str(c_qk[0] + 1)[-2:]}"

        # YoY (stock rule): latest date vs same month one calendar year earlier
        latest = total_series[-1]
        latest_d = date.fromisoformat(latest["period_end_date"])
        prior_year_point = next(
            (p for p in total_series
             if date.fromisoformat(p["period_end_date"]).year == latest_d.year - 1
             and date.fromisoformat(p["period_end_date"]).month == latest_d.month),
            None,
        )
        if prior_year_point and prior_year_point["amount"]:
            kpis["yoy_delta_pct"] = round((latest["amount"] - prior_year_point["amount"]) / prior_year_point["amount"] * 100, 1)
            kpis["yoy_period"] = f"{prior_year_point['period_end_date']} → {latest['period_end_date']}"

    return {"kpis": kpis, "sections": sections}


def _profit_loss_analytics(db: Session, sheet_source_id: str) -> dict:
    rows = db.execute(text("""
        SELECT section, entity_type, item_no, line_key, line_label,
               period_start_date, period_end_date, period_type, amount, percent
        FROM profit_loss_lines WHERE sheet_source_id = :sid
        ORDER BY period_end_date
    """), {"sid": sheet_source_id}).fetchall()

    sections = {
        "trading_account": {"line_items": [], "subtotals": []},
        "income_statement": {"line_items": [], "subtotals": []},
    }
    by_key: dict = {}
    fy_to_date = []
    monthly_sales, monthly_nett = [], []

    for r in rows:
        point = {
            "period_start_date": r.period_start_date.isoformat(), "period_end_date": r.period_end_date.isoformat(),
            "amount": float(r.amount), "percent": r.percent,
        }
        if r.period_type == "annual":
            fy_to_date.append({"line_key": r.line_key, "line_label": r.line_label, "section": r.section, **point})
            continue

        entry = by_key.setdefault(r.line_key, {
            "line_key": r.line_key, "line_label": r.line_label, "item_no": r.item_no,
            "section": r.section, "entity_type": r.entity_type, "series": [],
        })
        entry["series"].append(point)

        label_norm = r.line_label.upper().rstrip(":").strip()
        if label_norm == "SALES ACCOUNTS":
            monthly_sales.append({"year": r.period_end_date.year, "month": r.period_end_date.month, "amount": float(r.amount)})
        if label_norm == "NETT PROFIT":
            monthly_nett.append({"year": r.period_end_date.year, "month": r.period_end_date.month, "amount": float(r.amount)})

    headline = {"gross_profit": {"series": []}, "nett_profit": {"series": []}}
    for entry in by_key.values():
        sec = sections.get(entry["section"])
        if sec is None:
            continue
        label_norm = entry["line_label"].upper().rstrip(":").strip()
        if entry["entity_type"] == "total" and label_norm == "GROSS PROFIT":
            headline["gross_profit"] = entry
        elif entry["entity_type"] == "total" and label_norm == "NETT PROFIT":
            headline["nett_profit"] = entry
        elif entry["entity_type"] == "subtotal":
            sec["subtotals"].append(entry)
        else:
            sec["line_items"].append(entry)

    for sec in sections.values():
        sec["line_items"].sort(key=lambda x: (x["item_no"] is None, x["item_no"] or 0))

    kpis = {
        "sales_accounts_total": round(sum(m["amount"] for m in monthly_sales), 2) if monthly_sales else 0.0,
        "nett_profit_total": round(sum(m["amount"] for m in monthly_nett), 2) if monthly_nett else 0.0,
        **_growth_kpis(monthly_sales),
    }

    return {"kpis": kpis, "sections": sections, "headline": headline, "fy_to_date": fy_to_date}


@router.get("/analytics")
def finance_analytics(
    sheet_source_id: str = Query(...),
    statement: str = Query(..., pattern="^(balance_sheet|profit_loss)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    source = db.query(SheetSource).filter(SheetSource.id == sheet_source_id, SheetSource.module == MODULE).first()
    if not source:
        raise HTTPException(status_code=404, detail="Sheet source not found")
    require_sheet_source_access(db, current_user, source.id)

    if statement == "balance_sheet":
        return _balance_sheet_analytics(db, sheet_source_id)
    return _profit_loss_analytics(db, sheet_source_id)


# ── Sync history ──────────────────────────────────────────────────────────────
@router.get("/sync-history")
def sync_history(
    sheet_source_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_module(db, current_user, MODULE_KEY)

    query = db.query(SyncLog).filter(SyncLog.module == MODULE)
    if sheet_source_id:
        source = db.query(SheetSource).filter(SheetSource.id == sheet_source_id, SheetSource.module == MODULE).first()
        if source:
            require_sheet_source_access(db, current_user, source.id)
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

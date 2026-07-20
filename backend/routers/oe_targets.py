"""
AutoForm MIS — OE Quarterly Targets analytics.

Reads the oe_targets rows produced by services/oe_targets_sync.py. The registry
and sync for target sheets live in routers/oe_network.py alongside the other two
OE sheet types; this router is the read side only.

Two deliberate choices:
  • Every aggregate is computed from the per-salesperson monthly rows. The source
    sheet's own TOTAL row/column is never ingested — it drifts from its own data.
  • ACH % is derived here, never stored, and every response carries BOTH the
    units (nos) and the money (value) figures. They diverge a lot in the real
    data (Hyundai AMJ: 72% on units, 84% on value), so the UI can toggle between
    them without a refetch and neither is privileged as "the" number.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
from models import User
from routers.auth import get_current_user
from routers.oe_network import _require_access
from services.oe_targets_sync import QUARTER_TAGS

router = APIRouter(prefix="/oe-network/targets", tags=["OE Network"])


def _fy_label(fy: int) -> str:
    return f"FY{fy % 100:02d}-{(fy + 1) % 100:02d}"


def _filters(oem, category, salesperson, region):
    where, params = ["1=1"], {}
    for col, val in {"oem": oem, "category": category,
                     "salesperson": salesperson, "region": region}.items():
        if val:
            where.append(f"{col} = :{col}")
            params[col] = val
    return where, params


def _metrics(r) -> dict:
    """Target/achievement pair plus both achievement percentages."""
    tn = float(r.tgt_nos or 0)
    tv = float(r.tgt_value or 0)
    an = float(r.ach_nos or 0)
    av = float(r.ach_value or 0)
    return {
        "tgt_nos": tn, "ach_nos": an,
        "tgt_value": tv, "ach_value": av,
        "ach_pct_nos": round(an / tn * 100, 1) if tn else None,
        "ach_pct_value": round(av / tv * 100, 1) if tv else None,
        "gap_nos": an - tn, "gap_value": av - tv,
    }


_SUMS = """
    SUM(tgt_nos) AS tgt_nos, SUM(tgt_value) AS tgt_value,
    SUM(ach_nos) AS ach_nos, SUM(ach_value) AS ach_value
"""


@router.get("/periods")
def periods(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Quarters that actually have data, newest first."""
    _require_access(db, current_user)
    rows = db.execute(text("""
        SELECT DISTINCT fy_year, quarter FROM oe_targets ORDER BY fy_year DESC, quarter DESC
    """)).fetchall()
    return [
        {
            "fy_year": r.fy_year, "quarter": r.quarter,
            "token": f"{r.fy_year}-Q{r.quarter}",
            "label": f"{QUARTER_TAGS[r.quarter]} {_fy_label(r.fy_year)}",
        }
        for r in rows
    ]


@router.get("/filter-options")
def filter_options(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _require_access(db, current_user)

    def distinct(col: str):
        rows = db.execute(text(
            f"SELECT DISTINCT {col} FROM oe_targets WHERE {col} IS NOT NULL ORDER BY {col}"
        )).fetchall()
        return [r[0] for r in rows]

    return {
        "oems": distinct("oem"),
        "categories": distinct("category"),
        "salespersons": distinct("salesperson"),
        "regions": distinct("region"),
    }


@router.get("/summary")
def summary(
    fy_year: int = Query(..., description="FY start year — 2026 means FY26-27"),
    quarter: int = Query(..., ge=1, le=4),
    oem: Optional[str] = None,
    category: Optional[str] = None,
    salesperson: Optional[str] = None,
    region: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Everything the Targets tab draws, in one round trip."""
    _require_access(db, current_user)

    where, params = _filters(oem, category, salesperson, region)
    where += ["fy_year = :fy_year", "quarter = :quarter"]
    params |= {"fy_year": fy_year, "quarter": quarter}
    where_sql = " AND ".join(where)

    if not db.execute(text(f"SELECT 1 FROM oe_targets WHERE {where_sql} LIMIT 1"), params).first():
        raise HTTPException(status_code=404, detail="No target data for this selection")

    kpis = db.execute(text(f"SELECT {_SUMS} FROM oe_targets WHERE {where_sql}"), params).fetchone()

    def grouped(select_cols: str, group_by: str, order_by: str):
        rows = db.execute(text(f"""
            SELECT {select_cols}, {_SUMS}
            FROM oe_targets WHERE {where_sql} AND {group_by.split(',')[0]} IS NOT NULL
            GROUP BY {group_by} ORDER BY {order_by}
        """), params).fetchall()
        return rows

    by_sp = grouped("salesperson AS key, MIN(region) AS region", "salesperson", "SUM(tgt_value) DESC")
    # by_oem clubs TATA's SC and MAT together — that's the default view the
    # business asked for; by_oem_category keeps the split available underneath.
    by_oem = grouped("oem AS key", "oem", "SUM(tgt_value) DESC")
    by_oem_cat = grouped("oem, category AS key", "oem, category", "oem, category")
    by_region = grouped("region AS key", "region", "SUM(tgt_value) DESC")
    by_month = db.execute(text(f"""
        SELECT period_year, period_month, {_SUMS}
        FROM oe_targets WHERE {where_sql}
        GROUP BY period_year, period_month ORDER BY period_year, period_month
    """), params).fetchall()

    # Which money scale each OEM's sheet block used — surfaced so a crore-scaled
    # block (₹0.01 Cr = ₹1L resolution) is never mistaken for rupee precision.
    scales = db.execute(text(f"""
        SELECT oem, MIN(value_scale) AS scale FROM oe_targets WHERE {where_sql} GROUP BY oem
    """), params).fetchall()

    return {
        "fy_year": fy_year, "quarter": quarter,
        "label": f"{QUARTER_TAGS[quarter]} {_fy_label(fy_year)}",
        "kpis": _metrics(kpis),
        "by_salesperson": [{"key": r.key, "region": r.region, **_metrics(r)} for r in by_sp],
        "by_oem": [{"key": r.key, **_metrics(r)} for r in by_oem],
        "by_oem_category": [{"oem": r.oem, "key": r.key, **_metrics(r)} for r in by_oem_cat],
        "by_region": [{"key": r.key, **_metrics(r)} for r in by_region],
        "by_month": [
            {"year": r.period_year, "month": r.period_month, **_metrics(r)} for r in by_month
        ],
        "value_scales": {r.oem: r.scale for r in scales},
    }

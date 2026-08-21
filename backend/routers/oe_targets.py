"""
AutoForm MIS — OE Quarterly Targets analytics.

Reads the oe_targets rows produced by services/oe_targets_sync.py. The registry
and sync for target sheets live in routers/oe_network.py alongside the other two
OE sheet types; this router is the read side only.

Three deliberate choices:
  • Every aggregate is computed from the per-row monthly figures. The source
    sheet's own TOTAL row/column is never ingested — it drifts from its own data.
  • ACH % is derived here, never stored, and every response carries BOTH the
    units (nos) and the money (value) figures. They diverge a lot in the real
    data (Hyundai AMJ: 72% on units, 84% on value), so the UI can toggle between
    them without a refetch and neither is privileged as "the" number.
  • Rows with salesperson IS NULL are real targets that belong to nobody: MSIL
    and TATA book accessories as one unattributed line inside their seat-cover
    block. They count in the KPIs, in by_oem and in by_month, but they cannot
    appear in by_salesperson or by_region — so the response also returns them on
    their own as `unattributed`, and the UI shows that row explicitly. Without
    it the salesperson bars would quietly fail to add up to the headline number.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
from models import User
from routers.auth import get_current_user
from routers.oe_network import _scope
from services.oe_targets_sync import QUARTER_TAGS
from services.period_filters import month_bounds

MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

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
    scope, _ = _scope(db, current_user)
    where, params = ["1=1"], {}
    scope.apply(where, params, "salesperson", "oe_targets")
    rows = db.execute(text(f"""
        SELECT DISTINCT fy_year, quarter FROM oe_targets
        WHERE {" AND ".join(where)} ORDER BY fy_year DESC, quarter DESC
    """), params).fetchall()
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
    scope, _ = _scope(db, current_user)
    scope_where, scope_params = [], {}
    scope.apply(scope_where, scope_params, "salesperson", "oe_targets")
    scope_sql = "".join(f" AND {c}" for c in scope_where)

    def distinct(col: str):
        rows = db.execute(text(
            f"SELECT DISTINCT {col} FROM oe_targets "
            f"WHERE {col} IS NOT NULL{scope_sql} ORDER BY {col}"
        ), scope_params).fetchall()
        return [r[0] for r in rows]

    return {
        "oems": distinct("oem"),
        "categories": distinct("category"),
        "salespersons": distinct("salesperson"),
        "regions": distinct("region"),
    }


@router.get("/summary")
def summary(
    fy_year: Optional[int] = Query(None, description="FY start year — 2026 means FY26-27"),
    quarter: Optional[int] = Query(None, ge=1, le=4),
    from_ym: Optional[str] = Query(None, description="YYYY-MM; the shared period controls"),
    to_ym: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD; the custom day range"),
    to_date: Optional[str] = Query(None),
    oem: Optional[str] = None,
    category: Optional[str] = None,
    salesperson: Optional[str] = None,
    region: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Everything the Targets tab draws, in one round trip.

    Scoped either by FY+quarter (how the sheets are published) or by a date
    range. Targets are stored one row per MONTH inside their quarter, so a date
    range selects whole months — a target is a number for a month, and there is
    no honest way to show a third of one. A range that lands inside a single
    quarter therefore reads exactly like picking that quarter's months.
    """
    scope, salesperson = _scope(db, current_user, salesperson)

    where, params = _filters(oem, category, salesperson, region)
    scope.apply(where, params, "salesperson", "oe_targets")
    # Three ways in, in priority order: an explicit month/day range from the
    # shared period controls, the FY+quarter the sheets are published as, or
    # nothing at all — which is the "all time" preset and means every month.
    pm_from, pm_to = month_bounds(from_ym, to_ym, from_date, to_date)
    if pm_from and pm_to:
        where.append("(period_year * 100 + period_month) BETWEEN :pm_from AND :pm_to")
        params |= {"pm_from": pm_from, "pm_to": pm_to}
    elif fy_year is not None and quarter is not None:
        where += ["fy_year = :fy_year", "quarter = :quarter"]
        params |= {"fy_year": fy_year, "quarter": quarter}
    where_sql = " AND ".join(where) if where else "TRUE"

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

    # grouped() drops NULL keys, so by_salesperson and by_region are people-only
    # — the unattributed accessory lines are fetched separately below rather than
    # being silently absorbed into somebody's bar.
    #
    # The region is every one the person is filed under, not just one: the
    # workbook spells the same territory differently between OEMs (Umesh is
    # "WEST" on the Hyundai and Kia tabs but "WEST/CENTRAL" on MSIL, TATA and
    # Mahindra), and picking one would assert a narrower patch than he runs.
    by_sp = grouped(
        "salesperson AS key, STRING_AGG(DISTINCT region, ' · ' ORDER BY region) AS region",
        "salesperson", "SUM(tgt_value) DESC",
    )
    # by_oem clubs an OEM's products together — that's the default view the
    # business asked for; by_oem_category keeps the split available underneath.
    by_oem = grouped("oem AS key", "oem", "SUM(tgt_value) DESC")
    by_oem_cat = grouped("oem, category AS key", "oem, category", "oem, category")
    by_region = grouped("region AS key", "region", "SUM(tgt_value) DESC")
    by_month = db.execute(text(f"""
        SELECT period_year, period_month, {_SUMS}
        FROM oe_targets WHERE {where_sql}
        GROUP BY period_year, period_month ORDER BY period_year, period_month
    """), params).fetchall()

    # Targets that belong to no salesperson — the MSIL/TATA accessories lines.
    # Named per OEM so the UI can say whose they are rather than just "other".
    unattributed = db.execute(text(f"""
        SELECT {_SUMS} FROM oe_targets WHERE {where_sql} AND salesperson IS NULL
    """), params).fetchone()
    unattributed_oems = db.execute(text(f"""
        SELECT DISTINCT oem FROM oe_targets
        WHERE {where_sql} AND salesperson IS NULL ORDER BY oem
    """), params).fetchall()

    # Which money scale each OEM's sheet block used — surfaced so a crore-scaled
    # block (₹0.01 Cr = ₹1L resolution) is never mistaken for rupee precision.
    scales = db.execute(text(f"""
        SELECT oem, MIN(value_scale) AS scale FROM oe_targets WHERE {where_sql} GROUP BY oem
    """), params).fetchall()

    # A date range can straddle quarters, so the label names the months it
    # actually covers rather than claiming to be one quarter.
    if pm_from and pm_to:
        y1, m1 = divmod(pm_from, 100)
        y2, m2 = divmod(pm_to, 100)
        label = (f"{MONTH_SHORT[m1 - 1]} {y1}" if pm_from == pm_to
                 else f"{MONTH_SHORT[m1 - 1]} {y1} – {MONTH_SHORT[m2 - 1]} {y2}")
    elif fy_year is not None and quarter is not None:
        label = f"{QUARTER_TAGS[quarter]} {_fy_label(fy_year)}"
    else:
        label = "All time"

    return {
        "fy_year": fy_year, "quarter": quarter,
        "label": label,
        "kpis": _metrics(kpis),
        "by_salesperson": [{"key": r.key, "region": r.region, **_metrics(r)} for r in by_sp],
        "by_oem": [{"key": r.key, **_metrics(r)} for r in by_oem],
        "by_oem_category": [{"oem": r.oem, "key": r.key, **_metrics(r)} for r in by_oem_cat],
        "by_region": [{"key": r.key, **_metrics(r)} for r in by_region],
        "by_month": [
            {"year": r.period_year, "month": r.period_month, **_metrics(r)} for r in by_month
        ],
        # None when everything in scope is attributed — e.g. any salesperson
        # filter is on, since an unowned line can never match a person.
        "unattributed": (
            {"oems": [r.oem for r in unattributed_oems], **_metrics(unattributed)}
            if unattributed_oems else None
        ),
        "value_scales": {r.oem: r.scale for r in scales},
    }

"""
AutoForm MIS — OE brand-level target analytics.

Reads the oe_oem_targets rows produced by services/oe_oem_targets_sync.py. The
registry and sync live in routers/oe_network.py alongside the other sheet
types; this router is the read side only.

Not to be confused with routers/oe_targets.py. That reads the quarterly
workbook where the year's money is split across SALESPEOPLE. This reads the
commitment made to each BRAND. Two files, two grains, never one number.

Five choices worth knowing:

  • Every aggregate is computed from the per-month rows. The sheet's own annual
    and quarter totals are not ingested, and one of them is already wrong —
    MSIL's "Total Qty" reads 56,145 against 71,262 actually achieved, because
    its formula lost April. Deriving means the tab cannot inherit that.

  • THE WHOLE YEAR IS TARGETED, ONLY PART OF IT IS ACHIEVED. All twelve months
    carry a target from the day the sheet is published; achievement lands one
    month at a time. So achievement ÷ full-year target is not "how are we
    doing" — in August it reads 30% for a brand that is exactly on plan. Every
    response therefore carries TWO denominators and names both:
        pace     = achieved ÷ target for the months that have been published
        year_pct = achieved ÷ the full target of the selected period
    The UI must show pace as the performance figure and year_pct as progress,
    and say which is which next to the number.

  • ACHIEVEMENT IS NULL, NEVER 0, FOR A MONTH THAT HAS NOT BEEN PUBLISHED, and
    SUM() over nothing stays NULL all the way to the response. A brand with no
    published month returns None and the UI draws "—". The sheet's own quarter
    columns say 0 for quarters that have not started; that number is not in
    this database and must not be reintroduced here.

  • HYUNDAI AND KIA ARE REPORTED AS ONE BRAND, "MOBIS" — see OEM_GROUPS. The
    folding happens HERE, on read, never in the stored rows: the workbook keeps
    a tab each because that is how the two OEMs report, and a database that
    matches its source is a database somebody can reconcile. It also means
    splitting them again is a one-line edit rather than a re-sync.

  • NOT SCOPED, DELIBERATELY. These are OEM-wide totals with no personal
    attribution — nobody's name appears anywhere in the source. Scoping them
    would answer a question the data cannot ask. _scope() is still called, and
    must be: it is what gates the module, and the coverage test requires every
    OE route to go through it.
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

router = APIRouter(prefix="/oe-network/oem-targets", tags=["OE Network"])


def _fy_label(fy: int) -> str:
    return f"FY{fy % 100:02d}-{(fy + 1) % 100:02d}"


# Hyundai and Kia are one commercial relationship: both brands are supplied
# through Mobis, and the business commits, reviews and reports against the
# combined number. The workbook cannot say that — it gets a tab per OEM because
# that is how each one publishes — so the tab says it instead.
#
# Grouping on read rather than at sync is deliberate twice over. The stored
# rows stay a faithful copy of the sheet, so a figure here can always be traced
# back to a cell. And it avoids a collision that would lose data outright:
# Hyundai and Kia both sell MATS and ACCESSORIES, so writing both tabs under
# one OEM name would breach the (oem, product, month) unique index and force
# the two rows to be added together at ingest, destroying the split for good.
OEM_GROUPS = {"MOBIS": ("HYUNDAI", "KIA")}


def _oem_sql(col: str = "oem") -> str:
    """`col` folded into its display group.

    Generated from OEM_GROUPS rather than written out, so the dropdown, the
    aggregates and the filter cannot drift apart — the day a third brand joins
    Mobis, one tuple changes and all three follow. The values are module
    constants and never request input, so there is nothing here to bind.
    """
    whens = " ".join(
        "WHEN {c} IN ({members}) THEN '{group}'".format(
            c=col, group=group, members=", ".join(f"'{m}'" for m in members))
        for group, members in OEM_GROUPS.items()
    )
    return f"CASE {whens} ELSE {col} END"


OEM_SQL = _oem_sql()


def _pct(num, den) -> Optional[float]:
    """None, not 0, when there is nothing to divide — a percentage of an absent
    number is absent, and 0% would read as a measured failure."""
    if num is None or not den:
        return None
    return round(float(num) / float(den) * 100, 1)


# Two denominators, both needed — see the module docstring. The FILTER clauses
# are the whole point: tgt_*_todate is the target of exactly the months whose
# achievement has been published, so pace compares like with like.
_SUMS = """
    SUM(tgt_nos)   AS tgt_nos,
    SUM(tgt_value) AS tgt_value,
    SUM(ach_nos)   AS ach_nos,
    SUM(ach_value) AS ach_value,
    SUM(tgt_nos)   FILTER (WHERE ach_nos   IS NOT NULL) AS tgt_nos_todate,
    SUM(tgt_value) FILTER (WHERE ach_value IS NOT NULL) AS tgt_value_todate,
    COUNT(DISTINCT (period_year * 100 + period_month)) AS months_total,
    COUNT(DISTINCT (period_year * 100 + period_month))
        FILTER (WHERE ach_nos IS NOT NULL) AS months_published
"""


def _num(v) -> Optional[float]:
    return None if v is None else float(v)


def _metrics(r) -> dict:
    """The figure block every grouping returns.

    Nothing is coerced to zero on the way out. `ach_nos = None` means no month
    in this selection has been published yet, which is a different fact from a
    brand that was measured and sold none.
    """
    tn, tv = _num(r.tgt_nos), _num(r.tgt_value)
    an, av = _num(r.ach_nos), _num(r.ach_value)
    tnd, tvd = _num(r.tgt_nos_todate), _num(r.tgt_value_todate)
    return {
        "tgt_nos": tn, "tgt_value": tv,
        "ach_nos": an, "ach_value": av,
        # The honest denominator: the target of the published months only.
        "tgt_nos_todate": tnd, "tgt_value_todate": tvd,
        # Performance — are we hitting plan on the months that have run?
        "pace_pct_nos": _pct(an, tnd), "pace_pct_value": _pct(av, tvd),
        # Progress — how much of the selected period's target is banked?
        "year_pct_nos": _pct(an, tn), "year_pct_value": _pct(av, tv),
        # Gap is against the published months too, for the same reason: against
        # the full year every brand is "behind" until March.
        "gap_nos": None if (an is None or tnd is None) else an - tnd,
        "gap_value": None if (av is None or tvd is None) else av - tvd,
        "months_total": int(r.months_total or 0),
        "months_published": int(r.months_published or 0),
    }


def _filters(oem, product, product_key):
    where, params = ["1=1"], {}
    if oem:
        # Compared against the GROUPED name, so "MOBIS" selects both its tabs
        # while every ungrouped OEM still matches itself. One code path means
        # the dropdown cannot offer a value the filter is unable to honour.
        where.append(f"{OEM_SQL} = :oem")
        params["oem"] = oem
    for col, val in {"product": product, "product_key": product_key}.items():
        if val:
            where.append(f"{col} = :{col}")
            params[col] = val
    return where, params


@router.get("/periods")
def periods(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Months the sheet covers, and the newest one whose achievement is in.

    Both halves matter. The picker must offer every month — a full year of
    targets is published up front and looking at March's target in August is a
    legitimate thing to do — but the tab must OPEN on the newest month that has
    an actual, or it lands on a screen of targets with no results against them
    and reads as broken.
    """
    _scope(db, current_user)
    rows = db.execute(text("""
        SELECT period_year, period_month, fy_year,
               BOOL_OR(ach_nos IS NOT NULL) AS has_actual
        FROM oe_oem_targets
        GROUP BY period_year, period_month, fy_year
        ORDER BY period_year DESC, period_month DESC
    """)).fetchall()
    months = [
        {"year": r.period_year, "month": r.period_month, "fy_year": r.fy_year,
         "has_actual": bool(r.has_actual)}
        for r in rows
    ]
    latest = next((m for m in months if m["has_actual"]), None)
    return {
        "months": months,
        # None when the sheet is registered but no month has been filled in yet.
        "latest_actual": latest and {"year": latest["year"], "month": latest["month"]},
        "fy_years": sorted({m["fy_year"] for m in months}, reverse=True),
    }


@router.get("/filter-options")
def filter_options(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Every value the sheet holds, never only those the current filter left —
    a dropdown that shrinks to the active selection traps the user."""
    _scope(db, current_user)

    def distinct(col: str):
        rows = db.execute(text(
            f"SELECT DISTINCT {col} FROM oe_oem_targets "
            f"WHERE {col} IS NOT NULL ORDER BY {col}"
        )).fetchall()
        return [r[0] for r in rows]

    oems = [r[0] for r in db.execute(text(
        f"SELECT DISTINCT {OEM_SQL} AS oem FROM oe_oem_targets"
        f" WHERE oem IS NOT NULL ORDER BY oem"
    )).fetchall()]

    return {
        # Grouped, so HYUNDAI and KIA never appear on their own — offering a
        # value the aggregates no longer produce would return an empty tab.
        "oems": oems,
        "products": distinct("product"),
        "product_keys": distinct("product_key"),
    }


@router.get("/summary")
def summary(
    fy_year: Optional[int] = Query(None, description="FY start year — 2026 means FY26-27"),
    from_ym: Optional[str] = Query(None, description="YYYY-MM; the shared period controls"),
    to_ym: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD; the custom day range"),
    to_date: Optional[str] = Query(None),
    oem: Optional[str] = None,
    product: Optional[str] = None,
    product_key: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Everything the OEM Targets tab draws, in one round trip."""
    _scope(db, current_user)

    where, params = _filters(oem, product, product_key)
    # A day range snaps to whole months: a target is a number for a month and
    # there is no honest way to show a third of one. The tab says so on screen.
    pm_from, pm_to = month_bounds(from_ym, to_ym, from_date, to_date)
    snapped = bool(pm_from and pm_to and (from_date or to_date))
    if pm_from and pm_to:
        where.append("(period_year * 100 + period_month) BETWEEN :pm_from AND :pm_to")
        params |= {"pm_from": pm_from, "pm_to": pm_to}
    elif fy_year is not None:
        where.append("fy_year = :fy_year")
        params["fy_year"] = fy_year
    where_sql = " AND ".join(where)

    if not db.execute(text(f"SELECT 1 FROM oe_oem_targets WHERE {where_sql} LIMIT 1"),
                      params).first():
        raise HTTPException(status_code=404, detail="No OEM target data for this selection")

    kpis = db.execute(text(f"SELECT {_SUMS} FROM oe_oem_targets WHERE {where_sql}"),
                      params).fetchone()

    def grouped(select_cols: str, group_by: str, order_by: str):
        return db.execute(text(f"""
            SELECT {select_cols}, {_SUMS}
            FROM oe_oem_targets WHERE {where_sql}
            GROUP BY {group_by} ORDER BY {order_by}
        """), params).fetchall()

    by_oem = grouped(f"{OEM_SQL} AS key", OEM_SQL, "SUM(tgt_value) DESC")
    # Keyed by product_key so MSIL's "Docket + Accessories" and Hyundai's
    # "ACCESSORIES" land on one bar. The verbatim product name stays available
    # in by_oem_product, which is what the drilldown reads.
    by_product = grouped("product_key AS key", "product_key", "SUM(tgt_value) DESC")
    # Grouped by the display name but still split by the verbatim product, so
    # Hyundai's "SEAT COVERS" and Kia's "SEAT COVERS (PASSANGER)" stay two
    # lines under Mobis while their identically named MATS become one.
    by_oem_product = grouped(
        f"{OEM_SQL} AS oem, product AS key, MIN(product_key) AS product_key",
        f"{OEM_SQL}, product", f"{OEM_SQL}, SUM(tgt_value) DESC")
    by_month = db.execute(text(f"""
        SELECT period_year, period_month, quarter, {_SUMS}
        FROM oe_oem_targets WHERE {where_sql}
        GROUP BY period_year, period_month, quarter
        ORDER BY period_year, period_month
    """), params).fetchall()
    by_quarter = db.execute(text(f"""
        SELECT fy_year, quarter, {_SUMS}
        FROM oe_oem_targets WHERE {where_sql}
        GROUP BY fy_year, quarter ORDER BY fy_year, quarter
    """), params).fetchall()

    # Last year's actual, for the same OEMs and products in scope. It has no
    # month, so it is NOT cut by the period — it is a full prior year either
    # way, and the UI labels it as such rather than implying it matches the
    # selected window.
    #
    # It IS cut to the financial years the selection touches, and that is not
    # optional: the period filter cannot reach this table, so the moment a
    # second FY's workbook is registered an unrestricted query would add two
    # years of "last year" together and report it as one.
    py_where, py_params = _filters(oem, product, product_key)
    py_where.append(
        f"fy_year IN (SELECT DISTINCT fy_year FROM oe_oem_targets WHERE {where_sql})")
    # _filters produced the same parameter names and values on both sides, so
    # merging cannot change what either clause means.
    py_params |= params
    prior = db.execute(text(f"""
        SELECT {OEM_SQL} AS oem, SUM(py_nos) AS py_nos, SUM(py_value) AS py_value
        FROM oe_oem_target_annual WHERE {" AND ".join(py_where)}
        GROUP BY {OEM_SQL} ORDER BY 1
    """), py_params).fetchall()

    # Which money scale each OEM's columns used. A crore-scaled tab carries
    # ₹1L resolution at best, and the tab says so rather than letting a
    # rupee-precise figure imply precision the source never had.
    scales = db.execute(text(f"""
        SELECT {OEM_SQL} AS oem,
               STRING_AGG(DISTINCT tgt_value_scale, '/' ORDER BY tgt_value_scale) AS tgt_scale,
               STRING_AGG(DISTINCT ach_value_scale, '/' ORDER BY ach_value_scale) AS ach_scale
        FROM oe_oem_targets WHERE {where_sql} GROUP BY {OEM_SQL}
    """), params).fetchall()

    if pm_from and pm_to:
        y1, m1 = divmod(pm_from, 100)
        y2, m2 = divmod(pm_to, 100)
        label = (f"{MONTH_SHORT[m1 - 1]} {y1}" if pm_from == pm_to
                 else f"{MONTH_SHORT[m1 - 1]} {y1} – {MONTH_SHORT[m2 - 1]} {y2}")
    elif fy_year is not None:
        label = _fy_label(fy_year)
    else:
        label = "All time"

    return {
        "fy_year": fy_year,
        "label": label,
        "snapped_to_months": snapped,
        "kpis": _metrics(kpis),
        "by_oem": [{"key": r.key, **_metrics(r)} for r in by_oem],
        "by_product": [{"key": r.key, **_metrics(r)} for r in by_product],
        "by_oem_product": [
            {"oem": r.oem, "key": r.key, "product_key": r.product_key, **_metrics(r)}
            for r in by_oem_product
        ],
        "by_month": [
            {"year": r.period_year, "month": r.period_month, "quarter": r.quarter,
             **_metrics(r)} for r in by_month
        ],
        "by_quarter": [
            {"fy_year": r.fy_year, "quarter": r.quarter,
             "label": f"{QUARTER_TAGS[r.quarter]} {_fy_label(r.fy_year)}",
             **_metrics(r)} for r in by_quarter
        ],
        "prior_year": [
            {"oem": r.oem, "py_nos": _num(r.py_nos), "py_value": _num(r.py_value)}
            for r in prior
        ],
        "value_scales": {
            r.oem: {"target": r.tgt_scale, "actual": r.ach_scale} for r in scales
        },
    }

"""
AutoForm MIS — shared period parsing for the OE Network views.

Every OE tab takes the same period controls (a month, a quarter, an FY, or an
exact date range), but the tables behind them do not all carry a day:

  • oe_visit_logs has a real visit_date, so a day range cuts it exactly.
  • oe_visit_plans, oe_targets and oe_dealer_monthly are written one row per
    MONTH. A day range there can only widen to the months it touches.

Keeping these two helpers in one place is what stops the routers from drifting
into disagreeing about what a date range means.
"""
from datetime import date
from typing import Optional

from fastapi import HTTPException


def parse_date(v: Optional[str], field: str) -> Optional[date]:
    if not v:
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must be YYYY-MM-DD")


def date_bounds(from_date: Optional[str], to_date: Optional[str]):
    """(date, date) or (None, None), rejecting a reversed range."""
    d1, d2 = parse_date(from_date, "from_date"), parse_date(to_date, "to_date")
    if not (d1 and d2):
        return None, None
    if d1 > d2:
        raise HTTPException(status_code=400, detail="from_date is after to_date")
    return d1, d2


def snap_to_months(from_date: Optional[str], to_date: Optional[str]):
    """A day range widened to the whole months it touches, as ('YYYY-MM', …).

    Used wherever a day range meets month-grain data. On the endpoints that
    compare the log book against the visit plans, BOTH sides are widened:
    narrowing only the log side would measure twelve days of visits against a
    whole month of plan and quietly deflate every coverage percentage.
    """
    d1, d2 = date_bounds(from_date, to_date)
    if not d1:
        return None, None
    return f"{d1.year}-{d1.month:02d}", f"{d2.year}-{d2.month:02d}"


def month_value(d: date) -> int:
    """A date as the YYYYMM integer the routers compare year/month columns with."""
    return d.year * 100 + d.month

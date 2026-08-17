"""
The dealer drawer's two scopes.

The drawer opens from a row in a period-filtered table. Its headline tiles must
cover the SAME window as that row (`totals`), while the trend and the contact
log stay full history (`lifetime`) — showing lifetime figures under a monthly
row made the drawer look like it disagreed with the table.

The scoping itself is small, so it is reproduced here exactly as the router does
it and pinned against the boundary cases: a month on the edge of the window, an
all-time selection, and a dealer whose YSASC is missing for some months.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.period_filters import month_value  # noqa: E402,F401


def scope_months(months: dict, m_from, m_to):
    """Exactly the router's month filter (inclusive at both ends)."""
    return [k for k in months
            if (m_from is None or k >= m_from) and (m_to is None or k <= m_to)]


def scope_contacts(history: list, d_from, d_to):
    """Exactly the router's contact filter. visit_date is an ISO string on the
    already-serialised history rows, compared against ISO bounds — string
    comparison is safe for ISO dates and avoids re-parsing."""
    return [h for h in history
            if h["visit_date"]
            and (d_from is None or h["visit_date"] >= d_from.isoformat())
            and (d_to is None or h["visit_date"] <= d_to.isoformat())]


def funnel(rows):
    """The router's totals_for, reduced to the arithmetic that can go wrong."""
    avail = [m["ysasc"] for m in rows if m["ysasc"] is not None]
    return {
        "oem_total": sum(m["oem_total"] or 0 for m in rows),
        "ysasc": sum(avail) if avail else None,
        "ys_sale": sum(m["ys_sale"] or 0 for m in rows),
        "months": len(rows),
    }


MONTHS = {
    date(2026, 6, 1): {"oem_total": 100, "ysasc": 60, "ys_sale": 10},
    date(2026, 7, 1): {"oem_total": 200, "ysasc": 120, "ys_sale": 20},
    date(2026, 8, 1): {"oem_total": 300, "ysasc": None, "ys_sale": 30},
}
HISTORY = [
    {"visit_date": "2026-06-15", "contact_mode": "Visit"},
    {"visit_date": "2026-07-02", "contact_mode": "Calling"},
    {"visit_date": "2026-08-01", "contact_mode": "Visit"},
    {"visit_date": "2026-08-31", "contact_mode": "Calling"},
    {"visit_date": None, "contact_mode": "Visit"},          # undated log row
]


class TestMonthScoping:
    def test_a_single_month_selects_only_that_month(self):
        keys = scope_months(MONTHS, date(2026, 7, 1), date(2026, 7, 1))
        assert keys == [date(2026, 7, 1)]
        assert funnel([MONTHS[k] for k in keys])["ys_sale"] == 20

    def test_bounds_are_inclusive_at_both_ends(self):
        keys = scope_months(MONTHS, date(2026, 6, 1), date(2026, 8, 1))
        assert len(keys) == 3

    def test_all_time_takes_everything(self):
        assert len(scope_months(MONTHS, None, None)) == 3

    def test_a_window_with_no_data_is_empty_not_an_error(self):
        keys = scope_months(MONTHS, date(2026, 1, 1), date(2026, 3, 1))
        assert keys == []
        # An empty scope must report zeros and a null ysasc, never a division.
        f = funnel([MONTHS[k] for k in keys])
        assert f == {"oem_total": 0, "ysasc": None, "ys_sale": 0, "months": 0}


class TestYsascStaysNullable:
    def test_a_month_without_ysasc_does_not_become_zero(self):
        # August supplies no YSASC. Summed with July it must contribute nothing
        # rather than dragging the total down as a zero.
        keys = sorted(scope_months(MONTHS, date(2026, 7, 1), date(2026, 8, 1)))
        assert funnel([MONTHS[k] for k in keys])["ysasc"] == 120

    def test_ysasc_is_none_when_no_month_in_scope_supplied_it(self):
        keys = scope_months(MONTHS, date(2026, 8, 1), date(2026, 8, 1))
        assert funnel([MONTHS[k] for k in keys])["ysasc"] is None


class TestContactScoping:
    def test_counts_only_contacts_inside_the_day_window(self):
        got = scope_contacts(HISTORY, date(2026, 8, 1), date(2026, 8, 31))
        assert len(got) == 2

    def test_boundary_days_are_included(self):
        # 1 Aug and 31 Aug are both in an August window — an exclusive end would
        # silently drop the last day of every month.
        got = scope_contacts(HISTORY, date(2026, 8, 1), date(2026, 8, 31))
        assert {h["visit_date"] for h in got} == {"2026-08-01", "2026-08-31"}

    def test_undated_rows_never_count_toward_a_period(self):
        got = scope_contacts(HISTORY, date(2026, 1, 1), date(2026, 12, 31))
        assert all(h["visit_date"] for h in got)
        assert len(got) == 4

    def test_all_time_keeps_undated_rows_out_of_the_window_count_too(self):
        # lifetime uses the raw history (5 rows); a None-dated row cannot be
        # placed in any window, so the period count is always <= lifetime.
        assert len(scope_contacts(HISTORY, None, None)) == 4
        assert len(HISTORY) == 5


def scope_targets(targets: list, m_from, m_to):
    """The drawer's quarter filter: keep a quarter if it OVERLAPS the period at
    all. Bounds are ISO strings on the serialised rows, as the UI sees them."""
    lo = m_from.isoformat() if m_from else None
    hi = m_to.isoformat() if m_to else None
    return [t for t in targets
            if (lo is None or t["period_end"] >= lo)
            and (hi is None or t["period_start"] <= hi)]


TARGETS = [
    {"label": "AMJ '26", "period_start": "2026-04-01", "period_end": "2026-06-30"},
    {"label": "JAS '26", "period_start": "2026-07-01", "period_end": "2026-09-30"},
    {"label": "OND '26", "period_start": "2026-10-01", "period_end": "2026-12-31"},
]


class TestQuarterOverlap:
    def test_a_month_inside_a_quarter_keeps_that_quarter(self):
        got = scope_targets(TARGETS, date(2026, 8, 1), date(2026, 8, 1))
        assert [t["label"] for t in got] == ["JAS '26"]

    def test_a_range_spanning_two_quarters_keeps_both(self):
        got = scope_targets(TARGETS, date(2026, 6, 1), date(2026, 7, 1))
        assert [t["label"] for t in got] == ["AMJ '26", "JAS '26"]

    def test_a_quarter_is_kept_on_a_single_overlapping_month(self):
        # Touching a quarter by one month is enough — the target is never
        # pro-rated, so partial overlap still shows the whole quarter.
        got = scope_targets(TARGETS, date(2026, 6, 1), date(2026, 6, 1))
        assert [t["label"] for t in got] == ["AMJ '26"]

    def test_boundary_months_count_as_overlap(self):
        # The period ends exactly where JAS begins.
        got = scope_targets(TARGETS, date(2026, 1, 1), date(2026, 7, 1))
        assert "JAS '26" in [t["label"] for t in got]

    def test_a_period_before_every_quarter_keeps_none(self):
        assert scope_targets(TARGETS, date(2025, 1, 1), date(2025, 3, 1)) == []

    def test_all_time_keeps_every_quarter(self):
        assert len(scope_targets(TARGETS, None, None)) == 3


class TestPeriodNeverExceedsLifetime:
    def test_totals_are_a_subset_of_lifetime(self):
        for lo, hi in [(date(2026, 6, 1), date(2026, 6, 1)),
                       (date(2026, 7, 1), date(2026, 8, 1)),
                       (None, None)]:
            scoped = funnel([MONTHS[k] for k in scope_months(MONTHS, lo, hi)])
            life = funnel(list(MONTHS.values()))
            assert scoped["ys_sale"] <= life["ys_sale"]
            assert scoped["oem_total"] <= life["oem_total"]
            assert scoped["months"] <= life["months"]

"""
Period parsing shared by every OE Network view.

These helpers decide what a selected period MEANS for tables that carry no day
(oe_targets, oe_visit_plans, oe_dealer_monthly are one row per month). Getting
them wrong does not raise — it silently answers a different question than the
one on screen, which is why they are pinned down here.

Run: backend/venv/Scripts/python.exe -m pytest backend/tests -q
"""
import os
import sys
from datetime import date

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.period_filters import (          # noqa: E402
    parse_date, date_bounds, snap_to_months, month_value, parse_ym, month_bounds,
)


class TestParseDate:
    def test_parses_iso(self):
        assert parse_date("2026-08-17", "from_date") == date(2026, 8, 17)

    def test_empty_is_none(self):
        assert parse_date(None, "from_date") is None
        assert parse_date("", "from_date") is None

    def test_rejects_garbage_with_the_field_name(self):
        with pytest.raises(HTTPException) as e:
            parse_date("17/08/2026", "from_date")
        assert e.value.status_code == 400
        assert "from_date" in e.value.detail


class TestDateBounds:
    def test_needs_both_ends(self):
        assert date_bounds("2026-04-01", None) == (None, None)
        assert date_bounds(None, "2026-04-01") == (None, None)

    def test_rejects_a_reversed_range(self):
        with pytest.raises(HTTPException) as e:
            date_bounds("2026-06-01", "2026-04-01")
        assert e.value.status_code == 400

    def test_allows_a_single_day(self):
        assert date_bounds("2026-04-01", "2026-04-01") == (date(2026, 4, 1),) * 2


class TestSnapToMonths:
    def test_widens_a_part_month_range_to_whole_months(self):
        # 15 Apr – 2 Jun must become Apr–Jun, not Apr–May: the range TOUCHES
        # June, and June's month row is all-or-nothing.
        assert snap_to_months("2026-04-15", "2026-06-02") == ("2026-04", "2026-06")

    def test_zero_pads(self):
        assert snap_to_months("2026-01-05", "2026-09-30") == ("2026-01", "2026-09")


class TestParseYm:
    def test_parses_to_yyyymm_int(self):
        assert parse_ym("2026-08", "from_ym") == 202608
        assert parse_ym("2026-01", "from_ym") == 202601

    def test_none_for_empty(self):
        assert parse_ym(None, "from_ym") is None

    @pytest.mark.parametrize("bad", ["2026-13", "2026-00", "2026", "2026-8-1", "aug-2026"])
    def test_rejects_impossible_months(self, bad):
        with pytest.raises(HTTPException) as e:
            parse_ym(bad, "from_ym")
        assert e.value.status_code == 400


class TestMonthValue:
    def test_encodes_year_and_month(self):
        assert month_value(date(2026, 8, 17)) == 202608

    def test_orders_across_a_year_boundary(self):
        # The whole point of the encoding: BETWEEN must work over Dec→Jan.
        assert month_value(date(2025, 12, 1)) < month_value(date(2026, 1, 1))


class TestMonthBounds:
    """The one the Targets tab now depends on — it takes either form the shared
    period controls send and reduces both to whole months."""

    def test_month_range_from_the_presets(self):
        assert month_bounds("2026-04", "2026-06", None, None) == (202604, 202606)

    def test_day_range_from_the_custom_picker_snaps_to_months(self):
        assert month_bounds(None, None, "2026-04-15", "2026-06-02") == (202604, 202606)

    def test_a_single_month_is_a_valid_range(self):
        assert month_bounds("2026-08", "2026-08", None, None) == (202608, 202608)

    def test_no_params_means_all_time(self):
        # Not an error: this is what the "all time" preset sends, and the caller
        # turns it into "no period filter at all".
        assert month_bounds(None, None, None, None) == (None, None)

    def test_a_half_range_is_all_time_not_a_crash(self):
        assert month_bounds("2026-04", None, None, None) == (None, None)
        assert month_bounds(None, None, "2026-04-15", None) == (None, None)

    def test_months_win_over_days_when_both_are_sent(self):
        assert month_bounds("2026-04", "2026-06", "2020-01-01", "2020-01-31") == (202604, 202606)

    def test_rejects_a_reversed_month_range(self):
        with pytest.raises(HTTPException) as e:
            month_bounds("2026-06", "2026-04", None, None)
        assert e.value.status_code == 400

    def test_fy_q4_range_crosses_the_calendar_year(self):
        # FY26-27 Q4 = Jan–Mar 2027, which the frontend sends as this range.
        assert month_bounds("2027-01", "2027-03", None, None) == (202701, 202703)

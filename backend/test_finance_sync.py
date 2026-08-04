"""
Offline parser test for Finance v2 (no network, no DB).

Loads the two dummy workbooks the finance team supplied — a monthly sheet and a
yearly sheet — into raw grids via openpyxl and runs the pure parser path
(parse_finance_workbook_grids), asserting the Phase A sections, the auto-detected
cadence (monthly vs annual), the merged timeline, and that the sheet's own Total
rows are mirrored (Balance Sheet balances; section totals equal the sum of their
line items).

Run:  venv/Scripts/python.exe test_finance_sync.py
"""
import os
from datetime import date

import openpyxl

from services.finance_sync import (
    REGISTERED_SECTIONS, parse_finance_tab, parse_finance_workbook_grids,
)

DUMMY_DIR = r"D:\MIS\Local_sheets\Finance_new"
MONTHLY_XLSX = "Monthly Complete Financial Dashboard Dummy Data.xlsx"
YEARLY_XLSX = "Yearly Complete Financial Dashboard Dummy Data.xlsx"

# The statement sections that must always parse. Asserted as a SUBSET rather than
# an exact set: finance keeps adding sections to the template, and an equality
# check here silently rotted once Phase B registered ratios/units (it had been
# failing for weeks before anyone ran it). Nothing outside the registry may be
# emitted, which is the property actually worth guarding.
CORE_SECTIONS = {
    "sales_accounts", "profit_loss_a_c", "balance_sheet", "inventories",
    "working_capital", "production_cost", "employee_s_cost",
}


def _grid(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    return [list(row) for row in ws.iter_rows(min_row=1, max_row=160, max_col=26, values_only=True)]


def load_grids():
    return {
        "monthly": _grid(os.path.join(DUMMY_DIR, MONTHLY_XLSX)),
        "yearly": _grid(os.path.join(DUMMY_DIR, YEARLY_XLSX)),
    }


def test_parse():
    records, errors, covered = parse_finance_workbook_grids(load_grids())
    assert not errors, f"unexpected parse errors: {errors}"
    assert records, "no records parsed"

    # (a) every core statement section captured, and nothing outside the registry
    sections = {r["section_key"] for r in records}
    assert CORE_SECTIONS <= sections, f"missing core sections: {CORE_SECTIONS - sections}"
    assert sections <= REGISTERED_SECTIONS, f"parsed unregistered sections: {sections - REGISTERED_SECTIONS}"

    # (b) cadence auto-detection: yearly tab → 3 annual FY points; monthly → 3 months
    annual_periods = {(r["period_start_date"], r["period_end_date"]) for r in records if r["period_type"] == "annual"}
    monthly_periods = {(r["period_start_date"], r["period_end_date"]) for r in records if r["period_type"] == "monthly"}
    assert len(annual_periods) == 3, f"expected 3 FY points, got {sorted(annual_periods)}"
    assert len(monthly_periods) == 3, f"expected 3 monthly points, got {sorted(monthly_periods)}"
    assert all(r["cadence"] == "yearly" for r in records if r["period_type"] == "annual")
    assert all(r["cadence"] == "monthly" for r in records if r["period_type"] == "monthly")

    # monthly points land in Apr/May/Jun 2026, normalised to month-end
    from datetime import date
    assert (date(2026, 4, 1), date(2026, 4, 30)) in monthly_periods
    assert (date(2026, 6, 1), date(2026, 6, 30)) in monthly_periods
    # yearly FY spans Apr→Mar
    assert (date(2023, 4, 1), date(2024, 3, 31)) in annual_periods
    assert (date(2025, 4, 1), date(2026, 3, 31)) in annual_periods

    # (c) Balance Sheet balances every period: Sources total == Application total
    src = {r["period_end_date"]: r["amount"] for r in records if r["line_key"] == "balance_sheet/sources_of_funds/total"}
    app = {r["period_end_date"]: r["amount"] for r in records if r["line_key"] == "balance_sheet/application_of_funds/total"}
    assert src and set(src) == set(app), "balance-sheet totals missing/uneven across periods"
    for pe in src:
        assert abs(src[pe] - app[pe]) < 0.01, f"balance sheet does not balance at {pe}: {src[pe]} vs {app[pe]}"

    # (d) merged timeline is deduped (both tabs union into one covered set)
    triples = [(r["line_key"], r["period_start_date"], r["period_end_date"]) for r in records]
    assert len(triples) == len(set(triples)), "duplicate (line_key, period) rows in merge"
    assert covered == set(triples)

    # (e) mirror-the-sheet: Sales Accounts Total == sum of its line items every period
    for pe in {r["period_end_date"] for r in records if r["section_key"] == "sales_accounts"}:
        items = [r["amount"] for r in records
                 if r["line_key"].startswith("sales_accounts/") and r["entity_type"] == "line_item" and r["period_end_date"] == pe]
        total = [r["amount"] for r in records if r["line_key"] == "sales_accounts/total" and r["period_end_date"] == pe]
        assert total, f"sales_accounts total missing at {pe}"
        assert abs(sum(items) - total[0]) < 1.0, f"sales total mismatch at {pe}: {sum(items)} vs {total[0]}"

    # (f) Working Capital sub-sections resolve correctly (blank 'Advance' rows are
    #     dropped, not mistaken for sub-headers)
    wc = {r["line_key"] for r in records if r["section_key"] == "working_capital"}
    assert "working_capital/current_assets/total" in wc
    assert "working_capital/current_liabilities/total" in wc
    assert "working_capital/net_working_capital" in wc
    assert not any("advance" in k for k in wc), "blank Advance rows should not appear"

    print(f"OK — {len(records)} records, sections={sorted(sections)}, "
          f"{len(annual_periods)} FY + {len(monthly_periods)} monthly periods")


def test_units_segments():
    """§7 UNITS: the live sheet splits Sales/Production into 4w and 2w blocks and
    nests an "Others" group inside the 2w ones. Two regressions are guarded here,
    both observed on real company tabs before the fix:

      * "Others" appearing under BOTH a sales and a production block collapsed
        onto one line_key (units/others/lifestyle), so the production figure
        silently overwrote the sales one on upsert.
      * A line item that is blank in every loaded period (a company with no Mats
        this quarter) was promoted to a sub-header and hijacked the grouping of
        every row beneath it, filing real figures under units/mats/other.
    """
    grid = [
        [None, "COMPANY'S NAME", "TEST CO", None],
        [None, "Particulars", date(2026, 6, 15), "%"],
        [7, "UNITS", None, None],
        [None, "Sales 4w", None, None],
        [None, "Seat Cover", 100, None],
        [None, "Mats", None, None],        # blank line item — must NOT regroup
        [None, "Other", 200, None],
        [None, "Sales 2w", None, None],
        [None, "Seat Cover", 300, None],
        [None, "Others", None, None],      # nested group under Sales 2w
        [None, "Lifestyle", 400, None],
        [None, "Productions 2w", None, None],
        [None, "Others", None, None],      # nested group under Productions 2w
        [None, "Lifestyle", 500, None],
    ]
    records, errors = parse_finance_tab(grid, "TEST CO")
    assert not errors, f"unexpected errors: {errors}"
    by_key = {r["line_key"]: r["amount"] for r in records}

    # The blank "Mats" row must not have hijacked the grouping.
    assert by_key.get("units/sales_4w/seat_cover") == 100, by_key
    assert by_key.get("units/sales_4w/other") == 200, "blank row hijacked the sub-section"
    assert "units/mats/other" not in by_key, "blank line item was treated as a sub-header"

    # The two "Others" groups must stay distinct, keeping both figures.
    assert by_key.get("units/sales_2w/seat_cover") == 300, by_key
    assert by_key.get("units/sales_2w/others/lifestyle") == 400, by_key
    assert by_key.get("units/productions_2w/others/lifestyle") == 500, by_key
    assert "units/others/lifestyle" not in by_key, "nested group lost its parent segment"

    # No record may collide on the sync's uniqueness key.
    triples = [(r["line_key"], r["period_start_date"], r["period_end_date"]) for r in records]
    assert len(triples) == len(set(triples)), "colliding (line_key, period) rows"

    print(f"OK — units segments: {len(records)} records, {len(set(r['sub_section'] for r in records))} sub-sections")


if __name__ == "__main__":
    test_parse()
    test_units_segments()

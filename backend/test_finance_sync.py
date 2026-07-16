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
import openpyxl

from services.finance_sync import parse_finance_workbook_grids

DUMMY_DIR = r"D:\MIS\Local_sheets\Finance_new"
MONTHLY_XLSX = "Monthly Complete Financial Dashboard Dummy Data.xlsx"
YEARLY_XLSX = "Yearly Complete Financial Dashboard Dummy Data.xlsx"

PHASE_A = {
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

    # (a) all seven Phase A sections captured, and nothing outside the registry
    sections = {r["section_key"] for r in records}
    assert sections == PHASE_A, f"section mismatch: {sections} vs {PHASE_A}"

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


if __name__ == "__main__":
    test_parse()

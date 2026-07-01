"""
Offline test for the Finance (Balance Sheet + P&L) parser — no network/DB
dependency. Loads the real dummy workbook directly via openpyxl (simulating
the grid shape the Sheets API's values.get would return) and runs the same
parser that the live sync endpoint will use.
"""
import sys; sys.path.insert(0, '.')
from datetime import date
import openpyxl
from services.finance_sync import parse_finance_tab, parse_finance_workbook_grids

WORKBOOK = r"D:\MIS\Local_sheets\FInance\Dashboard_DataInput-2.xlsx"


def sheet_to_grid(ws):
    return [[c.value for c in row] for row in ws.iter_rows()]


def main():
    wb = openpyxl.load_workbook(WORKBOOK, data_only=True)
    grids = {title: sheet_to_grid(wb[title]) for title in wb.sheetnames}
    assert set(grids.keys()) == {"abc", "xyz"}, grids.keys()

    parsed, errors = parse_finance_tab(grids["abc"], "abc")
    bs, pl = parsed["balance_sheet"], parsed["profit_loss"]
    print(f"balance_sheet: {len(bs)} records, profit_loss: {len(pl)} records, {len(errors)} messages")
    for e in errors:
        print(" ", e)

    def bs_amount(line_key, period_end):
        rec = next(r for r in bs if r["line_key"] == line_key and r["period_end_date"] == period_end)
        return rec["amount"], rec["percent"]

    def pl_rec(line_key, start, end):
        return next(r for r in pl if r["line_key"] == line_key and r["period_start_date"] == start and r["period_end_date"] == end)

    d_31may26 = date(2026, 5, 31)
    d_31mar26 = date(2026, 3, 31)
    p_may_start, p_may_end = date(2026, 5, 1), date(2026, 5, 31)
    p_fy_start, p_fy_end = date(2025, 4, 1), date(2026, 3, 31)

    # ── Balance Sheet ────────────────────────────────────────────────────────
    amount, percent = bs_amount("sources_of_funds_capital_account", d_31may26)
    assert amount == 164019800, amount
    assert percent == 23.35, percent

    amount, _ = bs_amount("sources_of_funds_total", d_31mar26)
    assert amount == 782915448.62, amount

    amount, _ = bs_amount("application_of_funds_total", d_31may26)
    assert amount == 702368842.99, amount

    # ── Profit & Loss ────────────────────────────────────────────────────────
    sales = pl_rec("trading_account_sales_accounts", p_may_start, p_may_end)
    assert sales["amount"] == 205093564.93, sales["amount"]
    assert sales["period_type"] == "monthly", sales["period_type"]

    direct_incomes = pl_rec("trading_account_direct_incomes", p_may_start, p_may_end)
    subtotal_key = f"trading_account_subtotal_after_{direct_incomes['line_key']}"
    subtotal = pl_rec(subtotal_key, p_may_start, p_may_end)
    assert subtotal["amount"] == 207054082.43, subtotal["amount"]

    gross_profit = pl_rec("trading_account_gross_profit", p_may_start, p_may_end)
    assert gross_profit["entity_type"] == "total", gross_profit["entity_type"]
    assert gross_profit["amount"] == 15909074.49, gross_profit["amount"]

    indirect_incomes = pl_rec("income_statement_indirect_incomes", p_may_start, p_may_end)
    subtotal_key2 = f"income_statement_subtotal_after_{indirect_incomes['line_key']}"
    subtotal2 = pl_rec(subtotal_key2, p_may_start, p_may_end)
    assert subtotal2["amount"] == 16612027.56, subtotal2["amount"]

    nett_profit = pl_rec("income_statement_nett_profit", p_may_start, p_may_end)
    assert nett_profit["entity_type"] == "total", nett_profit["entity_type"]
    assert nett_profit["amount"] == 404395.85, nett_profit["amount"]

    # ── Period-type classification ──────────────────────────────────────────
    fy_sales = pl_rec("trading_account_sales_accounts", p_fy_start, p_fy_end)
    assert fy_sales["period_type"] == "annual", fy_sales["period_type"]

    # ── Multi-tab union/reconciliation — both dummy tabs report identical
    # periods; covered sets must dedupe rather than double-count. ────────────
    all_records, all_errors, covered = parse_finance_workbook_grids(grids)
    assert len(covered["bs_period_ends"]) == 3, covered["bs_period_ends"]
    assert len(covered["pl_periods"]) == 3, covered["pl_periods"]
    assert len(all_records["balance_sheet"]) == 2 * len(bs), len(all_records["balance_sheet"])

    print("\nAll assertions passed.")


if __name__ == "__main__":
    main()

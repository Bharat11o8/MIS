"""
DB smoke test for Finance v2 — exercises the real Postgres schema + the real
analytics code (routers.finance._balance_sheet_analytics / _profit_loss_analytics)
using the parsed dummy workbooks, WITHOUT a Google round-trip.

Requires the SSH tunnel to the VPS dev DB (localhost:5433, per backend/.env) and
that migrate_phase9_finance_v2.sql has been applied. Creates a throwaway
sheet_source, inserts the parsed rows, runs both analytics, prints a summary,
then deletes the source (ON DELETE CASCADE cleans finance_lines).

Run:  venv/Scripts/python.exe smoke_finance_v2.py
"""
import os
import uuid
import openpyxl
from dotenv import load_dotenv

load_dotenv()

from sqlalchemy import text
from database import SessionLocal
from services.finance_sync import parse_finance_workbook_grids
from routers.finance import _balance_sheet_analytics, _profit_loss_analytics

DUMMY_DIR = r"D:\MIS\Local_sheets\Finance_new"
MONTHLY = "Monthly Complete Financial Dashboard Dummy Data.xlsx"
YEARLY = "Yearly Complete Financial Dashboard Dummy Data.xlsx"


def _grid(fn):
    ws = openpyxl.load_workbook(os.path.join(DUMMY_DIR, fn), data_only=True).worksheets[0]
    return [list(r) for r in ws.iter_rows(min_row=1, max_row=160, max_col=26, values_only=True)]


def main():
    records, errors, _ = parse_finance_workbook_grids({"monthly": _grid(MONTHLY), "yearly": _grid(YEARLY)})
    assert not errors, errors
    db = SessionLocal()
    sid = str(uuid.uuid4())
    try:
        # throwaway source
        db.execute(text("""
            INSERT INTO sheet_sources (id, module, sheet_id, label, calendar_year, created_by)
            VALUES (:id, 'finance', :sheet_id, 'SMOKE v2', NULL, NULL)
        """), {"id": sid, "sheet_id": f"SMOKE-{sid[:8]}"})
        db.commit()

        for rec in records:
            db.execute(text("""
                INSERT INTO finance_lines
                    (id, sheet_source_id, tab_title, cadence, section_key, section_label, sub_section,
                     entity_type, item_no, line_key, line_label, parent_key,
                     period_start_date, period_end_date, period_type, amount, percent)
                VALUES
                    (:id, :sid, :tab_title, :cadence, :section_key, :section_label, :sub_section,
                     :entity_type, :item_no, :line_key, :line_label, :parent_key,
                     :period_start_date, :period_end_date, :period_type, :amount, :percent)
            """), {"id": str(uuid.uuid4()), "sid": sid, **{k: rec[k] for k in (
                "tab_title", "cadence", "section_key", "section_label", "sub_section", "entity_type",
                "item_no", "line_key", "line_label", "parent_key", "period_start_date", "period_end_date",
                "period_type", "amount", "percent")}})
        db.commit()
        n = db.execute(text("SELECT COUNT(*) FROM finance_lines WHERE sheet_source_id=:s"), {"s": sid}).scalar()
        print(f"inserted {n} finance_lines")

        bs = _balance_sheet_analytics(db, sid)
        pl = _profit_loss_analytics(db, sid)
        print("\nBALANCE SHEET kpis:", bs["kpis"])
        print("  groups:", [(g["section_key"], [s["key"] for s in g["sub_sections"]]) for g in bs["groups"]])
        print("  periods:", [p["period_end_date"] for p in bs["periods"]])
        print("\nP&L kpis:", pl["kpis"])
        print("  groups:", [(g["section_key"], sum(len(s["line_items"]) for s in g["sub_sections"])) for g in pl["groups"]])

        assert bs["kpis"]["sources_total_latest"] is not None
        assert abs(bs["kpis"]["sources_total_latest"] - bs["kpis"]["application_total_latest"]) < 1
        assert pl["kpis"]["sales_total"] > 0
        assert len(bs["periods"]) == 6
        print("\nOK — schema + analytics verified end-to-end.")
    finally:
        db.execute(text("DELETE FROM sheet_sources WHERE id=:s"), {"s": sid})
        db.commit()
        left = db.execute(text("SELECT COUNT(*) FROM finance_lines WHERE sheet_source_id=:s"), {"s": sid}).scalar()
        print(f"cleanup: {left} finance_lines remain (should be 0 — cascade)")
        db.close()


if __name__ == "__main__":
    main()

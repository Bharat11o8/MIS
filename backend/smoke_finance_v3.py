"""
DB smoke test for Finance v3 (shared masters, companies = tabs). No Google call —
synthesizes two master workbooks from the dummy tabs, drives the fan-out sync
logic (parse_finance_workbook_by_company + _sync_company_records) against real
Postgres, and asserts company auto-creation, both cadences, cadence-scoped
reconcile, per-company analytics, and company-only listing.

Requires the SSH tunnel + migrate_phase10 applied. Run:
  venv/Scripts/python.exe smoke_finance_v3.py
"""
import os
import uuid
import openpyxl
from dotenv import load_dotenv

load_dotenv()

from sqlalchemy import text
from database import SessionLocal
from models import SheetSource
from services.finance_sync import parse_finance_workbook_by_company, _slugify
from routers.finance import _sync_company_records, _balance_sheet_analytics

DIR = r"D:\MIS\Local_sheets\Finance_new"


def _grid(fn):
    ws = openpyxl.load_workbook(os.path.join(DIR, fn), data_only=True).worksheets[0]
    return [list(r) for r in ws.iter_rows(min_row=1, max_row=160, max_col=26, values_only=True)]


def _fan_out(db, by_company, admin_id, log_id):
    """Mirror of sync_master's company loop (no HTTP/Google)."""
    ins = upd = dele = 0
    for tab_title, entry in by_company.items():
        ckey = _slugify(tab_title)
        company = db.query(SheetSource).filter(
            SheetSource.module == "finance", SheetSource.kind == "company", SheetSource.sheet_id == ckey).first()
        if not company:
            company = SheetSource(id=uuid.uuid4(), module="finance", kind="company", sheet_id=ckey, label=tab_title, created_by=admin_id)
            db.add(company); db.flush()
        i, u, d = _sync_company_records(db, str(company.id), entry, log_id)
        ins += i; upd += u; dele += d
    db.commit()
    return ins, upd, dele


def main():
    mg = _grid("Monthly Complete Financial Dashboard Dummy Data.xlsx")
    yg = _grid("Yearly Complete Financial Dashboard Dummy Data.xlsx")
    monthly_master = {"SMK-ABC": mg, "SMK-XYZ": mg}
    yearly_master = {"SMK-ABC": yg, "SMK-XYZ": yg}

    db = SessionLocal()
    created_ids = []
    try:
        # a throwaway sync log
        log_id = str(uuid.uuid4())
        db.execute(text("INSERT INTO sync_logs (id, module, source_label, status) VALUES (:i,'finance','SMOKE-v3','Processing')"), {"i": log_id})
        db.commit()

        # 1) monthly master fan-out
        mc, _ = parse_finance_workbook_by_company(monthly_master)
        _fan_out(db, mc, None, log_id)
        # 2) yearly master fan-out
        yc, _ = parse_finance_workbook_by_company(yearly_master)
        _fan_out(db, yc, None, log_id)

        companies = db.query(SheetSource).filter(SheetSource.kind == "company", SheetSource.sheet_id.like("smk_%")).all()
        created_ids = [str(c.id) for c in companies]
        print("companies auto-created:", sorted(c.label for c in companies))
        assert len(companies) == 2

        for c in companies:
            cad = db.execute(text("SELECT DISTINCT cadence FROM finance_lines WHERE sheet_source_id=:s ORDER BY 1"), {"s": str(c.id)}).fetchall()
            cads = sorted(x[0] for x in cad)
            n = db.execute(text("SELECT COUNT(*) FROM finance_lines WHERE sheet_source_id=:s"), {"s": str(c.id)}).scalar()
            print(f"  {c.label}: {n} rows, cadences={cads}")
            assert cads == ["monthly", "yearly"], f"{c.label} missing a cadence"

        # 3) cadence-scoped reconcile: re-sync ONLY monthly, assert yearly rows survive
        abc = next(c for c in companies if c.label == "SMK-ABC")
        yearly_before = db.execute(text("SELECT COUNT(*) FROM finance_lines WHERE sheet_source_id=:s AND cadence='yearly'"), {"s": str(abc.id)}).scalar()
        remc, _ = parse_finance_workbook_by_company({"SMK-ABC": mg})
        _fan_out(db, remc, None, log_id)
        yearly_after = db.execute(text("SELECT COUNT(*) FROM finance_lines WHERE sheet_source_id=:s AND cadence='yearly'"), {"s": str(abc.id)}).scalar()
        print(f"cadence-scoped reconcile: yearly rows before={yearly_before} after monthly re-sync={yearly_after}")
        assert yearly_before == yearly_after and yearly_after > 0, "yearly rows were disturbed by a monthly sync!"

        # 4) per-company analytics still balances + ties hold
        bs = _balance_sheet_analytics(db, str(abc.id))
        assert abs(bs["kpis"]["sources_total_latest"] - bs["kpis"]["application_total_latest"]) < 1
        tied = sum(1 for t in bs["reconciliation"] if t["matches"])
        print(f"analytics for {abc.label}: balanced OK, reconciliation {tied}/{len(bs['reconciliation'])} tied, {len(bs['periods'])} periods")
        assert tied == len(bs["reconciliation"]) == 5

        print("\nOK — v3 fan-out, cadence-scoped reconcile, and per-company analytics all verified.")
    finally:
        for cid in created_ids:
            db.execute(text("DELETE FROM sheet_sources WHERE id=:i"), {"i": cid})
        db.execute(text("DELETE FROM sync_logs WHERE source_label='SMOKE-v3'"))
        db.commit()
        left = db.execute(text("SELECT COUNT(*) FROM finance_lines WHERE sheet_source_id = ANY(:ids)"), {"ids": created_ids or ["00000000-0000-0000-0000-000000000000"]}).scalar()
        print(f"cleanup: {left} finance_lines remain (should be 0)")
        db.close()


if __name__ == "__main__":
    main()

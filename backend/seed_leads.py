"""
Seed script: create demo leads_head user + import all 4 months of lead data
"""
import sys, os
sys.path.insert(0, '.')
from dotenv import load_dotenv
load_dotenv()

import uuid
import bcrypt
from database import SessionLocal
from models import User, UploadLog
from services.lead_parser import parse_leads_file

db = SessionLocal()

# ── 1. Create demo user ──────────────────────────────────────────────────────
DEMO_EMAIL    = "lead@autoformindia.com"
DEMO_PASSWORD = "Lead@2024"
DEMO_NAME     = "Lead Manager (Demo)"
DEMO_ROLE     = "leads_head"

existing = db.query(User).filter(User.email == DEMO_EMAIL).first()
if existing:
    print(f"User already exists: {DEMO_EMAIL}")
    demo_user = existing
else:
    demo_user = User(
        id=uuid.uuid4(),
        name=DEMO_NAME,
        email=DEMO_EMAIL,
        password_hash=bcrypt.hashpw(DEMO_PASSWORD.encode(), bcrypt.gensalt()).decode(),
        role=DEMO_ROLE,
        department="Lead Management",
        is_active=True,
        must_change_password=False,
    )
    db.add(demo_user)
    db.commit()
    db.refresh(demo_user)
    print(f"Created user: {DEMO_EMAIL} / {DEMO_PASSWORD}")

# ── 2. Import all 4 months of lead data ─────────────────────────────────────
from models import Lead
folder = r'd:\MIS\Local_sheets\Lead Management'
files  = sorted(os.listdir(folder))

total_inserted = 0
total_errors   = 0

for filename in files:
    if not filename.endswith(('.xlsx', '.xls', '.csv')):
        continue

    filepath = os.path.join(folder, filename)
    with open(filepath, 'rb') as f:
        file_bytes = f.read()

    records, errors = parse_leads_file(file_bytes, filename)

    # Create upload log
    log = UploadLog(
        id=uuid.uuid4(),
        module="leads",
        filename=filename,
        rows_total=len(records),
        rows_success=0,
        rows_failed=0,
        status="Processing",
        uploaded_by=demo_user.id,
    )
    db.add(log)
    db.commit()
    db.refresh(log)

    inserted = 0
    for rec in records:
        lead = Lead(
            id=uuid.uuid4(),
            upload_log_id=log.id,
            uploaded_by=demo_user.id,
            **rec,
        )
        db.add(lead)
        inserted += 1

    real_errors = [e for e in errors if not e.startswith("INFO:")]
    log.rows_success = inserted
    log.rows_failed  = len(real_errors)
    log.status       = "Done"
    db.commit()

    total_inserted += inserted
    total_errors   += len(real_errors)
    print(f"  {filename}: {inserted} rows inserted, {len(real_errors)} errors")

print(f"\nTotal: {total_inserted} leads imported, {total_errors} errors")

# ── 3. Quick stats check ─────────────────────────────────────────────────────
from sqlalchemy import func
total = db.query(func.count(Lead.id)).scalar()
sources = db.query(Lead.source, func.count(Lead.id)).group_by(Lead.source).all()
print(f"\nDB now has {total} leads")
print("By source:", {s: c for s, c in sources})

db.close()

"""
AutoForm MIS — ASM self-service portal (public, OTP-only, read-only).

Lets a field rep check their own OE log-book entries without any of the main
MIS login/roles/permissions machinery. Deliberately separate from routers/auth.py:
  • No password ever exists for this flow — email in, 6-digit OTP out, a
    short-lived scoped token back (see _create_asm_token / get_current_asm).
  • The token carries {"scope": "asm", "email": ..., "salesperson": ...} and is
    checked independently of the `users` table — it cannot authenticate against
    any other route in the app, and an ASM is not a User row.
  • Every query is hard-filtered to the caller's own salesperson (resolved once,
    at OTP verification, from asm_portal_users — never taken from client input),
    so there is no way to request another rep's data by editing a query param.

Read-only: nothing here writes to oe_visit_logs or the Google Sheet. The visit
log itself is still only written by routers/visit_log.py's public submit form.
"""
import csv
import io
import os
import random
import smtplib
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
from models import AsmPortalOtp, AsmPortalUser

router = APIRouter(prefix="/asm-portal", tags=["ASM Portal"])

SECRET_KEY = os.getenv("SECRET_KEY", "fallback-secret")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
_TOKEN_EXPIRE_MIN = 240  # 4h — long enough for a field day, short enough to not matter if a phone is lost
_OTP_EXPIRE_MIN = 10
_OAUTH2_SCHEME = OAuth2PasswordBearer(tokenUrl="/asm-portal/verify-otp", auto_error=False)


# ── Schemas ──────────────────────────────────────────────────────────────────
class RequestOtpBody(BaseModel):
    email: str


class VerifyOtpBody(BaseModel):
    email: str
    otp: str


# ── Email ────────────────────────────────────────────────────────────────────
def _send_otp_email(to_email: str, otp: str) -> None:
    smtp_user = os.getenv("VISIT_LOG_EMAIL_USER", "")
    smtp_pass = os.getenv("VISIT_LOG_EMAIL_PASS", "")
    smtp_from = os.getenv("VISIT_LOG_EMAIL_FROM", smtp_user)
    if not smtp_user or not smtp_pass:
        raise RuntimeError("VISIT_LOG_EMAIL_USER/PASS is not configured.")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Amato Automotive — Your Login OTP"
    msg["From"] = f"Amato Automotive MIS <{smtp_from}>"
    msg["To"] = to_email

    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background:#111827;padding:28px 32px;">
        <p style="color:#fff;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;margin:0;">Amato Automotive · My Visits</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 28px;">
          Use the OTP below to view your visit log — it expires in <strong>{_OTP_EXPIRE_MIN} minutes</strong>.
        </p>
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:24px;text-align:center;margin-bottom:8px;">
          <p style="color:#9a3412;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 8px;">Your OTP</p>
          <p style="color:#f46617;font-size:36px;font-weight:900;letter-spacing:0.25em;margin:0;">{otp}</p>
        </div>
      </div>
      <div style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
        <p style="color:#9ca3af;font-size:11px;margin:0;">© {datetime.now().year} Amato Automotive · This is an automated message, please do not reply.</p>
      </div>
    </div>
    """
    msg.attach(MIMEText(html, "html"))

    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_from, to_email, msg.as_string())


# ── Token ────────────────────────────────────────────────────────────────────
def _create_asm_token(email: str, salesperson: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=_TOKEN_EXPIRE_MIN)
    payload = {"scope": "asm", "email": email, "salesperson": salesperson, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_asm(token: str = Depends(_OAUTH2_SCHEME)) -> dict:
    """Returns {"email": ..., "salesperson": ...} for the calling ASM. Rejects
    anything that isn't an asm-scope token — a main-MIS user's JWT (scope-less)
    is not valid here, and this token is not valid on any main-MIS route."""
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired session. Please log in again.")
    if payload.get("scope") != "asm":
        raise HTTPException(status_code=401, detail="Invalid session.")
    return {"email": payload["email"], "salesperson": payload["salesperson"]}


# ── Login: request + verify OTP ──────────────────────────────────────────────
@router.post("/request-otp")
def request_otp(body: RequestOtpBody, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    asm = db.query(AsmPortalUser).filter(
        AsmPortalUser.email == email, AsmPortalUser.is_active == True
    ).first()

    # Same response either way — don't reveal which emails are registered.
    generic = {"message": "If that email is registered, an OTP has been sent."}
    if not asm:
        return generic

    otp = str(random.randint(100000, 999999))
    expires = datetime.now(timezone.utc) + timedelta(minutes=_OTP_EXPIRE_MIN)
    db.add(AsmPortalOtp(email=email, otp=otp, expires_at=expires))
    db.commit()

    try:
        _send_otp_email(email, otp)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not send OTP email: {e}")

    return generic


@router.post("/verify-otp")
def verify_otp(body: VerifyOtpBody, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    otp = body.otp.strip()

    asm = db.query(AsmPortalUser).filter(
        AsmPortalUser.email == email, AsmPortalUser.is_active == True
    ).first()
    invalid = HTTPException(status_code=400, detail="Invalid or expired OTP.")
    if not asm:
        raise invalid

    record = (
        db.query(AsmPortalOtp)
        .filter(AsmPortalOtp.email == email, AsmPortalOtp.otp == otp, AsmPortalOtp.used_at.is_(None))
        .order_by(AsmPortalOtp.created_at.desc())
        .first()
    )
    if not record:
        raise invalid

    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) > expires_at:
        raise HTTPException(status_code=400, detail="OTP has expired. Please request a new one.")

    record.used_at = datetime.now(timezone.utc)
    db.commit()

    token = _create_asm_token(asm.email, asm.salesperson)
    return {
        "access_token": token,
        "token_type": "bearer",
        "salesperson": asm.salesperson,
    }


# ── Filters shared by the list + export endpoints ────────────────────────────
def _build_where(asm: dict, oem: Optional[str], contact_mode: Optional[str],
                  from_date: Optional[str], to_date: Optional[str], q: Optional[str]):
    where = ["salesperson = :salesperson"]
    params: dict = {"salesperson": asm["salesperson"]}

    if oem:
        where.append("oem = :oem")
        params["oem"] = oem.strip().upper()
    if contact_mode:
        where.append("contact_mode = :contact_mode")
        params["contact_mode"] = contact_mode.strip().title()
    if from_date:
        where.append("visit_date >= :from_date")
        params["from_date"] = from_date
    if to_date:
        where.append("visit_date <= :to_date")
        params["to_date"] = to_date
    if q:
        where.append("(dealership ILIKE :q OR city ILIKE :q OR state ILIKE :q)")
        params["q"] = f"%{q.strip()}%"

    return " AND ".join(where), params


@router.get("/my-logs")
def my_logs(
    oem: Optional[str] = None,
    contact_mode: Optional[str] = Query(None, description="'Visit' or 'Calling'"),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    q: Optional[str] = Query(None, description="Search dealership / city / state"),
    page: int = Query(1, ge=1),
    per_page: int = Query(30, ge=1, le=200),
    asm: dict = Depends(get_current_asm),
    db: Session = Depends(get_db),
):
    where_sql, params = _build_where(asm, oem, contact_mode, from_date, to_date, q)

    # KPI tiles ignore the Visit/Calling filter on purpose: filtering the table
    # to "Visit" would trivially zero out the Calls tile (and vice versa),
    # which isn't a useful number. The tiles reflect every OTHER active filter
    # (date range, OEM, search) so they stay meaningful regardless of which
    # mode the table itself is narrowed to.
    kpi_where_sql, kpi_params = _build_where(asm, oem, None, from_date, to_date, q)
    summary = db.execute(text(f"""
        SELECT COUNT(*) FILTER (WHERE contact_mode = 'Visit') AS visits,
               COUNT(*) FILTER (WHERE contact_mode = 'Calling') AS calls,
               COUNT(DISTINCT dealership) AS dealerships
        FROM oe_visit_logs WHERE {kpi_where_sql}
    """), kpi_params).fetchone()

    total = db.execute(text(f"SELECT COUNT(*) FROM oe_visit_logs WHERE {where_sql}"), params).scalar()

    params["limit"] = per_page
    params["offset"] = (page - 1) * per_page
    rows = db.execute(text(f"""
        SELECT visit_date, dealership, address, contact_person, contact_number, designation,
               car_sales, seat_cover_sales, mats_sales,
               remarks, remark_product_feedback, remark_replacement, remark_sales, remark_others,
               photo_link, email, oem, channel, contact_mode, city, state
        FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    return {
        "salesperson": asm["salesperson"],
        "total": total, "page": page, "per_page": per_page,
        "summary": {
            "visits": summary.visits, "calls": summary.calls, "dealerships": summary.dealerships,
        },
        # Field order matches the sheet's own column order (Visit Date/Calling
        # Date .. State) so nothing is reordered relative to the source of truth.
        # Remarks and the 4 categories are kept separate — never merged — same
        # as the sheet itself.
        "data": [
            {
                "visit_date": r.visit_date.isoformat() if r.visit_date else None,
                "dealership": r.dealership,
                "address": r.address,
                "contact_person": r.contact_person,
                "contact_number": r.contact_number,
                "designation": r.designation,
                "car_sales": float(r.car_sales) if r.car_sales is not None else None,
                "seat_cover_sales": float(r.seat_cover_sales) if r.seat_cover_sales is not None else None,
                "mats_sales": float(r.mats_sales) if r.mats_sales is not None else None,
                "remarks": r.remarks,
                "remark_product_feedback": r.remark_product_feedback,
                "remark_replacement": r.remark_replacement,
                "remark_sales": r.remark_sales,
                "remark_others": r.remark_others,
                "photo_link": r.photo_link,
                "email": r.email,
                "oem": r.oem,
                "channel": r.channel,
                "contact_mode": r.contact_mode,
                "city": r.city,
                "state": r.state,
            }
            for r in rows
        ],
    }


# Matches the live log-book sheet's own header wording AND column order exactly
# (see the sheet's row 1 / services/oe_network_sync.py:LOG_COLUMNS) so the
# export reads the same as the source of truth rather than a paraphrase of it.
# Timestamp and "Column 1" (a month abbreviation) are the only sheet columns
# omitted — both are metadata that duplicates Visit Date, not visit data.
_EXPORT_HEADERS = [
    "Visit Date / Calling Date", "Dealership Name", "Visit / Calling", "OEM", "Channel",
    "Contact Person", "Contact No.", "Designation", "City", "State", "Dealership Address",
    "Total Car Sales", "Total Seat Covers Sales", "Mats Sales",
    "Remarks", "Product Feedback", "Replacement", "Sales", "Others",
    "Upload Photo", "Email address",
]


def _export_rows(asm: dict, oem, contact_mode, from_date, to_date, q, db: Session):
    where_sql, params = _build_where(asm, oem, contact_mode, from_date, to_date, q)
    rows = db.execute(text(f"""
        SELECT visit_date, dealership, contact_mode, oem, channel,
               contact_person, contact_number, designation, city, state, address,
               car_sales, seat_cover_sales, mats_sales,
               remarks, remark_product_feedback, remark_replacement, remark_sales, remark_others,
               photo_link, email
        FROM oe_visit_logs WHERE {where_sql}
        ORDER BY visit_date DESC, sheet_row DESC NULLS LAST
    """), params).fetchall()
    return [
        [
            r.visit_date.strftime("%d/%m/%Y") if r.visit_date else "",
            r.dealership or "", r.contact_mode or "", r.oem or "", r.channel or "",
            r.contact_person or "", r.contact_number or "", r.designation or "",
            r.city or "", r.state or "", r.address or "",
            r.car_sales if r.car_sales is not None else "",
            r.seat_cover_sales if r.seat_cover_sales is not None else "",
            r.mats_sales if r.mats_sales is not None else "",
            r.remarks or "", r.remark_product_feedback or "", r.remark_replacement or "",
            r.remark_sales or "", r.remark_others or "",
            r.photo_link or "", r.email or "",
        ]
        for r in rows
    ]


@router.get("/my-logs/export.csv")
def export_csv(
    oem: Optional[str] = None,
    contact_mode: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    q: Optional[str] = None,
    asm: dict = Depends(get_current_asm),
    db: Session = Depends(get_db),
):
    data = _export_rows(asm, oem, contact_mode, from_date, to_date, q, db)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_EXPORT_HEADERS)
    writer.writerows(data)
    buf.seek(0)
    filename = f"visit-log_{asm['salesperson'].replace(' ', '_')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/my-logs/export.xlsx")
def export_xlsx(
    oem: Optional[str] = None,
    contact_mode: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    q: Optional[str] = None,
    asm: dict = Depends(get_current_asm),
    db: Session = Depends(get_db),
):
    data = _export_rows(asm, oem, contact_mode, from_date, to_date, q, db)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Visit Log"
    ws.append(_EXPORT_HEADERS)
    for row in data:
        ws.append(row)
    for col_idx, header in enumerate(_EXPORT_HEADERS, start=1):
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = max(12, len(header) + 2)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = f"visit-log_{asm['salesperson'].replace(' ', '_')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

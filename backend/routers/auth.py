"""
AutoForm MIS — Auth Router (Phase 3)
Adds must_change_password flag in login response + change-password endpoint.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone
import bcrypt
import random
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from jose import JWTError, jwt
from pydantic import BaseModel
from database import get_db
from models import User
from services.permissions import get_user_modules
import os

router = APIRouter(prefix="/auth", tags=["Authentication"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

SECRET_KEY = os.getenv("SECRET_KEY", "fallback-secret")
ALGORITHM  = os.getenv("ALGORITHM", "HS256")
EXPIRE_MIN = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 480))


# ── Pydantic schemas ─────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    email: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    must_change_password: bool
    user: dict

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordOTPRequest(BaseModel):
    email: str
    otp: str
    new_password: str


# ── Helpers ──────────────────────────────────────────────────────────────────
def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception as e:
        print(f"Bcrypt verification failed: {e}")
        return False

def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=EXPIRE_MIN)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    payload = decode_token(token)
    user = db.query(User).filter(User.id == payload["sub"]).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


# ── Login ────────────────────────────────────────────────────────────────────
@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(
        User.email == body.email,
        User.is_active == True
    ).first()

    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password"
        )

    token = create_access_token({
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "name": user.name,
    })

    return {
        "access_token": token,
        "token_type": "bearer",
        "must_change_password": bool(user.must_change_password),
        "user": {
            "id": str(user.id),
            "name": user.name,
            "email": user.email,
            "role": user.role,
            "department": user.department,
            "must_change_password": bool(user.must_change_password),
            "modules": get_user_modules(db, user),
        },
    }


# ── Current session ───────────────────────────────────────────────────────────
@router.get("/me")
def get_me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {
        "id": str(current_user.id),
        "name": current_user.name,
        "email": current_user.email,
        "role": current_user.role,
        "department": current_user.department,
        "must_change_password": bool(current_user.must_change_password),
        "modules": get_user_modules(db, current_user),
    }


# ── Change Password ──────────────────────────────────────────────────────────
@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")

    current_user.password_hash = get_password_hash(body.new_password)
    current_user.must_change_password = False
    db.commit()
    return {"message": "Password changed successfully"}


# ── Email helper ─────────────────────────────────────────────────────────────
def _send_otp_email(to_email: str, otp: str, name: str) -> None:
    smtp_user = os.getenv("EMAIL_USER", "")
    smtp_pass = os.getenv("EMAIL_PASS", "")
    smtp_from = os.getenv("EMAIL_FROM", smtp_user)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "AutoForm MIS — Password Reset OTP"
    msg["From"]    = f"AutoForm MIS <{smtp_from}>"
    msg["To"]      = to_email

    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background:#111827;padding:28px 32px;">
        <p style="color:#fff;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;margin:0;">AutoForm India · MIS</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#374151;font-size:15px;margin:0 0 8px;">Hi {name},</p>
        <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 28px;">
          We received a request to reset your MIS password. Use the OTP below — it expires in <strong>10 minutes</strong>.
        </p>
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:24px;text-align:center;margin-bottom:28px;">
          <p style="color:#9a3412;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 8px;">Your OTP</p>
          <p style="color:#f46617;font-size:36px;font-weight:900;letter-spacing:0.25em;margin:0;">{otp}</p>
        </div>
        <p style="color:#9ca3af;font-size:12px;line-height:1.6;margin:0;">
          If you didn't request this contact IT Support immediately.
        </p>
      </div>
      <div style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
        <p style="color:#9ca3af;font-size:11px;margin:0;">© 2025 AutoForm India · This is an automated message, please do not reply.</p>
      </div>
    </div>
    """
    msg.attach(MIMEText(html, "html"))

    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_from, to_email, msg.as_string())


# ── Forgot password — send OTP ───────────────────────────────────────────────
@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(
        User.email == body.email.strip().lower(),
        User.is_active == True,
    ).first()

    # Always return same message to prevent email enumeration
    generic = {"message": "If that email is registered, an OTP has been sent."}
    if not user:
        return generic

    otp     = str(random.randint(100000, 999999))
    expires = datetime.now(timezone.utc) + timedelta(minutes=10)

    user.reset_otp            = otp
    user.reset_otp_expires_at = expires
    db.commit()

    try:
        _send_otp_email(user.email, otp, user.name)
    except Exception as e:
        print(f"[OTP email error] {e}")
        raise HTTPException(status_code=500, detail="Failed to send OTP email. Please check your inbox or try again.")

    return generic


# ── Reset password via OTP ───────────────────────────────────────────────────
@router.post("/reset-password")
def reset_password_via_otp(body: ResetPasswordOTPRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(
        User.email == body.email.strip().lower(),
        User.is_active == True,
    ).first()

    invalid = HTTPException(status_code=400, detail="Invalid or expired OTP.")

    if not user or not user.reset_otp:
        raise invalid

    if user.reset_otp != body.otp.strip():
        raise invalid

    if not user.reset_otp_expires_at:
        raise invalid

    expires_at = user.reset_otp_expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) > expires_at:
        user.reset_otp = None
        user.reset_otp_expires_at = None
        db.commit()
        raise HTTPException(status_code=400, detail="OTP has expired. Please request a new one.")

    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    user.password_hash        = get_password_hash(body.new_password)
    user.must_change_password = False
    user.reset_otp            = None
    user.reset_otp_expires_at = None
    db.commit()

    return {"message": "Password reset successfully. You can now log in."}

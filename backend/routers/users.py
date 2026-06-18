"""
AutoForm MIS — Users Router
Superadmin can create users, list users, toggle active state.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import User
from routers.auth import get_current_user, get_password_hash
import uuid

router = APIRouter(prefix="/users", tags=["Users"])


# ── Schemas ──────────────────────────────────────────────────────────────────
class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str
    department: Optional[str] = None

class UserOut(BaseModel):
    id: str
    name: str
    email: str
    role: str
    department: Optional[str]
    is_active: bool
    must_change_password: bool

    class Config:
        from_attributes = True


# ── Guards ───────────────────────────────────────────────────────────────────
def require_superadmin(current_user: User = Depends(get_current_user)):
    if current_user.role != "superadmin":
        raise HTTPException(status_code=403, detail="Superadmin access required")
    return current_user


# ── Create user ──────────────────────────────────────────────────────────────
@router.post("/", response_model=UserOut, status_code=201)
def create_user(
    body: CreateUserRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_superadmin),
):
    VALID_ROLES = {"superadmin", "management", "sales_head", "leads_head", "sales_rep", "staff"}
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {', '.join(VALID_ROLES)}")

    existing = db.query(User).filter(User.email == body.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    new_user = User(
        id=uuid.uuid4(),
        name=body.name,
        email=body.email,
        password_hash=get_password_hash(body.password),
        role=body.role,
        department=body.department,
        is_active=True,
        must_change_password=True,   # always force reset on first login
        created_by=admin.id,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return UserOut(
        id=str(new_user.id),
        name=new_user.name,
        email=new_user.email,
        role=new_user.role,
        department=new_user.department,
        is_active=new_user.is_active,
        must_change_password=new_user.must_change_password,
    )


# ── List users ───────────────────────────────────────────────────────────────
@router.get("/")
def list_users(
    db: Session = Depends(get_db),
    admin: User = Depends(require_superadmin),
):
    users = db.query(User).order_by(User.created_at.desc()).all()
    return [
        {
            "id": str(u.id),
            "name": u.name,
            "email": u.email,
            "role": u.role,
            "department": u.department,
            "is_active": u.is_active,
            "must_change_password": bool(u.must_change_password),
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in users
    ]


# ── Toggle active ────────────────────────────────────────────────────────────
@router.patch("/{user_id}/toggle-active")
def toggle_active(
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_superadmin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if str(user.id) == str(admin.id):
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")

    user.is_active = not user.is_active
    db.commit()
    return {"id": str(user.id), "is_active": user.is_active}

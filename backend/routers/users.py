"""
AutoForm MIS — Users Router
Superadmin can create users, list users, toggle active state.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import text
from database import get_db
from models import User, UserModuleAccess, UserSheetSourceAccess, SheetSource
from routers.auth import get_current_user, get_password_hash
from services.oe_scope import SCOPED_TABLES, names_match
from services.permissions import VALID_MODULES, get_user_modules, get_user_sheet_source_ids
import uuid

router = APIRouter(prefix="/users", tags=["Users"])


# ── Schemas ──────────────────────────────────────────────────────────────────
class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str
    department: Optional[str] = None

class UserAccessIn(BaseModel):
    modules: list[str]
    finance_company_ids: list[str] = []
    # None = sees all OE data. A name = hard-scoped to that salesperson on every
    # /oe-network endpoint. Ignored unless 'oe_network' is among the modules.
    oe_salesperson: Optional[str] = None

class UserAccessOut(BaseModel):
    modules: list[str]
    finance_company_ids: list[str]
    oe_salesperson: Optional[str] = None

class UpdateProfileRequest(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None

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


# ── Own profile ──────────────────────────────────────────────────────────────
@router.patch("/me")
def update_my_profile(
    body: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if body.email and body.email.strip().lower() != current_user.email:
        conflict = db.query(User).filter(User.email == body.email.strip().lower()).first()
        if conflict:
            raise HTTPException(status_code=409, detail="Email already in use by another account")
        current_user.email = body.email.strip().lower()

    if body.name and body.name.strip():
        current_user.name = body.name.strip()

    db.commit()
    db.refresh(current_user)
    return {
        "id": str(current_user.id),
        "name": current_user.name,
        "email": current_user.email,
        "role": current_user.role,
        "department": current_user.department,
    }


# ── Guards ───────────────────────────────────────────────────────────────────
def require_superadmin(current_user: User = Depends(get_current_user)):
    if current_user.role != "superadmin":
        raise HTTPException(status_code=403, detail="Superadmin access required")
    return current_user


# ── OE salesperson names ─────────────────────────────────────────────────────
@router.get("/oe-salespersons")
def oe_salespersons(
    db: Session = Depends(get_db),
    admin: User = Depends(require_superadmin),
):
    """Every salesperson name the OE data actually contains, deduplicated across
    the four tables that spell them differently.

    This exists so the access screen can offer a dropdown. A free-text box would
    be the obvious shortcut and the wrong one: a scope that matches no rows
    fails closed, so a single typo would hand the rep an empty module with no
    error anywhere — a support ticket that looks like a broken deployment.

    The variants of one person are collapsed to the longest spelling, because
    that is the most identifiable ("PANKAJ VIG" over "PANKAJ") and the scope
    token-matches anyway, so which variant is stored does not change what the
    rep sees.
    """
    seen: list[str] = []
    for table, col in SCOPED_TABLES.items():
        rows = db.execute(text(
            f"SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL AND {col} <> ''"
        )).fetchall()
        for (name,) in rows:
            match = next((i for i, kept in enumerate(seen) if names_match(kept, name)), None)
            if match is None:
                seen.append(name)
            elif len(name) > len(seen[match]):
                seen[match] = name
    return {"salespersons": sorted(seen)}


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

    grants = db.query(UserModuleAccess.user_id, UserModuleAccess.module).all()
    by_user: dict = {}
    for uid, m in grants:
        by_user.setdefault(str(uid), []).append(m)

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
            "modules": sorted(VALID_MODULES) if u.role == "superadmin" else by_user.get(str(u.id), []),
            "oe_salesperson": u.oe_salesperson,
        }
        for u in users
    ]


# ── Access management (module + Finance company grants) ──────────────────────
@router.get("/{user_id}/access", response_model=UserAccessOut)
def get_user_access(
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_superadmin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserAccessOut(
        modules=get_user_modules(db, user),
        finance_company_ids=get_user_sheet_source_ids(db, user, module="finance"),
        oe_salesperson=user.oe_salesperson,
    )


@router.put("/{user_id}/access", response_model=UserAccessOut)
def set_user_access(
    user_id: str,
    body: UserAccessIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_superadmin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    bad_modules = set(body.modules) - VALID_MODULES
    if bad_modules:
        raise HTTPException(status_code=400, detail=f"Unknown module(s): {', '.join(bad_modules)}")

    valid_ids = set()
    if body.finance_company_ids:
        valid_ids = {
            str(r.id) for r in db.query(SheetSource.id).filter(
                SheetSource.module == "finance", SheetSource.kind == "company",
                SheetSource.id.in_(body.finance_company_ids)
            ).all()
        }
        bad_ids = set(body.finance_company_ids) - valid_ids
        if bad_ids:
            raise HTTPException(status_code=400, detail=f"Unknown finance company id(s): {', '.join(bad_ids)}")

    # Dropped when OE access is dropped, so a re-grant later can never silently
    # reinstate a stale scope the admin has forgotten about.
    scope_name = (body.oe_salesperson or "").strip() or None
    user.oe_salesperson = scope_name if "oe_network" in set(body.modules) else None

    db.query(UserModuleAccess).filter(UserModuleAccess.user_id == user.id).delete()
    for m in set(body.modules):
        db.add(UserModuleAccess(user_id=user.id, module=m, granted_by=admin.id))

    db.query(UserSheetSourceAccess).filter(UserSheetSourceAccess.user_id == user.id).delete()
    for sid in valid_ids:
        db.add(UserSheetSourceAccess(user_id=user.id, sheet_source_id=sid, granted_by=admin.id))

    db.commit()
    return UserAccessOut(
        modules=get_user_modules(db, user),
        finance_company_ids=get_user_sheet_source_ids(db, user, module="finance"),
        oe_salesperson=user.oe_salesperson,
    )


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


# ── Delete user (permanent) ──────────────────────────────────────────────────
@router.delete("/{user_id}")
def delete_user(
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_superadmin),
):
    """Permanently remove an account. Module/company grants cascade away with it.
    Work the user produced (leads, upload logs, sheet sources, sync logs) is kept
    — those FKs are ON DELETE SET NULL, so rows survive and only lose attribution.
    Blocking self-deletion also guarantees at least one superadmin always remains.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if str(user.id) == str(admin.id):
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    db.delete(user)
    db.commit()
    return {"id": str(user_id), "deleted": True}

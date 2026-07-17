"""
AutoForm MIS — Sheets helper router.
Serves the non-secret bits of the Google service-account config so the
"Connect a Google Sheet" guide can show the exact address users must share
their sheet with, instead of hardcoding it in the frontend.
"""
from fastapi import APIRouter, Depends, HTTPException

from models import User
from routers.auth import get_current_user
from services.google_sheets import load_service_account_info

router = APIRouter(prefix="/sheets", tags=["Sheets"])


@router.get("/service-account")
def get_service_account(current_user: User = Depends(get_current_user)):
    """Return ONLY the service account's email address.

    Never returns the private key or any other credential field — the email is
    public by nature (it gets shared onto every source sheet), the rest is not.
    """
    try:
        info = load_service_account_info()
    except Exception:
        raise HTTPException(
            status_code=503,
            detail="Google service account is not configured on the server.",
        )

    client_email = info.get("client_email")
    if not client_email:
        raise HTTPException(
            status_code=503,
            detail="Service account config is missing a client_email.",
        )
    return {"client_email": client_email}

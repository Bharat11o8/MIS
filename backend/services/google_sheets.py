"""
AutoForm MIS — Shared Google Sheets service-account auth.
Used by every sheet-backed sync service (Plant-to-Depot, Depot-to-Distributor,
and any future module that registers a Google Sheet via `sheet_sources`).
"""
import os
import json
import base64
import re

from google.oauth2 import service_account
from googleapiclient.discovery import build

SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

_SHEET_ID_RE = re.compile(r"/d/([a-zA-Z0-9_-]{20,})")


def load_service_account_info() -> dict:
    raw = (os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON") or "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON is not set")
    if raw.startswith("{"):
        return json.loads(raw)
    return json.loads(base64.b64decode(raw))


def get_sheets_service():
    info = load_service_account_info()
    creds = service_account.Credentials.from_service_account_info(info, scopes=SHEETS_SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def extract_sheet_id(raw: str) -> str:
    """Accepts a full Google Sheets URL or a bare ID; returns the bare ID."""
    raw = raw.strip()
    m = _SHEET_ID_RE.search(raw)
    return m.group(1) if m else raw

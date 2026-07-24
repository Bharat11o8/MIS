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
# Read + write — used only by the visit-log form, which appends response rows.
# Every sync path stays on the read-only scope above.
SHEETS_WRITE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
# Drive upload for the visit-log photo. Full `drive` scope is needed because the
# target is a PRE-EXISTING folder (the Google Form's "(File responses)"), and
# drive.file can only touch folders/files this app itself created — it 403s with
# "Insufficient permissions for the specified parent" on the Form's folder. We
# upload as a real user who owns that folder, so `drive` is appropriate.
DRIVE_UPLOAD_SCOPES = ["https://www.googleapis.com/auth/drive"]

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


def get_sheets_service_rw():
    """Read/write Sheets client — for appending form responses. Kept separate
    from get_sheets_service so nothing in the sync path can accidentally write."""
    info = load_service_account_info()
    creds = service_account.Credentials.from_service_account_info(info, scopes=SHEETS_WRITE_SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def extract_sheet_id(raw: str) -> str:
    """Accepts a full Google Sheets URL or a bare ID; returns the bare ID."""
    raw = raw.strip()
    m = _SHEET_ID_RE.search(raw)
    return m.group(1) if m else raw


def _oauth_user_creds():
    """Build user OAuth credentials from a stored refresh token, if configured.

    A service account has no Drive storage of its own, so it can't own files in a
    personal My Drive folder. Uploading AS a real user (whose account owns the
    folder) sidesteps that — the file uses that user's quota, exactly like the
    Google Form does. The one-time consent is done by scripts/oauth_authorize.py,
    which prints these three env values. Returns None when not configured, so the
    caller falls back to the service account.
    """
    client_id = (os.getenv("DRIVE_OAUTH_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("DRIVE_OAUTH_CLIENT_SECRET") or "").strip()
    refresh_token = (os.getenv("DRIVE_OAUTH_REFRESH_TOKEN") or "").strip()
    if not (client_id and client_secret and refresh_token):
        return None
    from google.oauth2.credentials import Credentials as UserCredentials
    return UserCredentials(
        token=None,
        refresh_token=refresh_token,
        client_id=client_id,
        client_secret=client_secret,
        token_uri="https://oauth2.googleapis.com/token",
        scopes=DRIVE_UPLOAD_SCOPES,
    )


def get_drive_service():
    """Drive client for uploading the visit-log photo. Prefers user OAuth (uploads
    owned by a real account, into a My Drive folder — see _oauth_user_creds), then
    domain-wide delegation (VISIT_LOG_DRIVE_AS_USER), then the plain service
    account (only works for a Shared Drive, which has no per-user quota)."""
    user_creds = _oauth_user_creds()
    if user_creds is not None:
        return build("drive", "v3", credentials=user_creds, cache_discovery=False)

    info = load_service_account_info()
    creds = service_account.Credentials.from_service_account_info(info, scopes=DRIVE_UPLOAD_SCOPES)
    as_user = (os.getenv("VISIT_LOG_DRIVE_AS_USER") or "").strip()
    if as_user:
        creds = creds.with_subject(as_user)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def upload_photo_to_folder(file_bytes: bytes, filename: str, mime_type: str, folder_id: str) -> str:
    """Upload bytes into a Drive folder and return a shareable view link.

    The file is created INSIDE folder_id and given no explicit permissions, so it
    inherits the folder's sharing — only people with folder access can open it.
    supportsAllDrives is set so this also works if the folder lives in a Shared
    Drive. Requires the Drive API to be enabled on the service account's project.
    """
    from googleapiclient.http import MediaInMemoryUpload

    drive = get_drive_service()
    media = MediaInMemoryUpload(file_bytes, mimetype=mime_type or "application/octet-stream", resumable=False)
    created = drive.files().create(
        body={"name": filename, "parents": [folder_id]},
        media_body=media,
        fields="id, webViewLink",
        supportsAllDrives=True,
    ).execute()
    # webViewLink is the human-openable URL; fall back to the canonical form.
    return created.get("webViewLink") or f"https://drive.google.com/file/d/{created['id']}/view"

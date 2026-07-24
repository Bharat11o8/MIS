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
# Drive upload for the visit-log photo. drive.file only grants access to files the
# service account itself creates — the least privilege that still lets it drop a
# photo into the shared responses folder.
DRIVE_UPLOAD_SCOPES = ["https://www.googleapis.com/auth/drive.file"]

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


def get_drive_service():
    """Drive client for uploading the visit-log photo.

    A service account has no Drive storage of its own, so it cannot own files in a
    personal My Drive folder ("Service Accounts do not have storage quota"). Two
    ways around it, chosen by env:

      • VISIT_LOG_DRIVE_AS_USER set  → domain-wide delegation: the SA impersonates
        that Workspace user, and uploads use THAT user's quota and ownership. This
        lets photos land in the existing Google-Form My Drive folder. Requires a
        Workspace admin to authorize the SA's client id for DRIVE_UPLOAD_SCOPES.
      • unset                        → plain SA credentials. Works only when the
        target folder is in a Shared Drive (files owned by the drive, no quota).
    """
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

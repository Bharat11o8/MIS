"""
AutoForm MIS — OE Network visit-log form (public).

Replaces the Google Form OEM salespeople used. Appends one row per submission to
the log-book responses sheet, in the exact column order the sheet already has, so
the existing OE Network sync (services/oe_network_sync.py) keeps reading it.

This endpoint is intentionally UNAUTHENTICATED — reps open a shared link, no login
— mirroring how the Google Form worked. The target sheet is set by
VISIT_LOG_SHEET_ID so the test sheet and the live sheet are a config swap, never a
code change.

Photo upload (sheet column L) is deferred to a later phase; this writes text only.
"""
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Form, HTTPException, UploadFile, File
from googleapiclient.errors import HttpError

from services.google_sheets import get_sheets_service_rw, upload_photo_to_folder

router = APIRouter(prefix="/visit-log", tags=["OE Visit Log"])

IST = ZoneInfo("Asia/Kolkata")

# The response tab. Google Forms names it "Form responses 1"; kept configurable
# in case a copy renames it.
SHEET_TAB = os.getenv("VISIT_LOG_SHEET_TAB", "Form responses 1")

# Sheet columns A..V, in order. Each entry is how that column's value is produced
# from the submitted form. "" = leave blank (Timestamp is filled at write time;
# S/U/V are stray/derived columns the Form left to Sheets).
# NOTE: a "Channel" column was inserted at O, shifting Salesperson..onward right
# by one — the order below matches the sheet's current 22-column header exactly.
#   A Timestamp                 -> set here
#   B Visit Date / Calling Date -> visit_date (DD/MM/YYYY, matching existing rows)
#   C Dealership Name           -> dealership
#   D Dealership Address        -> address
#   E Contact Person            -> contact_person
#   F Contact No.               -> contact_number
#   G Designation               -> designation
#   H Monthly Car Sales         -> car_sales
#   I Monthly Seat Covers Sales -> seat_cover_sales
#   J Monthly Mats Sales        -> mats_sales
#   K Remarks                   -> remarks (already combined on the client)
#   L Upload Photo              -> "" (images: later phase)
#   M Email address             -> email
#   N OEM                       -> oem
#   O Channel                   -> channel (Arena/Nexa; MSIL only, else blank)
#   P Sales Person's Name       -> salesperson
#   Q Visit / Calling           -> contact_mode
#   R City                      -> city
#   S State                     -> state
#   T Dealers Name              -> "" (empty; confirmed unused)
#   U Column 18                 -> ""
#   V Column 1                  -> month abbrev (existing rows carry e.g. "Jul")


def _fmt_date_ddmmyyyy(iso: str) -> str:
    """The form sends YYYY-MM-DD; the sheet's existing rows are DD/MM/YYYY."""
    try:
        d = datetime.strptime(iso, "%Y-%m-%d")
    except (ValueError, TypeError):
        return iso  # pass through anything unexpected rather than dropping it
    return d.strftime("%d/%m/%Y")


@router.post("/submit")
def submit_visit_log(
    salesperson: str = Form(...),
    email: str = Form(""),
    oem: str = Form(...),
    contact_mode: str = Form(...),
    visit_date: str = Form(...),
    state: str = Form(...),
    city: str = Form(...),
    dealership: str = Form(...),
    address: str = Form(""),
    contact_person: str = Form(""),
    contact_number: str = Form(""),
    designation: str = Form(""),
    car_sales: str = Form(""),
    seat_cover_sales: str = Form(""),
    mats_sales: str = Form(""),
    remarks: str = Form(""),
    channel: str = Form(""),
    remark_categories: str = Form(""),
    photo: UploadFile | None = File(None),
):
    sheet_id = os.getenv("VISIT_LOG_SHEET_ID")
    if not sheet_id:
        raise HTTPException(status_code=503, detail="VISIT_LOG_SHEET_ID is not configured.")

    now = datetime.now(IST)
    timestamp = now.strftime("%d/%m/%Y %H:%M:%S")
    month_abbr = now.strftime("%b")  # matches "Jul" seen in existing rows

    # Photo → Drive (column L). Gated by VISIT_LOG_PHOTOS_ENABLED, which stays off
    # until a Workspace admin authorizes domain-wide delegation (see
    # DRIVE_DELEGATION_SETUP.md) — a service account can't own files in My Drive on
    # its own. While off, the row is still saved with column L blank rather than
    # failing the whole submission; once on, an upload error surfaces to the rep.
    photos_enabled = (os.getenv("VISIT_LOG_PHOTOS_ENABLED", "").lower() in ("1", "true", "yes"))
    photo_link = ""
    if photos_enabled and photo is not None and photo.filename:
        folder_id = os.getenv("VISIT_LOG_DRIVE_FOLDER_ID")
        if not folder_id:
            raise HTTPException(status_code=503, detail="VISIT_LOG_DRIVE_FOLDER_ID is not configured.")
        try:
            data = photo.file.read()
            safe_person = (salesperson or "unknown").replace("/", "-").strip()
            fname = f"{now.strftime('%Y%m%d_%H%M%S')}_{safe_person}_{photo.filename}"
            photo_link = upload_photo_to_folder(data, fname, photo.content_type or "", folder_id)
        except HttpError as e:
            raise HTTPException(status_code=502, detail=f"Could not upload the photo: {e}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Photo upload failed: {e}")

    # A..V, exactly matching the sheet's current header order (Channel at O).
    row = [
        timestamp,                       # A Timestamp
        _fmt_date_ddmmyyyy(visit_date),  # B Visit Date / Calling Date
        dealership,                      # C Dealership Name
        address,                         # D Dealership Address
        contact_person,                  # E Contact Person
        contact_number,                  # F Contact No.
        designation,                     # G Designation
        car_sales,                       # H Monthly Car Sales
        seat_cover_sales,                # I Monthly Seat Covers Sales
        mats_sales,                      # J Monthly Mats Sales
        remarks,                         # K Remarks
        photo_link,                      # L Upload Photo (Drive link, or "")
        email,                           # M Email address
        oem,                             # N OEM
        channel,                         # O Channel (Arena/Nexa; blank if not MSIL)
        salesperson,                     # P Sales Person's Name
        contact_mode,                    # Q Visit / Calling
        city,                            # R City
        state,                           # S State
        "",                              # T Dealers Name (empty)
        "",                              # U Column 18
        month_abbr,                      # V Column 1
    ]

    try:
        svc = get_sheets_service_rw()
        svc.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range=f"'{SHEET_TAB}'!A1",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [row]},
        ).execute()
    except HttpError as e:
        # 403 here almost always means the service account lacks Editor access.
        raise HTTPException(status_code=502, detail=f"Could not write to the sheet: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Submit failed: {e}")

    return {"status": "ok"}

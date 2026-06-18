"""
AutoForm MIS — Lead Data Parser
Handles Excel/CSV ingestion with normalization, ASM extraction, and reason classification.
"""
import re
import io
import pandas as pd
from typing import Tuple

# ── State Normalization Map ─────────────────────────────────────────────────
# Maps any variant (lowercase, stripped) → canonical Indian state name
STATE_MAP = {
    # Andhra Pradesh
    "ap": "Andhra Pradesh", "andhra": "Andhra Pradesh",
    "andhra pradesh": "Andhra Pradesh", "andhrapradesh": "Andhra Pradesh",
    "andhra pradesh ": "Andhra Pradesh", "tirupati": "Andhra Pradesh",
    # Assam
    "assam": "Assam", "guwahati": "Assam",
    # Bihar
    "bihar": "Bihar",
    # Chandigarh
    "chandigarh": "Chandigarh",
    # Chhattisgarh
    "cg": "Chhattisgarh", "chhattisgarh": "Chhattisgarh",
    # Delhi
    "delhi": "Delhi",
    # Gujarat
    "gujarat": "Gujarat", "ahmedabad": "Gujarat",
    # Haryana
    "haryana": "Haryana", "harwana": "Haryana",
    "ghaziabad": "Uttar Pradesh",  # ghaziabad is UP, not haryana
    # Himachal Pradesh
    "hp": "Himachal Pradesh", "himachal": "Himachal Pradesh",
    "himachal pradesh": "Himachal Pradesh",
    # Jammu & Kashmir
    "j&k": "Jammu & Kashmir", "jk": "Jammu & Kashmir",
    "jammu": "Jammu & Kashmir", "kashmir": "Jammu & Kashmir",
    # Jharkhand
    "jharkhand": "Jharkhand", "jamshedpur": "Jharkhand",
    "dhanbad": "Jharkhand",
    # Karnataka
    "karnataka": "Karnataka",
    # Kerala
    "kerala": "Kerala",
    # Madhya Pradesh
    "mp": "Madhya Pradesh", "madhya pradesh": "Madhya Pradesh",
    # Maharashtra
    "maharashtra": "Maharashtra", "maharshtra": "Maharashtra",
    "mumbai": "Maharashtra", "pune": "Maharashtra", "thane": "Maharashtra",
    "nagpur": "Maharashtra",
    # Nagaland
    "nagaland": "Nagaland",
    # Odisha
    "odisha": "Odisha", "bhubaneswar": "Odisha",
    # Punjab
    "punjab": "Punjab", "punajab": "Punjab", "punajb": "Punjab",
    # Rajasthan
    "rajasthan": "Rajasthan", "jaipur": "Rajasthan",
    # Sikkim
    "sikkim": "Sikkim", "sikkam": "Sikkim",
    # Tamil Nadu
    "tamil nadu": "Tamil Nadu", "tamilnadu": "Tamil Nadu",
    "taminnadu": "Tamil Nadu", "chennai": "Tamil Nadu",
    # Telangana
    "telangana": "Telangana", "telagana": "Telangana",
    "telegana": "Telangana", "telalgana": "Telangana",
    "hyderabad": "Telangana",
    # Tripura
    "tripura": "Tripura",
    # Uttar Pradesh
    "uttar pradesh": "Uttar Pradesh", "up": "Uttar Pradesh",
    "uttar pardesh": "Uttar Pradesh",
    # Uttarakhand
    "uttarakhand": "Uttarakhand", "uttrakhand": "Uttarakhand",
    "uttarakhnad": "Uttarakhand",
    # West Bengal
    "west bengal": "West Bengal",
}

# ── Source Normalization ────────────────────────────────────────────────────
SOURCE_MAP = {
    "ivr": "IVR",
    "whatsapp": "WhatsApp",
    "instagram": "Instagram",
}

# ── Status Normalization ────────────────────────────────────────────────────
CALL_STATUS_MAP = {
    "follow up": "Follow Up",
    "closed won": "Closed Won",
    "no response": "No Response",
    "complaint": "Complaint",
    "take recording": "Take Recording",
    "asking about the autocruze brand": "Inquiry",
    "asking about the product warranty": "Inquiry",
}

REVIEW_STATUS_MAP = {
    "closed won": "Closed Won",
    "closed lost": "Closed Lost",
    "follow up": "Follow Up",
    "no response": "No Response",
    "call disconnected": "Call Disconnected",
    "switch off": "Switch Off",
    "switch off ": "Switch Off",
    "complaint": "Complaint",
}

# Summary rows to skip (appear at bottom of some sheets)
SUMMARY_ROW_KEYWORDS = {
    "total calls received", "total percentage", "total",
    "grand total", "summary",
}

# ── Canonical ASM names (fuzzy dedup) ──────────────────────────────────────
# Maps variant spellings → canonical name
ASM_NAME_MAP = {
    "prosejit": "Prosenjit",
    "prosenit": "Prosenjit",
    "prosenjit": "Prosenjit",
    "atul asm number": "Atul",
    "rg store": "RG Store",
}

# ── ASM extraction pattern ──────────────────────────────────────────────────
_ASM_RE = re.compile(
    r'shared\s+with\s+(.+?)\s+(?:asm|sir)\s*$',
    re.IGNORECASE
)

# ── Reason category patterns ────────────────────────────────────────────────
_REASON_PATTERNS = [
    (re.compile(r'shared\s+with\s+.+?\s+(?:asm|sir)', re.IGNORECASE), "ASM Shared"),
    (re.compile(r'shared\s+(images?|image)', re.IGNORECASE),           "Images Shared"),
    (re.compile(r'shared\s+.*(store|address)', re.IGNORECASE),         "Store Shared"),
    (re.compile(r'(bought|buy|purchase|said.*bought)', re.IGNORECASE), "Already Bought"),
    (re.compile(r'asking|enquir|inquir', re.IGNORECASE),               "Inquiry"),
]


# ── Helper functions ────────────────────────────────────────────────────────

def _clean_str(raw) -> str | None:
    """Convert to string, stripping whitespace. Returns None for NaN / 'nan' / empty."""
    if raw is None:
        return None
    try:
        if pd.isna(raw):
            return None
    except (TypeError, ValueError):
        pass
    s = str(raw).strip()
    return None if (s == "" or s.lower() == "nan") else s


def _normalize_state(raw) -> str | None:
    s = _clean_str(raw)
    if not s:
        return None
    return STATE_MAP.get(s.lower(), s)


def _normalize_source(raw) -> str:
    s = _clean_str(raw)
    if not s:
        return "Other"
    return SOURCE_MAP.get(s.lower(), s)


def _normalize_call_status(raw) -> str | None:
    s = _clean_str(raw)
    if not s:
        return None
    return CALL_STATUS_MAP.get(s.lower(), s.title())


def _normalize_review_status(raw) -> str | None:
    s = _clean_str(raw)
    if not s:
        return None
    return REVIEW_STATUS_MAP.get(s.lower(), s.title())


def _extract_asm(reason: str | None) -> str | None:
    """Extract ASM name from reason text. Returns canonical name or None."""
    if not reason:
        return None
    m = _ASM_RE.search(reason)
    if not m:
        return None
    raw_name = m.group(1).strip()
    return ASM_NAME_MAP.get(raw_name.lower(), raw_name)


def _classify_reason(reason: str | None) -> str:
    """Classify reason text into a category."""
    if not reason:
        return "Other"
    for pattern, category in _REASON_PATTERNS:
        if pattern.search(reason):
            return category
    return "Other"


def _is_summary_row(row: pd.Series) -> bool:
    """Detect and skip summary/total rows injected at sheet bottom."""
    for col in ["Review Status", "Status", "Chanel"]:
        val = _clean_str(row.get(col))
        if val and val.lower() in SUMMARY_ROW_KEYWORDS:
            return True
    return False


def _parse_mobile(raw) -> str | None:
    """Convert numeric mobile to string. Returns None for NaN."""
    if raw is None:
        return None
    try:
        if pd.isna(raw):
            return None
    except (TypeError, ValueError):
        pass
    try:
        return str(int(float(str(raw))))
    except (ValueError, TypeError):
        s = str(raw).strip()
        return None if (s == "" or s.lower() == "nan") else s[:50]


def _parse_date(raw) -> str | None:
    """Return ISO date string from pandas Timestamp or string."""
    if raw is None:
        return None
    try:
        if pd.isna(raw):
            return None
    except (TypeError, ValueError):
        pass
    try:
        return pd.to_datetime(raw, dayfirst=True).date().isoformat()
    except Exception:
        return None



# ── Main parser ─────────────────────────────────────────────────────────────

def parse_leads_file(file_bytes: bytes, filename: str) -> Tuple[list[dict], list[str]]:
    """
    Parse a leads Excel/CSV file.

    Returns:
        (records, errors)
        records — list of clean dicts ready for DB insert
        errors  — list of human-readable row-level error messages
    """
    errors = []
    records = []

    try:
        if filename.lower().endswith(".csv"):
            df_raw = pd.read_csv(io.BytesIO(file_bytes))
        else:
            # Try all sheets, combine
            xl = pd.ExcelFile(io.BytesIO(file_bytes))
            frames = []
            for sheet in xl.sheet_names:
                try:
                    frames.append(pd.read_excel(io.BytesIO(file_bytes), sheet_name=sheet))
                except Exception as e:
                    errors.append(f"Sheet '{sheet}' could not be read: {e}")
            if not frames:
                return [], ["No readable sheets found in file"]
            df_raw = pd.concat(frames, ignore_index=True)
    except Exception as e:
        return [], [f"Could not open file: {e}"]

    # Validate required columns exist
    required_cols = {"Date", "Chanel", "Mobile Number"}
    missing = required_cols - set(df_raw.columns)
    if missing:
        return [], [f"Missing required columns: {', '.join(missing)}. Expected: Date, Chanel, Customer Name, Mobile Number, Car Type, Product Type, Location, State, Status, Reason, Review Status, Review Reason"]

    skipped_summary = 0
    for idx, row in df_raw.iterrows():
        row_num = idx + 2  # 1-based + header row

        # Skip summary rows
        if _is_summary_row(row):
            skipped_summary += 1
            continue

        # Skip completely blank rows
        if row.get("Mobile Number") is None or pd.isna(row.get("Mobile Number", None)):
            if row.get("Date") is None or pd.isna(row.get("Date", None)):
                continue  # blank row

        lead_date = _parse_date(row.get("Date"))
        if not lead_date:
            errors.append(f"Row {row_num}: Invalid or missing Date")
            continue

        source = _normalize_source(row.get("Chanel"))
        reason_raw = _clean_str(row.get("Reason"))

        record = {
            "lead_date":       lead_date,
            "source":          source,
            "customer_name":   _clean_str(row.get("Customer Name")),
            "mobile_number":   _parse_mobile(row.get("Mobile Number")),
            "car_type":        _clean_str(row.get("Car Type")),
            "product_type":    _clean_str(row.get("Product Type")),
            "location":        _clean_str(row.get("Location")),
            "state":           _normalize_state(row.get("State")),
            "call_status":     _normalize_call_status(row.get("Status")),
            "reason":          reason_raw,
            "reason_category": _classify_reason(reason_raw),
            "assigned_asm":    _extract_asm(reason_raw),
            "review_status":   _normalize_review_status(row.get("Review Status")),
            "review_reason":   _clean_str(row.get("Review Reason")),
        }
        records.append(record)

    if skipped_summary:
        errors.append(f"INFO: {skipped_summary} summary/total rows were automatically skipped")

    return records, errors

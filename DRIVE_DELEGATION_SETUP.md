# Enable Photo Uploads for the OE Visit-Log Form — Workspace Admin Steps

The visit-log form is done and already writes every response into the log-book
Google Sheet. The **one remaining piece is the photo upload** into the Drive
folder the current Google Form uses.

## Why admin action is needed

The MIS backend uploads via a **service account** (a robot identity). Service
accounts have **no Google Drive storage quota of their own**, so they cannot own
files in a personal *My Drive* folder — every upload fails with
*"Service Accounts do not have storage quota."*

The fix is **domain-wide delegation**: authorize the service account to act as a
real Workspace user for Drive uploads. Then uploads use that user's quota and the
files land in the existing folder, owned by that user — exactly like the Google
Form does today. This requires a **Google Workspace admin** (admin.google.com).

## What the admin needs to do (~5 minutes)

**1. Turn on domain-wide delegation for the service account** (Google Cloud console)
- Project: `eighth-parity-490612-s2`
- Service account: `mis-autoform@eighth-parity-490612-s2.iam.gserviceaccount.com`
- Enable "domain-wide delegation" if not already on.

**2. Authorize it in the Admin console**
- Go to **admin.google.com → Security → Access and data control → API controls
  → Domain-wide delegation → Manage Domain Wide Delegation → Add new**
- **Client ID:** `107224093853721781795`
- **OAuth scopes:** `https://www.googleapis.com/auth/drive.file`
- Save.

**3. Tell us which user to impersonate**
- Pick the Workspace account whose Drive should own the uploaded photos — ideally
  the same account that owns the current Google-Form file-responses folder
  (e.g. `marketing@autoformindia.com` or the form owner).
- That folder must be shared with the impersonated user as at least **Editor**
  (usually already true if they own it).

## What we do once it's set

- Set `VISIT_LOG_DRIVE_AS_USER=<that user's email>` in the backend `.env`.
- Point `VISIT_LOG_DRIVE_FOLDER_ID` at the real folder.
- Photos then upload straight into the existing folder — no other changes.

## Details for reference

| Item | Value |
|---|---|
| Service account email | `mis-autoform@eighth-parity-490612-s2.iam.gserviceaccount.com` |
| Service account client ID | `107224093853721781795` |
| GCP project | `eighth-parity-490612-s2` |
| Scope to authorize | `https://www.googleapis.com/auth/drive.file` |

## Alternative (no impersonation)

If instead the team is OK moving OE photos to a **Shared Drive**: create one, add
the service account as **Content Manager**, put the folder there, and leave
`VISIT_LOG_DRIVE_AS_USER` blank. Files are then owned by the drive itself (no
quota issue). This does NOT keep photos in the current My Drive folder.

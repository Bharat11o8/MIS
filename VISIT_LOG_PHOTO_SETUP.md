# Enable Photo Uploads for the OE Visit-Log Form (OAuth, no admin)

The visit-log form already writes every response into the log-book sheet. This
turns on the **photo upload** into the real Google-Form folder
`Log Book (File responses)` (owned by `yssupport@autoformindia.com`).

## Why this is needed

The backend uploads via a **service account**, which has **no Drive storage
quota** — so it cannot own files in a personal *My Drive* folder (confirmed: the
service account has Editor on the folder but still gets *"Service Accounts do not
have storage quota"*). The fix that needs **no Workspace admin**: upload **as a
real user** who owns the folder (`yssupport@`). Files then use that user's quota
and land in the exact folder, just like the Google Form does.

## One-time setup (~10 min)

### 1. Create an OAuth client ID (Google Cloud console)
Project `eighth-parity-490612-s2` (same project where the Drive API was enabled):
- **APIs & Services → Credentials → Create Credentials → OAuth client ID**
- Application type: **Desktop app** → Create → note the **Client ID** and **Client secret**.
- **OAuth consent screen:** if it's in *Testing* mode, add `yssupport@autoformindia.com`
  under **Test users** (otherwise sign-in is blocked).

### 2. Run the one-time authorization (locally)
```bash
cd backend
.\venv\Scripts\activate            # Windows
python scripts/oauth_authorize.py <CLIENT_ID> <CLIENT_SECRET>
```
A browser opens — **sign in as `yssupport@autoformindia.com`** (the folder owner)
and approve. The script prints three lines.

### 3. Put the values in `backend/.env`
```
DRIVE_OAUTH_CLIENT_ID=...
DRIVE_OAUTH_CLIENT_SECRET=...
DRIVE_OAUTH_REFRESH_TOKEN=...
VISIT_LOG_PHOTOS_ENABLED=true
VISIT_LOG_DRIVE_FOLDER_ID=1o6Uwu6ZNG7q62Qtegh2iujjrV-9XP1elj1ouU-D8nSS5CVsvpALYRdrGKvH1a1yCNeuXfGRq
```
Restart the backend. Photos now upload into `Log Book (File responses)`, owned by
`yssupport@`, and the Drive link is written to the sheet's Upload-Photo column.

## Notes
- The refresh token is long-lived; it auto-refreshes. If `yssupport@` revokes app
  access or changes the password's security, re-run step 2.
- Scope is `drive.file` — the app can only touch files it creates, nothing else in
  the user's Drive.
- Keep the three `DRIVE_OAUTH_*` values secret; they live only in `.env` (gitignored).
- Alternative (needs a Workspace admin): domain-wide delegation — see
  `DRIVE_DELEGATION_SETUP.md`. Not required if you use this OAuth path.

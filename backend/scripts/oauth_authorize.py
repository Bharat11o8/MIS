"""
One-time OAuth authorization for the visit-log photo upload.

Why: a service account has no Drive storage, so it can't own files in a personal
My Drive folder (the Google Form's "(File responses)" folder). Instead the backend
uploads AS a real user who owns/can-edit that folder. This script does the one-time
browser consent for that user and prints a refresh token to store in backend/.env.

Prerequisites (one-time, in the Google Cloud console for the service account's
project — same project where the Drive API was enabled):
  1. APIs & Services → Credentials → Create Credentials → OAuth client ID
     • Application type: Desktop app
     • Download the client's ID and secret.
  2. If the app is in "Testing" mode, add the uploading user (e.g.
     yssupport@autoformindia.com) under OAuth consent screen → Test users.

Run (from backend/, with the venv active):
    python scripts/oauth_authorize.py <CLIENT_ID> <CLIENT_SECRET>

A browser opens; sign in as the account that owns the photos folder
(yssupport@autoformindia.com) and approve. The script prints three lines to add
to backend/.env:

    DRIVE_OAUTH_CLIENT_ID=...
    DRIVE_OAUTH_CLIENT_SECRET=...
    DRIVE_OAUTH_REFRESH_TOKEN=...

After that, set VISIT_LOG_PHOTOS_ENABLED=true and photos upload into the real
folder, owned by that user.
"""
import sys

# Full drive scope — the target is the Google Form's pre-existing "(File
# responses)" folder, which drive.file cannot write to (it only allows folders
# this app created). We upload as the folder's owner, so drive is appropriate.
SCOPES = ["https://www.googleapis.com/auth/drive"]


def main():
    if len(sys.argv) != 3:
        print("Usage: python scripts/oauth_authorize.py <CLIENT_ID> <CLIENT_SECRET>")
        sys.exit(1)
    client_id, client_secret = sys.argv[1], sys.argv[2]

    from google_auth_oauthlib.flow import InstalledAppFlow

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }

    flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)
    # access_type=offline + prompt=consent guarantees a refresh_token comes back.
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")

    if not creds.refresh_token:
        print("\nNo refresh token was returned. Re-run — the account may have "
              "already granted consent (revoke it at myaccount.google.com and retry).")
        sys.exit(1)

    print("\n" + "=" * 68)
    print("Add these three lines to backend/.env (keep them secret):\n")
    print(f"DRIVE_OAUTH_CLIENT_ID={client_id}")
    print(f"DRIVE_OAUTH_CLIENT_SECRET={client_secret}")
    print(f"DRIVE_OAUTH_REFRESH_TOKEN={creds.refresh_token}")
    print("=" * 68)


if __name__ == "__main__":
    main()

# AutoForm MIS — Deployment Guide

How the app is deployed, how to make future changes live, and the gotchas to
avoid. Written after the Phase 1 production deployment (2026-07-20).

---

## 1. Architecture at a glance

The app is **two independently deployed halves** plus a database:

| Part        | Tech                     | Where it runs                                   | Public URL |
|-------------|--------------------------|-------------------------------------------------|------------|
| Frontend    | React + Vite (static)    | **Hostinger** (static hosting)                  | `https://mis.amatoautomotive.co.in` |
| Backend API | FastAPI (Python) + uvicorn | **VPS** `srv1645350` under PM2, behind nginx  | `https://mis-api.autoformindia.co.in` |
| Database    | PostgreSQL               | **VPS** `srv1645350`, localhost:5432            | (not public) |

The frontend is a static bundle: the browser downloads it from Hostinger, and
then it calls the backend API directly over HTTPS. The backend URL is **baked
into the frontend bundle at build time** via `VITE_API_URL` — it is not
configurable after the build.

```
Browser ──> https://mis.amatoautomotive.co.in        (Hostinger: static React app)
   │
   └─ fetch()──> https://mis-api.autoformindia.co.in  (VPS: nginx ──> uvicorn :8000 ──> Postgres)
```

---

## 2. Infrastructure reference

### VPS
- Host: `srv1645350`, IP `187.127.162.249`, Ubuntu 24.04
- SSH user: `deploy`
- The VPS **also runs an unrelated project** (`warranty-api`, a Node app on port
  3000). Do not touch it. MIS uses a different port (8000), a different PM2
  process, and a different nginx site.

### Backend
- Repo checkout: `/home/deploy/MIS`
- App entry: `backend/main.py` → `main:app`
- Runs under **PM2** as process `mis-api`, bound to `127.0.0.1:8000`
- Python venv: `/home/deploy/MIS/backend/venv`
- Secrets: `/home/deploy/MIS/backend/.env` (not in git)

### Database
- PostgreSQL on the VPS, `localhost:5432`
- Database: `autoform_mis`, owner/user: `mis_user`
- **Important:** on the VPS the DB is reached at port **5432** (direct). Your
  local dev machine reaches the same DB through an **SSH tunnel on 5433**, so the
  local `.env` and the VPS `.env` have *different* ports in `DATABASE_URL`.

### Reverse proxy / TLS
- nginx site: `/etc/nginx/sites-available/mis-api` (symlinked into `sites-enabled/`)
- TLS: Let's Encrypt via certbot for `mis-api.autoformindia.co.in` (auto-renews)

### Frontend
- Hosted on Hostinger, subdomain `mis.amatoautomotive.co.in`
- Upload target: the subdomain's document root (contains `index.html`)
- Requires an `.htaccess` SPA-rewrite file (see §5)

### Source control
- GitHub: `https://github.com/Bharat11o8/MIS.git`, branch `master`

---

## 3. Environment variables (`backend/.env`)

Never commit this file. On the VPS it lives at `/home/deploy/MIS/backend/.env`.

| Key | Purpose | Notes |
|-----|---------|-------|
| `DATABASE_URL` | Postgres connection | `postgresql+psycopg://mis_user:<pass>@localhost:5432/autoform_mis` — driver prefix **must** be `postgresql+psycopg` (psycopg 3). Port **5432** on the VPS. |
| `SECRET_KEY` | JWT signing key | Strong random value. If unset the code falls back to `"fallback-secret"` — **never** allow that in production (anyone could forge logins). Generate with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`. |
| `ALGORITHM` | JWT algorithm | `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Token lifetime | e.g. `480` |
| `EMAIL_USER` / `EMAIL_PASS` / `EMAIL_FROM` | Forgot-password emails | copy from a known-good `.env` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Sheets auth | The service-account JSON, stored **inline** (raw JSON or base64). Not a file path. Share each Google Sheet with this service account's email. |

The frontend has one build-time variable, set in `.env.production` at the repo
root (see §5):

| Key | Value |
|-----|-------|
| `VITE_API_URL` | `https://mis-api.autoformindia.co.in` |

---

## 4. Making BACKEND changes live (the routine)

After code is merged to `master` on GitHub:

```bash
# On the VPS
cd /home/deploy/MIS
git pull origin master

cd backend
source venv/bin/activate

# Only if requirements.txt changed:
pip install -r requirements.txt

# Only if there are new DB migrations (see §6):
# sudo -u postgres psql -d autoform_mis -f migrate_phaseN_xxx.sql

# Restart the API to load the new code
pm2 restart mis-api
pm2 save

# Verify it came up cleanly (look for "Uvicorn running", no tracebacks)
pm2 logs mis-api --lines 20 --nostream
curl -i https://mis-api.autoformindia.co.in/health   # expect {"status":"healthy"}
```

That's the whole backend deploy loop: **pull → (deps) → (migrations) → restart → verify.**

---

## 5. Making FRONTEND changes live (the routine)

The frontend is built locally and uploaded to Hostinger.

```bash
# On your machine, in the repo root (D:\MIS)

# .env.production must exist and contain the backend URL.
# IMPORTANT: create it with UTF-8, NOT PowerShell `>` (which writes UTF-16 and
# Vite will silently ignore it). Use Git Bash:
printf 'VITE_API_URL=https://mis-api.autoformindia.co.in\n' > .env.production

npm run build      # outputs to dist/
```

Verify the backend URL actually got baked in before uploading:
```powershell
Select-String -Path dist\assets\*.js -Pattern "mis-api.autoformindia.co.in" | Select-Object -First 1
```
If that finds a match, the build is good. If it finds nothing, `.env.production`
wasn't read (usually the UTF-16 encoding problem above).

Then in **Hostinger File Manager**:
1. Upload the **contents of `dist/`** (not the `dist` folder itself) into the
   subdomain's document root, overwriting the previous files. The JS filenames
   are content-hashed, so old `assets/*.js` files can be deleted.
2. Ensure an **`.htaccess`** file exists in that same folder (enable "show hidden
   files" to see it). Without it, deep links like `/login` or `/dashboard/finance`
   return Hostinger's default page instead of the app. Contents:
   ```apache
   <IfModule mod_rewrite.c>
     RewriteEngine On
     RewriteBase /
     RewriteCond %{REQUEST_FILENAME} !-f
     RewriteCond %{REQUEST_FILENAME} !-d
     RewriteRule . /index.html [L]
   </IfModule>
   ```
3. **Hard-refresh** the site (`Ctrl-Shift-R`) to bypass the cached old bundle.

> Static assets used by the app (images, logo) must live in `public/` and be
> referenced with a root-relative path (e.g. `/seat-cover-hero-4.webp`). A file
> in a random top-level folder or referenced with a `../` relative CSS url is
> **not** bundled by Vite and will 404 in production.

---

## 6. Database migrations

Migrations are plain SQL files in `backend/`, named `migrate_phaseN_*.sql`.

- Apply on the VPS with:
  ```bash
  sudo -u postgres psql -d autoform_mis -f /home/deploy/MIS/backend/migrate_phaseN_xxx.sql
  ```
- **Check before running.** Most use bare `CREATE TABLE`, which **errors if the
  table already exists** — so only run migrations whose objects don't exist yet.
  Inspect current tables with `\dt`, and a table's columns with `\d <table>`.
- Some migrations contain **one-time destructive cleanup** (e.g.
  `migrate_phase10_finance_masters.sql` does `DELETE FROM sheet_sources WHERE
  module='finance'`). Do **not** re-run those after go-live — read a migration
  before running it.
- There is no migration framework (no Alembic); tracking what's applied is
  manual. When adding a new migration, prefer idempotent SQL (`IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`).

---

## 7. Common operations

```bash
# Process status / logs
pm2 list
pm2 logs mis-api --lines 40 --nostream
pm2 restart mis-api
pm2 stop mis-api

# What is holding port 8000?
sudo lsof -i :8000

# Database shell
sudo -u postgres psql -d autoform_mis
# quick queries:
sudo -u postgres psql -d autoform_mis -c "\dt"
sudo -u postgres psql -d autoform_mis -c "SELECT module, COUNT(*) FROM sync_logs GROUP BY module;"

# nginx
sudo nginx -t                       # test config
sudo systemctl reload nginx
sudo cat /etc/nginx/sites-available/mis-api

# TLS cert (auto-renews; to check/renew manually)
sudo certbot certificates
sudo certbot renew --dry-run
```

### Access control model (who can do what)
- Access is **per-user module toggles + per-company toggles**, managed on the
  Users page (superadmin only). Role-based gating was replaced by this.
- `superadmin` bypasses all gates. `management` is the second-tier role.
- **Finance sheet management** (add/sync/delete master sheets) is allowed for
  `superadmin` and `management`, but the user must **also have the finance
  module enabled** on the Users page — `management` does not auto-get modules.

### Google Sheets sync model
- Each Sheets-backed module (Sales Plant-to-Depot, Depot-to-Distributor,
  Finance, OE Network) uses the same **registry pattern**: register a sheet via
  "Add Sheet", then "Sync Now". Synced rows are tagged with that sheet's
  `sheet_source_id`; sync history lands in the `sync_logs` table.
- Leads is different — it uses **file uploads**, history in `upload_logs`, not
  `sync_logs`.

---

## 8. First-time deployment (what was done in Phase 1)

For reference / rebuilding from scratch. Order matters.

1. **DNS:** Added an `A` record `mis-api.autoformindia.co.in` → `187.127.162.249`.
   Confirmed with `dig +short mis-api.autoformindia.co.in`. (Frontend domain
   `mis.amatoautomotive.co.in` points to Hostinger.)
2. **Code on VPS:** `git clone` into `/home/deploy/MIS`.
3. **Python env:** `sudo apt install -y python3.12-venv`, then
   `python3 -m venv venv`, `pip install -r requirements.txt`.
4. **`.env`:** created with the values in §3 (DB port 5432, strong `SECRET_KEY`).
5. **Migrations:** DB was already migrated; verified tables with `\dt` and
   applied only the missing finance migration.
6. **Smoke test:** ran uvicorn manually, `curl :8000/health` → ok, then stopped it.
7. **PM2:**
   ```bash
   pm2 start venv/bin/uvicorn --name mis-api --interpreter venv/bin/python -- \
     main:app --host 127.0.0.1 --port 8000
   pm2 save
   ```
8. **nginx:** created `/etc/nginx/sites-available/mis-api` proxying to
   `127.0.0.1:8000` (with `client_max_body_size 50M` for uploads), symlinked,
   `nginx -t`, reload.
9. **TLS:** `sudo certbot --nginx -d mis-api.autoformindia.co.in` (chose redirect).
10. **Frontend:** built with `VITE_API_URL`, uploaded `dist/` contents +
    `.htaccess` to Hostinger.
11. **Verified:** logged in over HTTPS end-to-end.

### nginx site (`/etc/nginx/sites-available/mis-api`, pre-certbot form)
```nginx
server {
    listen 80;
    server_name mis-api.autoformindia.co.in;
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
(certbot rewrites this to add the `listen 443 ssl`, cert paths, and an
HTTP→HTTPS redirect.)

---

## 9. Gotchas we hit (and how to fix them fast)

| Symptom | Cause | Fix |
|---------|-------|-----|
| Frontend calls `localhost:8000` in production | `.env.production` written by PowerShell `>` as **UTF-16**; Vite ignored it | Write it as UTF-8 (`printf ... > .env.production` in Git Bash), rebuild, re-upload |
| Login returns **500**, browser also shows a **CORS "no Access-Control-Allow-Origin"** error | The 500 is the real bug; FastAPI doesn't attach CORS headers to unhandled 500s, so CORS is a *symptom*. Root cause was `DATABASE_URL` port **5433** (local tunnel) instead of **5432** (VPS) → "connection refused" | Check `pm2 logs mis-api` for the real traceback; fix `DATABASE_URL` port to 5432; `pm2 restart mis-api` |
| PM2 process loops with `[Errno 98] address already in use` on :8000 | A stray manual `uvicorn` (from a smoke test) still held the port | `pm2 stop mis-api`; `sudo lsof -ti :8000 \| xargs -r sudo kill -9`; `pm2 restart mis-api` |
| Deep link (`/login`) shows Hostinger default page | Missing SPA rewrite | Add `.htaccess` (see §5) next to `index.html` |
| Background image / asset missing in production | Referenced with `../` CSS url or from a non-`public/` folder, so Vite didn't bundle it | Put the asset in `public/`, reference it root-relative (`/file.ext`) |
| `python3 -m venv` fails: "ensurepip is not available" | `python3-venv` package not installed | `sudo apt install -y python3.12-venv` |
| CORS error for a **new** frontend origin | Origin not in backend allow-list | Add it to `allow_origins` in `backend/main.py`, `pm2 restart mis-api` |

To validate CORS quickly (should return an `access-control-allow-origin` header):
```bash
curl -i -X OPTIONS https://mis-api.autoformindia.co.in/auth/login \
  -H "Origin: https://mis.amatoautomotive.co.in" \
  -H "Access-Control-Request-Method: POST"
```

---

## 10. Security checklist for any deploy

- [ ] `SECRET_KEY` is set to a strong random value (not the fallback).
- [ ] `DATABASE_URL` uses port **5432** on the VPS.
- [ ] No demo/hardcoded credentials in the frontend or committed anywhere.
- [ ] The `dev@autoformindia.com` (and any seed) passwords have been rotated from
      their initial values.
- [ ] `.env` files are gitignored and never committed.
- [ ] Google Sheets are shared only with the service account, and the
      service-account JSON is only in `.env`.

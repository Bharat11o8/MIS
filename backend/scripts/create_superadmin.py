"""
Create (or reset) the first superadmin.

This replaces the seed that used to sit at the bottom of schema.sql. That seed
carried a fixed bcrypt hash and named its own password in a comment — in a
public repo that is a published credential, and every database created from the
file shared it.

Nothing is hardcoded here. The account comes from the environment:

    SUPERADMIN_EMAIL=you@autoformindia.com
    SUPERADMIN_PASSWORD=<a password you generate, not one from a repo>

Run from backend/ with the venv active:

    venv/Scripts/python.exe scripts/create_superadmin.py

The account is created with must_change_password set, so whoever first logs in
is forced to replace whatever was typed here — the password never has to be a
long-lived secret, and it never has to be shared to be used.

Re-running against an existing email RESETS that account's password rather than
failing, which is the other thing this is for: recovering the one admin account
when nobody can get in to reset it from inside the app.
"""
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv()

import bcrypt  # noqa: E402
from database import SessionLocal  # noqa: E402
from models import User  # noqa: E402

MIN_LENGTH = 12


def main() -> int:
    email = (os.getenv("SUPERADMIN_EMAIL") or "").strip().lower()
    password = os.getenv("SUPERADMIN_PASSWORD") or ""
    name = (os.getenv("SUPERADMIN_NAME") or "Super Admin").strip()

    if not email or not password:
        print("SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD must both be set.\n"
              "Set them for this command only — putting them in .env leaves the\n"
              "password on disk after the account exists.")
        return 1
    # A short password on the one account that can do everything is the whole
    # risk this script exists to remove, so it is refused rather than warned about.
    if len(password) < MIN_LENGTH:
        print(f"SUPERADMIN_PASSWORD must be at least {MIN_LENGTH} characters.")
        return 1

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if user:
            user.password_hash = hashed
            user.role = "superadmin"
            user.is_active = True
            user.must_change_password = True
            action = "reset the password for"
        else:
            db.add(User(
                id=uuid.uuid4(),
                name=name,
                email=email,
                password_hash=hashed,
                role="superadmin",
                is_active=True,
                must_change_password=True,
            ))
            action = "created"
        db.commit()
    finally:
        db.close()

    # The password is never echoed: this runs in a terminal whose scrollback and
    # shell history outlive the command.
    print(f"{action} superadmin {email} — it must be changed at first login.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

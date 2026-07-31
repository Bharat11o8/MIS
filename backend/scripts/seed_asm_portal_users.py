"""
Seed/sync asm_portal_users from the visit-log form's SALESPERSON_EMAILS map.

That map (src/pages/VisitLogFormPage.tsx) is the single source of truth for
which ASMs exist and their email — the visit-log form's salesperson dropdown
is generated from its keys, so it is kept as-is here rather than retyped, to
guarantee the ASM portal can never drift out of sync with the submit form.

Upserts (never deletes) so re-running after adding a new ASM to the TSX map is
always safe — an ASM removed from the map is deactivated, not dropped, so
their historical submissions stay attributable.

Run (from backend/, with the venv active), AFTER applying
migrate_phase15_asm_portal.sql:

    python scripts/seed_asm_portal_users.py            # dry run
    python scripts/seed_asm_portal_users.py --commit   # actually write
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text  # noqa: E402

from database import SessionLocal  # noqa: E402

TSX = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "src", "pages", "VisitLogFormPage.tsx",
)


def parse_salesperson_emails(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        src = f.read()
    start = src.find("const SALESPERSON_EMAILS")
    if start < 0:
        raise SystemExit(f"SALESPERSON_EMAILS not found in {path}")
    open_brace = src.index("{", start)
    end = src.index("}", open_brace)
    body = src[open_brace + 1:end]

    out = {}
    for m in re.finditer(r'"([^"]+)"\s*:\s*"([^"]+)"', body):
        out[m.group(1)] = m.group(2)
    return out


def main() -> None:
    commit = "--commit" in sys.argv
    emails = parse_salesperson_emails(TSX)

    print(f"Parsed {TSX}")
    for name, email in emails.items():
        print(f"  {name:<20} {email}")
    print(f"  TOTAL: {len(emails)} ASMs")

    if not commit:
        print("\nDry run — nothing written. Re-run with --commit to apply.")
        return

    db = SessionLocal()
    try:
        for name, email in emails.items():
            db.execute(text("""
                INSERT INTO asm_portal_users (email, salesperson, is_active)
                VALUES (:email, :salesperson, TRUE)
                ON CONFLICT (email) DO UPDATE
                    SET salesperson = EXCLUDED.salesperson, is_active = TRUE
            """), {"email": email.strip().lower(), "salesperson": name.strip().upper()})

        # Deactivate anyone in the table who is no longer in the TSX map —
        # keeps their historical rows/attribution but blocks new logins.
        known_emails = [e.strip().lower() for e in emails.values()]
        removed = db.execute(text("""
            UPDATE asm_portal_users SET is_active = FALSE
            WHERE email <> ALL(:known) AND is_active = TRUE
            RETURNING email
        """), {"known": known_emails}).fetchall()
        db.commit()
    finally:
        db.close()

    print(f"\nUpserted {len(emails)} ASM(s).")
    if removed:
        print(f"Deactivated {len(removed)} ASM(s) no longer in the map: "
              f"{', '.join(r[0] for r in removed)}")


if __name__ == "__main__":
    main()

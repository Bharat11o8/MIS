"""
One-time seed of oe_dealerships from the frontend's hardcoded dealer list.

The visit-log form's dropdown was a TS constant (DEALERSHIPS_BY_OEM_STATE in
src/pages/VisitLogFormPage.tsx) holding 1,512 dealers across 5 OEMs. Phase 13
moves that list into the database so ASMs can add to it from the form.

The list is parsed out of the .tsx rather than retyped here, so the seeded rows
are exactly what the form has been showing in production — no transcription step
that could silently drop a dealer.

Run (from backend/, with the venv active), AFTER applying
migrate_phase13_oe_dealerships.sql:

    python scripts/seed_dealerships.py            # dry run: parse + report only
    python scripts/seed_dealerships.py --commit   # actually insert

Idempotent: rows conflict on (oem, state, UPPER(name)) and are skipped, so
re-running never duplicates. Existing rows are left untouched, including any an
ASM has already added through the form.
"""
import json
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


def parse_dealer_map(path: str) -> dict:
    """Pull the DEALERSHIPS_BY_OEM_STATE object literal out of the .tsx.

    Brace-matched out and json-parsed rather than regex-scraped field by field.
    Two fixups make it valid JSON: the OEM keys are bare identifiers (MSIL:, not
    "MSIL":), and object literals carry trailing commas. Dealer names and state
    names are already double-quoted strings.
    """
    with open(path, encoding="utf-8") as f:
        src = f.read()

    start = src.find("const DEALERSHIPS_BY_OEM_STATE")
    if start < 0:
        raise SystemExit(f"DEALERSHIPS_BY_OEM_STATE not found in {path}")

    open_brace = src.index("{", start)
    depth = 0
    end = -1
    for i in range(open_brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        raise SystemExit("Could not brace-match the dealer map literal.")

    literal = src[open_brace:end + 1]
    literal = re.sub(r"([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)", r'\1"\2"\3', literal)  # quote bare keys
    literal = re.sub(r",(\s*[}\]])", r"\1", literal)                              # strip trailing commas
    return json.loads(literal)


def main() -> None:
    commit = "--commit" in sys.argv
    by_oem = parse_dealer_map(TSX)

    rows = []
    for oem, states in by_oem.items():
        for state, names in states.items():
            for name in names:
                rows.append({"oem": oem, "state": state, "name": name})

    print(f"Parsed {TSX}")
    for oem, states in sorted(by_oem.items()):
        n = sum(len(v) for v in states.values())
        print(f"  {oem:<10} {n:>5} dealers across {len(states):>2} states")
    print(f"  {'TOTAL':<10} {len(rows):>5} dealers")

    if not commit:
        print("\nDry run — nothing written. Re-run with --commit to insert.")
        return

    db = SessionLocal()
    try:
        before = db.execute(text("SELECT COUNT(*) FROM oe_dealerships")).scalar()
        db.execute(text("""
            INSERT INTO oe_dealerships (oem, state, name, source)
            VALUES (:oem, :state, :name, 'seed')
            ON CONFLICT (oem, state, UPPER(name)) DO NOTHING
        """), rows)
        db.commit()
        after = db.execute(text("SELECT COUNT(*) FROM oe_dealerships")).scalar()
    finally:
        db.close()

    print(f"\nInserted {after - before} new row(s). "
          f"Table now holds {after} (was {before}).")


if __name__ == "__main__":
    main()

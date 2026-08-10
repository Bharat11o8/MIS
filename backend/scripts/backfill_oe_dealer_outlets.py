"""
Backfill dealer OUTLET identity into `oe_dealerships` from the OE team's own
dealer file (see migrate_phase18_oe_dealer_outlets.sql for the why).

The file's identity block — DEALER NAME | DEALER CITY | STATES | SALES PERSON |
CODE — is the authority for which outlets exist and what they are called. Our
master already holds every one of the names (334/334 for MSIL); what it lacks is
the CITY that separates two outlets of the same group, plus the assigned rep and
the OEM's dealer codes.

STATE IS NOT TAKEN FROM THE FILE. The master's state values are the geo API's
spellings on purpose — the form's State dropdown is fed by that same API
(VisitLogFormPage.tsx, GEO_STATES_URL), so a dealer whose state does not match
it letter-for-letter simply vanishes from the dropdown. The file disagrees in
two ways that would both do damage:
  • spelling — "Andman & Nicobar" vs "Andaman and Nicobar Islands";
  • meaning — its STATES column is really a sales region, so GHAZIABAD and
    NOIDA are filed under DELHI NCR when they are genuinely Uttar Pradesh.
So the file is authoritative for name / city / rep / codes, and the master stays
authoritative for state. Where a new outlet row needs a state, we take it from
the other master rows of the same dealer, falling back to a file-state → master-
state map learned from the dealers that pair 1:1.

What this does, per (oem, normalised name):
  • pairs the file's outlets against the master rows we already have, preferring
    a state match so a multi-state group keeps each outlet in the right state;
  • UPDATEs a paired master row with city / salesperson / dealer_codes, keeping
    its id so every visit log, and anything else already pointing at it,
    survives;
  • INSERTs the outlets that have no master row left to pair with (the extra
    cities of a multi-city group);
  • leaves master rows the file does not mention completely alone — reps add
    dealers through the form and those must keep working. They are reported, not
    touched.

Run with --apply to write; without it, nothing is committed.

    python -m scripts.backfill_oe_dealer_outlets --file "<path.xlsx>" --oem MSIL
    python -m scripts.backfill_oe_dealer_outlets --file "<path.xlsx>" --oem MSIL --apply
"""
import argparse
import collections
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import openpyxl
from sqlalchemy import text

from database import SessionLocal
from services.oe_network_sync import normalize_state

# Identity columns we read. Everything else in the file (monthly sales, targets)
# is ingested separately — this script only establishes who the dealers are.
COL_NAME, COL_CITY, COL_STATE, COL_SP, COL_CODE = (
    "DEALER NAME", "DEALER CITY", "STATES", "SALES PERSON", "CODE")

# Trade words that carry no identity. Dropped only for MATCHING against the
# master; the file's spelling is what we store.
_NOISE = re.compile(r"\b(PVT|PRIVATE|LTD|LIMITED|LLP|CO|COMPANY|AND|THE)\b")


def norm_name(s: str) -> str:
    s = _NOISE.sub(" ", (s or "").upper())
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]", " ", s)).strip()


def norm_city(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").upper()).strip()


def read_outlets(path: str, tab: str) -> list[dict]:
    """One dict per outlet row, exact duplicates merged (their codes unioned).

    The file ends with grand-total rows carrying no dealer name; skipping rows
    with a blank name drops them without having to know how many there are.
    """
    ws = openpyxl.load_workbook(path, data_only=True)[tab]
    rows = list(ws.iter_rows(values_only=True))
    hdr = [str(h).strip().upper() if h is not None else "" for h in rows[0]]
    for c in (COL_NAME, COL_CITY, COL_STATE):
        if c not in hdr:
            raise SystemExit(f"'{tab}' has no {c} column — headers: {hdr[:8]}")
    ix = {c: hdr.index(c) for c in (COL_NAME, COL_CITY, COL_STATE, COL_SP, COL_CODE)
          if c in hdr}

    merged: dict[tuple, dict] = {}
    for r in rows[1:]:
        name = str(r[ix[COL_NAME]] or "").strip()
        if not name:
            continue
        city = str(r[ix[COL_CITY]] or "").strip()
        out = {
            "name": name,
            "city": city,
            "state": normalize_state(str(r[ix[COL_STATE]] or "").strip()),
            "salesperson": str(r[ix[COL_SP]] or "").strip() if COL_SP in ix else "",
            "codes": str(r[ix[COL_CODE]] or "").strip() if COL_CODE in ix else "",
        }
        key = (norm_name(name), norm_city(city))
        if key in merged:
            # Same outlet listed twice (BHANDARI / KOLKATA). One dealer, so
            # keep one row and union the code lists rather than lose either.
            prev = merged[key]
            codes = [c.strip() for c in f"{prev['codes']},{out['codes']}".split(",") if c.strip()]
            prev["codes"] = ", ".join(dict.fromkeys(codes))
        else:
            merged[key] = out
    return list(merged.values())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--oem", required=True, help="OEM these outlets belong to, e.g. MSIL")
    ap.add_argument("--tab", help="worksheet name (defaults to --oem)")
    ap.add_argument("--apply", action="store_true", help="commit; otherwise dry run")
    args = ap.parse_args()

    outlets = read_outlets(args.file, args.tab or args.oem)
    by_name = collections.defaultdict(list)
    for o in outlets:
        by_name[norm_name(o["name"])].append(o)
    print(f"file: {len(outlets)} outlets / {len(by_name)} names")

    db = SessionLocal()
    master = db.execute(text("""
        SELECT id, name, state, city, source FROM oe_dealerships
        WHERE UPPER(oem) = UPPER(:oem) AND is_active
        ORDER BY name, state
    """), {"oem": args.oem}).mappings().all()
    m_by_name = collections.defaultdict(list)
    for m in master:
        m_by_name[norm_name(m["name"])].append(dict(m))
    print(f"master: {len(master)} rows / {len(m_by_name)} names\n")

    # Learn file-state → master-state from the dealers that pair unambiguously
    # (one master row, one outlet). Those are the rows where the two sides
    # can only be talking about the same place, so the pairing is evidence.
    votes: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for key, outs in by_name.items():
        pool = m_by_name.get(key, [])
        if len(outs) == 1 and len(pool) == 1:
            votes[outs[0]["state"]][pool[0]["state"]] += 1
    state_map = {k: c.most_common(1)[0][0] for k, c in votes.items()}
    print("file-state -> master-state (learned from 1:1 dealers):")
    for k, v in sorted(state_map.items()):
        if k != v:
            print(f"     {k:<22} -> {v}")

    def state_for(outlet: dict, siblings: list[dict]) -> str:
        """Which state a NEW outlet row belongs in. The other master rows of the
        same dealer are the best evidence; the learned map is the fallback."""
        seen = {m["state"] for m in siblings}
        if len(seen) == 1:
            return seen.pop()
        return state_map.get(outlet["state"], outlet["state"])

    updates, inserts = [], []
    for key, outs in by_name.items():
        siblings = list(m_by_name.get(key, []))
        pool = list(siblings)
        # State first, so a multi-state group (AKANKSHA AUTOMOBILES is in both
        # Uttar Pradesh and Uttarakhand) keeps each outlet on the right row.
        for o in outs:
            want = state_map.get(o["state"], o["state"])
            hit = next((m for m in pool if m["state"] == want), None)
            if hit:
                pool.remove(hit)
                updates.append((hit, o))
            else:
                o["_pending"] = True
        for o in [x for x in outs if x.pop("_pending", False)]:
            if pool:
                updates.append((pool.pop(0), o))
            else:
                o["state"] = state_for(o, siblings)
                inserts.append(o)

    unmatched = [m for k, ms in m_by_name.items() if k not in by_name for m in ms]

    print(f"\nUPDATE existing rows : {len(updates)}  (state left as-is)")
    print(f"\nINSERT new outlet rows: {len(inserts)}")
    for o in inserts[:12]:
        print(f"     {o['name'][:34]:<34} {o['city']:<16} {o['state']}")
    if len(inserts) > 12:
        print(f"     ... and {len(inserts) - 12} more")
    print(f"\nmaster rows the file does not mention (left untouched): {len(unmatched)}")
    for m in unmatched:
        print(f"     {m['name'][:34]:<34} {str(m['state'])[:16]:<16} source={m['source']}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        db.close()
        return

    for m, o in updates:
        db.execute(text("""
            UPDATE oe_dealerships
               SET city = :city, name = :name,
                   salesperson = NULLIF(:sp, ''), dealer_codes = NULLIF(:codes, ''),
                   updated_at = NOW()
             WHERE id = :id
        """), {"id": m["id"], "city": o["city"],
               "name": o["name"], "sp": o["salesperson"], "codes": o["codes"]})
    for o in inserts:
        db.execute(text("""
            INSERT INTO oe_dealerships (oem, state, city, name, salesperson,
                                        dealer_codes, source)
            VALUES (:oem, :state, :city, :name, NULLIF(:sp, ''), NULLIF(:codes, ''), 'oe_file')
            ON CONFLICT (oem, state, UPPER(name), UPPER(COALESCE(city, ''))) DO NOTHING
        """), {"oem": args.oem, "state": o["state"], "city": o["city"],
               "name": o["name"], "sp": o["salesperson"], "codes": o["codes"]})
    db.commit()

    n = db.execute(text("""
        SELECT COUNT(*) FROM oe_dealerships
        WHERE UPPER(oem) = UPPER(:oem) AND COALESCE(city, '') <> ''
    """), {"oem": args.oem}).scalar()
    print(f"\nAPPLIED. {args.oem} rows now carrying a city: {n}")
    db.close()


if __name__ == "__main__":
    main()

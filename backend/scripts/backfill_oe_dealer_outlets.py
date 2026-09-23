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
  • FOLDS the per-code rows of a dealership the file now lists on one row
    ("3008040, 300B910") into the row that dealership keeps: its visit logs
    move across, the row is deleted, and its sales and targets go with it for
    the next sync to rewrite onto the dealership. Only rows whose code the file
    lists — a code is the one piece of evidence that two rows are one outlet;
  • leaves master rows the file does not mention completely alone — reps add
    dealers through the form and those must keep working. They are reported, not
    touched.

ROW GRAIN differs between the tabs. MSIL merges every dealer code a group holds
in one city onto ONE row, so its outlet is name + city. TATA lists one row PER
CODE and gives each its own quarter target, so there the code is part of
identity; read on the wrong grain, 43 name+city pairs fold into one and 55
outlets vanish. It is read off the tab's own headers by `classify_columns`
(services/oe_dealer_data_sync.py) — the same call the DATA parser keys its rows
with, so the two cannot disagree about who exists. It used to be a --per-code
flag you had to remember to pass, which is a thing you can get wrong quietly.
Since Sep 2026 TATA lists one row per dealership with its codes in one cell;
`keyed_by_code` sees the multi-code cells and reads it as name + city.

SOURCE is the registered dealer_data sheet — the same rows the sync reads, and
the only thing this script will read. It deliberately cannot be pointed at a
downloaded .xlsx: the OE team edits the sheet in place, so a copy saved last
week does not contain the outlet that is breaking today's sync, and a run
against it pairs last week's dealers, prints a clean result, and leaves the sync
failing on exactly the rows the copy predates. (An emailed copy is loaded by
load_dealer_data_file.py, which is a different job — that one writes sales.)

Run with --apply to write; without it, nothing is committed.

    python -m scripts.backfill_oe_dealer_outlets --oem MSIL
    python -m scripts.backfill_oe_dealer_outlets --oem TATA --apply
"""
import argparse
import collections
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text

from database import SessionLocal
from routers.oe_network import MODULE_DD
from services.oe_dealer_data_sync import (
    REQUIRED_HEADERS, classify_columns, keyed_by_code, split_codes,
)
from services.oe_network_sync import (
    _fetch_all_grids, _find_header_row, _norm_header, normalize_state,
)

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


def _code(v) -> str:
    """A dealer code as text. Sheets and openpyxl hand back whole-number codes
    as numbers (3007720) and alphanumeric ones as strings (300B350); left alone
    the first kind keys as '3007720.0' and never matches."""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v or "").strip()


def _cell(row, i: int):
    """A cell by column index, tolerating a short row.

    The Sheets API truncates each row at its last non-empty cell, so a dealer
    with no CODE yet comes back shorter than the header and indexing it blindly
    raises. openpyxl pads instead, which is why the .xlsx path never hit this.
    """
    return row[i] if i is not None and i < len(row) else None


def pair_outlets(outs: list[dict], siblings: list[dict],
                 state_map: dict) -> tuple[list[tuple], list[dict]]:
    """Pair one dealer group's file outlets against its master rows.

    Returns ([(master_row, outlet), …], outlets_with_no_row_left). Each master
    row is claimed at most once, so the paired rows' resulting identities are
    distinct — which is what lets the caller write them all.

    The passes are ordered by how much identity each match preserves, because a
    master row's id is what its visit logs and monthly sales point at. Moving a
    row to a different outlet does not lose the history, it REATTRIBUTES it.
    """
    pool = list(siblings)
    matched, pending = [], []

    # CODE first. A row that already carries this outlet's code IS this outlet:
    # oe_dealer_monthly rows were written against that id under that code, so
    # pairing the code elsewhere moves a dealer's sales to a sibling. It also
    # keeps a re-run still: with codes honoured, a second run pairs everything
    # exactly as the first did and has nothing to change.
    #
    # Skipping this pass is what made --apply die on a unique violation. Blind
    # to the code, the city pass below paired ANANYA AUTO AGENCY's two PATNA
    # rows in file order and swapped 300C002 with 3007180 — a swap the final
    # state permits but no single UPDATE in it does, because the row holding a
    # code is still holding it when the other row tries to take it.
    for o in outs:
        if not o["code"]:
            pending.append(o)
            continue
        hit = next((m for m in pool
                    if (m.get("dealer_code") or "").upper() == o["code"].upper()), None)
        if hit:
            pool.remove(hit)
            matched.append((hit, o))
        else:
            pending.append(o)

    # A dealership row lists every code it holds, and the master may still hold
    # one row per code from when the tab was cut that way. The row to keep is
    # one of those: the one in the dealership's own city, else the lowest code —
    # the anchor dealer_resolve already sends a group's contacts to, so the
    # visits resolved there stay where they are. The others are folded in by
    # absorbed_siblings.
    by_list = []
    for o in pending:
        listed = {c.upper() for c in split_codes(o["codes"])} if not o["code"] else set()
        hits = [m for m in pool if (m.get("dealer_code") or "").upper() in listed]
        if hits:
            hit = min(hits, key=lambda m: (norm_city(m["city"]) != norm_city(o["city"]),
                                           (m.get("dealer_code") or "").upper()))
            pool.remove(hit)
            matched.append((hit, o))
        else:
            by_list.append(o)
    pending = by_list

    # CITY next, then state. Pairing on state alone is only safe the FIRST time
    # this runs, when no master row has a city yet; once they do, a multi-city
    # group in ONE state pairs arbitrarily and silently rotates its outlets
    # between cities — SEVEN AUTOCORP's BASTI row becomes LUCKNOW and LUCKNOW
    # becomes BASTI. The Dealers tab groups contacts by (oem, name, CITY)
    # (_DEALER_AGG_SQL), so moving a row to another city moves its visit history
    # to another dealership. Re-running used to relabel 122 rows and carry 192
    # visit logs with them.
    rest = []
    for o in pending:
        want = state_map.get(o["state"], o["state"])
        hit = next((m for m in pool if m["state"] == want
                    and norm_city(m["city"]) == norm_city(o["city"])), None)
        if hit:
            pool.remove(hit)
            matched.append((hit, o))
        else:
            rest.append(o)
    # The same city under a different state: the master's state wins (the
    # file's is a sales region), so the city is the stronger signal here.
    stateless = []
    for o in rest:
        hit = next((m for m in pool if norm_city(m["city"]) == norm_city(o["city"])), None)
        if hit:
            pool.remove(hit)
            matched.append((hit, o))
        else:
            stateless.append(o)
    # Only now by state, and only onto a row that does not already name a city —
    # a row that names one is some other outlet of this group. Multi-state
    # groups (AKANKSHA AUTOMOBILES spans Uttar Pradesh and Uttarakhand) still
    # land on the right row here.
    spare = []
    for o in stateless:
        want = state_map.get(o["state"], o["state"])
        hit = next((m for m in pool if m["state"] == want and not norm_city(m["city"])), None)
        if hit:
            pool.remove(hit)
            matched.append((hit, o))
        else:
            spare.append(o)
    unpaired = []
    for o in spare:
        hit = next((m for m in pool if not norm_city(m["city"])), None)
        if hit:
            pool.remove(hit)
            matched.append((hit, o))
        else:
            unpaired.append(o)
    return matched, unpaired


def absorbed_siblings(matched: list[tuple], siblings: list[dict]) -> list[tuple[dict, dict]]:
    """[(master_row, row_it_folds_into)] — the per-code rows a dealership row
    now speaks for.

    Only a row whose code the file lists against a paired dealership, and only
    where that outlet is a whole dealership (no identity code of its own). A
    row the file does not name — one a rep added through the form — is not
    evidence of anything and is left alone, as it always has been.
    """
    kept = {m["id"] for m, _o in matched}
    out = []
    for m in siblings:
        mc = (m.get("dealer_code") or "").upper()
        if m["id"] in kept or not mc:
            continue
        for keeper, o in matched:
            if not o["code"] and mc in {c.upper() for c in split_codes(o["codes"])}:
                out.append((m, keeper))
                break
    return out


def outlets_from_grid(grid: list, tab: str) -> list[dict]:
    """One dict per outlet row, exact duplicates merged (their codes unioned).

    The header row is located with `_find_header_row` and the SAME required
    headers the DATA parser uses, not assumed to be row 0 — so both readers
    start the dealers on the same row even when the tab opens with a title.

    The grain comes from `classify_columns`: on a code-keyed tab the dealer CODE
    joins the key, so two codes of one dealership in one city stay two outlets
    instead of being merged into one. Derived, never passed in — see the note on
    ROW GRAIN above.

    The file ends with grand-total rows carrying no dealer name; skipping rows
    with a blank name drops them without having to know how many there are.
    """
    header = _find_header_row(grid, REQUIRED_HEADERS)
    if header is None:
        seen = [_norm_header(v) for v in (grid[0] if grid else [])][:8]
        raise SystemExit(f"'{tab}' has no {'/'.join(sorted(REQUIRED_HEADERS))} header row "
                         f"— first row reads: {seen}")
    h_row, cols = header
    if COL_STATE not in cols:
        # The parser can live without it; this script cannot place a new outlet
        # without a state to fall back on when its siblings disagree.
        raise SystemExit(f"'{tab}' has no {COL_STATE} column — headers: {sorted(cols)[:8]}")
    rows = grid[h_row + 1:]
    shape = classify_columns(cols, _norm_header(tab))
    per_code = keyed_by_code(shape, (_cell(r, cols.get(COL_CODE)) for r in rows))
    print(f"'{tab}': outlets are keyed by "
          + ("NAME + CITY + CODE (one row per code)" if per_code
             else "NAME + CITY (one row per dealership)"))
    ix = {c: cols[c] for c in (COL_NAME, COL_CITY, COL_STATE, COL_SP, COL_CODE)
          if c in cols}

    # A per-code tab carries a few blank-CODE rows repeating a name+city that is
    # already listed WITH a code, all figures zero — padding left behind by
    # editing (KEY MOTOR / BANGALORE appears three extra times). The DATA parser
    # drops them (services/oe_dealer_data_sync.py), so this script must too, or
    # it creates outlets the sync never writes a sale to: phantoms that show up
    # as "assigned, never contacted" and quietly lower every coverage figure.
    # A blank-CODE row whose name+city appears nowhere else is a different
    # thing — a real outlet not yet coded — and is kept.
    coded_keys = set()
    if per_code and COL_CODE in ix:
        for r in rows:
            nm = str(_cell(r, ix[COL_NAME]) or "").strip()
            if nm and _code(_cell(r, ix[COL_CODE])):
                coded_keys.add((norm_name(nm),
                                norm_city(str(_cell(r, ix[COL_CITY]) or "").strip())))

    merged: dict[tuple, dict] = {}
    skipped_padding = 0
    for r in rows:
        name = str(_cell(r, ix[COL_NAME]) or "").strip()
        if not name:
            continue
        city = str(_cell(r, ix[COL_CITY]) or "").strip()
        if per_code and COL_CODE in ix and not _code(_cell(r, ix[COL_CODE])) \
                and (norm_name(name), norm_city(city)) in coded_keys:
            skipped_padding += 1
            continue
        code = _code(_cell(r, ix[COL_CODE])) if COL_CODE in ix else ""
        out = {
            "name": name,
            "city": city,
            "state": normalize_state(str(_cell(r, ix[COL_STATE]) or "").strip()),
            "salesperson": str(_cell(r, ix[COL_SP]) or "").strip() if COL_SP in ix else "",
            "codes": ", ".join(split_codes(code)),
            # Identity only where the tab is keyed that way; NULL elsewhere, so
            # those outlets key exactly as they do today.
            "code": code if per_code else "",
        }
        key = (norm_name(name), norm_city(city), out["code"])
        if key in merged:
            # Same outlet listed twice (BHANDARI / KOLKATA). One dealer, so
            # keep one row and union the code lists rather than lose either.
            prev = merged[key]
            codes = [c.strip() for c in f"{prev['codes']},{out['codes']}".split(",") if c.strip()]
            prev["codes"] = ", ".join(dict.fromkeys(codes))
        else:
            merged[key] = out
    if skipped_padding:
        print(f"skipped {skipped_padding} blank-CODE padding row(s) that repeat a coded dealer")
    return list(merged.values())


def fetch_outlets(sheet_id: str, tab: str) -> list[dict]:
    """Outlets from the live sheet — the same rows the sync will read."""
    grids = _fetch_all_grids(sheet_id)
    if tab not in grids:
        raise SystemExit(f"no tab named '{tab}' in the sheet — tabs: {list(grids)}")
    return outlets_from_grid(grids[tab], tab)


def dealer_sheet_id(db) -> str:
    """The registered dealer file, so the usual run needs no id pasted in.

    MODULE_DD rather than a literal: the module name is the registry's key for
    this file (routers/oe_network.py), and it is what the sync resolves too.
    """
    rows = db.execute(text("""
        SELECT sheet_id, label FROM sheet_sources
        WHERE module = :m ORDER BY created_at DESC
    """), {"m": MODULE_DD}).mappings().all()
    if len(rows) != 1:
        raise SystemExit(
            f"{len(rows)} dealer files registered — pass --sheet-id to say which: "
            + ", ".join(f"{r['label']} ({r['sheet_id']})" for r in rows))
    print(f"source: registered sheet '{rows[0]['label']}' ({rows[0]['sheet_id']})")
    return rows[0]["sheet_id"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet-id", help="read this sheet instead of the registered "
                                       "dealer_data source")
    ap.add_argument("--oem", required=True, help="OEM these outlets belong to, e.g. MSIL")
    ap.add_argument("--tab", help="worksheet name (defaults to --oem)")
    ap.add_argument("--apply", action="store_true", help="commit; otherwise dry run")
    args = ap.parse_args()

    db = SessionLocal()
    tab = args.tab or args.oem
    outlets = fetch_outlets(args.sheet_id or dealer_sheet_id(db), tab)
    by_name = collections.defaultdict(list)
    for o in outlets:
        by_name[norm_name(o["name"])].append(o)
    print(f"file: {len(outlets)} outlets / {len(by_name)} names")

    master = db.execute(text("""
        SELECT id, name, state, city, dealer_code, source FROM oe_dealerships
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

    updates, inserts, absorbed, leftover = [], [], [], []
    for key, outs in by_name.items():
        siblings = list(m_by_name.get(key, []))
        paired, spare = pair_outlets(outs, siblings, state_map)
        updates.extend(paired)
        folded = absorbed_siblings(paired, siblings)
        absorbed.extend(folded)
        gone = {m["id"] for m, _k in paired} | {m["id"] for m, _k in folded}
        leftover.extend(m for m in siblings if m["id"] not in gone)
        for o in spare:
            o["state"] = state_for(o, siblings)
            inserts.append(o)

    unmatched = [m for k, ms in m_by_name.items() if k not in by_name for m in ms]
    n_visits = 0
    if absorbed:
        n_visits = db.execute(text("""
            SELECT COUNT(*) FROM oe_visit_logs WHERE dealer_id = ANY(CAST(:ids AS uuid[]))
        """), {"ids": [str(m["id"]) for m, _k in absorbed]}).scalar()

    print(f"\nUPDATE existing rows : {len(updates)}  (state left as-is)")
    print(f"\nINSERT new outlet rows: {len(inserts)}")
    for o in inserts[:12]:
        print(f"     {o['name'][:34]:<34} {o['city']:<16} {o['state']}")
    if len(inserts) > 12:
        print(f"     ... and {len(inserts) - 12} more")
    print(f"\nFOLD per-code rows into their dealership: {len(absorbed)}  "
          f"({n_visits} visit log(s) move with them; their sales and targets are "
          f"dropped and rewritten onto the dealership by the next sync)")
    for m, k in absorbed[:12]:
        print(f"     {m['name'][:34]:<34} {str(m['city'] or '?'):<16} "
              f"{m['dealer_code']:<9} -> {k['city'] or '?'}")
    if len(absorbed) > 12:
        print(f"     ... and {len(absorbed) - 12} more")
    if leftover:
        # A dealership the file still names, with a master row it no longer
        # accounts for: no sale will be written to it again. Not folded, because
        # nothing says which outlet it belongs to — someone has to look.
        print(f"\nmaster rows of a listed dealer that the file no longer accounts for "
              f"(left untouched, will show no figures): {len(leftover)}")
        for m in leftover:
            print(f"     {m['name'][:34]:<34} {str(m['city'] or '?'):<16} "
                  f"code={m['dealer_code'] or '-'} source={m['source']}")
    print(f"\nmaster rows the file does not mention (left untouched): {len(unmatched)}")
    for m in unmatched:
        print(f"     {m['name'][:34]:<34} {str(m['state'])[:16]:<16} source={m['source']}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        db.close()
        return

    # Fold first, so the parking and updates below never meet a row that is
    # about to go. Visits are moved rather than left to ON DELETE SET NULL: a
    # nulled visit drops out of every contact count until the next visit-log
    # sync re-resolves it. Sales and targets cascade away with the row — the
    # next dealer sync deletes and rewrites this whole source anyway, and moving
    # them would collide with the keeper's own month on (dealer_id, month,
    # product).
    for m, k in absorbed:
        db.execute(text("UPDATE oe_visit_logs SET dealer_id = CAST(:keep AS uuid) "
                        "WHERE dealer_id = CAST(:gone AS uuid)"),
                   {"keep": str(k["id"]), "gone": str(m["id"])})
        db.execute(text("DELETE FROM oe_dealerships WHERE id = CAST(:gone AS uuid)"),
                   {"gone": str(m["id"])})

    # Park every row being updated on a dealer_code nothing else can hold, then
    # write the real values. `idx_oe_dealerships_unique_v2` covers (oem, state,
    # name, city, dealer_code) and is a plain unique index, so it cannot be
    # DEFERRED: it is checked row by row, mid-statement, even inside one UPDATE.
    # The end state the pairing produces is always distinct, but a step towards
    # it need not be — if the OE team moves a code from one outlet of a group to
    # another, the row still holding that code makes the other row's UPDATE fail
    # and the whole run dies. The id is already unique, so keying the park on it
    # guarantees no intermediate collides; both statements are in the same
    # transaction, so nothing is ever left parked.
    # The sentinel is the row's position in this batch, not its id: dealer_code
    # is varchar(30) and a uuid does not fit.
    for i in range(0, len(updates), 500):
        chunk = updates[i:i + 500]
        # CAST(...), not a ::uuid suffix — text() does not recognise a bind
        # parameter immediately followed by a colon and leaves it as literal SQL.
        values = ", ".join(f"(CAST(:pid_{n} AS uuid), :pcode_{n})"
                           for n in range(len(chunk)))
        params = {}
        for n, (row, _o) in enumerate(chunk):
            params[f"pid_{n}"] = row["id"]
            params[f"pcode_{n}"] = f"~park{i + n}"
        db.execute(text(f"""
            UPDATE oe_dealerships d SET dealer_code = v.code
              FROM (VALUES {values}) AS v(id, code)
             WHERE d.id = v.id
        """), params)

    # Which master row of a group gets which code is NOT arbitrary — see the
    # code-first pass in pair_outlets. Every existing row keeps its id, so the
    # visit history already pointing at it survives, and keeps the code it had,
    # so the sales written under that code stay with it.
    for m, o in updates:
        db.execute(text("""
            UPDATE oe_dealerships
               SET city = :city, name = :name,
                   salesperson = NULLIF(:sp, ''), dealer_codes = NULLIF(:codes, ''),
                   dealer_code = NULLIF(:code, ''),
                   updated_at = NOW()
             WHERE id = :id
        """), {"id": m["id"], "city": o["city"], "name": o["name"],
               "sp": o["salesperson"], "codes": o["codes"], "code": o["code"]})
    for o in inserts:
        db.execute(text("""
            INSERT INTO oe_dealerships (oem, state, city, name, salesperson,
                                        dealer_code, dealer_codes, source)
            VALUES (:oem, :state, :city, :name, NULLIF(:sp, ''), NULLIF(:code, ''),
                    NULLIF(:codes, ''), 'oe_file')
            ON CONFLICT (oem, state, UPPER(name), UPPER(COALESCE(city, '')),
                         UPPER(COALESCE(dealer_code, ''))) DO NOTHING
        """), {"oem": args.oem, "state": o["state"], "city": o["city"],
               "name": o["name"], "sp": o["salesperson"], "codes": o["codes"],
               "code": o["code"]})
    db.commit()

    n = db.execute(text("""
        SELECT COUNT(*) FROM oe_dealerships
        WHERE UPPER(oem) = UPPER(:oem) AND COALESCE(city, '') <> ''
    """), {"oem": args.oem}).scalar()
    print(f"\nAPPLIED. {args.oem} rows now carrying a city: {n}")
    db.close()


if __name__ == "__main__":
    main()

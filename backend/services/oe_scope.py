"""
AutoForm MIS — OE Network row-level scoping.

A user with `users.oe_salesperson` set sees only that person's rows, on every
OE endpoint. A user with it NULL is unscoped and behaves exactly as before.

Two things make this less trivial than a WHERE clause:

1. **One person, several spellings.** The visit-plan tabs are titled "PANKAJ",
   the log-book form records "PANKAJ VIG", and the dealer master's SALES PERSON
   column says "PANKAJ". `names_match` already existed in routers/oe_network.py
   for exactly this reason and lives here now so the scope and the filters agree
   on what "the same person" means — two names match when they share any token
   of 3+ letters, so an initial ("D" in "D PRASHANTH KUMAR") never matches.

   That test is Python, and it cannot run inside SQL. So the scope resolves the
   canonical name into the *literal spellings present in each table* once per
   request and binds them as `= ANY(:names)`. The distinct-name lists are ~10
   rows per table, so this costs one trivial query per table per request.

2. **It must fail closed.** A scoped name that matches nothing produces `1=0` —
   zero rows — never an unfiltered query. The dangerous bug in a feature like
   this is not "the rep sees too little", it is a mistyped name silently
   degrading to "sees everything", so the empty case is handled explicitly and
   pinned by a test.

The scope also always overrides a client-supplied `?salesperson=`; see
`resolve` in routers/oe_network.py. A scoped rep cannot widen their own view by
editing a query parameter.
"""
import re
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

# The OE tables that carry a salesperson, and the column it is called there.
# Anything scoped must name one of these — a typo'd table would otherwise
# resolve to an empty name list and silently show the rep nothing.
SCOPED_TABLES = {
    "oe_visit_logs": "salesperson",
    "oe_visit_plans": "salesperson",
    "oe_targets": "salesperson",
    "oe_dealerships": "salesperson",
}


def name_tokens(name: Optional[str]) -> set:
    """Words of 3+ letters, upper-cased. Initials are excluded deliberately: a
    single letter matches far too much to be evidence of identity."""
    if not name:
        return set()
    return {t for t in re.split(r"[^A-Za-z]+", name.upper()) if len(t) >= 3}


def names_match(a: Optional[str], b: Optional[str]) -> bool:
    """True when two spellings refer to the same person."""
    return bool(name_tokens(a) & name_tokens(b))


class OEScope:
    """The calling user's OE row-level scope.

    Build one per request via routers.oe_network._scope. `canonical` is None for
    an unscoped user, in which case every method here is a no-op and the
    endpoints behave exactly as they did before this feature.
    """

    def __init__(self, db: Session, canonical: Optional[str]):
        self._db = db
        self.canonical = (canonical or "").strip() or None
        self._cache: dict[str, list[str]] = {}

    @property
    def limited(self) -> bool:
        """True when this user must not see other people's rows."""
        return self.canonical is not None

    def names_in(self, table: str) -> Optional[list[str]]:
        """Every literal spelling of this person in `table`.

        None  → unscoped, apply no filter.
        []    → scoped, but this table knows no such person: show nothing.
        """
        if not self.limited:
            return None
        if table not in SCOPED_TABLES:
            raise ValueError(f"{table!r} has no salesperson column to scope on")
        if table not in self._cache:
            col = SCOPED_TABLES[table]
            rows = self._db.execute(text(
                f"SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL"
            )).fetchall()
            self._cache[table] = [r[0] for r in rows if names_match(r[0], self.canonical)]
        return self._cache[table]

    def apply(self, where: list, params: dict, column: str, table: str,
              key: str = "oe_scope") -> None:
        """Append this user's scope to a WHERE list built for `table`.

        `column` is how the salesperson column is written in *this* query (it
        may be aliased, e.g. "d.salesperson"); `table` is which table's spellings
        to resolve against. `key` only needs overriding when one statement
        scopes two different tables (plan-vs-actual does).
        """
        names = self.names_in(table)
        if names is None:
            return
        if not names:
            # Fail closed. A scoped user whose name matches nothing in this
            # table sees zero rows — never every row.
            where.append("1=0")
            return
        where.append(f"{column} = ANY(:{key})")
        params[key] = names

    def keep(self, rows: list, attr: str = "salesperson") -> list:
        """Scope an already-fetched list of rows, for the endpoints that group
        in Python rather than in SQL (plan-vs-actual, plan-adherence). Matches
        on the name itself, so it needs no per-table resolution."""
        if not self.limited:
            return rows
        return [r for r in rows
                if names_match(getattr(r, attr, None) if not isinstance(r, dict)
                               else r.get(attr), self.canonical)]

    def as_dict(self) -> Optional[dict]:
        """The `scope` block the API returns so the UI can hide the person
        filter and say whose numbers are on screen — inferred from the response,
        never from the client's own idea of who it is."""
        if not self.limited:
            return None
        return {"salesperson": self.canonical}

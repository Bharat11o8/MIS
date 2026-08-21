"""
OE Network row-level scoping.

A user with users.oe_salesperson set must see their own rows and nothing else,
on every OE endpoint. The failure mode worth testing for is not "the rep sees
too little" — that is visible and gets reported. It is a scope that silently
degrades to "sees everything", which looks exactly like working software.

So the cases pinned here are the ones where that could happen: a name that
matches nothing, a name that matches several spellings, an unscoped user, and
the query parameter a rep might try to edit.

No database: OEScope's only query is "the distinct names in this table", so a
stub standing in for the session keeps this a pure-logic test like the rest of
the suite.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.oe_scope import OEScope, name_tokens, names_match  # noqa: E402


class FakeDB:
    """Returns a fixed set of distinct names, and counts how often it is asked."""

    def __init__(self, names):
        self.names = names
        self.queries = 0

    def execute(self, *_args, **_kwargs):
        self.queries += 1
        return self

    def fetchall(self):
        return [(n,) for n in self.names]


LOG_NAMES = ["PANKAJ VIG", "D PRASHANTH KUMAR", "ASHOKA", "UMESH PATIL", "DURGESH"]


# ── Name matching ─────────────────────────────────────────────────────────────

def test_tokens_ignore_initials():
    """A single letter matches far too much to be evidence of identity."""
    assert name_tokens("D PRASHANTH KUMAR") == {"PRASHANTH", "KUMAR"}


@pytest.mark.parametrize("a,b", [
    ("PANKAJ", "PANKAJ VIG"),          # plan tab vs log form
    ("PRASHANTH", "D PRASHANTH KUMAR"),
    ("umesh patil", "UMESH"),          # case is irrelevant
])
def test_same_person_matches(a, b):
    assert names_match(a, b)


@pytest.mark.parametrize("a,b", [
    ("PANKAJ", "DURGESH"),
    ("D PRASHANTH KUMAR", "D DEBASIS"),   # sharing only the initial is not a match
    ("ASHOKA", None),
    (None, None),
])
def test_different_people_do_not_match(a, b):
    assert not names_match(a, b)


# ── Unscoped users are untouched ──────────────────────────────────────────────

def test_unscoped_adds_no_clause():
    db = FakeDB(LOG_NAMES)
    scope = OEScope(db, None)
    where, params = ["1=1"], {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    assert where == ["1=1"]
    assert params == {}
    assert not scope.limited
    assert scope.as_dict() is None
    # An unscoped user must not pay for the feature at all.
    assert db.queries == 0


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_blank_scope_is_no_scope(blank):
    """An empty string in the column must mean 'unscoped', not 'scoped to
    nobody' — otherwise a stray UPDATE blanks a user out of the module."""
    assert not OEScope(FakeDB(LOG_NAMES), blank).limited


# ── Scoped users ──────────────────────────────────────────────────────────────

def test_scope_resolves_every_spelling_of_one_person():
    db = FakeDB(["PANKAJ VIG", "PANKAJ", "DURGESH"])
    scope = OEScope(db, "PANKAJ")
    where, params = ["1=1"], {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    assert where == ["1=1", "salesperson = ANY(:oe_scope)"]
    # Both spellings, so the rep's own rows are not split in half by the scope.
    assert sorted(params["oe_scope"]) == ["PANKAJ", "PANKAJ VIG"]


def test_scope_excludes_everyone_else():
    scope = OEScope(FakeDB(LOG_NAMES), "PANKAJ")
    assert scope.names_in("oe_visit_logs") == ["PANKAJ VIG"]


def test_scope_honours_the_column_alias():
    """The dealer queries alias the table, so the clause must too."""
    scope = OEScope(FakeDB(["ASHOKA"]), "ASHOKA")
    where, params = [], {}
    scope.apply(where, params, "d.salesperson", "oe_dealerships")
    assert where == ["d.salesperson = ANY(:oe_scope)"]


def test_two_tables_in_one_statement_do_not_collide():
    """plan-vs-actual scopes both sides; distinct keys keep the binds apart."""
    scope = OEScope(FakeDB(LOG_NAMES), "UMESH")
    where, params = [], {}
    scope.apply(where, params, "p.salesperson", "oe_visit_plans", key="scope_plan")
    scope.apply(where, params, "l.salesperson", "oe_visit_logs", key="scope_log")
    assert where == ["p.salesperson = ANY(:scope_plan)", "l.salesperson = ANY(:scope_log)"]
    assert set(params) == {"scope_plan", "scope_log"}


def test_names_are_resolved_once_per_table():
    """One trivial query per table per request, not one per WHERE clause."""
    db = FakeDB(LOG_NAMES)
    scope = OEScope(db, "PANKAJ")
    for _ in range(5):
        scope.apply([], {}, "salesperson", "oe_visit_logs")
    assert db.queries == 1


# ── The one that matters: failing closed ──────────────────────────────────────

def test_unmatched_name_shows_nothing_not_everything():
    """A scope naming somebody the table has never heard of yields zero rows.

    This is the whole safety property. If a mistyped or retired name fell
    through as "no clause", the rep would quietly be handed the entire team's
    numbers and nothing would look wrong.
    """
    scope = OEScope(FakeDB(LOG_NAMES), "SOMEBODY ELSE")
    where, params = ["1=1"], {}
    scope.apply(where, params, "salesperson", "oe_visit_logs")
    assert where == ["1=1", "1=0"]
    assert "oe_scope" not in params


def test_empty_table_shows_nothing():
    """A table with no rows yet must not read as 'no restriction'."""
    scope = OEScope(FakeDB([]), "PANKAJ")
    where = []
    scope.apply(where, {}, "salesperson", "oe_targets")
    assert where == ["1=0"]


def test_unknown_table_is_refused_loudly():
    """A typo'd table name would resolve to no names and silently blank the
    rep's screen, so it raises instead."""
    scope = OEScope(FakeDB(LOG_NAMES), "PANKAJ")
    with pytest.raises(ValueError):
        scope.names_in("oe_visit_log")       # missing the plural


def test_scope_block_names_the_person():
    assert OEScope(FakeDB(LOG_NAMES), "PANKAJ VIG").as_dict() == {"salesperson": "PANKAJ VIG"}

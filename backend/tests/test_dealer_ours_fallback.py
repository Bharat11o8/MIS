"""
The "Amato SC Sale" tile is the sum of the column printed underneath it.

A target-only OEM (TATA) has no quarter-achievement column, so our units for a
quarter are summed from its months at read time as `sold`. That sum is NULL —
not 0 — for a dealer whose months touch no quarter at all, which happens
routinely: JAS'26 targets are published before the OND ones, so an October
screen has achievement with no quarter to put it in.

The Dealers tab has always handled that with a fallback to ys_sale (oursOf in
model.ts, pinned by rank.test.ts). The KPI tile did not: the router summed
`d["sold"] or 0`, so the tile read 0 while every row beneath it showed real
units. Two numbers disagreeing on one screen is a support call.

Both sides are pinned here — the Python fallback, and the fact that the
TypeScript it mirrors still says the same thing.
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from routers.oe_network import _ours  # noqa: E402

MODEL_TS = os.path.join(os.path.dirname(__file__), "..", "..",
                        "src", "pages", "oe-network", "dealers", "model.ts")


def test_a_present_sold_is_used_as_is():
    assert _ours({"sold": 120.0, "ys_sale": 40}) == 120.0


def test_an_absent_sold_falls_back_to_the_filtered_months():
    """NULL means "no quarter to sum", not "sold nothing"."""
    assert _ours({"sold": None, "ys_sale": 40}) == 40


def test_a_genuine_zero_is_kept():
    """The whole point of the distinction: 0 is a measurement and must survive.
    A fallback that fired on falsiness rather than on None would report 40 here
    and overstate a dealer who really did sell none inside the quarter."""
    assert _ours({"sold": 0.0, "ys_sale": 40}) == 0.0


def test_the_tile_matches_the_column_it_sums():
    """What the bug actually broke: the tile is the sum of oursOf() per row."""
    dealers = [
        {"sold": 120.0, "ys_sale": 40},   # has a quarter
        {"sold": None, "ys_sale": 40},    # months touch no quarter
        {"sold": 0.0, "ys_sale": 40},     # in a quarter, sold none
    ]
    assert sum(_ours(d) for d in dealers) == 160.0
    # What the router used to compute, kept as the regression marker.
    assert sum(d["sold"] or 0 for d in dealers) == 120.0


def test_the_typescript_still_agrees():
    """_ours mirrors oursOf. A mirror nobody checks is a mirror that drifts, and
    the drift is invisible — both sides keep returning plausible numbers."""
    with open(MODEL_TS, encoding="utf-8") as f:
        src = f.read()
    body = src.split("export const oursOf", 1)[1].split(";", 1)[0]
    assert re.search(r"d\.sold\s*\?\?\s*d\.ys_sale", body), (
        "oursOf no longer falls back from sold to ys_sale; _ours in "
        "routers/oe_network.py mirrors it and must be changed to match")

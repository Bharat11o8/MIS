"""
The dealer file's two shapes, and the places where reading one as the other
produces a plausible-looking wrong answer rather than a crash.

The OE team's dealer workbook now has a tab per OEM in two different formats:

  MSIL   a funnel — TOTAL MSIL <month> / TOTAL YS <month> / YSC <month> —
         seat covers only, with every dealer code a group holds in one city
         merged onto ONE row.
  TATA   target vs achievement, split by product — TGT FOR JAS'26 SC /
         JULY'26 ACH SC / TGT FOR JAS'26 MAT / JULY'26 ACH MAT — with one row
         PER DEALER CODE, each carrying its own target.

Everything here is about a difference that would be invisible on screen if it
were wrong: a mat figure filed as a seat cover, two codes' targets folded into
one, an achievement stored as if it were the dealer's own sales, or a zero
standing in for a figure the OEM does not publish.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.oe_dealer_data_sync import parse_dealer_grids  # noqa: E402

IDENTITY = ["DEALER NAME", "DEALER CITY", "STATES", "SALES PERSON", "CODE"]

TATA_HEADERS = IDENTITY + [
    "TGT FOR JAS'26 SC", "JULY'26 ACH SC",
    "TGT FOR JAS'26 MAT", "JULY'26 ACH MAT",
    "AUG SC", "AUG MAT",
]
MSIL_HEADERS = IDENTITY + [
    "TOTAL MSIL JAN'26", "TOTAL YS JAN'26", "TOTAL MSIL",
    "YSC JAN'26", "YSC TOTAL", "AVG PENE",
    "AMJ'26 TGT", "AMJ'26 ACH", "JAS'26 TGT", "AUG'26 (VISIT)",
]


def tata(*rows):
    return parse_dealer_grids({"TATA": [TATA_HEADERS, *rows]})


def msil(*rows):
    return parse_dealer_grids({"MSIL": [MSIL_HEADERS, *rows]})


def by_key(records):
    return {(r["name"], r["city"], r["dealer_code"]): r for r in records}


def monthly(rec, product):
    return [m for m in rec["monthly"] if m["product"] == product]


# ── The TATA shape ────────────────────────────────────────────────────────────

def test_achievement_lands_on_the_right_product_and_only_as_our_sale():
    """The ACH columns are OUR units, per product — the same quantity MSIL's YSC
    carries. Filing the mat figure as a seat cover, or either as the dealer's own
    volume, would both read as a normal number on every screen."""
    recs, _, _ = tata(["ADISHAKTI CARS", "BANGALORE", "KARNATAKA", "ASHOKA",
                       3007720, 329, 88, 113, 5, None, None])
    rec, = recs
    sc, = monthly(rec, "SC")
    mat, = monthly(rec, "MAT")
    assert (sc["month"], sc["ys_sale"]) == (date(2026, 7, 1), 88)
    assert (mat["month"], mat["ys_sale"]) == (date(2026, 7, 1), 5)
    # NOT zero. This OEM publishes no total-sold and no addressable figure, and a
    # 0 would report a dealer as having sold nothing and make every ratio false.
    for m in rec["monthly"]:
        assert m.get("oem_total") is None and m.get("ysasc") is None


def test_quarter_target_is_per_product_and_carries_no_achievement():
    """TATA sets a target per product and reports results only per month, so the
    quarter achievement is derived at read time — never stored, or the two could
    disagree."""
    recs, _, _ = tata(["ADISHAKTI CARS", "BANGALORE", "KARNATAKA", "ASHOKA",
                       3007720, 329, 88, 113, 5, None, None])
    targets = {t["product"]: t for t in recs[0]["targets"]}
    assert targets["SC"]["target"] == 329
    assert targets["MAT"]["target"] == 113
    for t in targets.values():
        assert t["achievement"] is None
        assert t["quarter"] == "Q2" and t["fy_year"] == 2026
        assert (t["period_start"], t["period_end"]) == (date(2026, 7, 1), date(2026, 9, 30))


def test_two_codes_in_one_city_stay_two_outlets():
    """ANANYA AUTO AGENCY / PATNA is two codes with two targets the team set
    separately. Merging them on name+city — which is right for MSIL — would fold
    94 and 452 into one 546 nobody agreed to."""
    recs, _, errors = tata(
        ["ANANYA AUTO AGENCY PVT LTD", "PATNA", "BIHAR", "DEBASIS", "300C002", 94, 10, 0, 0, None, None],
        ["ANANYA AUTO AGENCY PVT LTD", "PATNA", "BIHAR", "DEBASIS", 3007180, 452, 40, 0, 0, None, None],
    )
    assert len(recs) == 2
    keys = by_key(recs)
    assert keys[("ANANYA AUTO AGENCY PVT LTD", "PATNA", "300C002")]["targets"][1]["target"] == 94
    assert keys[("ANANYA AUTO AGENCY PVT LTD", "PATNA", "3007180")]["targets"][1]["target"] == 452
    # Two codes are not a duplicate, so nothing is reported.
    assert not errors


def test_a_repeated_code_is_a_duplicate_and_is_summed():
    """Same outlet, same code, twice — that IS one dealer listed twice, and the
    rows are added rather than one silently winning."""
    recs, _, errors = tata(
        ["KHT AGENCIES", "BANGALORE", "KARNATAKA", "ASHOKA", "3002710", 100, 10, 5, 1, None, None],
        ["KHT AGENCIES", "BANGALORE", "KARNATAKA", "ASHOKA", "3002710", 20, 3, 5, 1, None, None],
    )
    rec, = recs
    assert monthly(rec, "SC")[0]["ys_sale"] == 13
    assert {t["product"]: t["target"] for t in rec["targets"]} == {"SC": 120, "MAT": 10}
    assert any("listed more than once" in e for e in errors)


def test_whole_number_codes_do_not_key_as_floats():
    """Sheets hands back 3007720 as a number. Left alone it stringifies as
    '3007720.0' one sync and '3007720' the next, and the outlet is recreated
    every time — with its sales history stranded on the old row."""
    recs, _, _ = tata(["AUTO MATRIX", "MANGALORE", "KARNATAKA", "ASHOKA",
                       3009550.0, 438, 73, 45, 4, None, None])
    assert recs[0]["dealer_code"] == "3009550"


def test_blank_code_padding_rows_are_dropped_but_real_new_outlets_are_kept():
    """KEY MOTOR / BANGALORE appears three extra times with no code and no
    figures — leftover blank rows. A blank-code row for a name+city that appears
    nowhere else is a different thing: a real outlet not yet coded."""
    recs, _, errors = tata(
        ["KEY MOTOR", "BANGALORE", "KARNATAKA", "ASHOKA", "3007560", 434, 130, 177, 27, None, None],
        ["KEY MOTOR", "BANGALORE", "KARNATAKA", "ASHOKA", None, None, 0, None, 0, None, None],
        ["GUARD TATA", "DWARKA", "DELHI", "PANKAJ", None, None, 0, None, 0, None, None],
    )
    names = sorted((r["name"], r["dealer_code"]) for r in recs)
    assert names == [("GUARD TATA", None), ("KEY MOTOR", "3007560")]
    assert any("leftover blank rows" in e for e in errors)


def test_a_placeholder_month_column_with_figures_is_reported_not_dropped():
    """'AUG SC' has no year, so the month cannot be placed. Empty it is harmless.
    Filled it is a month of real sales, and reading it as anything would be a
    guess — so it is refused loudly instead of silently vanishing."""
    _, _, quiet = tata(["A DEALER", "PUNE", "MAHARASHTRA", "UMESH", "1", 10, 5, 0, 0, None, None])
    assert not [e for e in quiet if "AUG SC" in e]

    _, _, loud = tata(["A DEALER", "PUNE", "MAHARASHTRA", "UMESH", "1", 10, 5, 0, 0, 44, None])
    assert any("AUG SC" in e and "no year" in e for e in loud)


# ── The MSIL shape is untouched by all of the above ───────────────────────────

def test_funnel_tab_still_parses_as_seat_covers_on_one_outlet_per_city():
    """The funnel tab merges every code onto one outlet row, so the code is
    reference data there and must NOT become identity — doing so would split
    MY CAR PUNE into four dealerships overnight."""
    recs, _, _ = msil(["MY CAR", "PUNE", "MAHARASHTRA", "PANKAJ", "1907, 19NA",
                       975, 178, 975, 64, 64, 6.5, 136, 56, 201, None])
    rec, = recs
    assert rec["dealer_code"] is None          # not part of identity here
    assert rec["dealer_codes"] == "1907, 19NA"
    m, = rec["monthly"]
    assert m["product"] == "SC"
    assert (m["oem_total"], m["ysasc"], m["ys_sale"]) == (975, 178, 64)
    q1, q2 = rec["targets"]
    assert (q1["quarter"], q1["target"], q1["achievement"]) == ("Q1", 136, 56)
    assert (q2["quarter"], q2["target"], q2["achievement"]) == ("Q2", 201, None)
    assert {t["product"] for t in rec["targets"]} == {"SC"}


def test_funnel_tab_merges_a_repeated_outlet_on_name_and_city():
    """BHANDARI / KOLKATA is on two rows of the real file. Without the code in
    the key they are one outlet, and the volumes add."""
    recs, _, errors = msil(
        ["BHANDARI", "KOLKATA", "WEST BENGAL", "DEBASIS", "111", 100, 50, 100, 10, 10, 10, 0, 0, 0, None],
        ["BHANDARI", "KOLKATA", "WEST BENGAL", "DEBASIS", "222", 40, 20, 40, 5, 5, 12, 0, 0, 0, None],
    )
    rec, = recs
    m, = rec["monthly"]
    assert (m["oem_total"], m["ysasc"], m["ys_sale"]) == (140, 70, 15)
    assert rec["dealer_codes"] == "111, 222"
    assert any("listed more than once" in e for e in errors)


def test_the_funnel_must_narrow():
    """A month where the addressable figure exceeds the total, or where we sold
    more than was addressable, is a broken source column — the check that caught
    TOTAL MSIL MAR'26 being a copy of February on 401 of 404 rows."""
    _, _, errors = msil(["ODD ONE", "DELHI", "DELHI", "PANKAJ", "1",
                         100, 150, 100, 10, 10, 10, 0, 0, 0, None])
    assert any("cannot exceed the total" in e for e in errors)

    _, _, errors = msil(["ODD TWO", "DELHI", "DELHI", "PANKAJ", "1",
                         100, 50, 100, 80, 80, 80, 0, 0, 0, None])
    assert any("more than was addressable" in e for e in errors)


def test_a_tab_with_neither_shape_is_skipped_with_a_reason():
    """Silently skipping a tab is how a whole OEM goes missing without anyone
    noticing; the headers it did find go in the message so it can be fixed."""
    recs, skipped, errors = parse_dealer_grids(
        {"HYUNDAI": [IDENTITY + ["SOMETHING ELSE"],
                     ["A DEALER", "PUNE", "MAHARASHTRA", "UMESH", "1", 5]]})
    assert recs == [] and skipped == ["HYUNDAI"]
    assert any("no month or target columns recognised" in e for e in errors)


# ── Target precision ──────────────────────────────────────────────────────────

def test_quarterly_target_keeps_the_sheet_s_fraction():
    """A dealer's target is a share of an OEM total, so it is not a whole number.

    Storing it rounded is what put the MSIL JAS'26 total 27 units under the
    sheet's own figure: 403 dealers each rounded, then added up, is a different
    number from added up and rounded once. The parser must hand back exactly
    what the cell holds and leave the rounding to the last moment.
    """
    recs, _, _ = msil(
        ["A M MOTORS", "MALAPPURAM", "KERALA", "ASHOKA", "E6NA",
         975, 178, 975, 64, 64, 0.18, 32.76036, 30, 48.177, None],
    )
    tgts = {(t["quarter"], t["product"]): t for t in recs[0]["targets"]}
    assert tgts[("Q1", "SC")]["target"] == 32.76036
    assert tgts[("Q2", "SC")]["target"] == 48.177


def test_rounding_each_dealer_would_miss_the_sheet_total():
    """The regression, stated as the arithmetic that caused it.

    Three dealers whose fractional targets sum to a clean 100. Round each first
    and the total is 99 — a shortfall that looks like missing data and is only
    ever an artefact of where the rounding happened.
    """
    recs, _, _ = msil(
        *[[f"DEALER {i}", "CITY", "STATE", "ASHOKA", f"C{i}",
           10, 5, 10, 3, 3, 0.3, None, None, share, None]
          for i, share in enumerate([33.4, 33.3, 33.3])],
    )
    targets = [t["target"] for r in recs for t in r["targets"]
               if t["quarter"] == "Q2" and t["product"] == "SC"]
    assert sum(targets) == 100.0
    assert sum(round(t) for t in targets) == 99

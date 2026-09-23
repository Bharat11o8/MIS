"""
Which master row each file outlet is paired with.

Nothing here is about a crash. A master row's id is what its visit logs and its
monthly sales point at, so pairing an outlet to the wrong row of the same
dealership does not lose that history — it moves it to a sibling, silently, and
the figures that come out still look like figures. These tests pin the passes
that stop it: the code a row already holds, then its city, then its state.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.backfill_oe_dealer_outlets import (  # noqa: E402
    absorbed_siblings, identity_clashes, pair_outlets,
)


def m(mid, city, state, code=""):
    return {"id": mid, "name": "X", "city": city, "state": state,
            "dealer_code": code, "source": "oe_file"}


def o(city, state, code="", name="X"):
    return {"name": name, "city": city, "state": state, "salesperson": "",
            "codes": code, "code": code}


def paired(matched):
    return {row["id"]: out["code"] for row, out in matched}


def test_a_row_keeps_the_code_it_already_holds():
    """ANANYA AUTO AGENCY's two PATNA rows. Paired by city alone they match in
    file order, which swapped 300C002 onto the row holding 3007180 — and the
    sales written under each code followed the swap."""
    master = [m("a", "PATNA", "Bihar", "3007180"), m("b", "PATNA", "Bihar", "300C002")]
    matched, spare = pair_outlets(
        [o("PATNA", "Bihar", "300C002"), o("PATNA", "Bihar", "3007180")], master, {})
    assert not spare
    assert paired(matched) == {"b": "300C002", "a": "3007180"}


def test_a_new_code_in_a_city_that_already_has_one_becomes_its_own_outlet():
    """SEVEN AUTOCORP / LUCKNOW gained a second code. The existing row keeps the
    code it had; the new one has no row to take and must be inserted — leaving
    it to land on the existing row is what made the sync refuse to write."""
    master = [m("a", "LUCKNOW", "Uttar Pradesh", "300B390")]
    matched, spare = pair_outlets(
        [o("LUCKNOW", "Uttar Pradesh", "300B390"), o("LUCKNOW", "Uttar Pradesh", "300B391")],
        master, {})
    assert paired(matched) == {"a": "300B390"}
    assert [x["code"] for x in spare] == ["300B391"]


def test_a_second_city_does_not_take_the_first_citys_row():
    """FRONTIER COMMERCIAL VEHICLES: one master row in DWARKA, and the file now
    lists GURGAON too. The Dealers tab groups contacts by (oem, name, city), so
    handing GURGAON the DWARKA row would move DWARKA's visits to GURGAON."""
    master = [m("a", "DWARKA", "Delhi", "3000050")]
    matched, spare = pair_outlets(
        [o("DWARKA", "Delhi", "3000050"), o("GURGAON", "Delhi", "3000051")], master, {})
    assert paired(matched) == {"a": "3000050"}
    assert [x["city"] for x in spare] == ["GURGAON"]


def test_pairing_is_stable_across_a_re_run():
    """The second run must have nothing to change. Feeding the first run's
    result back in has to reproduce it exactly, or every run rotates the group
    and carries its history round with it."""
    master = [m("a", "", "Uttar Pradesh"), m("b", "", "Uttar Pradesh")]
    outs = [o("BASTI", "Uttar Pradesh", "300B330"), o("LUCKNOW", "Uttar Pradesh", "300B390")]
    first, spare = pair_outlets(outs, master, {})
    assert not spare
    settled = [m(row["id"], out["city"], row["state"], out["code"]) for row, out in first]
    second, spare2 = pair_outlets(outs, settled, {})
    assert not spare2
    assert paired(second) == paired(first)


def test_a_multi_state_group_keeps_each_outlet_in_its_own_state():
    """AKANKSHA AUTOMOBILES spans Uttar Pradesh and Uttarakhand. Neither row
    names a city yet, so only the state separates them."""
    master = [m("up", "", "Uttar Pradesh"), m("uk", "", "Uttarakhand")]
    matched, spare = pair_outlets(
        [o("HALDWANI", "Uttarakhand"), o("BAREILLY", "Uttar Pradesh")], master, {})
    assert not spare
    assert {row["id"]: out["city"] for row, out in matched} \
        == {"uk": "HALDWANI", "up": "BAREILLY"}


def test_the_file_s_sales_region_is_translated_before_the_state_is_compared():
    """The file files GHAZIABAD under DELHI NCR. The learned map is what stops
    that outlet drifting onto a Delhi row of the same group."""
    master = [m("up", "", "Uttar Pradesh"), m("dl", "", "Delhi")]
    matched, _ = pair_outlets([o("GHAZIABAD", "DELHI NCR")], master,
                              {"DELHI NCR": "Uttar Pradesh"})
    assert [row["id"] for row, _out in matched] == ["up"]


def test_a_row_that_already_names_a_city_is_not_given_a_different_one():
    """The state pass only fills rows with no city. A row that names one is some
    other outlet of the group, and overwriting it moves that outlet's visits."""
    master = [m("has", "BASTI", "Uttar Pradesh")]
    matched, spare = pair_outlets([o("LUCKNOW", "Uttar Pradesh")], master, {})
    assert not matched
    assert [x["city"] for x in spare] == ["LUCKNOW"]


# ── A dealership row that lists the codes the master holds separately ────────

def group(city, state, codes):
    return {"name": "X", "city": city, "state": state, "salesperson": "",
            "codes": codes, "code": ""}


def test_a_dealership_keeps_the_row_in_its_own_city_and_folds_the_rest():
    """ADISHAKTI CARS: three per-code rows, now one row for BANGALORE. The
    BANGALORE row is kept, so its visits never move; the other two fold in."""
    master = [m("blr", "BANGALORE", "Karnataka", "3007720"),
              m("smg", "SHIMOGA", "Karnataka", "3003160"),
              m("dvg", "DAVANAGERE", "Karnataka", "300B350")]
    out = group("BANGALORE", "Karnataka", "3007720, 3003160, 300B350")
    matched, spare = pair_outlets([out], master, {})
    assert not spare
    assert [row["id"] for row, _o in matched] == ["blr"]
    folded = absorbed_siblings(matched, master)
    assert {gone["id"]: keep["id"] for gone, keep in folded} == {"smg": "blr", "dvg": "blr"}


def test_two_codes_in_the_dealership_s_city_keep_the_lowest():
    """ANANYA AUTO AGENCY has both codes in PATNA. The lowest is the anchor the
    visit resolver already uses, so the contacts resolved to it stay put."""
    master = [m("c", "PATNA", "Bihar", "300C002"), m("7", "PATNA", "Bihar", "3007180")]
    matched, _ = pair_outlets([group("PATNA", "Bihar", "300C002, 3007180")], master, {})
    assert [row["id"] for row, _o in matched] == ["7"]


def test_the_keeper_is_found_by_code_when_the_city_has_changed():
    """ANR AUTOMOBILES is listed at GHAZIABAD; neither old row need be there."""
    master = [m("g", "GURGAON", "Haryana", "3008640"), m("n", "NOIDA", "Uttar Pradesh", "3001100")]
    matched, spare = pair_outlets([group("GHAZIABAD", "DELHI NCR", "3008640, 3001100")],
                                  master, {})
    assert not spare
    assert [row["id"] for row, _o in matched] == ["n"]


def test_a_row_the_file_does_not_list_is_never_folded():
    """A rep-added row, or a code the file dropped, is not evidence of anything."""
    master = [m("a", "AMRITSAR", "Punjab", "3008040"),
              m("form", "PATHANKOT", "Punjab", ""),
              m("old", "JALANDHAR", "Punjab", "3009999")]
    matched, _ = pair_outlets([group("AMRITSAR", "Punjab", "3008040, 300B910")], master, {})
    assert absorbed_siblings(matched, master) == []


def test_a_per_code_tab_folds_nothing():
    master = [m("a", "LUCKNOW", "Uttar Pradesh", "300B390"),
              m("b", "LUCKNOW", "Uttar Pradesh", "300B391")]
    matched, _ = pair_outlets([o("LUCKNOW", "Uttar Pradesh", "300B390")], master, {})
    assert absorbed_siblings(matched, master) == []


def test_an_uncoded_row_already_in_the_dealership_s_city_is_the_one_kept():
    """GUGNANI AUTOCARS: an uncoded BHUBANESHWAR row and a 3000010 row in
    CUTTACK; the file lists BHUBANESHWAR, 3000010. Keeping the coded row moved
    it onto the uncoded row's exact identity and --apply died on the unique
    index. The uncoded row is kept and the coded one folds into it."""
    master = [m("bbsr", "BHUBANESHWAR", "Odisha"), m("ctc", "CUTTACK", "Odisha", "3000010")]
    matched, spare = pair_outlets([group("BHUBANESHWAR", "ODISHA", "3000010")], master, {})
    assert not spare
    assert [row["id"] for row, _o in matched] == ["bbsr"]
    folded = absorbed_siblings(matched, master)
    assert {gone["id"]: keep["id"] for gone, keep in folded} == {"ctc": "bbsr"}
    assert identity_clashes(master, matched, folded) == []


def test_a_clash_is_reported_before_anything_is_written():
    """The check the dry run makes, fed the pairing that broke --apply."""
    master = [m("bbsr", "BHUBANESHWAR", "Odisha"), m("ctc", "CUTTACK", "Odisha", "3000010")]
    bad = [(master[1], group("BHUBANESHWAR", "Odisha", "3000010"))]
    assert identity_clashes(master, bad, []) == [("Odisha", "X", "BHUBANESHWAR", "")]

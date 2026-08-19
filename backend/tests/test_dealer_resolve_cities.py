"""
Folding two spellings of one city onto one key.

The visit log and the dealer master name their cities from different sources —
until Aug 2026 the form filled City from a public geo API, and the master's
spellings are the OE team's own. So the same place arrives as Hyderābād and
HYDERABAD, Saftarjung and SAFDARJANG, Coach Bihar and COOCHBEHAR.

None of this crashes. A city that fails to fold makes `resolve` abstain, the row
keeps a NULL dealer_id, and Coverage quietly reads lower than the team's real
reach — a wrong number with nothing on screen to say so. That is what these
tests are guarding.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.dealer_resolve import norm_city  # noqa: E402


# ── Accents come off first ────────────────────────────────────────────────────

def test_the_geo_api_s_macrons_fold_to_the_dealer_list_s_plain_letters():
    """Every one of these was sitting unattributed in the August log."""
    assert norm_city("Hyderābād") == "HYDERABAD"
    assert norm_city("Karīmnagar") == "KARIMNAGAR"
    assert norm_city("Guntūr") == "GUNTUR"
    assert norm_city("Ambāla") == "AMBALA"


def test_accents_are_stripped_before_the_alias_table_is_consulted():
    """The order is the point.

    The alias table is written in plain ASCII, so a macron'd spelling only finds
    its entry if the accents have already come off. Get this backwards and the
    table has to carry every accented variant of every key — and a missing one
    fails silently, which is the worst way for this to fail.
    """
    assert norm_city("Māpuçá") == "MAPUSA"      # accents -> MAPUCA -> alias
    assert norm_city("MAPUCA") == "MAPUSA"      # already plain, same answer
    assert norm_city("Bengalūru") == "BANGALORE"


# ── Named exceptions ──────────────────────────────────────────────────────────

def test_safdarjung_folds_whichever_way_it_was_spelt():
    """The geo API writes Saftarjung, the dealer list writes Safdarjang.

    They score 0.80 against each other against a 0.82 threshold — near miss, and
    that is the point: 0.02 lower and Cuddapah/Kadapa (0.57) still would not
    reach it, while genuinely different places would start to. So they are
    named, not scored.
    """
    folded = {norm_city(c) for c in
              ("Saftarjung", "SAFDARJANG", "Safdarjung", "safdargunj")}
    # Pinned to the dealer list's own spelling, not just "all the same": the
    # master is the side that has to be matched against, so folding onto any
    # other spelling would need the whole master re-folded to agree with it.
    assert folded == {"SAFDARJANG"}


def test_the_other_two_spellings_seen_in_the_log():
    assert norm_city("Coach Bihar") == norm_city("COOCHBEHAR") == "COOCHBEHAR"
    assert norm_city("Cooch Behar") == "COOCHBEHAR"
    # Renamed in 2005; both names are still in daily use on both sides.
    assert norm_city("Cuddapah") == norm_city("KADAPA") == "KADAPA"


def test_renames_still_fold():
    assert norm_city("Bengaluru") == norm_city("BANGALORE")
    assert norm_city("Prayagraj") == norm_city("ALLAHABAD")
    assert norm_city("Gurugram") == norm_city("GURGAON")


# ── What must NOT fold ────────────────────────────────────────────────────────

def test_different_places_stay_different():
    """The failure this whole file exists to avoid is the opposite one.

    Folding two real places together attaches a visit to a dealer nobody
    visited, and unlike an unmatched row it leaves no trace — the number just
    lands on the wrong outlet's record.
    """
    for a, b in [("Guntur", "Ongole"), ("Noida", "Greater Noida"),
                 ("Kannur", "Kottayam"), ("Nashik", "Nagpur")]:
        assert norm_city(a) != norm_city(b), (a, b)


def test_blank_and_missing_cities_are_the_empty_string_not_a_crash():
    # Three of the five OEM masters carry no city at all, so this is the common
    # case, not an edge one.
    assert norm_city(None) == ""
    assert norm_city("") == ""
    assert norm_city("   ") == ""

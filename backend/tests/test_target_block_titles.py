"""
Reading an OEM, a product and a quarter out of a target block's title.

The workbook has no schema for this line — each tab's author writes it their own
way, and the shapes change between quarters. Everything here is a title that
really appeared in the FY26-27 sheets, and the failure they cause is always the
same kind: the numbers all arrive, just filed under a name nothing else uses, so
a product quietly splits in two on every filter, chart and comparison.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.oe_targets_sync import _split_oem_category  # noqa: E402


def cat(title):
    return _split_oem_category(title)[1]


def test_q1_and_q2_spell_the_same_product_differently():
    """Q1 bracketed the quarter, Q2 brackets the product instead.

    'KIA SEAT COVER (AMJ'26)' -> 'KIA JAS (SEAT COVER)'. Both are seat covers.
    Before the brackets were stripped the second filed as '(SEAT COVER)', so
    Hyundai's and Kia's JAS'26 seat covers sat in their own category and never
    lined up against their own Q1 figures.
    """
    assert cat("KIA SEAT COVER (AMJ'26)") == "SC"
    assert cat("KIA JAS (SEAT COVER)") == "SC"
    assert cat("HYUNDAI JAS (SEAT COVER)") == "SC"
    assert cat("HYUNDAI JAS (MAT)") == "MAT"
    assert cat("HYUNDAI JAS (ACC)") == "ACC"


def test_the_titles_that_already_worked_still_do():
    assert _split_oem_category("MSIL AMJ") == ("MSIL", "SC", "AMJ", None)
    assert _split_oem_category("TATA SEAT COVER (AMJ'26)") == ("TATA", "SC", "AMJ", 26)
    assert _split_oem_category("MAHINDRA ACC (JAS'26)") == ("MAHINDRA", "ACC", "JAS", 26)
    assert _split_oem_category("TATA SC") == ("TATA", "SC", None, None)


def test_a_product_the_parser_does_not_know_still_comes_through_named():
    """An unknown product is passed through, not dropped or forced into SC —
    but it comes through without the brackets, so a new product line cannot
    arrive under two spellings at once."""
    assert cat("KIA JAS (SUN SHADE)") == "SUN SHADE"
    assert cat("KIA SUN SHADE (JAS'26)") == "SUN SHADE"

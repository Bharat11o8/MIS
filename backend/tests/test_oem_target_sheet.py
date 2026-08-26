"""
The OEM target summary sheet, and the places where misreading it produces a
plausible-looking wrong answer rather than a crash.

Four hazards, all of them silent:

  MIXED MONEY SCALE   One row of the real TATA tab carries its April target in
                      rupees (37,008,000) and its April ACTUAL in crores
                      (3.58). Read as one scale, achievement lands 10,000,000x
                      out — or, in the other direction, a ₹3.58 Cr month is
                      stored as ₹3.58 and the brand looks like it sold nothing.
  ABSENT vs ZERO      Targets for all twelve months are published up front;
                      achievement arrives monthly. A month not yet published
                      must stay NULL. The sheet's own quarter columns say 0 for
                      quarters that have not started, and 0 is a measurement.
  DRIFTING HEADERS    The same month is 'Jun Qty', 'Jun Qty Target' and 'Jun
                      Qty TGT' on three different tabs. Matching by position
                      instead of by header silently drops a month and quietly
                      shrinks the year.
  DERIVED TOTALS      The annual and quarter TOTAL columns must never be read
                      as data. MSIL's live 'Total Qty' is already wrong by one
                      month against its own rows.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.oe_oem_targets_sync import parse_oem_grids, _product_key  # noqa: E402

# A tab in the real shape: identity column, last year, this year's annual
# total, a running total, then four columns for April and four for June — June
# spelled the way MAHINDRA spells it, which is the one that used to be lost.
HEADERS = [
    "PRODUCT", "25~26 Qty", "25~26 Value", "26~27 Target Qty", "26~27 Target Value",
    "Total Qty", "Total Value",
    "April Qty Target", "April Value Target", "Apr Qty Actual", "Apr Value Actual",
    "Jun Qty TGT", "Jun Value", "Jun Qty Actual", "Jun Value Actual",
    "TOTAL AMJ'26 TGT QTY", "TOTAL AMJ'26 TGT VALUE",
    "TOTAL AMJ'26 ACH QTY", "TOTAL AMJ'26 ACH VALUE", "ACH %",
]


def parse(*rows, tab="TATA"):
    return parse_oem_grids({tab: [["TATA"], HEADERS, *rows]}, 2026)


def by_month(records, product, month):
    return next(r for r in records
                if r["product"] == product and r["period_month"] == month)


def scale_errors(errors):
    """These fixtures carry two months, not twelve, so the parser rightly warns
    about the ten it cannot find (see the missing-month test). Only the money
    scale complaints are of interest to the tests that use this."""
    return [e for e in errors if "money scale" in e]


# ── Scale ─────────────────────────────────────────────────────────────────────

def test_target_in_rupees_and_actual_in_crores_on_the_same_row():
    """The real TATA April row. Both columns must come out in rupees."""
    months, _, _, errors = parse(
        # last yr,          annual,        running,   April tgt,     April ach,  June...
        ["Seat Cover", 157402, 48.54, 192000, 59.21, 62776, 7.20,
         12000, 37008000, 11458, 3.5833499,
         13350, 41171400, 11565, 3.6018863,
         # TOTAL columns, which must be ignored entirely
         42350, 13.06, 39622, 12.33, 0.94],
        ["Total", 242140, 67.58, 281848, 79.99, 98803, 9.66,
         19515, 5.24, 18935, 5.20, 18780, 5.58, 19691, 5.02,
         60745, 17.60, 63205, 16.90, 0.94],
    )
    assert not scale_errors(errors)
    apr = by_month(months, "Seat Cover", 4)
    assert apr["tgt_value"] == 37008000
    assert round(apr["ach_value"]) == 35833499        # 3.5833499 Cr, not ₹3.58
    assert apr["tgt_value_scale"] == "rupees"
    assert apr["ach_value_scale"] == "crores"


def test_a_tab_entirely_in_rupees_is_left_alone():
    months, _, _, errors = parse(
        ["Seat Covers", 126360, 382646613, 160600, 481800000, 40705, 133193086,
         13000, 39000000, 9917, 31694970,
         13000, 39000000, 10033, 32020203,
         39000, 11.7, 29425, 9.30, 0.79],
        ["TOTAL", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        tab="MSIL",
    )
    assert not scale_errors(errors)
    apr = by_month(months, "Seat Covers", 4)
    assert apr["tgt_value"] == 39000000
    assert apr["ach_value"] == 31694970


# ── Absent vs zero ────────────────────────────────────────────────────────────

def test_an_unpublished_month_is_none_and_a_measured_zero_is_zero():
    """The whole point of the table. A blank actual is 'not yet'; a typed 0 is
    a month in which we sold none, and the two must not collapse."""
    months, _, _, _ = parse(
        # April sold nothing (a real 0); June has not been published (blank).
        ["Steering Cover", 4600, 1378404, 4620, 1677060, 240, 86816,
         1400, 508200, 0, 0,
         160, 58080, "", "",
         2490, 0.09, 0, 0, 0],
        ["TOTAL", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        tab="MSIL",
    )
    apr = by_month(months, "Steering Cover", 4)
    jun = by_month(months, "Steering Cover", 6)
    assert apr["ach_nos"] == 0 and apr["ach_value"] == 0
    assert jun["ach_nos"] is None and jun["ach_value"] is None
    # And the target for the unpublished month is still there — that is what
    # makes "target set, nothing achieved yet" expressible at all.
    assert jun["tgt_nos"] == 160


def test_a_month_with_nothing_at_all_is_not_written():
    """No row, rather than a row of NULLs: 'this OEM publishes nothing for
    June' and 'June exists with no numbers' are different facts."""
    months, _, _, _ = parse(
        ["Pet Barrier", 100, 0.004, 100, 0.004, 200, 0.005,
         100, 260000, 50, 0.013,
         "", "", "", "",
         100, 0.004, 200, 0.005, 1.0],
        ["Total", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    )
    assert {r["period_month"] for r in months} == {4}


# ── Headers ───────────────────────────────────────────────────────────────────

def test_the_month_whose_header_reads_tgt_is_still_found():
    """'Jun Qty TGT' is MAHINDRA's spelling. Losing it cost that tab 8,029
    units of its year and nothing on screen said so."""
    months, _, _, _ = parse(
        ["MATS", 116617, 39.76, 139810, 47.35, 65895, 22.94,
         9757, 3.30, 17176, 6.30,
         12918, 4.37, 13625, 4.33,
         35129, 11.89, 47165, 16.35, 1.34],
        ["TOTAL", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        tab="MAHINDRA",
    )
    assert by_month(months, "MATS", 6)["tgt_nos"] == 12918


def test_the_quarter_and_annual_total_columns_are_never_read_as_months():
    """They are exactly the sum of their months, and one of them is already
    wrong in the live sheet. Only the two real months may appear."""
    months, _, _, _ = parse(
        ["Mat", 52690, 17.9, 57800, 19.6, 18727, 2.2,
         4300, 14611400, 4547, 1.47,
         4150, 14101700, 4011, 1.31,
         12750, 4.33, 12788, 4.16, 1.0],
        ["Total", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    )
    assert sorted(r["period_month"] for r in months) == [4, 6]
    # The annual target column (57800) must not have become a figure anywhere.
    assert sum(r["tgt_nos"] for r in months) == 4300 + 4150


def test_a_missing_month_is_reported_rather_than_shrinking_the_year():
    _, _, _, errors = parse(
        ["Mat", 0, 0, 0, 0, 0, 0, 4300, 14611400, 4547, 1.47,
         4150, 14101700, 4011, 1.31, 0, 0, 0, 0, 0],
        ["Total", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    )
    assert any("no target columns for month" in e for e in errors)


# ── Rows ──────────────────────────────────────────────────────────────────────

def test_the_total_row_is_not_a_product_and_stops_the_read():
    months, annual, _, _ = parse(
        ["Seat Cover", 100, 0.03, 100, 0.03, 100, 0.03,
         100, 300000, 100, 0.03, 100, 300000, 100, 0.03, 0, 0, 0, 0, 0],
        ["Total", 999, 999, 999, 999, 999, 999,
         999, 999, 999, 999, 999, 999, 999, 999, 0, 0, 0, 0, 0],
        ["stray note somebody typed under the block", 1, 1, 1, 1, 1, 1,
         1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    )
    assert {r["product"] for r in months} == {"Seat Cover"}
    assert {r["product"] for r in annual} == {"Seat Cover"}


def test_last_year_is_one_figure_per_product_not_one_per_month():
    """Copied onto the month rows it would sum to twelve times last year the
    first time anyone grouped by OEM — a wrong number that looks plausible."""
    months, annual, _, _ = parse(
        ["Seat Cover", 157402, 48.5417939, 192000, 59.21, 62776, 7.2,
         12000, 37008000, 11458, 3.58,
         13350, 41171400, 11565, 3.60,
         0, 0, 0, 0, 0],
        ["Total", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    )
    assert len(annual) == 1
    assert annual[0]["py_nos"] == 157402
    assert round(annual[0]["py_value"]) == 485417939      # crores -> rupees
    assert len(months) == 2                               # and not 2 + a copy


# ── Product buckets ───────────────────────────────────────────────────────────

def test_product_buckets_group_across_the_names_each_oem_uses():
    assert _product_key("Seat Covers") == "SC"
    assert _product_key("SEAT COVERS (PASSANGER)") == "SC"
    assert _product_key("SEAT COVERS (COMMERCIAL)") == "SC"
    assert _product_key("Mat") == "MAT"
    assert _product_key("MATS") == "MAT"
    # 'Docket + Accessories' is MSIL's accessories line, not a product of
    # its own, and 'Seat Massager' is not a seat cover.
    assert _product_key("Docket + Accessories") == "ACC"
    assert _product_key("ACCESSORIES") == "ACC"
    assert _product_key("Steering Cover") == "STEERING"
    assert _product_key("Seat Massager") == "OTHER"
    assert _product_key("Tire Table") == "OTHER"


def test_the_two_mahindra_seat_cover_rows_stay_two_rows():
    """Same bucket, different products. The bucket is for comparison, never
    for identity — folding them would merge two targets nobody merged."""
    months, _, _, _ = parse(
        ["SEAT COVERS (COMMERCIAL)", 0, 0, 0, 0, 0, 0,
         7942, 770374, 10436, 1139155, 8029, 778813, 7511, 857914, 0, 0, 0, 0, 0],
        ["SEAT COVERS (PASSANGER)", 0, 0, 0, 0, 0, 0,
         7274, 2641189, 5484, 1969081, 4054, 1472007, 5739, 2080572, 0, 0, 0, 0, 0],
        ["TOTAL", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        tab="MAHINDRA",
    )
    apr = [r for r in months if r["period_month"] == 4]
    assert len(apr) == 2
    assert all(r["product_key"] == "SC" for r in apr)
    assert sorted(r["tgt_nos"] for r in apr) == [7274, 7942]

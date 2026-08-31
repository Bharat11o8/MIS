"""Hyundai + Kia are reported as one brand, "MOBIS".

The rule is applied on read, in SQL, which makes it easy to change in one
place and easy to half-change in five. These tests pin the three things that
have to agree: the dropdown offers the group, the filter accepts it, and every
aggregate is folded the same way. If they drift, the tab shows a MOBIS option
that returns nothing, or a MOBIS bar beside a stray HYUNDAI one.
"""
import re

import pytest

from routers import oe_oem_targets as m


def test_group_membership_is_the_source_of_truth():
    assert m.OEM_GROUPS == {"MOBIS": ("HYUNDAI", "KIA")}


def test_sql_folds_members_and_leaves_everyone_else_alone():
    sql = m.OEM_SQL
    assert "'HYUNDAI'" in sql and "'KIA'" in sql and "THEN 'MOBIS'" in sql
    # ELSE, not a lookup table: MSIL / TATA / MAHINDRA must pass through, and
    # so must a sixth OEM whose tab is added tomorrow.
    assert sql.rstrip().endswith("ELSE oem END")
    assert "MSIL" not in sql


def test_sql_can_fold_a_qualified_column():
    assert m._oem_sql("t.oem") == m.OEM_SQL.replace("oem", "t.oem")


def test_group_name_is_not_a_stored_value():
    """MOBIS exists only as a label. Nothing writes it, so a filter that
    compared against the raw column would silently return nothing."""
    assert "MOBIS" not in m.OEM_GROUPS["MOBIS"]


@pytest.mark.parametrize("oem", ["MOBIS", "MSIL"])
def test_filter_matches_the_grouped_name(oem):
    where, params = m._filters(oem, None, None)
    clause = next(c for c in where if ":oem" in c)
    assert clause == f"{m.OEM_SQL} = :oem"
    assert params["oem"] == oem


def test_filter_leaves_product_columns_raw():
    """Only the OEM is grouped; folding a product column too would merge
    Hyundai's SEAT COVERS into Kia's SEAT COVERS (PASSANGER)."""
    where, params = m._filters(None, "MATS", "SC")
    assert "product = :product" in where
    assert "product_key = :product_key" in where
    assert params == {"product": "MATS", "product_key": "SC"}


def test_no_oem_filter_adds_no_clause():
    where, params = m._filters(None, None, None)
    assert where == ["1=1"] and params == {}


def test_every_oem_aggregate_groups_by_the_expression():
    """The failure this guards against is partial adoption: by_oem folded but
    prior_year not, so last year's Mobis arrives as two rows the tab cannot
    line up against one."""
    src = open(m.__file__, encoding="utf-8").read()
    body = src.split("def summary(", 1)[1]
    # Every GROUP BY that mentions the oem column at all must fold it.
    for clause in re.findall(r"GROUP BY ([^\n\"]*oem[^\n\"]*)", body):
        assert "OEM_SQL" in clause or "CASE" in clause, clause
    assert body.count("OEM_SQL") >= 4        # by_oem, by_oem_product, prior, scales

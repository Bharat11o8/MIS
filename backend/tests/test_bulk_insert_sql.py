"""
The batched INSERT statements every OE sync writes through.

Two failure modes are pinned here, both of which are invisible until a sync runs
against the real database:

  1. A bind parameter SQLAlchemy does not recognise. `text()` silently leaves
     an unrecognised placeholder as literal SQL — this is exactly how
     ":id_0::uuid" shipped, binding sp_/codes_ but never the ids, and failing
     every re-sync of the dealer file. A missing name here means a broken
     statement, not a test nit.

  2. Overflowing Postgres's 65535 bind-parameter ceiling. The limit is per
     statement, so it scales with chunk size TIMES column count — adding
     columns to the widest table is what would breach it, not adding rows.

Importing the router needs a DATABASE_URL; a throwaway SQLite URL is enough,
since nothing here connects.
"""
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite://")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest                                                   # noqa: E402
from sqlalchemy import text                                     # noqa: E402

from routers.oe_network import (                                # noqa: E402
    _LOG_COLS, _PLAN_COLS, _TGT_COLS,
    _DEALER_MONTHLY_COLS, _DEALER_TARGET_COLS,
    _INSERT_CHUNK, _DATA_TABLES,
    MODULE_LOG, MODULE_PLAN, MODULE_TGT,
)

PG_MAX_PARAMS = 65535

TABLES = [
    ("oe_visit_logs", _LOG_COLS),
    ("oe_visit_plans", _PLAN_COLS),
    ("oe_targets", _TGT_COLS),
    ("oe_dealer_monthly", _DEALER_MONTHLY_COLS),
    ("oe_dealer_targets", _DEALER_TARGET_COLS),
]


def build(table: str, cols: tuple, chunk: int) -> str:
    """The statement _bulk_insert builds, reproduced exactly."""
    values = ", ".join(
        "(" + ", ".join(f":{c}_{n}" for c in cols) + ")"
        for n in range(chunk)
    )
    return f"INSERT INTO {table} ({', '.join(cols)}) VALUES {values}"


@pytest.mark.parametrize("table,cols", TABLES, ids=[t for t, _ in TABLES])
class TestBatchedInsert:
    def test_every_placeholder_is_a_recognised_bind(self, table, cols):
        stmt = text(build(table, cols, chunk=3))
        binds = set(stmt.compile().binds.keys())
        want = {f"{c}_{n}" for c in cols for n in range(3)}
        assert want - binds == set(), (
            "unrecognised placeholders reach Postgres as literal SQL"
        )

    def test_no_placeholder_is_followed_by_a_cast_operator(self, table, cols):
        # ":p::uuid" is the shape that broke. Casts must be written CAST(:p AS t).
        assert "::" not in build(table, cols, chunk=2)

    def test_a_full_chunk_stays_under_the_parameter_ceiling(self, table, cols):
        assert _INSERT_CHUNK * len(cols) <= PG_MAX_PARAMS

    def test_columns_are_unique(self, table, cols):
        # A duplicate column would produce two placeholders with the same name,
        # so the second row's value would silently overwrite the first's.
        assert len(set(cols)) == len(cols)

    def test_one_row_and_many_rows_both_build(self, table, cols):
        for chunk in (1, _INSERT_CHUNK):
            stmt = text(build(table, cols, chunk))
            assert len(stmt.compile().binds) == chunk * len(cols)


class TestModuleTableMapping:
    @pytest.mark.parametrize("module", [MODULE_PLAN, MODULE_LOG, MODULE_TGT])
    def test_sheet_modules_write_exactly_one_table(self, module):
        # The sync loop inserts into _DATA_TABLES[module][0]; a module that grew
        # a second table would silently never have it written.
        assert len(_DATA_TABLES[module]) == 1

    def test_the_dealer_file_writes_two(self):
        assert set(_DATA_TABLES["oe_dealer_data"]) == {
            "oe_dealer_monthly", "oe_dealer_targets"
        }

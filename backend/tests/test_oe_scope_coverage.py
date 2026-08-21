"""
Every OE endpoint goes through the scope. Structurally, not by inspection.

Row-level scoping is only as good as its least careful call site: one endpoint
added later that checks module access and forgets the scope hands a rep the
whole team's numbers, and nothing about the response looks wrong. Reviewing for
that by eye works exactly until somebody is in a hurry.

So the shape of the code is pinned instead:

  • routers/oe_network.py has no "just check the module" helper left to call —
    _require_access is gone, replaced by _scope, which cannot be used without
    receiving the scope object back.
  • No OE router calls require_module directly, which would be the other way to
    reach the data while side-stepping _scope.
  • Every route function in both OE routers mentions _scope or _require_admin.

These read the source rather than the running app because the endpoints need a
database and this suite deliberately has none. A structural test is weaker than
an integration test and stronger than nothing; it catches the realistic mistake,
which is omission.
"""
import ast
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

ROUTERS = os.path.join(os.path.dirname(__file__), "..", "routers")
OE_FILES = ["oe_network.py", "oe_targets.py"]

# Endpoints that own the sheet registry rather than reading rows. They gate on
# _require_admin, which is stricter than a scope: a scoped user is refused
# outright. /sync-latest is deliberately NOT here — pulling the latest rows is
# routine and every OE user, reps included, may press Sync.
ADMIN_ONLY = {
    "add_sheet_source",
    "delete_sheet_source",
    "sync_sheet_source",
    "sync_history",
}


def _source(name):
    with open(os.path.join(ROUTERS, name), encoding="utf-8") as f:
        return f.read()


def _routes(name):
    """(function name, source segment) for every @router.<verb> function."""
    src = _source(name)
    tree = ast.parse(src)
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            func = dec.func if isinstance(dec, ast.Call) else dec
            if (isinstance(func, ast.Attribute)
                    and isinstance(func.value, ast.Name)
                    and func.value.id == "router"):
                out.append((node.name, ast.get_source_segment(src, node) or ""))
                break
    return out


def test_the_unscoped_access_helper_is_gone():
    """_require_access checked the module and returned nothing, so an endpoint
    could call it and read every rep's rows. It must not come back."""
    for name in OE_FILES:
        assert "_require_access" not in _source(name), (
            f"{name} still refers to _require_access; use _scope so the caller "
            f"is handed the scope it has to apply")


def test_no_oe_router_checks_the_module_directly():
    """require_module is the other door to the data. Only _scope may open it."""
    for name in OE_FILES:
        src = _source(name)
        # _scope's own definition is the single permitted call.
        assert src.count("require_module(") <= (1 if name == "oe_network.py" else 0), (
            f"{name} calls require_module directly — route it through _scope, "
            f"which also resolves the row-level scope")


@pytest.mark.parametrize("filename", OE_FILES)
def test_every_route_resolves_a_scope(filename):
    routes = _routes(filename)
    assert routes, f"no routes found in {filename} — did the decorator style change?"
    for func_name, body in routes:
        expected = "_require_admin" if func_name in ADMIN_ONLY else "_scope"
        assert expected in body, (
            f"{filename}::{func_name} never calls {expected}. Every OE endpoint "
            f"must resolve the caller's scope before it reads anything.")


def test_scope_helpers_really_delegate_to_scope():
    """A route may reach the scope through a helper rather than calling _scope
    itself. That satisfies the substring check above by coincidence -- the
    helper's own name contains "_scope" -- so the delegation is pinned here
    instead of being taken on trust."""
    src = _source("oe_network.py")
    for helper in ("_my_visits_scope",):
        if f"def {helper}(" not in src:
            continue
        body = src.split(f"def {helper}(", 1)[1].split("\ndef ", 1)[0]
        assert "_scope(db, current_user)" in body, (
            f"{helper} does not call _scope, so routes using it are unscoped "
            f"while still passing the coverage check")


def test_admin_only_endpoints_are_actually_admin_only():
    """Named explicitly so that moving one out of the registry set is a
    deliberate edit with a diff, not an accident."""
    names = {n for n, _ in _routes("oe_network.py")}
    assert ADMIN_ONLY <= names, f"stale ADMIN_ONLY entries: {ADMIN_ONLY - names}"
    # The Sync button on the Overview stays open to reps.
    assert "sync_latest" not in ADMIN_ONLY


@pytest.mark.parametrize("filename", OE_FILES)
def test_scoped_endpoints_do_not_trust_the_query_parameter(filename):
    """An endpoint taking ?salesperson= must reassign it from _scope, or a rep
    could name a colleague and read their numbers."""
    for func_name, body in _routes(filename):
        if "salesperson: Optional[str]" not in body:
            continue
        assert "salesperson = _scope(" in body or "salesperson = scope.canonical" in body, (
            f"{filename}::{func_name} accepts ?salesperson= but never replaces it "
            f"with the value _scope returns")

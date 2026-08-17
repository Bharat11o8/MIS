"""
The Google API clients' timeout and retry configuration.

Neither is exercised by a normal sync — they only matter when Google is slow or
briefly unavailable, which is exactly when nobody is watching. Without a
timeout, httplib2 waits forever and the sync UI just spins with nothing to
report; without retries, one 429 fails a sync the user then has to redo.

These assert the wiring, not the network: an anonymous credential is enough to
build a client, and static discovery keeps it entirely offline.
"""
import importlib
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite://")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httplib2                                                  # noqa: E402
import pytest                                                    # noqa: E402
from google.auth.credentials import AnonymousCredentials         # noqa: E402
from googleapiclient.discovery import build                      # noqa: E402

from services import google_sheets                               # noqa: E402


class TestTimedHttp:
    def test_applies_the_timeout_to_the_transport(self):
        authed = google_sheets._timed_http(AnonymousCredentials(), 47)
        assert authed.http.timeout == 47

    def test_builds_a_working_client_offline(self):
        # static_discovery must keep this local — otherwise the first call of
        # every sync fetches a discovery document before asking for any data.
        authed = google_sheets._timed_http(AnonymousCredentials(), 30)
        svc = build("sheets", "v4", http=authed,
                    cache_discovery=False, static_discovery=True)
        assert hasattr(svc, "spreadsheets")

    def test_each_client_gets_its_own_transport(self):
        # httplib2.Http is not thread-safe; two concurrent syncs must not share.
        a = google_sheets._timed_http(AnonymousCredentials(), 30)
        b = google_sheets._timed_http(AnonymousCredentials(), 30)
        assert a.http is not b.http


class TestDefaults:
    def test_timeout_is_finite_and_sane(self):
        # The bug this guards: no timeout at all, i.e. an infinite hang.
        assert 0 < google_sheets.SHEETS_TIMEOUT <= 600

    def test_retries_are_enabled_but_bounded(self):
        assert 1 <= google_sheets.SHEETS_RETRIES <= 10

    @pytest.mark.parametrize("env,attr,value", [
        ("SHEETS_TIMEOUT_SECONDS", "SHEETS_TIMEOUT", "45"),
        ("SHEETS_RETRIES", "SHEETS_RETRIES", "7"),
    ])
    def test_overridable_by_environment(self, env, attr, value, monkeypatch):
        # Tunable without a code change when a sheet grows or Google throttles.
        monkeypatch.setenv(env, value)
        reloaded = importlib.reload(google_sheets)
        try:
            assert getattr(reloaded, attr) == int(value)
        finally:
            monkeypatch.delenv(env, raising=False)
            importlib.reload(google_sheets)


class TestReadsRetryAndWritesDoNot:
    """Idempotent reads retry; a file create must not, or a 5xx that actually
    landed produces a duplicate photo."""

    def _source(self, name):
        path = os.path.join(os.path.dirname(__file__), "..", "services", name)
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    @pytest.mark.parametrize("module", [
        "oe_network_sync.py", "finance_sync.py",
        "sales_sync.py", "distributor_sales_sync.py",
    ])
    def test_every_sheet_read_passes_num_retries(self, module):
        src = self._source(module)
        bare = [ln.strip() for ln in src.splitlines() if ".execute()" in ln]
        assert bare == [], f"sheet read without retries in {module}: {bare}"

    def test_the_drive_upload_does_not_retry(self):
        src = self._source("google_sheets.py")
        assert "supportsAllDrives=True,\n    ).execute()" in src.replace("\r\n", "\n")

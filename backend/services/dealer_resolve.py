"""
AutoForm MIS — resolving a logged dealership to a dealer OUTLET.

Every visit-log row names a dealership and a city as free-ish text. The dealer
view needs those rows attached to a specific outlet in `oe_dealerships`, because
one group can run several (PREM MOTORS Narela vs PREM MOTORS Wazirpur) and
leadership asks its questions per outlet: coverage, top/bottom 20, growth.

Matching is not a straight equality check for two reasons:

  • History. Until Aug 2026 the form filled City from a public geo API, picked
    independently of the dealership, so its spellings are the API's and the
    dealer list's are the OE team's — Bengaluru/BANGALORE, Ambāla/AMBALA,
    Guwhati/GUWAHATI, Bhubaneswar/BHUBANESHWAR. About 39% of August's rows
    disagree on city while naming the right dealer.
  • Names carry trade noise (PVT / LTD / LLP) inconsistently on both sides, and
    the pre-dropdown era is full of truncations — "Anand Motors" for ANAND
    MOTOR, "Poddar Car" for PODDAR CAR WORLD, "Bimal Auto" for BIMAL AUTO
    AGENCY.
  • Some cities were renamed rather than misspelt. Bengaluru scores 0.667
    against BANGALORE and Prayagraj 0.333 against ALLAHABAD — no similarity
    threshold can catch those without also accepting genuinely wrong places, so
    they need naming, not scoring.

New rows do not have this problem — the form now takes the city from the chosen
dealer — so this is mostly about not throwing away the history.

The rule, in order:
  1. find the dealer by exact normalised name within the OEM; failing that, by
     name containment (one side's words are all present in the other) and only
     when exactly ONE dealer qualifies, so "BHANDARI" can't swallow a longer
     unrelated name;
  2. that dealer has exactly ONE outlet → that one, whatever city was typed. A
     group with a single outlet cannot be ambiguous, so a city typo is
     harmless;
  3. several outlets → the best city, accepted only if it clears
     MIN_CITY_SIMILARITY *and* is clearly ahead of the runner-up. Two outlets
     of one group in similar-sounding cities is exactly where a wrong guess
     would be invisible, so we abstain instead.

Anything unresolved stays unresolved. A NULL dealer_id is a reportable fact —
never guess to make a number look complete.
"""
from __future__ import annotations

import collections
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

# A city has to look this much like the candidate before we accept it.
# 0.82 keeps Bengaluru→BANGALORE (0.84) and Guwhati→GUWAHATI (0.93) while
# rejecting genuinely different places like Ongole→GUNTUR (0.33).
MIN_CITY_SIMILARITY = 0.82
# ...and it has to beat the next-best candidate by this much, so a group with
# two similar city names is left alone rather than assigned on a coin flip.
MIN_CITY_MARGIN = 0.08

_NOISE = re.compile(r"\b(PVT|PRIVATE|LTD|LIMITED|LLP|CO|COMPANY|AND|THE)\b")

# Cities that were renamed, or that the two sides simply call different things.
# Both spellings are folded to one side; which side wins does not matter as
# long as it is consistent. Only pairs seen in the real data are listed — this
# is not meant to become a gazetteer.
_CITY_ALIASES = {
    "BENGALURU": "BANGALORE",
    "PRAYAGRAJ": "ALLAHABAD",
    "GURUGRAM": "GURGAON",
    "MYSURU": "MYSORE",
    "VADODARA": "BARODA",
    "KOCHI": "COCHIN",
    "THIRUVANANTHAPURAM": "TRIVANDRUM",
    "PUDUCHERRY": "PONDICHERRY",
    "VISAKHAPATNAM": "VIZAG",
    "VISHAKHAPATNAM": "VIZAG",
    "KOZHIKODE": "CALICUT",
}


def _strip_accents(s: str) -> str:
    """Ambāla → Ambala. The geo API returns diacritics, the dealer list doesn't."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm_name(s: Optional[str]) -> str:
    """Fold a dealership name to what actually identifies it.

    Trailing plurals go too: the two sides disagree on MOTOR/MOTORS and
    CAR/CARS constantly ("Anand Motors" for ANAND MOTOR). Only on words long
    enough that the S is a plural rather than the whole point of the word.
    """
    s = _NOISE.sub(" ", _strip_accents(s or "").upper())
    s = re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]", " ", s)).strip()
    return " ".join(w[:-1] if len(w) > 3 and w.endswith("S") else w for w in s.split())


def norm_city(s: Optional[str]) -> str:
    s = _strip_accents(s or "").upper()
    s = re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]", " ", s)).strip()
    return _CITY_ALIASES.get(s, s)


def _city_score(a: str, b: str) -> float:
    """How much two city strings look like the same place.

    Containment is treated as near-certain because the disagreements that take
    that shape are qualifiers, not different places: "West Delhi" vs DELHI,
    "Pune Division" vs PUNE. Plain similarity handles the misspellings.
    """
    if a == b:
        return 1.0
    ta, tb = set(a.split()), set(b.split())
    if ta and tb and (ta <= tb or tb <= ta):
        return 0.95
    return SequenceMatcher(None, a, b).ratio()


class DealerIndex:
    """Loads the outlet master once, then resolves rows in memory.

    A sync replaces thousands of rows in one transaction; querying per row over
    the SSH tunnel to the VPS would dominate its runtime.
    """

    def __init__(self, db: Session):
        rows = db.execute(text("""
            SELECT id, oem, name, COALESCE(city, '') AS city
            FROM oe_dealerships
            WHERE is_active
        """)).fetchall()
        self._by_name: dict[tuple, list[tuple[str, str]]] = collections.defaultdict(list)
        self._names_by_oem: dict[str, list[tuple[str, frozenset]]] = collections.defaultdict(list)
        self._count = 0
        for r in rows:
            oem = (r.oem or "").upper()
            nn = norm_name(r.name)
            if not oem or not nn:
                continue
            key = (oem, nn)
            if key not in self._by_name:
                self._names_by_oem[oem].append((nn, frozenset(nn.split())))
            self._by_name[key].append((norm_city(r.city), r.id))
            self._count += 1
        self._memo: dict[tuple, Optional[str]] = {}

    def __len__(self) -> int:
        return self._count

    def _find_name(self, oem: str, nn: str) -> Optional[tuple]:
        """The dealer key this name refers to, or None if it is ambiguous.

        Falls back to word containment for the truncations the old free-text
        form is full of, and only when a single dealer qualifies — "BHANDARI"
        is itself a dealer name and would otherwise absorb every longer name
        starting with it.
        """
        key = (oem, nn)
        if key in self._by_name:
            return key
        words = frozenset(nn.split())
        if not words:
            return None
        hits = [n for n, ws in self._names_by_oem.get(oem, []) if ws <= words or words <= ws]
        return (oem, hits[0]) if len(hits) == 1 else None

    def resolve(self, oem: Optional[str], name: Optional[str],
                city: Optional[str]) -> Optional[str]:
        oem = (oem or "").upper()
        nn, nc = norm_name(name), norm_city(city)
        if not oem or not nn:
            return None

        memo_key = (oem, nn, nc)
        if memo_key in self._memo:
            return self._memo[memo_key]

        result = None
        key = self._find_name(oem, nn)
        if key:
            candidates = self._by_name[key]
            if len(candidates) == 1:
                result = candidates[0][1]
            else:
                scored = sorted(((_city_score(nc, c), did) for c, did in candidates),
                                key=lambda x: -x[0])
                best, runner_up = scored[0], scored[1]
                if best[0] >= MIN_CITY_SIMILARITY and best[0] - runner_up[0] >= MIN_CITY_MARGIN:
                    result = best[1]

        self._memo[memo_key] = result
        return result

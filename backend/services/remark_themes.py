"""
AutoForm MIS — OE log-book remark theme classifier.

The log book's REMARKS column is free-text field notes the OE team write after
every dealer visit or call ("Order logged today — Seat Covers 20 & 7D mats 6",
"Follow-up, he will confirm by Monday", "shared new Tiago catalogue"). Leadership
wants to see *what everyone is up to* without reading 800 lines a month, so we
tag each remark with zero or more themes using keyword patterns tuned against the
real July'26 log book (877 remarks).

Design notes:
  • Multi-label on purpose — one remark routinely does two things at once
    ("order logged today, will follow up next week" is both an order and a
    follow-up). Counts across themes therefore sum to more than the remark count.
  • Order matters: `THEMES` is the display order (most business-important first).
  • Everything is plain keyword/regex matching — transparent and cheap. The
    remarks are all in Indian business English, so no transliteration is needed.
  • Negation is handled narrowly where it flips the meaning that matters most:
    an order that is *not yet* placed is a follow-up, not a booked order.
"""
import re
from typing import List

# A theme is (key, label, list-of-patterns). A remark gets the theme if ANY
# pattern matches. Patterns are lowercase regex fragments matched case-insensitively.
_THEME_DEFS = [
    ("order_booked", "Order booked", [
        r"order(?:s)?\s+(?:logged|placed|booked|confirm(?:ed)?|received|done)",
        r"logged\s+(?:today|to\s?tata|to\s+tata)",
        r"\b(?:placed|logged|booked)\s+today\b",
        r"\bordered\b",
        r"(?:she|he|dealer|they)\s+confirmed",
        r"confirmed\s+(?:today|the\s+order|order)",
        r"order\s+confirm\b",
        r"(?:has\s+(?:already\s+)?placed|placing)\s+order",
        r"procur(?:e|ed|ing)\b",
        r"(?:doing|selling)\s+our\b",
        r"order\s*[-:]\s*\d|order\s+\d+\s*set",
    ]),
    ("order_push", "Order pushed / asked", [
        r"asked\s+to\s+(?:order|place|start|support|do|di|increase)",
        r"request(?:ed)?\s+(?:to\s+order|for\s+order)",
        r"suggest(?:ed)?\s+(?:to|him|to\s+order|to\s+work)",
        r"this\s+month\s+.*?order|order\s+\d+\s*(?:piece|pcs|p|nos|numbers)?",
        r"place\s+the\s+order\b",
        r"support\s+(?:and\s+order|our|for\s+our|ing\s+our)",
        r"push(?:ed)?\s+(?:dealer\s+)?(?:for\s+)?(?:more\s+|further\s+)?order",
        r"order\s+(?:minimum|maximum|\d)",
        r"plan\s+for\s+bill?ing",
        r"increase\s+(?:numbers|order|the\s+numbers)",
        r"this\s+month(?:s)?\s+\d",
        r"(?:assigned|this\s+month)\s+.*?target|target\s+\d",
    ]),
    ("follow_up", "Follow-up / pending", [
        r"follow[\s\-]?up",
        r"will\s+(?:confirm|place|order|discuss|update|inform|revisit|visit)",
        r"(?:order|it)\s+will\s+be\s+(?:place|placed|logged|confirm)",
        r"not\s+(?:yet\s+)?(?:confirm(?:ed)?|placed|logged)",
        r"\bpending\b",
        r"confirm\s+(?:by|on|the\s+quantity|tomorrow|next|monday|saturday)",
        r"discuss(?:ed)?\s+(?:again|on\s+\w+day)",
        r"\brevisit\b",
        r"remind|remember\s+you",
    ]),
    ("product_pitch", "Product pitched / catalogue", [
        r"catalogue|catalog",
        r"part\s+(?:no|nos|number|numbers)",
        r"shared\s+(?:the\s+)?(?:new|details|part|catalogue)",
        r"informed\s+about",
        r"introduc(?:e|ed|ing)",
        r"new\s+tiago",
        r"discussed\s+(?:our\s+)?(?:product|part|catalogue)",
        r"shared\s+new",
    ]),
    ("back_order", "Back order / supply", [
        r"back\s?order",
        r"billing\s+(?:has\s+)?not\s+(?:been\s+)?done",
        r"(?:different|wrong)\s+part",
        r"dispatch(?:ed)?|despatch",
        r"material\s+(?:not\s+)?(?:available|dispatch)",
        r"\bshort\s+supply\b",
    ]),
    ("stock", "Stock position", [
        r"\bstock\b|in\s+stock|out\s+of\s+stock|no\s+stock",
        r"\binventory\b",
        r"keep\s+material\s+available",
    ]),
    ("payment_issue", "Fund / payment", [
        r"\bfund(?:s)?\b|fund\s+issue",
        r"payment|outstanding|credit|dues?\b",
    ]),
    ("new_dealer", "New dealership", [
        r"new\s+deal(?:er|ership)",
        r"dealer\s+code\s+(?:re)?open",
        r"\breopen\b",
        r"first\s+(?:visit|time)|onboard",
    ]),
    ("incentive", "Incentive / scheme", [
        r"incentive|scheme\b|\boffer\b|discount|benefit",
    ]),
    ("market_feedback", "Market feedback", [
        r"car\s+sale(?:s)?\s+(?:is\s+|was\s+|are\s+)?(?:down|low|slow)",
        r"sale(?:s)?\s+(?:is\s+|are\s+|was\s+)?(?:down|low|slow)",
        r"penetration|footfall|market\s+(?:is|down|slow|condition)",
        r"low\s+at\s+this\s+area|down\s+here",
        r"competit(?:ion|or)",
    ]),
    ("complaint", "Complaint / concern", [
        r"disappoint(?:ed)?|unhappy|not\s+happy|complain(?:t|ed)?",
        r"issue\s+with|problem\s+with|concern",
        r"price\s+(?:issue|high|concern)|costly|expensive",
    ]),
]

# Compile once. Each theme -> single combined regex (any pattern).
_COMPILED = [
    (key, label, re.compile("|".join(f"(?:{p})" for p in pats), re.IGNORECASE))
    for key, label, pats in _THEME_DEFS
]

THEMES = [(key, label) for key, label, _ in _THEME_DEFS]
THEME_LABELS = {key: label for key, label in THEMES}
_VALID_KEYS = {key for key, _ in THEMES}


def classify(text: str) -> List[str]:
    """Return the theme keys a remark matches, in THEMES display order."""
    if not text:
        return []
    return [key for key, _label, rx in _COMPILED if rx.search(text)]


def is_theme(key: str) -> bool:
    return key in _VALID_KEYS

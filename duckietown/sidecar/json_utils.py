"""
json_utils.py — tiny shared helper for stripping markdown code fences off
a model's JSON response. Factored out of organise.py so rename.py doesn't
duplicate it.
"""

import re


def strip_json_fences(raw: str) -> str:
    raw = re.sub(r"```(?:json)?", "", raw).strip()
    return raw.strip("`").strip()

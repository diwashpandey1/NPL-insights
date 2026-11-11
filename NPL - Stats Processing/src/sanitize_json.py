"""
src/sanitize_json.py
====================
Phase 1, Step 1 — Fix corrupted npl_api.json (trailing comma at L1103).

Approach
--------
Applies a battle-tested regex pass that removes all *trailing commas* appearing
immediately before a closing brace `}` or bracket `]`, which is the single
class of error that makes the file unparseable. After sanitization the result
is validated by round-tripping through ``json.loads`` before writing.

Usage
-----
    python src/sanitize_json.py                     # fixes npl_api.json in-place
    python src/sanitize_json.py --dry-run           # print diff only, no write
    python src/sanitize_json.py --validate-only     # just check current state
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
RAW_JSON_PATH: Path = Path("data/raw/source/json_data/npl_api.json")

# Matches a trailing comma before ] or }, allowing optional whitespace/newlines
_TRAILING_COMMA_RE = re.compile(r",\s*(\]|\})", re.MULTILINE)


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------
def sanitize_json_text(text: str) -> str:
    """Remove all trailing commas before ``]`` or ``}`` in a JSON string.

    Parameters
    ----------
    text:
        Raw JSON string potentially containing trailing commas.

    Returns
    -------
    str
        Cleaned JSON string that should be parseable by ``json.loads``.
    """
    return _TRAILING_COMMA_RE.sub(r"\1", text)


def validate_json(text: str) -> dict | list:
    """Parse *text* as JSON, raising ``json.JSONDecodeError`` on failure.

    Parameters
    ----------
    text:
        JSON string to validate.

    Returns
    -------
    dict | list
        The parsed Python object.

    Raises
    ------
    json.JSONDecodeError
        If the string is not valid JSON even after sanitization.
    """
    return json.loads(text)


def fix_json_file(
    path: Path,
    *,
    dry_run: bool = False,
    validate_only: bool = False,
) -> bool:
    """Read, sanitize, validate, and optionally write-back a JSON file.

    Parameters
    ----------
    path:
        Filesystem path to the JSON file.
    dry_run:
        If ``True`` the sanitized content is printed but **not** saved.
    validate_only:
        If ``True`` the current file is only checked for JSON validity; no
        sanitization or writing occurs.

    Returns
    -------
    bool
        ``True`` if the file was successfully validated (and written when
        applicable), ``False`` otherwise.
    """
    if not path.exists():
        print(f"[ERROR] File not found: {path}", file=sys.stderr)
        return False

    raw_text: str = path.read_text(encoding="utf-8")

    # ------------------------------------------------------------------ validate-only
    if validate_only:
        try:
            validate_json(raw_text)
            print(f"[OK] {path} is already valid JSON — no changes needed.")
            return True
        except json.JSONDecodeError as exc:
            print(f"[FAIL] {path} is INVALID JSON: {exc}", file=sys.stderr)
            return False

    # ------------------------------------------------------------------ sanitize
    cleaned_text: str = sanitize_json_text(raw_text)

    try:
        parsed = validate_json(cleaned_text)
    except json.JSONDecodeError as exc:
        print(
            f"[ERROR] Sanitization was insufficient — JSON still invalid: {exc}",
            file=sys.stderr,
        )
        return False

    top_level_count: int = (
        len(parsed) if isinstance(parsed, (list, dict)) else -1
    )
    removed_commas: int = len(_TRAILING_COMMA_RE.findall(raw_text))

    print(
        f"[INFO] Trailing commas removed : {removed_commas}\n"
        f"[INFO] Top-level items         : {top_level_count}\n"
        f"[INFO] File                    : {path}"
    )

    if dry_run:
        print("[DRY-RUN] File NOT written — cleaned content preview (first 400 chars):")
        print(cleaned_text[:400])
        return True

    # ------------------------------------------------------------------ write-back
    path.write_text(cleaned_text, encoding="utf-8")
    print(f"[OK] Sanitized JSON written to {path}")
    return True


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fix trailing-comma JSON errors in npl_api.json."
    )
    parser.add_argument(
        "--path",
        type=Path,
        default=RAW_JSON_PATH,
        help="Path to the target JSON file (default: %(default)s).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview the sanitized output without writing.",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Check if the file is already valid JSON; do not modify.",
    )
    args = parser.parse_args()

    success = fix_json_file(
        args.path,
        dry_run=args.dry_run,
        validate_only=args.validate_only,
    )
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

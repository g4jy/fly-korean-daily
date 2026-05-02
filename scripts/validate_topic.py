#!/usr/bin/env python3
"""Validate + auto-fix a single topic JSON produced by a content-writer subagent.

Used by the manual-content fallback pipeline (Path C in master §11). Subagent
output is high quality but occasionally has minor structural issues:
  - vocab not sorted by Hangul codepoint
  - vocab count off by 1 from spec
  - 적-ending adjectival nouns labeled pos=adjective when kr is bare (no 이다)

This script normalizes those issues deterministically without touching the
Korean content itself, then validates the result. Re-runs are idempotent.

Usage:
    python scripts/validate_topic.py <path-to-topic.json>

Returns 0 on PASS (file may have been auto-fixed in place), non-zero on FAIL
when issues can't be auto-corrected (missing levels, missing required fields,
JSON parse error). Auto-fix actions are logged to stdout.
"""
import json
import sys
from pathlib import Path


SPEC_VOCAB = {"k1": 5, "k2": 8, "k3": 12, "k4": 15, "k5": 18}
SPEC_QUESTIONS = {"k1": 2, "k2": 3, "k3": 4, "k4": 5, "k5": 5}
EXPECTED_LEVELS = ["k1", "k2", "k3", "k4", "k5"]


def fix_pos(v: dict) -> bool:
    """Reclassify pos when the kr form clearly contradicts the label.
    Returns True if a change was made."""
    kr = v.get("kr", "")
    pos = v.get("pos", "")
    # Adjectival-noun (X-적): kr is bare, but labeled adjective. Reclassify as noun.
    if pos == "adjective" and kr.endswith("적") and len(kr) >= 2:
        v["pos"] = "noun"
        return True
    # Verb/adjective MUST end in 다. If not, demote to noun (best effort).
    if pos in ("verb", "adjective") and not kr.endswith("다"):
        v["pos"] = "noun"
        return True
    return False


def fix_missing_title(lvl: dict) -> bool:
    """If `title` is missing or empty, derive one from the first sentence of `text`.
    Subagents occasionally skip the title field — better to auto-derive than fail."""
    import re
    if lvl.get("title"):
        return False
    text = lvl.get("text", "")
    if not text:
        return False
    # Take content up to first terminator (Korean . ? ! 。) or 35 chars max.
    m = re.match(r"[^.?!。\n]{1,35}", text)
    title = (m.group(0) if m else text[:30]).strip()
    if title:
        lvl["title"] = title
        return True
    return False


def fix_missing_this_passage(v: dict) -> bool:
    """If no meaning has this_passage:true, mark the first meaning."""
    meanings = v.get("meanings", [])
    if not meanings:
        return False
    if any(m.get("this_passage") for m in meanings):
        return False
    meanings[0]["this_passage"] = True
    return True


def validate_and_fix(path: str) -> int:
    p = Path(path)
    if not p.exists():
        print(f"FAIL: file not found: {path}", file=sys.stderr)
        return 2
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"FAIL: invalid JSON: {e}", file=sys.stderr)
        return 2

    fixes = []
    fatal = []

    # Top-level required fields
    for f in ("id", "category", "source_title", "levels"):
        if f not in d:
            fatal.append(f"missing top-level field: {f}")

    # Levels
    for lk in EXPECTED_LEVELS:
        if lk not in d.get("levels", {}):
            fatal.append(f"missing level: {lk}")
            continue
        lvl = d["levels"][lk]

        # Auto-derive title from text if missing — subagents sometimes skip it.
        if fix_missing_title(lvl):
            fixes.append(f"{lk}: derived title from first sentence of text")

        for f in ("title", "text", "vocab", "questions"):
            if f not in lvl:
                fatal.append(f"{lk} missing field: {f}")

        # Should NOT have token_map (Python adds it later)
        if "token_map" in lvl:
            del lvl["token_map"]
            fixes.append(f"{lk}: removed premature token_map field")
        if "audio" in lvl:
            del lvl["audio"]
            fixes.append(f"{lk}: removed premature audio field")

        # Vocab fixes
        vocab = lvl.get("vocab", [])
        # 1) reclassify pos where kr contradicts label, fix this_passage marker
        for i, v in enumerate(vocab):
            if fix_pos(v):
                fixes.append(f"{lk} vocab[{i}] kr={v['kr']}: pos -> {v['pos']}")
            if fix_missing_this_passage(v):
                fixes.append(f"{lk} vocab[{i}] kr={v.get('kr','')}: marked first meaning this_passage:true")
        # 2) trim or warn on count mismatch
        target = SPEC_VOCAB.get(lk, len(vocab))
        if len(vocab) > target:
            removed = vocab[target:]
            lvl["vocab"] = vocab[:target]
            fixes.append(f"{lk}: trimmed vocab {len(vocab)} -> {target} (removed {len(removed)} extras)")
            vocab = lvl["vocab"]
        elif len(vocab) < target:
            fatal.append(f"{lk}: vocab count {len(vocab)} below target {target} (cannot auto-fix)")
        # 3) sort by Hangul codepoint
        sorted_vocab = sorted(vocab, key=lambda v: v.get("kr", ""))
        if sorted_vocab != vocab:
            lvl["vocab"] = sorted_vocab
            fixes.append(f"{lk}: sorted vocab by Hangul codepoint")

        # Per-vocab validation
        for i, v in enumerate(lvl["vocab"]):
            for f in ("kr", "en", "pos"):
                if not v.get(f):
                    fatal.append(f"{lk} vocab[{i}] missing required field: {f}")
            meanings = v.get("meanings", [])
            if not meanings:
                fatal.append(f"{lk} vocab[{i}] kr={v.get('kr')}: missing meanings array")
            elif not any(m.get("this_passage") for m in meanings):
                fatal.append(f"{lk} vocab[{i}] kr={v.get('kr')}: no this_passage:true meaning")

        # Questions count
        q_target = SPEC_QUESTIONS.get(lk)
        questions = lvl.get("questions", [])
        if q_target and len(questions) != q_target:
            if len(questions) > q_target:
                lvl["questions"] = questions[:q_target]
                fixes.append(f"{lk}: trimmed questions {len(questions)} -> {q_target}")
            else:
                fatal.append(f"{lk}: questions count {len(questions)} below target {q_target}")

    # Report
    print(f"=== Validation report: {p.name} ===")
    if fixes:
        print(f"AUTO-FIXED ({len(fixes)}):")
        for f in fixes:
            print(f"  - {f}")
    if fatal:
        print(f"FATAL ({len(fatal)}):")
        for f in fatal:
            print(f"  - {f}")
        return 1
    if fixes:
        # Write back the fixed JSON
        p.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"PASS (after {len(fixes)} fixes, file rewritten)")
    else:
        print("PASS (no changes needed)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate_topic.py <path-to-topic.json>", file=sys.stderr)
        sys.exit(1)
    sys.exit(validate_and_fix(sys.argv[1]))

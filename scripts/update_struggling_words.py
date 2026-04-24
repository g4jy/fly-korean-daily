#!/usr/bin/env python3
"""Append student struggling words to per-student caches.

Called by the evening feedback routine with a JSON file containing grading output:

    python scripts/update_struggling_words.py /tmp/feedback.json

Input shape (list of graded submissions):
    [
      {"student": "Sophie", "struggling_words": ["축제", "벚꽃"], ...},
      ...
    ]

Writes/merges into: data/_cache/struggling_<student>.json
"""
import json
import sys
from datetime import datetime
from pathlib import Path


CACHE_DIR = Path("data/_cache")
MAX_WORDS_PER_STUDENT = 80


def load_cache(student: str) -> dict:
    p = CACHE_DIR / f"struggling_{student}.json"
    if not p.exists():
        return {"student": student, "words": [], "updated": None}
    return json.loads(p.read_text(encoding="utf-8"))


def save_cache(cache: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    student = cache["student"]
    p = CACHE_DIR / f"struggling_{student}.json"
    p.write_text(
        json.dumps(cache, indent=2, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )


def merge_words(cache: dict, new_words: list[str]) -> dict:
    today = datetime.utcnow().date().isoformat()
    existing = {w["kr"]: w for w in cache.get("words", [])}
    for kr in new_words:
        if not kr:
            continue
        if kr in existing:
            existing[kr]["count"] += 1
            existing[kr]["last_seen"] = today
        else:
            existing[kr] = {"kr": kr, "count": 1, "first_seen": today, "last_seen": today}
    words = sorted(existing.values(), key=lambda w: (-w["count"], w["last_seen"]))[:MAX_WORDS_PER_STUDENT]
    cache["words"] = words
    cache["updated"] = datetime.utcnow().isoformat() + "Z"
    return cache


def main(feedback_path: str) -> int:
    feedback = json.loads(Path(feedback_path).read_text(encoding="utf-8"))
    by_student: dict[str, list[str]] = {}
    for entry in feedback:
        student = entry.get("student")
        words = entry.get("struggling_words") or []
        if not student:
            continue
        by_student.setdefault(student, []).extend(words)

    if not by_student:
        print("No struggling words to record.")
        return 0

    for student, words in by_student.items():
        cache = load_cache(student)
        cache = merge_words(cache, words)
        save_cache(cache)
        print(f"{student}: recorded {len(words)} struggling word(s); total tracked = {len(cache['words'])}")

    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: update_struggling_words.py <path-to-feedback-json>")
        sys.exit(1)
    sys.exit(main(sys.argv[1]))

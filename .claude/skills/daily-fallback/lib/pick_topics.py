#!/usr/bin/env python3
"""Pick N fresh topics for fly-korean-daily, avoiding recent overlap.

Reads the last 14 days of data/<date>.json files, collects:
  - topic IDs already used (avoid set)
  - per-category usage counts (for category rotation)

Outputs a JSON spec to stdout that the orchestrator passes to subagents.

Usage:
    python pick_topics.py --date 2026-04-29 --count 5
        [--repo-root G:/path/to/fly-korean-daily]
        [--lookback-days 14]
"""
import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path


# Twelve canonical categories (alphabetical, per routine-prompt.md schema)
CATEGORIES = [
    "Business", "Culture", "Daily Life", "Education", "Entertainment",
    "Health", "Korea", "Politics", "Science", "Sports", "Technology",
    "Travel", "World",
]


def load_recent_data(repo_root: Path, today: date, lookback_days: int):
    """Return dict of {date_str: data_dict} for files within lookback window."""
    out = {}
    data_dir = repo_root / "data"
    if not data_dir.exists():
        return out
    cutoff = today - timedelta(days=lookback_days)
    for p in data_dir.glob("20*.json"):
        stem = p.stem
        # Skip review/feedback files (e.g. 2026-04-22_review_QA2)
        if "_review_" in stem or "_feedback" in stem:
            continue
        try:
            d = datetime.strptime(stem, "%Y-%m-%d").date()
        except ValueError:
            continue
        if d < cutoff:
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"WARN: skipping {p.name}: {e}", file=sys.stderr)
            continue
        out[stem] = data
    return out


def pick(date_str: str, count: int, repo_root: Path, lookback_days: int) -> dict:
    today = datetime.strptime(date_str, "%Y-%m-%d").date()
    recent = load_recent_data(repo_root, today, lookback_days)

    avoid_ids = set()
    cat_counts = Counter()
    for d_str, data in recent.items():
        for t in data.get("topics", []):
            tid = t.get("id")
            if tid:
                avoid_ids.add(tid)
            cat = t.get("category")
            if cat:
                cat_counts[cat] += 1

    # Rotate categories: pick the N least-used categories first.
    # Tie-break alphabetically for determinism.
    by_use = sorted(CATEGORIES, key=lambda c: (cat_counts.get(c, 0), c))
    picked_cats = by_use[:count]

    return {
        "date": date_str,
        "count": count,
        "categories": picked_cats,
        "avoid_ids": sorted(avoid_ids),
        "lookback_days": lookback_days,
        "category_use_history": dict(cat_counts),
    }


def _auto_repo_root() -> Path:
    """Walk up from this script until we find a `data/` + `scripts/` sibling pair.
    Works whether this script lives inside the repo (.claude/skills/) or outside."""
    _here = Path(__file__).resolve()
    for p in _here.parents:
        if (p / "data").is_dir() and (p / "scripts").is_dir():
            return p
    return Path.cwd()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=date.today().isoformat(),
                    help="Target date (YYYY-MM-DD), default today")
    ap.add_argument("--count", type=int, default=5,
                    help="Number of topics to plan, default 5")
    ap.add_argument("--repo-root", default=str(_auto_repo_root()),
                    help="fly-korean-daily repo root (auto-detected from script location)")
    ap.add_argument("--lookback-days", type=int, default=14,
                    help="How many recent days of data/ to inspect for dedup")
    args = ap.parse_args()

    repo_root = Path(args.repo_root)
    if not repo_root.exists():
        print(f"ERROR: repo root not found: {repo_root}", file=sys.stderr)
        return 2

    plan = pick(args.date, args.count, repo_root, args.lookback_days)
    print(json.dumps(plan, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

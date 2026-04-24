#!/usr/bin/env python3
"""Purge old dated content to keep the repo under GitHub's soft limits.

Usage:
    python scripts/purge_old_content.py --keep-days 30

Deletes data/<YYYY-MM-DD>.json and audio/<YYYY-MM-DD>/ directories older than the cutoff.
Leaves data/latest.json and data/index.json untouched.
"""
import argparse
import datetime
import re
import shutil
import sys
from pathlib import Path


DATE_RE = re.compile(r"^20\d{2}-\d{2}-\d{2}$")


def old_dates(keep_days: int) -> set[str]:
    cutoff = datetime.date.today() - datetime.timedelta(days=keep_days)
    old = set()
    for p in Path("data").glob("20*.json"):
        name = p.stem
        if DATE_RE.match(name):
            try:
                d = datetime.date.fromisoformat(name)
                if d < cutoff:
                    old.add(name)
            except ValueError:
                continue
    for p in Path("audio").glob("20*"):
        name = p.name
        if DATE_RE.match(name):
            try:
                d = datetime.date.fromisoformat(name)
                if d < cutoff:
                    old.add(name)
            except ValueError:
                continue
    return old


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    to_delete = old_dates(args.keep_days)
    if not to_delete:
        print(f"Nothing to purge (keeping last {args.keep_days} days).")
        return 0

    print(f"Purging {len(to_delete)} old date(s)...")
    for d in sorted(to_delete):
        json_path = Path(f"data/{d}.json")
        audio_dir = Path(f"audio/{d}")
        if json_path.exists():
            if args.dry_run: print(f"  DRY: rm {json_path}")
            else: json_path.unlink(); print(f"  rm {json_path}")
        if audio_dir.exists() and audio_dir.is_dir():
            if args.dry_run: print(f"  DRY: rmdir {audio_dir}")
            else: shutil.rmtree(audio_dir); print(f"  rmdir {audio_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

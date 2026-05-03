#!/usr/bin/env python3
"""Move old dated content to long-term archive (preserves teacher reference value).

Old behavior was DELETE — that lost teacher-side data forever after 30 days.
New behavior: MOVE old data/<YYYY-MM-DD>.json into data/_archive/<YYYY-MM>/<YYYY-MM-DD>.json
and old audio/<YYYY-MM-DD>/ into _archive/audio/<YYYY-MM>/<YYYY-MM-DD>/.

This keeps the active data/ folder small for fast page loads while preserving
the full teaching corpus for retrospective analysis (Goal #5 in the requirement
list — "지금껏 배포된 텍스트 잘 정리되어 있음").

Usage:
    python scripts/purge_old_content.py --keep-days 30
    python scripts/purge_old_content.py --keep-days 30 --dry-run
    python scripts/purge_old_content.py --keep-days 30 --hard-delete    # legacy mode
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
        if not DATE_RE.match(name):
            continue
        try:
            d = datetime.date.fromisoformat(name)
        except ValueError:
            continue
        if d < cutoff:
            old.add(name)
    for p in Path("audio").glob("20*"):
        name = p.name
        if not DATE_RE.match(name):
            continue
        try:
            d = datetime.date.fromisoformat(name)
        except ValueError:
            continue
        if d < cutoff:
            old.add(name)
    return old


def archive_one(date_str: str, dry_run: bool, hard_delete: bool) -> None:
    """Move (or delete) one date's content. Skip if already archived/missing."""
    yyyymm = date_str[:7]   # "2026-04"
    json_src = Path(f"data/{date_str}.json")
    audio_src = Path(f"audio/{date_str}")

    if hard_delete:
        if json_src.exists():
            print(f"  rm {json_src}")
            if not dry_run:
                json_src.unlink()
        if audio_src.exists() and audio_src.is_dir():
            print(f"  rmdir {audio_src}")
            if not dry_run:
                shutil.rmtree(audio_src)
        return

    # Soft-archive path: preserve content under _archive/
    json_dst_dir = Path(f"data/_archive/{yyyymm}")
    json_dst = json_dst_dir / f"{date_str}.json"
    audio_dst_dir = Path(f"_archive/audio/{yyyymm}")
    audio_dst = audio_dst_dir / date_str

    if json_src.exists():
        if json_dst.exists():
            print(f"  skip-json (already archived): {date_str}")
            if not dry_run:
                json_src.unlink()
        else:
            print(f"  mv {json_src} -> {json_dst}")
            if not dry_run:
                json_dst_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(json_src), str(json_dst))
    if audio_src.exists() and audio_src.is_dir():
        if audio_dst.exists():
            print(f"  skip-audio (already archived): {date_str}")
            if not dry_run:
                shutil.rmtree(audio_src)
        else:
            print(f"  mv {audio_src}/ -> {audio_dst}/")
            if not dry_run:
                audio_dst_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(audio_src), str(audio_dst))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-days", type=int, default=30,
                    help="Keep this many recent days in active data/. Older content moves to _archive/.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--hard-delete", action="store_true",
                    help="Legacy mode: DELETE old content instead of archiving. Avoid unless space-constrained.")
    args = ap.parse_args()

    to_purge = old_dates(args.keep_days)
    if not to_purge:
        print(f"Nothing to purge (keeping last {args.keep_days} days).")
        return 0

    mode = "DELETE" if args.hard_delete else "ARCHIVE"
    if args.dry_run:
        mode = f"{mode} (DRY RUN)"
    print(f"{mode}: {len(to_purge)} old date(s)")
    for d in sorted(to_purge):
        archive_one(d, dry_run=args.dry_run, hard_delete=args.hard_delete)
    return 0


if __name__ == "__main__":
    sys.exit(main())

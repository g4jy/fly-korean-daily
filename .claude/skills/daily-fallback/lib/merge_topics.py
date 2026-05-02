#!/usr/bin/env python3
"""Merge per-topic JSON files from .micro workspace into data/<date>.json.

Pipeline:
  1. Glob .micro/fkd_<date>/topic_*.json
  2. For each: run validate_topic.py (auto-fix structural issues)
  3. Merge survivors into single daily JSON
  4. Sort topics by category, then by id (deterministic)
  5. Run scripts/upgrade_sample.py (kiwipiepy token_map derivation)
  6. Update data/index.json + ensure data/latest.json reflects newest

Usage:
    python merge_topics.py --date 2026-04-29
        [--repo-root G:/path/to/fly-korean-daily]
        [--source manual-fallback-via-subagents]
"""
import argparse
import datetime as dt
import glob
import json
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


KST = timezone(timedelta(hours=9))


def run_python(script: Path, *args, cwd: Path = None) -> tuple[int, str]:
    cmd = [sys.executable, str(script), *args]
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def validate_topic_files(topic_files: list[Path], validate_script: Path) -> tuple[list[Path], list[Path]]:
    """Run validator on each topic file. Return (passing, failing) lists."""
    passing = []
    failing = []
    for tf in sorted(topic_files):
        rc, out = run_python(validate_script, str(tf))
        print(f"--- {tf.name} ---")
        # Suppress per-line Korean characters by replacing on output stream
        try:
            print(out)
        except UnicodeEncodeError:
            print(out.encode("ascii", errors="replace").decode("ascii"))
        if rc == 0:
            passing.append(tf)
        else:
            failing.append(tf)
    return passing, failing


def merge(date_str: str, repo_root: Path, source_label: str) -> int:
    micro_dir = repo_root / ".micro" / f"fkd_{date_str}"
    if not micro_dir.exists():
        print(f"ERROR: micro dir not found: {micro_dir}", file=sys.stderr)
        return 2

    topic_files = list(micro_dir.glob("topic_*.json"))
    if not topic_files:
        print(f"ERROR: no topic_*.json files in {micro_dir}", file=sys.stderr)
        return 2

    print(f"Found {len(topic_files)} topic files")

    # 1. Validate (auto-fix in place where possible)
    validate_script = repo_root / "scripts" / "validate_topic.py"
    if not validate_script.exists():
        print(f"ERROR: validator not found: {validate_script}", file=sys.stderr)
        return 2
    passing, failing = validate_topic_files(topic_files, validate_script)
    print(f"\nValidation: {len(passing)} pass / {len(failing)} fail")
    if failing:
        print("FAILING files (excluded from merge):")
        for f in failing:
            print(f"  - {f.name}")

    if not passing:
        print("ERROR: no valid topics to merge", file=sys.stderr)
        return 1

    # 2. Merge
    topics = []
    for tf in passing:
        topics.append(json.loads(tf.read_text(encoding="utf-8")))
    topics.sort(key=lambda t: (t.get("category", ""), t.get("id", "")))

    now_kst = datetime.now(KST).replace(microsecond=0).isoformat()
    merged = {
        "date": date_str,
        "generated_at": now_kst,
        "source": source_label,
        "topics": topics,
    }
    out_path = repo_root / "data" / f"{date_str}.json"
    out_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nMerged {len(topics)} topics -> {out_path.name} ({out_path.stat().st_size} bytes)")
    print(f"Categories: {sorted(set(t['category'] for t in topics))}")
    print(f"IDs: {[t['id'] for t in topics]}")

    # 3. Run upgrade_sample.py to derive token_map (uses kiwipiepy)
    upgrade_script = repo_root / "scripts" / "upgrade_sample.py"
    rc, out = run_python(upgrade_script, str(out_path), cwd=repo_root)
    print(f"\nupgrade_sample.py output:")
    print(out)
    if rc != 0:
        print(f"WARN: upgrade_sample.py exited {rc}", file=sys.stderr)

    # 4. Update data/index.json
    data_dir = repo_root / "data"
    files = sorted([
        p.stem for p in data_dir.glob("20*.json")
        if "_review_" not in p.stem and "_feedback" not in p.stem
    ])
    idx_path = data_dir / "index.json"
    idx = {"latest": files[-1] if files else None, "dates": files}
    idx_path.write_text(json.dumps(idx, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nindex.json: latest={idx['latest']}, {len(files)} dates")

    return 0


def _auto_repo_root() -> Path:
    _here = Path(__file__).resolve()
    for p in _here.parents:
        if (p / "data").is_dir() and (p / "scripts").is_dir():
            return p
    return Path.cwd()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=date.today().isoformat())
    ap.add_argument("--repo-root", default=str(_auto_repo_root()),
                    help="fly-korean-daily repo root (auto-detected from script location)")
    ap.add_argument("--source", default="manual-fallback-via-subagents",
                    help="Provenance label written to merged JSON's 'source' field")
    args = ap.parse_args()
    repo_root = Path(args.repo_root)
    return merge(args.date, repo_root, args.source)


if __name__ == "__main__":
    sys.exit(main())

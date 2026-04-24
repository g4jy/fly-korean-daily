#!/usr/bin/env python3
"""Generate Korean TTS audio for a daily JSON file using edge-tts.

Usage:
    python scripts/generate_tts.py data/2026-04-22.json

Reads each topic's per-level `text` + `title` + `questions[].q_kr` and writes one MP3
per (topic, level) to audio/<date>/<topic_id>_<level>.mp3.

Voice: ko-KR-SunHiNeural (natural female Korean).
Fallback voice env: FKD_TTS_VOICE (e.g. ko-KR-InJoonNeural for male).
"""
import asyncio
import json
import os
import sys
from pathlib import Path

try:
    import edge_tts
except ImportError:
    print("ERROR: edge-tts not installed. Run: pip install edge-tts", file=sys.stderr)
    sys.exit(1)


VOICE = os.environ.get("FKD_TTS_VOICE", "ko-KR-SunHiNeural")
RATE = os.environ.get("FKD_TTS_RATE", "-5%")  # slightly slower for learners


async def synth(text: str, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    comm = edge_tts.Communicate(text=text, voice=VOICE, rate=RATE)
    await comm.save(str(out_path))


def passage_script(level: dict) -> str:
    """Compose the spoken script for a level: title, pause, full passage."""
    parts = []
    title = level.get("title", "").strip()
    if title:
        parts.append(title)
    text = level.get("text", "").strip()
    if text:
        parts.append(text)
    # Stitch paragraphs with sentence-friendly pauses
    return "\n\n".join(parts)


async def main(json_path: str) -> int:
    data = json.loads(Path(json_path).read_text(encoding="utf-8"))
    date = data.get("date")
    if not date:
        print("ERROR: JSON missing 'date' field", file=sys.stderr)
        return 1

    audio_dir = Path(f"audio/{date}")
    audio_dir.mkdir(parents=True, exist_ok=True)

    tasks = []
    plan = []
    for topic in data.get("topics", []):
        tid = topic["id"]
        for level_key, level in (topic.get("levels") or {}).items():
            out = audio_dir / f"{tid}_{level_key}.mp3"
            if out.exists() and out.stat().st_size > 1024:
                continue  # skip already-generated (idempotent)
            script = passage_script(level)
            if not script:
                continue
            plan.append((script, out))

    if not plan:
        print(f"TTS: nothing to generate (all {len(tasks)} files already exist).")
        return 0

    # Generate sequentially (edge-tts is rate-limited; parallel too many tends to fail)
    print(f"TTS: generating {len(plan)} file(s) with voice={VOICE} rate={RATE}")
    ok = 0
    fail = 0
    for i, (script, out) in enumerate(plan, 1):
        try:
            await synth(script, out)
            size = out.stat().st_size
            print(f"  [{i}/{len(plan)}] {out.name}  {size//1024} KB")
            ok += 1
        except Exception as e:
            print(f"  [{i}/{len(plan)}] {out.name}  FAILED: {e}")
            fail += 1

    print(f"TTS done: {ok} ok, {fail} failed")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: generate_tts.py <path-to-daily-json>")
        sys.exit(1)
    sys.exit(asyncio.run(main(sys.argv[1])))

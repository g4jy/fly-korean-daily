#!/usr/bin/env python3
"""
Daily content generator for Fly Korean Daily.

Runs on GitHub Actions at 06:00 KST daily. Calls Anthropic API one-level-at-a-time
to avoid any stream/timeout issues, writes the JSON progressively, derives token_map
via upgrade_sample.py, generates TTS via edge-tts, commits, and pushes.

Environment variables required:
  ANTHROPIC_API_KEY
  TELEGRAM_BOT_TOKEN   (optional — skipped if unset)
  TELEGRAM_CHAT_ID     (optional)
  FKD_MODEL            (optional, default: claude-sonnet-4-6)
  FKD_TARGET_TOPICS    (optional, default: 5)

Exits 0 on success, non-zero on failure. Pushes errors to Telegram if configured.
"""
import datetime as dt
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

try:
    import anthropic
except ImportError:
    print("ERROR: anthropic package not installed. pip install anthropic", file=sys.stderr)
    sys.exit(1)


API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not API_KEY:
    print("ERROR: ANTHROPIC_API_KEY env var not set", file=sys.stderr)
    sys.exit(1)

MODEL = os.environ.get("FKD_MODEL", "claude-sonnet-4-6")
TARGET_TOPICS = int(os.environ.get("FKD_TARGET_TOPICS", "5"))
TELE_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELE_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")

KST = dt.timezone(dt.timedelta(hours=9))
TODAY = dt.datetime.now(KST).strftime("%Y-%m-%d")
NOW_ISO = dt.datetime.now(KST).isoformat(timespec="seconds")

ROOT = Path(".")
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DAILY_PATH = DATA_DIR / f"{TODAY}.json"
LATEST_PATH = DATA_DIR / "latest.json"
INDEX_PATH = DATA_DIR / "index.json"


client = anthropic.Anthropic(api_key=API_KEY)


CATEGORIES = [
    ("Business", "economy, markets, companies"),
    ("Culture", "arts, heritage, film, literature (non-K-pop)"),
    ("Education", "schools, universities, learning"),
    ("Entertainment", "K-pop, K-drama, celebrities"),
    ("Health", "medicine, wellness, research"),
    ("Korea", "domestic Korean news not fitting elsewhere"),
    ("Politics", "government, elections, policy"),
    ("Science", "research, space, environment"),
    ("Sports", "all sports"),
    ("Technology", "tech, AI, gadgets"),
    ("Travel", "tourism, destinations"),
    ("World", "international news"),
]

LEVEL_SPEC = {
    "k1": {"paragraphs": 1, "sentences": "7-10", "chars": 200,
           "style": "Very short sentences. Basic vocab (native Korean > Sino-Korean). Present tense dominant.",
           "vocab": "5-7", "questions": 2, "q_types": "factual (direct recall, 1 sentence answer)"},
    "k2": {"paragraphs": 2, "sentences": "25-35", "chars": 750,
           "style": "Simple connectors (그리고, 하지만, 그래서). Basic past/present. Limited Sino-Korean.",
           "vocab": "8-10", "questions": 3, "q_types": "factual + yesno-plus (yes/no that explicitly asks '왜 그렇게 생각해요?' for complete-sentence answer)"},
    "k3": {"paragraphs": 4, "sentences": "60-80", "chars": 2400,
           "style": "Natural newspaper register. Mixed tenses. Sino-Korean freely. Causal reasoning.",
           "vocab": "12-15", "questions": 4, "q_types": "factual + reasoning + inference (NO yesno at this level)"},
    "k4": {"paragraphs": 6, "sentences": "90-120", "chars": 3600,
           "style": "Formal written register (문어체). Nominalization, complex clauses. 수능-level multi-angle analysis.",
           "vocab": "15-20", "questions": 5,
           "q_types": "reasoning + inference + synthesis (+ opinion ONLY when passage genuinely presents competing views, otherwise substitute another type)"},
}


# ---------- News gathering ----------

def fetch_news() -> list[dict]:
    """Fetch trending news headlines across categories using Google News RSS."""
    headlines = []
    for topic in ["BUSINESS", "TECHNOLOGY", "ENTERTAINMENT", "SPORTS", "SCIENCE", "HEALTH", "WORLD"]:
        url = f"https://news.google.com/rss/headlines/section/topic/{topic}?hl=ko&gl=KR&ceid=KR:ko"
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=15) as resp:
                xml = resp.read().decode("utf-8", errors="ignore")
            root = ET.fromstring(xml)
            for item in root.findall(".//item")[:4]:
                title = (item.findtext("title") or "").strip()
                link = (item.findtext("link") or "").strip()
                if title:
                    headlines.append({"category": _map_rss_to_cat(topic), "title": title, "url": link})
        except Exception as e:
            print(f"news fetch failed for {topic}: {e}", file=sys.stderr)
    print(f"fetched {len(headlines)} headlines across categories: {sorted(set(h['category'] for h in headlines))}")
    return headlines


def _map_rss_to_cat(rss_topic: str) -> str:
    return {
        "BUSINESS": "Business", "TECHNOLOGY": "Technology", "ENTERTAINMENT": "Entertainment",
        "SPORTS": "Sports", "SCIENCE": "Science", "HEALTH": "Health", "WORLD": "World",
    }.get(rss_topic, "Korea")


# ---------- Topic selection via API ----------

def pick_topics(headlines: list[dict], count: int) -> list[dict]:
    """Ask Claude to pick N diverse, learner-appropriate topics from the headlines."""
    if not headlines:
        raise RuntimeError("no headlines fetched")

    cat_list = "\n".join(f"- {h['category']}: {h['title']}" for h in headlines[:60])

    resp = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        messages=[{
            "role": "user",
            "content": f"""You are selecting {count} news stories for a Korean-learning reading app today ({TODAY}).

Candidate headlines (English-translated from Korean/world news):
{cat_list}

Pick exactly {count} stories with these priorities:
1. Cover DIVERSE categories — no two from the same category if possible.
2. Appropriate for adult language learners (no graphic violence, no politically inflammatory framing, no explicit sexual content).
3. Interesting cross-culturally for non-Korean learners.

Return ONLY a JSON array of objects, each with: `id` (kebab-case slug, English), `category`, `source_title` (keep original), `source_url` (keep original), `summary` (2-3 sentence English factual summary you will use to generate Korean content).

Return ONLY the JSON array. No prose, no markdown fences."""
        }]
    )
    text = resp.content[0].text.strip()
    # Strip markdown fences if present
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"): text = text[4:]
        text = text.rsplit("```", 1)[0] if "```" in text else text
    topics = json.loads(text.strip())
    # Attach original URL if summary LLM dropped it
    url_by_title = {h["title"]: h["url"] for h in headlines}
    for t in topics:
        if not t.get("source_url"):
            t["source_url"] = url_by_title.get(t.get("source_title", ""), "")
    print(f"picked {len(topics)} topics: {[(t['category'], t['id']) for t in topics]}")
    return topics


# ---------- Level generation ----------

def generate_level(topic: dict, level: str) -> dict:
    """Generate a single level's content via Claude API. Small response per call."""
    spec = LEVEL_SPEC[level]
    prompt = f"""You are generating Korean reading material for an adult language learner.

Topic: {topic['source_title']}
Category: {topic['category']}
English summary: {topic['summary']}

Generate ONLY Level {level} in this exact schema:

{{
  "title": "<short Korean noun phrase>",
  "text": "<plain Korean prose, {spec['paragraphs']} paragraph(s), {spec['sentences']} sentences, ~{spec['chars']} characters total>",
  "vocab": [
    {{"kr": "<dictionary form>", "en": "<short English>", "def": "<1-line Korean or English definition>", "pos": "noun|verb|adjective|adverb|proper-noun|idiom"}}
  ],
  "questions": [
    {{"id": "q1", "type": "<type>", "q_kr": "<Korean question>", "answer_hint": "<short Korean hint>"}}
  ],
  "audio": "audio/{TODAY}/{topic['id']}_{level}.mp3"
}}

Constraints:
1. Text is PLAIN PROSE — no bullets, no markdown bold, no ─ lines, no numbered lists, no headings.
2. Paragraph breaks in "text": use \\n\\n exactly — {spec['paragraphs']} paragraph(s) total.
3. Style: {spec['style']}
4. Vocab count: {spec['vocab']} entries. Sort by Korean codepoint. Dictionary forms only (학생 not 학생이, 먹다 not 먹어요).
5. Questions: exactly {spec['questions']}. Types allowed: {spec['q_types']}.
   - For yesno-plus questions, the q_kr MUST explicitly end with "왜 그렇게 생각해요?" or "이유를 설명해 주세요" to force a full-sentence answer.
   - Every question must be answerable from the passage.
6. No PII, no real children's names, no targeting of private individuals in negative framing.
7. audio path: use exactly "audio/{TODAY}/{topic['id']}_{level}.mp3".

Return ONLY the JSON object. No prose, no markdown fences."""

    resp = client.messages.create(model=MODEL, max_tokens=8000, messages=[{"role": "user", "content": prompt}])
    text = resp.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"): text = text[4:]
        text = text.strip().rsplit("```", 1)[0] if "```" in text else text
    obj = json.loads(text.strip())
    # Defensive: ensure the audio path is right regardless of what the model wrote
    obj["audio"] = f"audio/{TODAY}/{topic['id']}_{level}.mp3"
    return obj


# ---------- Assembly ----------

def load_daily() -> dict:
    if DAILY_PATH.exists():
        return json.loads(DAILY_PATH.read_text(encoding="utf-8"))
    return {"date": TODAY, "generated_at": NOW_ISO, "source": "routine", "topics": []}


def save_daily(data: dict) -> None:
    data["topics"].sort(key=lambda t: (t.get("category", ""), t.get("id", "")))
    DAILY_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def upsert_topic_level(data: dict, topic_meta: dict, level: str, level_data: dict) -> None:
    tid = topic_meta["id"]
    existing = next((t for t in data["topics"] if t.get("id") == tid), None)
    if existing is None:
        existing = {
            "id": tid,
            "category": topic_meta["category"],
            "source_title": topic_meta["source_title"],
            "source_url": topic_meta.get("source_url", ""),
            "levels": {},
        }
        data["topics"].append(existing)
    existing["levels"][level] = level_data


def run_post_processing() -> None:
    """upgrade_sample adds token_map from vocab+text. Then copy to latest.json, rewrite index."""
    subprocess.run([sys.executable, "scripts/upgrade_sample.py", str(DAILY_PATH)], check=True)
    # Copy today to latest
    LATEST_PATH.write_bytes(DAILY_PATH.read_bytes())
    # Rewrite index
    files = sorted(p.stem for p in DATA_DIR.glob("20*.json"))
    INDEX_PATH.write_text(json.dumps({"latest": files[-1] if files else None, "dates": files}, indent=2, ensure_ascii=False), encoding="utf-8")


def generate_tts() -> int:
    """Run edge-tts script. Returns audio file count."""
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "edge-tts"], check=True)
        subprocess.run([sys.executable, "scripts/generate_tts.py", str(DAILY_PATH)], check=True)
    except subprocess.CalledProcessError as e:
        print(f"TTS step failed: {e}", file=sys.stderr)
    count = len(list((ROOT / "audio" / TODAY).glob("*.mp3"))) if (ROOT / "audio" / TODAY).exists() else 0
    return count


# ---------- Git + Telegram ----------

def git_commit_push(topic_count: int, audio_count: int) -> str:
    subprocess.run(["git", "config", "user.name", "fly-korean-daily-bot"], check=True)
    subprocess.run(["git", "config", "user.email", "bot@flykorean.local"], check=True)
    subprocess.run(["git", "add", "data/", "audio/"], check=True)
    msg = f"daily: {TODAY} ({topic_count} topics, {audio_count} audio)"
    # If nothing changed, skip commit
    result = subprocess.run(["git", "diff", "--cached", "--quiet"])
    if result.returncode == 0:
        print("nothing to commit")
        return "no-change"
    subprocess.run(["git", "commit", "-m", msg], check=True)
    subprocess.run(["git", "push"], check=True)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()[:7]
    return sha


def telegram_notify(msg: str) -> bool:
    if not TELE_TOKEN or not TELE_CHAT:
        print("Telegram: skipped (no token/chat)")
        return False
    import urllib.parse, urllib.request
    data = urllib.parse.urlencode({"chat_id": TELE_CHAT, "text": msg}).encode()
    url = f"https://api.telegram.org/bot{TELE_TOKEN}/sendMessage"
    try:
        with urllib.request.urlopen(url, data=data, timeout=10) as r:
            return json.load(r).get("ok", False)
    except Exception as e:
        print(f"Telegram error: {e}", file=sys.stderr)
        return False


# ---------- Main ----------

def main() -> int:
    print(f"Fly Korean Daily generator — {TODAY} — model={MODEL} target={TARGET_TOPICS} topics")

    # 1. Gather news
    headlines = fetch_news()
    if len(headlines) < TARGET_TOPICS:
        telegram_notify(f"⚠️ Fly Korean Daily: only {len(headlines)} headlines for {TODAY}. Skipping.")
        return 2

    # 2. Pick topics
    topics = pick_topics(headlines, TARGET_TOPICS)

    # 3. Generate levels, resuming if a partial run exists
    data = load_daily()
    done_levels = {
        (t["id"], lk): True
        for t in data.get("topics", [])
        for lk, lv in (t.get("levels") or {}).items()
        if lv.get("text")
    }

    for topic in topics:
        for level in ["k1", "k2", "k3", "k4"]:
            if done_levels.get((topic["id"], level)):
                print(f"skip {topic['id']} {level}: already present")
                continue
            t0 = time.time()
            try:
                level_data = generate_level(topic, level)
            except Exception as e:
                print(f"FAIL {topic['id']} {level}: {e}", file=sys.stderr)
                continue
            upsert_topic_level(data, topic, level, level_data)
            save_daily(data)
            print(f"  {topic['id']} {level}: {len(level_data.get('text',''))} chars · {len(level_data.get('vocab',[]))} vocab · {len(level_data.get('questions',[]))} Q · {time.time()-t0:.1f}s")

    # 4. Post-process (derive token_map, latest.json, index.json)
    run_post_processing()

    # 5. TTS
    audio_count = generate_tts()

    # 6. Commit + push
    sha = git_commit_push(len(data["topics"]), audio_count)

    # 7. Telegram notify
    cats = sorted(set(t["category"] for t in data["topics"]))
    msg = f"📖 오늘의 한국어 읽기 · {TODAY}\n{len(data['topics'])} topics across {len(cats)} categories · {audio_count} audio files\ncommit {sha}\n→ https://g4jy.github.io/fly-korean-daily/reading.html"
    telegram_notify(msg)

    # 8. English-only report
    print(f"\n=== Run summary ===")
    print(f"topics: {len(data['topics'])} ({cats})")
    print(f"audio: {audio_count}")
    print(f"commit: {sha}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        import traceback
        traceback.print_exc()
        telegram_notify(f"❌ Fly Korean Daily run failed ({TODAY}): {type(e).__name__}: {str(e)[:200]}")
        sys.exit(1)

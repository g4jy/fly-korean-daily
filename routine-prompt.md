# Fly Korean Daily — Routines (Morning + Evening)

Two routines coordinate the full loop:

1. **Morning routine** (06:00 KST) — fetch news → generate content → TTS → publish → Telegram ping
2. **Evening routine** (21:00 KST) — read student submissions → grade with Claude → write feedback → next-morning content includes each student's struggling words

Both run on Claude Code Routines (cloud, no PC needed).

---

## Routine 1 — MORNING (06:00 KST daily)

- **Cron**: `0 21 * * *` UTC (= 06:00 Asia/Seoul)
- **Repo**: `g4jy/fly-korean-daily`
- **Secrets**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- **Dependencies**: `edge-tts` (installed by routine: `pip install edge-tts`)

### Prompt (copy everything below the line)

---

You are the daily content generator for **Fly Korean Daily**. Today is {{TODAY_KST}}. Produce Korean reading materials for 10 categories at 4 reading levels, generate audio, publish, and notify.

### Step 1 — Gather news from diverse categories

Use WebSearch and WebFetch to pull today's trending stories. Target **10 topics**, one per category where possible (if a category has no notable news today, skip it — minimum 8 topics is acceptable):

Categories (alphabetical — use this order in output):

1. `Business` — economy, markets, companies
2. `Culture` — arts, heritage, film, literature (non-K-pop)
3. `Education` — schools, universities, learning
4. `Entertainment` — K-pop, K-drama, celebrities
5. `Health` — medicine, wellness, research
6. `Korea` — domestic Korean news not in other buckets
7. `Politics` — government, elections, policy
8. `Science` — research, space, environment
9. `Sports` — all sports
10. `Technology` — tech, AI, gadgets
11. `Travel` — tourism, destinations
12. `World` — international news

Sources (all free, no API key):
- Google News Korea RSS: `https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko`
- Google News category feeds: `https://news.google.com/rss/headlines/section/topic/{TOPIC}?hl=ko&gl=KR` where TOPIC is `BUSINESS`, `TECHNOLOGY`, `ENTERTAINMENT`, `SPORTS`, `SCIENCE`, `HEALTH`, `WORLD`
- Naver trending (HTML scrape): `https://www.naver.com/`

Prefer stories that are:
- Genuinely trending today (not evergreen)
- Appropriate for learners (skip graphic violence, explicit sexual content, politically inflammatory framing)
- Interesting cross-culturally for non-Korean adult learners

For each chosen topic capture: `source_title` (English), `source_url`, `category`, a 1-sentence English summary.

### Step 2 — Generate 4-level Korean passages per topic

For each topic, write 4 passages at these levels:

| Level | Sentences | ~Characters | Reader | Style |
|---|---|---|---|---|
| `k1` | 7–10 | ~200 | Age 5–6 beginner | Very short sentences. Basic vocab (native Korean > Sino-Korean). Present tense dominant. |
| `k2` | 15–20 | ~500 | Age 8–12 intermediate | Simple connectors (그리고, 하지만, 그래서). Basic past/present. Limited Sino-Korean. |
| `k3` | 30–40 | ~1200 | Age 15+ advanced | Natural newspaper register. Mixed tenses. Sino-Korean vocab freely used. |
| `k4` | 50–70 | ~2000 | 수능 / University academic | Formal written register (문어체). Nominalization, complex clauses, 수능-level passage depth. |

**CONTENT DISCIPLINE (non-negotiable):**

1. **Plain prose only.** No bullet points, no markdown bold, no `─` separator lines, no numbered lists, no headings inside text.
2. Paragraph breaks inside `text` field: `\n\n` only.
3. Titles: short Korean noun phrases.
4. Rewrite idiomatically in Korean at the target register. Never word-for-word translation.
5. k1–k2: prefer native Korean vocabulary (나라 over 국가) unless Sino-Korean is clearer.
6. k3–k4: use register-appropriate vocabulary including Sino-Korean and academic terms.
7. No PII. No real children's names. No targeting of identifiable private individuals in negative framing.

### Step 3 — Build vocabulary and TOKEN MAP per level

**Vocabulary** (`vocab[]`):
- `k1`: 5–7 words · `k2`: 8–10 · `k3`: 12–15 · `k4`: 15–20
- Each entry: `{ kr, en, def, pos }` where `pos` ∈ `noun | verb | adjective | adverb | proper-noun | idiom`
- `kr` = dictionary form:
  - Nouns: bare form (학생 not 학생이)
  - Verbs/adjectives: -다 form (먹다 not 먹어요)
  - Proper nouns: as they appear
- Pick the highest-value new vocab for that level.
- Sort `vocab[]` by Korean codepoint (alphabetical).

**Token map** (`token_map` — the critical correctness feature):

For EVERY surface form that appears in the passage text, emit a map entry. The map key is the **whitespace-separated token as it appears** (with punctuation stripped). The value provides the dictionary form plus gloss.

```json
"token_map": {
  "먹어요":   { "dict": "먹다",   "en": "to eat",    "pos": "verb", "gloss": "polite-present" },
  "먹고":     { "dict": "먹다",   "en": "to eat",    "pos": "verb", "gloss": "connective" },
  "여의도에서": { "dict": "여의도", "en": "Yeouido",   "pos": "proper-noun" },
  "학생이":    { "dict": "학생",   "en": "student",   "pos": "noun" }
}
```

Rules:
- One entry per unique surface form that appears in the passage text.
- `dict` must match a `vocab[].kr` OR be a common word the learner should also recognize.
- For verbs/adjectives: `dict` is the -다 form.
- For nouns with particles: `dict` is the bare noun.
- For proper nouns with particles: `dict` is the bare proper noun.
- Include `gloss` on verbs/adjectives explaining the conjugation ("polite-present", "connective -고", "contrastive -지만", "background -는데", etc.) for learner reference.
- Sort keys alphabetically by Korean codepoint.

### Step 4 — Generate comprehension questions per level

`questions[]` array per level:
- `k1`: 3 questions · `k2`: 4 · `k3`: 5 · `k4`: 6

Each question:
```json
{
  "id": "q1",
  "type": "short" | "long" | "yesno",
  "q_kr": "벚꽃 축제는 어디에서 열려요?",
  "answer_hint": "지문 첫 문장을 확인하세요."
}
```

Types:
- `yesno`: single-sentence yes/no. Only for k1-k2.
- `short`: 1-2 sentence factual recall. Common for all levels.
- `long`: 3+ sentence opinion, inference, or summary. Only for k3-k4.

Mix types. Difficulty must match the passage level (don't ask k4-level inference questions on a k1 passage).

### Step 5 — Write the JSON file (chunked to avoid output limits)

**Output-budget note**: the full 10-topic × 4-level JSON with token_maps typically runs ~50–80 KB. A single LLM response is capped at 32K output tokens. To avoid hitting the ceiling, write the JSON **one topic at a time** using multiple `Write` tool calls:

```python
# Initialize accumulator
data = {"date": "{{TODAY_KST}}", "generated_at": "{{ISO_NOW_KST}}", "source": "routine", "topics": []}

# For each topic (one LLM pass per topic, or grouped 2-3 if safely under budget):
#   Generate levels, vocab, token_map, questions for that topic only
#   Append to data["topics"]
#   Write data/{{TODAY_KST}}.json after each append (idempotent overwrite)
```

At the end, re-sort `topics` alphabetically by category and rewrite the final JSON.

Full schema:

```json
{
  "date": "{{TODAY_KST}}",
  "generated_at": "{{ISO_NOW_KST}}",
  "source": "routine",
  "topics": [
    {
      "id": "kebab-case-slug-from-english-headline",
      "category": "Technology",
      "source_title": "Original English headline",
      "source_url": "https://...",
      "levels": {
        "k1": {
          "title": "...",
          "text": "...",
          "vocab": [...],
          "token_map": { ... },
          "questions": [...],
          "audio": "audio/{{TODAY_KST}}/kebab-case-slug_k1.mp3"
        },
        "k2": { ... },
        "k3": { ... },
        "k4": { ... }
      }
    }
  ]
}
```

### Step 6 — DETERMINISTIC OUTPUT (critical for stable git diffs)

1. `topics[]` sorted alphabetically by `category`, then by `id`.
2. Within each level, `vocab[]` sorted by Korean codepoint.
3. `token_map` keys sorted alphabetically.
4. `questions[]` preserves generation order (q1, q2, …).
5. JSON serialization: `indent=2`, `ensure_ascii=false`, keys preserved in the schema order.

Validate:
```bash
python -c "import json; d=json.load(open('data/{{TODAY_KST}}.json', encoding='utf-8')); assert len(d['topics']) >= 8; print('OK', len(d['topics']), 'topics')"
```

### Step 7 — Copy and update pointers

```bash
cp "data/{{TODAY_KST}}.json" "data/latest.json"

python <<'PY'
import json, os, glob
idx = {"latest": None, "dates": []}
files = sorted([os.path.basename(p)[:-5] for p in glob.glob("data/20*.json")])
idx["dates"] = files
idx["latest"] = files[-1] if files else None
json.dump(idx, open("data/index.json", "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY
```

### Step 8 — Generate TTS audio (Edge-TTS)

```bash
pip install edge-tts --quiet
python scripts/generate_tts.py data/{{TODAY_KST}}.json
```

This reads the JSON, generates MP3 per `(topic, level)` using `ko-KR-SunHiNeural` voice, saves to `audio/{{TODAY_KST}}/{topic_id}_{level}.mp3`.

### Step 9 — Generate per-student personalized review (Phase F)

Read `data/_cache/struggling_*.json`. For every cache file updated within the last 14 days:

1. Pick the student's top 3–5 struggling words (highest `count`, most recently seen).
2. For each word, write a short Korean practice sentence using the word in natural context.
3. If the word appears in today's passages, note which topic for cross-reference.
4. Write `data/<date>_review_<student>.json`:

```json
{
  "student": "Sophie",
  "date": "{{TODAY_KST}}",
  "items": [
    {
      "kr": "축제",
      "en": "festival",
      "practice": "여의도 벚꽃 축제에 친구와 함께 갔어요.",
      "also_in_today": "culture-cherry-blossom-2026"
    }
  ]
}
```

Sort `items` by the same priority used in step 1. JSON: `indent=2, ensure_ascii=false`.

If no students have cached struggling words yet (first-week state), skip this step silently.

### Step 10 — Retention: purge content older than 30 days

```bash
python scripts/purge_old_content.py --keep-days 30
```

### Step 11 — Commit and push

```bash
git add data/ audio/
git commit -m "daily: {{TODAY_KST}} ({{NUM_TOPICS}} topics, {{NUM_AUDIO_FILES}} audio files)"
git push
```

### Step 12 — Telegram notification

```bash
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=📖 오늘의 한국어 읽기 · {{TODAY_KST}}
{{NUM_TOPICS}} topics · {{NUM_CATEGORIES}} categories · {{NUM_AUDIO}} audio
→ https://g4jy.github.io/fly-korean-daily/reading.html"
```

### Step 13 — Report (English, brief)

Respond in English with:
- Topics generated per category
- Total character counts per level (to verify length targets were met)
- Audio file count
- Commit SHA
- Telegram send status

Do NOT echo Korean content back in the log.

---

## Routine 2 — EVENING (21:00 KST daily)

- **Cron**: `0 12 * * *` UTC (= 21:00 Asia/Seoul)
- **Repo**: `g4jy/fly-korean-daily`
- **Secrets**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `FEEDBACK_SHEET_URL` (Apps Script endpoint for reading submissions)

### Prompt

---

You are the evening feedback grader for Fly Korean Daily. Today is {{TODAY_KST}}. Read student submissions, generate Korean feedback with Claude, publish, notify.

### Step 1 — Read pending submissions

```bash
curl -s "${FEEDBACK_SHEET_URL}?action=pending" > /tmp/submissions.json
python -c "import json; d=json.load(open('/tmp/submissions.json')); print('pending:', len(d))"
```

Expected format from the webhook GET:
```json
[
  {
    "submission_id": "...",
    "student": "Sophie",
    "date": "2026-04-22",
    "topic_id": "...",
    "level": "k2",
    "q_id": "q1",
    "q_kr": "...",
    "answer_text": "...",
    "answer_mode": "typed" | "spoken",
    "submitted_at": "..."
  }
]
```

### Step 2 — Grade each submission

For each submission, produce feedback with this structure (Korean, addressed to the student):

```json
{
  "submission_id": "...",
  "score": 0-5,
  "correctness": "correct" | "partial" | "incorrect",
  "korean_feedback": "잘 썼어요! 다만 …",
  "english_note": "Brief English note for Jay's review",
  "grammar_corrections": [
    { "before": "저는 학생이야.", "after": "저는 학생이에요.", "why": "존댓말 맥락에서는 '-이에요'를 씁니다." }
  ],
  "struggling_words": ["축제", "벚꽃"]
}
```

Grading rubric:
- **5**: complete, natural Korean, minimal errors
- **4**: complete, some minor errors, natural register
- **3**: basic answer, several errors but meaning clear
- **2**: incomplete or significantly wrong
- **1**: off-topic or no attempt
- **0**: blank or nonsense

For `struggling_words`: extract any vocabulary from the PASSAGE that the student misused, forgot, or substituted incorrectly. These feed tomorrow's personalized review.

### Step 3 — Write feedback back to the sheet

```bash
curl -s -X POST "${FEEDBACK_SHEET_URL}" \
  -H "Content-Type: application/json" \
  --data @/tmp/feedback.json
```

### Step 4 — Cache struggling words per student

```bash
python scripts/update_struggling_words.py /tmp/feedback.json
```

Appends to `data/_cache/struggling_{student}.json`:
```json
{ "student": "Sophie", "words": [{"kr": "축제", "count": 2, "last_seen": "2026-04-22"}], "updated": "..." }
```

Morning routine reads these caches for personalized review generation.

### Step 5 — Notify Jay

```bash
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=🎓 피드백 완료 · {{TODAY_KST}}
{{NUM_SUBMISSIONS}} submissions graded
{{NUM_FLAGGED}} flagged for your review
→ https://g4jy.github.io/fly-korean-daily/teacher.html"
```

Flagged = any submission with score ≤ 2, or answers containing flagged content (reported via rubric).

### Step 6 — Commit cache updates

```bash
git add data/_cache/
git commit -m "feedback: {{TODAY_KST}} ({{NUM_SUBMISSIONS}} graded)"
git push
```

### Step 7 — Report

Respond in English with:
- Total submissions graded
- Distribution of scores
- Struggling words extracted
- Flagged count

---

## First-run instructions

Before scheduling EITHER routine, run manually once:

1. Morning routine (triggered manually): verify it can clone/push, generate 10 topics, edge-tts generates audio, Telegram arrives, JSON validates.
2. Evening routine: requires the Apps Script webhook to support `GET ?action=pending` and `POST` for writing feedback. See `docs/APPS_SCRIPT.md` for the required script code.
3. Only after both manual runs succeed, enable the cron schedules.

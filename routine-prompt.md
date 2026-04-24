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

| Level | Paragraphs | Sentences total | ~Chars | Reader | Style |
|---|---|---|---|---|---|
| `k1` | **1 paragraph** | 7–10 | ~200 | Beginner | Very short sentences. Basic vocab (native Korean > Sino-Korean). Present tense dominant. |
| `k2` | **2 paragraphs** | **25–35** (≈1.5x previous) | ~750 | Elementary | Simple connectors (그리고, 하지만, 그래서). Basic past/present. Limited Sino-Korean. |
| `k3` | **4 paragraphs** | **60–80** | ~2400 | Intermediate | Natural newspaper register. Mixed tenses. Sino-Korean freely used. Some causal reasoning. |
| `k4` | **6 paragraphs** | **90–120** | ~3600 | Advanced / 수능 | Formal written register (문어체). Nominalization, complex clauses. Multi-angle analysis, embedded cited evidence, 수능-level depth. |

**CONTENT DISCIPLINE (non-negotiable):**

1. **Plain prose only.** No bullet points, no markdown bold, no `─` separator lines, no numbered lists, no headings inside text.
2. Paragraph breaks inside `text` field: exactly `\n\n` — the paragraph COUNT per level must match the table above.
3. Titles: short Korean noun phrases.
4. Rewrite idiomatically in Korean at the target register. Never word-for-word translation.
5. k1–k2: prefer native Korean vocabulary (나라 over 국가) unless Sino-Korean is clearer.
6. k3–k4: use register-appropriate vocabulary including Sino-Korean and academic terms.
7. Each paragraph should develop ONE sub-idea. k3 = 4 distinct aspects; k4 = 6 distinct aspects of the topic.
8. No PII. No real children's names. No targeting of identifiable private individuals in negative framing.

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

Level-specific question profile (counts, types, expected answer length, nature):

| Level | Count | Types allowed | Expected answer | Nature |
|---|---|---|---|---|
| `k1` | **2** | `factual` only (maybe 1 `yesno-plus`) | 1 complete sentence | Direct recall from the passage. No inference. |
| `k2` | **3** | `factual`, `yesno-plus` | 1–2 complete sentences | Factual + simple why/how. No opinion. |
| `k3` | **4** | `factual`, `reasoning`, `inference` | 2–3 sentences | Summary + cause/effect + "what would happen if". No yesno. Opinion OK only when the passage itself presents a viewpoint. |
| `k4` | **5** | `reasoning`, `inference`, `synthesis`, `opinion` | 3–5 sentences | 수능-style: synthesize across paragraphs, evaluate arguments, compare perspectives. Opinion/agree-disagree questions ONLY when the passage explicitly presents at least two competing claims. |

**Question type definitions:**

- `factual`: direct recall. Example: "축제는 어디에서 열려요?" Answer is one clause extractable from the passage.
- `yesno-plus`: yes/no question that DEMANDS a complete-sentence answer with the reason or object. The question itself must prompt for elaboration: "벚꽃 축제를 좋아해요? 왜 그렇게 생각해요?" — NOT just "벚꽃 축제를 좋아해요?". Expected answer: "네. 예쁘기 때문에 좋아해요." NOT just "네." The `answer_hint` must explicitly say "완전한 문장으로 답해 주세요. 예: '네. ~~ 때문에 좋아해요.'"
- `reasoning`: asks HOW or WHY using passage content. Example: "왜 이 축제가 유명해졌어요?"
- `inference`: requires combining multiple sentences or reading between lines. Example: "이 글을 바탕으로 봄에 여의도를 방문하면 무엇을 기대할 수 있을까요?"
- `synthesis` (k4 only): asks to summarize or restate in the student's own words.
- `opinion`: ONLY use this type when the passage itself contains debatable claims, competing views, or controversy. Never ask agree/disagree on neutral descriptive topics (e.g., a travel guide).

**Each question schema:**

```json
{
  "id": "q1",
  "type": "factual" | "yesno-plus" | "reasoning" | "inference" | "synthesis" | "opinion",
  "q_kr": "…",
  "answer_hint": "짧은 한국어 힌트 (답의 형식을 안내)",
  "min_sentences": 1,
  "max_sentences": 5
}
```

**CRITICAL — question relevance:**

- Every question MUST be answerable FROM the passage, not from outside knowledge.
- For `yesno-plus`: the question must explicitly end with "왜 그렇게 생각해요?" or "이유를 설명해 주세요" so the student gives a complete sentence.
- For `opinion` at k4: re-read the passage. If it doesn't present a genuine debate, DO NOT generate an opinion question — substitute `inference` or `synthesis` instead.
- Never generate a question whose answer requires the student to know something NOT stated in the passage.
- Mix question types. Don't stack all factual or all inference — vary.

### Step 5 — Write the JSON file (STRICT chunking — prevents stream timeouts)

**⚠️ Critical — read carefully**: the previous run failed with "Stream idle timeout" after trying to write 3 topics as one batch. Large single responses in the chat stream time out. The fix is **extreme chunking — ONE level at a time**, not one topic.

**Execution pattern (follow exactly):**

```
Stage 1 — Initialize (one tool call):
  Write data/{{TODAY_KST}}.json with {"date":"{{TODAY_KST}}", "generated_at":"{{ISO_NOW_KST}}", "source":"routine", "topics":[]}

Stage 2 — For topic T in [your 10 chosen topics]:
  2a. Generate Level k1 ONLY for T. Output: {title, text, vocab, token_map, questions, audio_path}. ~1.5-3 KB.
      Build one topic-scaffold object with just this level: {id, category, source_title, source_url, levels:{k1:{...}}}
      Read current JSON, append/merge this scaffold into topics[], write back.
  2b. Generate Level k2 for T. Read current JSON, add levels.k2 to T's entry, write back.
  2c. Generate Level k3 for T. Same pattern. (This will be the longest level; still output ≤5KB.)
  2d. Generate Level k4 for T. Same pattern.
  2e. Brief log line: "topic T complete: {category}".

Stage 3 — Finalize:
  Read JSON. Re-sort topics[] alphabetically by category then id.
  Ensure each level has {title, text, vocab, token_map, questions, audio}.
  Write back.
```

**Why one LEVEL at a time (not one topic at a time):**
- k4 alone can be 3KB of Korean + its token_map of ~150 entries. Three k4s in one response is what timed out last time.
- Each Write tool call is a fresh response segment. Keeps the stream alive.

**Idempotent restart:**
- At startup, read `data/{{TODAY_KST}}.json` if it exists. For each topic already present, check which levels are filled.
- Skip levels that are already written (non-empty `text` AND non-empty `token_map`).
- This lets a failed run resume without starting over.

**Validation after every write:**
```bash
python -c "import json; json.load(open('data/{{TODAY_KST}}.json', encoding='utf-8'))"
```
If this fails, the last write corrupted the JSON — roll back and retry that write.

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

**SECURITY — critical:**
- The Telegram token is provided in the ROUTINE PROMPT BODY (not in this file). Use it for the HTTPS curl call only.
- NEVER echo the token to the log or reply text.
- NEVER write the token to any file in the repo (scripts, docs, JSON, anything committable).
- NEVER include the token in git commit messages.
- If the token is not present in the routine prompt body, skip Telegram silently and note "Telegram: skipped (no token)" in the English report.

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

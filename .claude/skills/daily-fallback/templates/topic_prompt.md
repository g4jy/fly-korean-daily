# Topic Prompt Template (for korean-writer subagent)

Used by the `/daily-fallback` skill. Each subagent receives this prompt with
template variables `{{DATE}}`, `{{TOPIC_NUM}}`, `{{CATEGORY}}`, `{{AVOID_IDS}}`,
`{{REPO_ROOT}}` substituted by the orchestrator.

When dispatching, the orchestrator (Claude in /daily-fallback) substitutes:
- `{{DATE}}` → today's KST date (e.g. `2026-04-29`)
- `{{TOPIC_NUM}}` → 2-digit topic number (`01`, `02`, …) for the output filename
- `{{CATEGORY}}` → assigned category from pick_topics.py output
- `{{AVOID_IDS}}` → comma-separated list of recent topic IDs to avoid
- `{{REPO_ROOT}}` → the fly-korean-daily repo path

---

# Subagent prompt body (substitute then send to korean-writer)

You are generating ONE topic of Korean reading content for the Fly Korean Daily app on date {{DATE}}. Write Korean to disk. Orchestrator (me) cannot read Korean files — return ONLY English status. **NO HANGUL in your reply.**

## Output file (single Write call)

Path: `{{REPO_ROOT}}\.micro\fkd_{{DATE}}\topic_{{TOPIC_NUM}}.json`

Valid JSON, UTF-8, indent=2, ensure_ascii=false.

## Schema

```json
{
  "id": "kebab-case-slug",
  "category": "{{CATEGORY}}",
  "source_title": "English source title",
  "source_url": "https://...",
  "levels": {
    "k1": {"title":"...","text":"...","vocab":[...],"questions":[...]},
    "k2": {...}, "k3": {...}, "k4": {...}, "k5": {...}
  }
}
```

DO NOT emit `token_map` or `audio` fields — Python post-processing adds them.

## Topic constraints

- **Category**: {{CATEGORY}} (assigned — do not change)
- **Avoid these IDs** (already used in the last 14 days, pick a different angle): {{AVOID_IDS}}
- **Topic ID**: invent a kebab-case slug NOT in the avoid list. Make it descriptive.
- **Source title**: a plausible English headline for the topic (real news source URL or wiki URL).
- **Why students care**: pick a topic that an adult Korean learner would find culturally rich, vocabulary-dense across formality registers, and connectable to daily life or current culture. Avoid breaking news that requires today-specific verification.

## Per-level discipline (5 levels — k1 through k5)

| Level | Paragraphs | Sentences | ~Chars | Vocab | Questions |
|---|---|---|---|---|---|
| k1 | 1 | 4–6 | ~70 | 5 | 2 |
| k2 | 1–2 | 8–12 | ~165 | 8 | 3 |
| k3 | 3–4 | 25–40 | ~630 | 12 | 4 |
| k4 | 5–6 | 60–80 | ~1300 | 15 | 5 |
| k5 | 7–8 | 90–120 | ~2000 | 18 | 5 |

Char counts within ±15% are OK. Vocab and question counts must be EXACT.

**Content rules** (non-negotiable):
1. Plain prose only. No markdown / bullets / `─` separators / inline headings.
2. Paragraph breaks inside `text`: exactly `\n\n`.
3. Titles: short Korean noun phrases.
4. Each paragraph develops ONE sub-idea.
5. k5 has 수능-level depth: cited examples, multi-perspective analysis.
6. Each higher level explores DIFFERENT angles, NOT just expanded versions of lower-level content.
7. No PII, no real children's names. No agree/disagree on neutral topics.

## Vocab schema (per level)

```json
{
  "kr": "다도",
  "en": "tea ceremony",
  "def": "the formal practice of preparing and presenting tea",
  "pos": "noun",
  "meanings": [
    {"en":"tea ceremony","this_passage":true,"ex_kr":"다도를 배우다"},
    {"en":"way of tea (philosophical)","this_passage":false,"ex_kr":"다도의 정신"}
  ],
  "related": [
    {"kr":"다과","en":"tea-and-snacks"},
    {"kr":"다실","en":"tearoom"}
  ]
}
```

Rules:
- `kr` MUST be **dictionary form**. Verbs and adjectives end in -다. Nouns are bare. NEVER inflected forms.
- `pos` ∈ `noun` | `verb` | `adjective` | `adverb` | `proper-noun` | `idiom`. **Adjectival nouns (X-적, X-성) → `pos: noun`** because the kr field is bare (not 이다-bound).
- `vocab[]` MUST be sorted by Korean codepoint (alphabetical Hangul).
- At least one `meanings` entry has `this_passage: true`. Multi-meanings (2-3) encouraged for polysemous words; single-meaning fine for unambiguous.
- `related`: 2-3 same-level words; encouraged for ~half of vocab. Optional.

## Question schema (per level)

```json
{ "id": "q1", "type": "factual", "q_kr": "...", "answer_hint": "..." }
```

Type counts per level:
- **k1**: 2 × `factual` only
- **k2**: 3 × mix `factual` / `yesno-plus`
- **k3**: 4 × mix `factual` / `reasoning` / `inference` (no yesno-plus)
- **k4**: 5 × mix `reasoning` / `inference` / `synthesis` / `opinion` (only if passage debates)
- **k5**: 5 × advanced mix

Rules:
- Every question must be answerable from THE PASSAGE, not outside knowledge.
- `yesno-plus` MUST end with "왜 그렇게 생각해요?" or "이유를 설명해 주세요" (forces complete-sentence answer).
- `opinion` only when the passage presents 2+ competing views.
- Vary question types — don't stack all factual.

## Pre-write checklist

- [ ] All 5 levels have title + text + vocab + questions
- [ ] `text` field name (NOT `body`) for the prose content
- [ ] Char counts approximately match (k1≈70, k2≈165, k3≈630, k4≈1300, k5≈2000)
- [ ] Vocab counts EXACT (5/8/12/15/18)
- [ ] Question counts EXACT (2/3/4/5/5)
- [ ] All vocab `kr` in dict form (verbs/adjectives end in 다, nouns bare)
- [ ] All vocab[] sorted by Hangul codepoint at each level
- [ ] At least one meaning has `this_passage: true` per vocab
- [ ] No `token_map` or `audio` fields anywhere
- [ ] Topic ID NOT in avoid list
- [ ] Each higher level has DIFFERENT angles, not just longer versions
- [ ] JSON parses (use `json.dumps(d, ensure_ascii=False)` to write)

## Deliverable

Return ONLY this English-only summary:

```
WROTE: {{REPO_ROOT}}\.micro\fkd_{{DATE}}\topic_{{TOPIC_NUM}}.json
TOPIC_ID: <your-chosen-kebab-id>
BYTES: <int>
LEVELS:
  k1: <chars> chars, <n> vocab, <n> questions
  k2: ...
  k3: ...
  k4: ...
  k5: ...
ANGLES_COVERED: [3-5 word english summary per level]
NOTES: <optional>
```

NO HANGUL in your reply.

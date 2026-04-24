# Fly Korean Daily

Daily Korean reading materials from trending news, at 4 difficulty levels, with:

- **Tap-to-save vocabulary** → SM-2 spaced-repetition flashcards
- **Neural Korean TTS** for every passage (edge-tts, ko-KR-SunHiNeural)
- **Comprehension questions** per passage (type or speak your answer in Korean)
- **AI-graded feedback** the same evening
- **Personalized next-morning review** built from each student's struggling words
- **Teacher dashboard** for override when the AI is wrong

Live (after deploy): https://g4jy.github.io/fly-korean-daily/

## What each page does

| Page | What it does |
|---|---|
| `index.html` | Landing + name gate + hub |
| `reading.html` | Today's content · 10 categories · 4 levels · tap-to-save · audio · questions |
| `flashcards.html` | SM-2 SRS over saved words |
| `teacher.html` | Jay's dashboard: submissions, feedback, flagged items |

## The 24-hour loop

**06:00 KST** — morning routine runs (Anthropic cloud, no PC needed):
1. Scrape Google News RSS for 10 categories
2. Generate 4-level Korean passages per topic (k1 age 5–6 → k4 수능 level)
3. Build `token_map` per passage: every surface form → dictionary form (handles 먹다/먹어요/먹고/먹지만 unification)
4. Generate vocab (sorted by Korean codepoint), 3–6 comprehension questions per level
5. Run edge-tts → one MP3 per (topic, level)
6. Read each active student's struggling-words cache → generate their personalized review for today
7. git commit + push → GitHub Pages auto-deploys in ~60s
8. Telegram ping Jay

**Anytime the student visits**:
- Reads a passage, taps unknown words (saved as dictionary form), answers questions
- Every event streamed to the Google Sheet webhook

**21:00 KST** — evening routine runs:
1. GET pending submissions from the webhook
2. Claude grades each: score 0–5 + Korean feedback + grammar corrections + extracted struggling words
3. POST feedback back to the Sheet
4. Update per-student struggling-words caches (drives tomorrow's personalized review)
5. Telegram Jay: "N graded, M flagged for review"

Full diagram: `docs/FLOW.md`. Setup: `docs/PRODUCTION_CHECKLIST.md`.

## File layout

```
fly-korean-daily/
├── index.html, reading.html, flashcards.html, teacher.html
├── css/styles.css
├── js/
│   ├── common.js        — webhook · marks · SRS · TTS · speech
│   ├── reading.js       — token_map lookup · categories · questions
│   └── flashcards.js    — SM-2 review loop
├── data/
│   ├── YYYY-MM-DD.json  — daily content (routine writes this)
│   ├── latest.json      — byte-identical copy of newest
│   ├── index.json       — list of available dates
│   ├── YYYY-MM-DD_review_<student>.json  — per-student personalized review
│   ├── _cache/
│   │   └── struggling_<student>.json     — feeds tomorrow's review
│   └── _feedback/
│       └── YYYY-MM-DD_<student>.json     — in-app feedback per Q
├── audio/
│   └── YYYY-MM-DD/<topic_id>_<level>.mp3  — neural Korean TTS
├── scripts/
│   ├── generate_tts.py           — edge-tts generator (called by morning routine)
│   ├── update_struggling_words.py — (called by evening routine)
│   └── purge_old_content.py      — 30-day retention (called by morning routine)
├── docs/
│   ├── FLOW.md                  — full pipeline diagram + flows
│   ├── PRODUCTION_CHECKLIST.md  — go-live steps (~45 min)
│   └── APPS_SCRIPT.md           — webhook extension code
├── routine-prompt.md   — morning + evening routine prompts (paste into /schedule)
└── README.md           — this file
```

## Daily content schema (the contract)

`data/YYYY-MM-DD.json`:

```json
{
  "date": "2026-04-22",
  "generated_at": "2026-04-22T06:00:00+09:00",
  "source": "routine",
  "topics": [
    {
      "id": "kebab-slug-from-headline",
      "category": "Technology",
      "source_title": "Original English headline",
      "source_url": "https://...",
      "levels": {
        "k1": {
          "title": "Korean noun phrase",
          "text": "plain Korean prose (paragraph breaks: \\n\\n only)",
          "audio": "audio/2026-04-22/<id>_k1.mp3",
          "vocab": [{"kr":"…","en":"…","def":"…","pos":"noun"}],
          "token_map": {"먹어요":{"dict":"먹다","en":"to eat","pos":"verb","gloss":"polite-present"}},
          "questions": [{"id":"q1","type":"short","q_kr":"…","answer_hint":"…"}]
        },
        "k2": {...},
        "k3": {...},
        "k4": {...}
      }
    }
  ]
}
```

- `topics` sorted alphabetically by category
- `vocab` sorted by Korean codepoint
- `token_map` keys sorted alphabetically
- JSON: `indent=2, ensure_ascii=false`

Same news input → byte-identical output. Clean git diffs.

## Content targets

| Level | Sentences | ~Chars | Vocab | Questions | Reader |
|---|---|---|---|---|---|
| k1 | 7–10 | ~200 | 5–7 | 3 | Age 5–6 |
| k2 | 15–20 | ~500 | 8–10 | 4 | Age 8–12 |
| k3 | 30–40 | ~1200 | 12–15 | 5 | Age 15+ |
| k4 | 50–70 | ~2000 | 15–20 | 6 | 수능 / University |

## Categories (12; routine picks 10 per day)

Alphabetical: Business · Culture · Education · Entertainment · Health · Korea · Politics · Science · Sports · Technology · Travel · World

Students can filter by category or star their favorites (starred topics show first by default).

## Cost

$0 beyond your existing Claude plan. Everything uses free tiers:
- GitHub Pages (free hosting)
- Claude Routines (covered by your plan)
- edge-tts (free via Azure's Neural voices)
- Apps Script (free quota 20k/day — we use <2%)
- Telegram Bot API (free)
- Google News RSS (free, no API key)

## Setup

See `docs/PRODUCTION_CHECKLIST.md`. ~45 minutes of one-time config.

# Fly Korean Daily — Full Pipeline

The 24-hour cycle from morning content generation through evening feedback, back to next morning's personalized review.

```
                    ┌──────────────────────────────────────────────────────┐
                    │                    CLAUDE ROUTINES                    │
                    │              (cloud, no local PC needed)              │
                    └──────────────────────────────────────────────────────┘

 06:00 KST  ╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶
            ┌──────────────────────────────────────────────────────────┐
            │ MORNING ROUTINE                                          │
            │                                                          │
            │  1. WebSearch: Google News RSS (10 categories)           │
            │  2. Generate 4 Korean passages per topic (k1–k4)         │
            │  3. Generate token_map + vocab + questions per passage   │
            │  4. Write data/YYYY-MM-DD.json (deterministic)           │
            │  5. Generate TTS (edge-tts → audio/YYYY-MM-DD/*.mp3)     │
            │  6. Generate per-student personalized reviews            │
            │     (from data/_cache/struggling_*.json)                 │
            │  7. Purge > 30-day content                               │
            │  8. git commit + push                                    │
            │  9. Telegram ping to Jay                                 │
            └──────────────────────────────────────────────────────────┘
                                      │
                                      ▼
            ┌──────────────────────────────────────────────────────────┐
            │ GITHUB PAGES (auto-deploy, ~60s)                         │
            │   https://g4jy.github.io/fly-korean-daily/               │
            └──────────────────────────────────────────────────────────┘
                                      │
                                      ▼

 anytime   ╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶
            ┌──────────────────────────────────────────────────────────┐
            │ STUDENT USES THE APP                                     │
            │   ?student=Sophie                                        │
            │                                                          │
            │  · Picks a category (or All / ★ Starred)                 │
            │  · Reads at chosen level (k1–k4)                         │
            │  · Taps words → saved to flashcards (localStorage)       │
            │  · Answers 3–6 questions per passage                     │
            │     - Types or records (Web Speech Korean recognition)   │
            │  · All events streamed to the webhook (Google Sheets)    │
            │  · Personalized review shown if cache has data           │
            └──────────────────────────────────────────────────────────┘
                                      │
                                      ▼
            ┌──────────────────────────────────────────────────────────┐
            │ APPS SCRIPT WEBHOOK + GOOGLE SHEET                       │
            │                                                          │
            │  · POST: receives events (word marks, answers, SRS)      │
            │  · Writes to Submissions sheet                           │
            │  · GET ?action=pending → returns ungraded submissions    │
            │  · POST action=feedback_batch → writes back grades       │
            └──────────────────────────────────────────────────────────┘
                                      │
                                      ▼

 21:00 KST  ╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶
            ┌──────────────────────────────────────────────────────────┐
            │ EVENING ROUTINE                                          │
            │                                                          │
            │  1. GET webhook pending submissions                      │
            │  2. Grade each with Claude                               │
            │     - score 0–5                                          │
            │     - korean_feedback (written to student)               │
            │     - grammar_corrections (before/after/why)             │
            │     - struggling_words (extracted misused vocab)         │
            │  3. POST feedback_batch back to webhook                  │
            │  4. Update data/_cache/struggling_<student>.json         │
            │  5. Optionally: write data/_feedback/YYYY-MM-DD_student  │
            │     for in-app display                                   │
            │  6. git commit + push                                    │
            │  7. Telegram summary to Jay                              │
            │     ("N graded, M flagged for your review")              │
            └──────────────────────────────────────────────────────────┘
                                      │
                                      ▼

                 ↺  loops to next 06:00 KST morning routine,
                    where struggling_<student>.json caches
                    drive personalized reviews.
```

## Why this architecture

| Design choice | Reason |
|---|---|
| **Cloud routines, not PC-hosted cron** | Zero reliance on your PC being on. Runs on Anthropic's infra. |
| **Token_map generated at routine time** | Claude knows Korean morphology. Client doesn't need it. Deterministic lookup. |
| **Deterministic JSON output** | Same news → byte-identical diff; no spurious git churn. |
| **Google Sheet as DB** | You already use it. No new infrastructure. |
| **Local cache files for struggling words** | Morning routine doesn't need to hit the webhook during its run (reduces failure modes). |
| **Personalized review as separate file** | Frontend fetches it independently; no change to main daily schema. |
| **Feedback as per-day + per-student file** | Frontend fetches on reading-view load → shows inline with the question. |

## Data artifacts (all in the repo)

```
data/
├── 2026-04-22.json              ← today's content (main)
├── latest.json                  ← byte-identical copy of newest dated file
├── index.json                   ← list of available dates
├── 2026-04-22_review_<name>.json← per-student personalized review
├── _cache/
│   └── struggling_<name>.json   ← morning routine reads this
└── _feedback/
    └── 2026-04-22_<name>.json   ← per-q feedback for a student (read by reading.js)

audio/
└── 2026-04-22/
    ├── <topic_id>_k1.mp3
    ├── <topic_id>_k2.mp3
    ├── <topic_id>_k3.mp3
    └── <topic_id>_k4.mp3
```

## Student experience, end-to-end

1. **Morning**: student opens `https://g4jy.github.io/fly-korean-daily/?student=Sophie`
2. Lands on hub. Sees stat count of due flashcards.
3. Clicks "Today's Reading". Sees 10 topics across categories.
4. If ★ starred categories, those show first by default.
5. Picks a topic. Sees 4 level tabs (Age 5–6 / 8–12 / 15+ / University).
6. Reads at her level. Clicks 🔊 to hear the passage in natural Korean.
7. Taps any unknown word → saved (dictionary form). Tap again to unmark.
8. Scrolls to 3–6 questions. Types answer OR hits 🎙️ to speak it.
9. Submits. Event streamed to webhook.
10. **Next morning**: opens the app, sees feedback on yesterday's answers inline.
11. Sees "Your personalized review (5 words)" drawer — words she got wrong yesterday.
12. Repeats.

## Teacher experience

- **06:02 KST**: Telegram ping — "오늘 10 topics 준비 완료."
- **During the day**: occasional glance at `teacher.html` to see who's active / who's struggling.
- **21:05 KST**: Telegram ping — "12 submissions graded, 2 flagged."
- **Evening**: review flagged submissions on `teacher.html`. Override feedback if needed (writes back via same sheet).

## Why each component is necessary

- **token_map**: fixes 먹다 / 먹어요 / 먹고 unification without a client-side morph analyzer
- **Deterministic output**: means you can diff yesterday's JSON to today's and see ONLY what changed
- **Edge-TTS audio**: makes pronunciation practice possible; better than browser built-ins for Korean
- **Personalized review**: closes the loop — struggling words resurface until mastered
- **Teacher dashboard**: lets you override the AI when it's wrong (rare but necessary)

## Operational safety

- All routines idempotent. Re-run morning at 10am → it sees existing files, skips regeneration.
- All routines write to disk, commit, push atomically. Partial state won't break the site.
- If the evening routine fails (e.g., webhook down), next evening's run picks up both days of pending submissions.
- 30-day retention keeps the repo under GitHub's 5GB soft limit even at 4MB/day audio.

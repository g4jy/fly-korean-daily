# Production Setup Checklist

Everything you need to do once, before the daily loop goes live. Budget ~30–45 minutes total.

---

## 1. GitHub repo (5 min)

- [ ] **Create repo `g4jy/fly-korean-daily`** (public)
  ```bash
  cd "G:\내 드라이브\Preply\fly-korean-daily"
  git init
  git add .
  git commit -m "initial: complete pipeline v1.0"
  gh repo create g4jy/fly-korean-daily --public --source=. --push
  ```

- [ ] **Enable GitHub Pages**
  - Repo → Settings → Pages
  - Source: `Deploy from branch` · Branch: `main` · Folder: `/ (root)`
  - Wait ~60s. Visit `https://g4jy.github.io/fly-korean-daily/`

- [ ] **Verify landing page loads** and you can enter a test student name

---

## 2. Telegram bot (5 min)

- [ ] **Create bot via @BotFather**
  - In Telegram → search `@BotFather`
  - `/newbot` → name: `Fly Korean Daily`
  - Save the token shown: `TELEGRAM_BOT_TOKEN`

- [ ] **Get your chat ID**
  - Message your new bot anything (e.g. "hi")
  - Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser
  - Find `"chat": {"id": <number>, ...}` → that's `TELEGRAM_CHAT_ID`

- [ ] **Test send**:
  ```bash
  curl -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
    -d "chat_id=<CHAT_ID>" -d "text=test"
  ```

---

## 3. Apps Script webhook extension (10 min)

Required for questions + AI feedback to work. If you skip this, reading and flashcards still work.

- [ ] **Open the existing Apps Script** (the one already running at your webhook URL)
- [ ] **Follow `docs/APPS_SCRIPT.md`** — paste the `fkdHandlePost`, `fkdWriteSubmissions`, `fkdWriteFeedback`, `doGet` functions
- [ ] **Modify your existing `doPost`** to call `fkdHandlePost(e)` first
- [ ] **Deploy new version** — Deploy → Manage deployments → Edit → New version
- [ ] **Verify**: `curl 'https://script.google.com/.../exec?action=pending&key=teacher'` should return `[]` (empty array)

---

## 4. Morning routine (10 min)

- [ ] **Open** `https://claude.ai/code/routines`
- [ ] **Create new routine** named `fly-korean-daily-morning`
- [ ] **Schedule**: `0 21 * * *` UTC (= 06:00 KST)
- [ ] **Attach repo**: `g4jy/fly-korean-daily`
- [ ] **Secrets**:
  - `TELEGRAM_BOT_TOKEN` = your bot token
  - `TELEGRAM_CHAT_ID` = your chat ID
- [ ] **Paste the prompt** from `routine-prompt.md` under "Routine 1 — MORNING"
- [ ] **Dependencies**: routine will `pip install edge-tts` on first run; that's already in the prompt
- [ ] **Run manually** once
  - Click "Run now"
  - Watch the log
  - Verify: commit appears in GitHub · Telegram ping arrives · `data/YYYY-MM-DD.json` exists · `audio/YYYY-MM-DD/` populated
- [ ] **Enable the schedule**

---

## 5. Evening routine (10 min)

- [ ] **Create routine** named `fly-korean-daily-evening`
- [ ] **Schedule**: `0 12 * * *` UTC (= 21:00 KST)
- [ ] **Attach repo**: same `g4jy/fly-korean-daily`
- [ ] **Secrets**:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`
  - `FEEDBACK_SHEET_URL` = your existing webhook URL (same as used by the morning routine's optional GET)
- [ ] **Paste the prompt** from `routine-prompt.md` under "Routine 2 — EVENING"
- [ ] **Run manually** once (ideally after your morning routine has run and you've submitted at least one test answer)
- [ ] **Verify**: feedback_score fills in on the Sheet · Telegram summary arrives · `data/_cache/struggling_*.json` file created
- [ ] **Enable the schedule**

---

## 6. Give students the URL (2 min)

- [ ] **First-time URL per student**: `https://g4jy.github.io/fly-korean-daily/?student=Yannis`
- [ ] After first visit, the name is stored. They bookmark `https://g4jy.github.io/fly-korean-daily/`.
- [ ] **Confirm** at least one student can:
  - Enter name
  - Read a passage
  - Hear audio
  - Tap a word → see it in flashcards
  - Answer a question → see it submit

---

## 7. Teacher bookmark (1 min)

- [ ] Bookmark: `https://g4jy.github.io/fly-korean-daily/teacher.html`
- [ ] Confirm it loads (may show "No data yet" until first submission arrives)

---

## Smoke tests after go-live

Run these once a week until you trust the loop:

- [ ] **07:00 KST** (morning): new `data/<today>.json` committed, Telegram ping received, site shows new content
- [ ] **Random time**: open app as yourself (`?student=Jay`), answer a question, hit submit, check the Google Sheet for the row
- [ ] **22:00 KST** (evening): Telegram summary arrives, `feedback_score` filled in the Sheet, next morning's review shows your struggling words

---

## Known limitations (not bugs, document these)

1. **Edge-TTS uses Microsoft Azure voices**. Not strictly open-source. If that service is ever rate-limited, the routine will continue (falls back to Web Speech in the browser). Long-term alternative: switch to Kokoro TTS (runs in-browser via ONNX).
2. **localStorage is per-browser**. A student switching devices starts with empty flashcards (their Sheet history is intact; we can add device-sync later).
3. **Korean Web Speech Recognition quality varies by browser**. Chrome/Edge/Samsung Internet work well. Firefox does not support it.
4. **GitHub free-tier repo has a 5GB soft limit**. Our purge retains 30 days (~120MB audio + ~6MB JSON) — well under.
5. **Apps Script free quota**: 20K invocations/day. At ~50 students × 10 events/day = 500/day → ~2% of quota. Fine.

---

## Rollback

If something breaks and you need to take the site offline quickly:

```bash
cd "G:\내 드라이브\Preply\fly-korean-daily"
echo "Under maintenance" > index.html
git commit -am "maintenance"
git push
```

GitHub Pages will serve the placeholder within 60s.

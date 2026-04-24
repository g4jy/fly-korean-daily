# Portability & Data Durability — Fly Korean Daily

This document describes how a student's learning history (saved words, flashcard SRS state, submitted answers, feedback) **survives code changes, repo moves, and app rewrites**.

## The contract

> **The Google Sheet is the single source of truth for every student.**
> The GitHub repo holds *daily content*. The browser's localStorage is a *cache*. Either can be rebuilt from the Sheet without loss.

As long as the Apps Script webhook URL points at the same Sheet, students' data is safe.

## What survives what

| Change | Student data impact |
|---|---|
| App CSS / HTML / JS updated | ✓ Nothing lost. localStorage keys unchanged. |
| localStorage keys changed (schema v2 → v3) | ✓ Migration runs on load (`Common.migrate()`). Pre-migration data preserved via snapshot on the Sheet. |
| Student clears their browser cache | ✓ App calls `pullMarksSnapshot()` on next visit → state restored from Sheet. |
| Student switches phone ↔ laptop | ✓ Same: snapshot pull restores full flashcard state across devices. |
| GitHub repo renamed or moved | ✓ Deploy app at the new URL. Student visits new URL with `?student=<name>`. Fresh localStorage is populated from the Sheet. **Teacher just sends the new URL.** |
| App merged with another repo | ✓ Same as rename. localStorage origin changes but snapshot pull fills it. |
| We switch to a new domain (e.g. flykorean.com) | ✓ Same mechanism. |
| Apps Script webhook URL changes | ⚠️ **Critical**. Update `WEBHOOK_URL` in `js/common.js` AND do a one-time data migration Sheet → new Sheet. |
| Google Sheet deleted | ❌ Only thing that would lose data. Back up the Sheet before any risky change. |

## The flow when you move the repo

1. Deploy the app to a new location (e.g. `newaccount.github.io/flykorean/`).
2. Apps Script webhook URL stays the same (we don't redeploy that).
3. Send each student the new URL **with their `?student=<name>` parameter**, same as before.
4. Student visits new URL. Fresh origin → empty localStorage → but `pullMarksSnapshot()` runs on app boot.
5. Snapshot GET to webhook → returns their full marks JSON from the Sheet.
6. Local state rehydrated. Student keeps using the app as if nothing happened.

**No student data is lost.** They see the same flashcards, same SRS schedule, same saved answers and feedback.

## Backup recommendations

1. **Belt-and-suspenders for students**: Flashcards page has a `💾 Export my flashcards` button. Students can download their full state as a JSON file anytime. A matching `📁 Import from file` restores an exported bundle, merging by per-word `lastSeen` timestamps.

2. **Teacher-level backup**: The Google Sheet is the master record. Right-click on it in Google Drive → `Make a copy` periodically, or set up Google Takeout to export weekly.

3. **Content backup**: The GitHub repo. Any clone of the repo has all past daily content. This is independent of student state.

## Custom domain (optional, recommended long-term)

Buy a domain (e.g., `flykorean.com`), point it at GitHub Pages via CNAME. Then:
- Students always bookmark `flykorean.com/reading.html`
- Internal repo can move freely; the domain redirects stay
- Most robust option; `$12/year`

Without a custom domain, you simply send students the new URL whenever the repo moves. Their data follows them via the webhook.

## Schema versioning

`fkd_schema_version` in localStorage tracks the schema the student is on.
Current: **v2**.

When schema changes:
1. Increment `SCHEMA_VERSION` in `js/common.js`.
2. Add a migration step in `Common.migrate()` — renames keys, backfills defaults, etc.
3. Migration runs automatically on every page load if local schema < current.

This way, upgrading the app never requires student action.

## What's in localStorage (for reference)

| Key | Purpose | Rebuildable? |
|---|---|---|
| `fkd_student` | Current student name | No — user enters on first visit |
| `fkd_marks:<student>` | Flashcards + SRS state | ✓ From Sheet Snapshots tab |
| `fkd_answers` | Submitted question answers | ✓ From Sheet Submissions tab |
| `fkd_pending` | Queued webhook events (flushes in 5 min / on unload) | Ephemeral |
| `fkd_history` | Last 2000 local events (audit log) | Ephemeral |
| `fkd_starred_cats` | Student's starred categories | ✓ Reconstructible via export/import |
| `fkd_seen_fb` | Which feedback items already viewed | Ephemeral |
| `fkd_schema_version` | Migration tracking | Auto |

Everything that matters is written through to the Sheet in real time. localStorage is just the fast local copy.

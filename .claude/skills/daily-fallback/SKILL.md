---
name: daily-fallback
description: |
  Manually generate today's (or a specified date's) fly-korean-daily content via parallel
  korean-writer subagents. Use this when the GitHub Actions cron failed (no API key, by design
  per the no-cost rule), when a Claude Routine missed its slot, or when Jay wants fresh content
  on demand. Picks N category-balanced topics avoiding the last 14 days, dispatches subagents
  in parallel, validates + auto-fixes structural issues, merges into data/<date>.json, derives
  the kiwipiepy-powered token_map, updates index.json, commits, and pushes to GitHub Pages.
  Use this skill when the user says /daily-fallback, "generate today's content", "fly-korean
  fallback", "오늘 콘텐츠 만들어", or "students need fresh reading".
argument-hint: "[--date YYYY-MM-DD] [--count N] [--no-push]"
allowed-tools: Bash(python *), Bash(mkdir *), Bash(ls *), Bash(git *)
---

# /daily-fallback — manual fly-korean-daily content generation

## Why this exists

The fly-korean-daily app expects `data/<today>.json` to exist by 06:00 KST. Three failure modes:

1. **GitHub Actions cron**: requires `ANTHROPIC_API_KEY` repo secret — intentionally NOT set per the no-API-cost rule (master §13). Will always fail.
2. **Claude Routine on Anthropic cloud**: works in principle (uses Jay's plan compute, no extra cost) but requires manual setup at https://claude.ai/code/routines and may miss slots if the routine is paused / re-deployed.
3. **Manual fallback (this skill)**: zero infrastructure, runs in a Claude Code session using subagents.

This skill is the canonical Path C from master §11. It's also what a Claude Routine would invoke
under the hood — set up a routine that simply runs `/daily-fallback` and you have a daily auto.

## Arguments

- **`--date YYYY-MM-DD`** (default = today KST): target date.
- **`--count N`** (default = 5): number of topics to generate. 5 is the proven minimum that fills
  category diversity without over-burdening parallel subagents. Set to 10 for a bigger day if
  budget allows.
- **`--no-push`** (default = push enabled): skip the final `git push`. Useful when iterating.

## Pre-flight

Before doing anything, check:

```bash
cd "$REPO_ROOT"
git status --short
git pull --ff-only   # ensure clean + up to date
```

If working tree dirty: stash or commit other work first. Never mix unrelated commits into a
daily-content commit.

## PHASE 1 — Plan topics (Python, ~2 sec)

Run the topic picker. It reads the last 14 days of `data/*.json`, identifies which categories
are over- or under-represented, and outputs an `avoid_ids` list.

```bash
python "$REPO_ROOT/.claude/skills/daily-fallback/lib/pick_topics.py" \
  --date {{DATE}} --count {{COUNT}}
```

The output JSON contains:
- `categories`: list of N picked categories (least-used first, alphabetical tie-break)
- `avoid_ids`: topic IDs already used in the last 14 days — subagents must NOT reuse these

Save this JSON to `.micro/fkd_{{DATE}}/_plan.json` for traceability:

```bash
mkdir -p ".micro/fkd_{{DATE}}"
python ".claude/skills/daily-fallback/lib/pick_topics.py" --date {{DATE}} --count {{COUNT}} \
  > ".micro/fkd_{{DATE}}/_plan.json"
cat ".micro/fkd_{{DATE}}/_plan.json"
```

## PHASE 2 — Dispatch korean-writer subagents in parallel

For each category in the plan, dispatch ONE `korean-writer` subagent. Use the prompt template at:

```
$REPO_ROOT/.claude/skills/daily-fallback/templates/topic_prompt.md
```

Read the template. For each topic `i = 1..N`, substitute:
- `{{DATE}}` → the target date
- `{{TOPIC_NUM}}` → 2-digit zero-padded number (`01`, `02`, …, `10`)
- `{{CATEGORY}}` → categories[i-1] from the plan
- `{{AVOID_IDS}}` → comma-separated avoid_ids
- `{{REPO_ROOT}}` → `$REPO_ROOT`

**Dispatch all subagents in a SINGLE message** with N parallel `Agent` tool calls. They run in
parallel and finish independently.

Each subagent is `subagent_type: korean-writer`. **NEVER use general-purpose agents for Korean
content** — surrogate-safety rule.

Each subagent's output: a single `topic_NN.json` written to `.micro/fkd_{{DATE}}/`. Subagent
returns ONLY English status. Discard their text — verify by inspecting files via `ls` and
`python` (NEVER read Korean files into orchestrator context).

## PHASE 3 — Validate each topic file

Run the validator on every topic file. It auto-fixes:
- vocab not sorted by Hangul codepoint
- vocab count off by 1 (trim extras)
- `body` field name (rename to `text`)
- adjectival nouns (X-적) mislabeled as `adjective` (relabel to `noun`)
- vocab missing `this_passage:true` marker (mark first meaning)

```bash
cd "$REPO_ROOT"
for f in .micro/fkd_{{DATE}}/topic_*.json; do
  python scripts/validate_topic.py "$f"
done
```

If a topic returns FATAL (missing required fields, unfixable structure), **re-dispatch that
single subagent ONCE** with the same prompt. If it still fatals, drop it and proceed with the
remaining N-1 (record this in the commit message).

## PHASE 4 — Merge + token_map + index update

```bash
python "$REPO_ROOT/.claude/skills/daily-fallback/lib/merge_topics.py" \
  --date {{DATE}}
```

This script:
1. Re-runs validate on every topic file (idempotent)
2. Merges passing topics into `data/{{DATE}}.json` sorted by category, then id
3. Runs `scripts/upgrade_sample.py` (kiwipiepy derives the token_map; replaces nouns
   correctly — no more 서울→서우다)
4. Updates `data/index.json` to include the new date
5. Logs final stats

## PHASE 5 — Spot-check quality (no Korean read)

Quick structural audit to confirm token_map is clean:

```bash
python -c "
import json
d = json.load(open(r'data/{{DATE}}.json', encoding='utf-8'))
total_tokens = sum(len(l.get('token_map',{})) for t in d['topics'] for l in t['levels'].values())
suspect = sum(1 for t in d['topics'] for l in t['levels'].values()
              for s, e in l.get('token_map', {}).items()
              if e.get('dict','').endswith('다') and s and s[-1] in '울알을길결발설'
              and e.get('pos') == 'noun')
print(f'topics={len(d[\"topics\"])} token_map_entries={total_tokens} ㄹ-suspect-noun-mappings={suspect}')
"
```

Expected: `suspect` should be 0 or very low (single digits). If >50, kiwipiepy install may
have regressed — check `import kiwipiepy` works and re-run upgrade_sample.py.

## PHASE 6 — Commit + push (skip if --no-push)

```bash
cd "$REPO_ROOT"
git add data/{{DATE}}.json data/index.json data/latest.json
git commit -m "daily: {{DATE}} ({{N}} topics via daily-fallback skill)

Topics ({{CATEGORY_LIST}}):
  {{TOPIC_ID_LIST}}

Generated via parallel korean-writer subagents (Path C, no API cost).
token_map derived with kiwipiepy. validate_topic.py reported {{FIXES}} auto-fixes.
"
git push   # only if --no-push not set
```

After push, GitHub Pages takes ~60 seconds to deploy. Live URL pattern:
- `https://g4jy.github.io/fly-korean-daily/data/{{DATE}}.json`
- `https://g4jy.github.io/fly-korean-daily/?student=NAME` (students see new content)

## PHASE 7 — Cleanup .micro

The `.micro/fkd_{{DATE}}/` workspace contains intermediate JSONs. Auto-cleaned on next run, but
can also be removed manually:

```bash
# Optional — keep for 7 days for debugging, then remove
rm -rf ".micro/fkd_{{DATE}}"
```

## Failure recovery

| Symptom | Cause | Fix |
|---|---|---|
| `pick_topics.py` ERROR repo not found | Wrong `--repo-root` | Pass explicit `--repo-root G:\...` |
| Subagent returns Hangul in status | Subagent ignored "no Hangul" rule | Discard, dispatch the SAME prompt again |
| `validate_topic.py` FATAL on body→text rename | Subagent used `body` field | Auto-fixed by validator now (since 18b9a7d). If still fatal, re-dispatch |
| `upgrade_sample.py` ImportError kiwipiepy | not installed in this Python | `pip install kiwipiepy` |
| Many ㄹ-noun→verb suspects in spot-check | upgrade_sample.py reverted | Check `_KIWI is not None` in `scripts/upgrade_sample.py` |
| `git push` blocked / permission | Harness gate | User approves, or use `git -C "$REPO" push` form |

## How to wire this as a Claude Routine (no extra cost)

Once the skill is verified working, you can deploy it as a Claude Code Routine on Anthropic's
cloud. Setup at https://claude.ai/code/routines:

1. Create routine `fly-korean-daily-morning`
2. Cron: `0 21 * * *` UTC (= 06:00 KST)
3. Repo: `g4jy/fly-korean-daily` (or the parent Preply workspace if .claude/skills lives there)
4. Prompt body: `Run /daily-fallback for today's KST date. Use --count 5.`
5. Enable schedule

The routine runs Claude Code which sees the `/daily-fallback` skill, executes it, pushes to
GitHub Pages. Zero PC dependency.

## Provenance + audit trail

Every JSON merged via this skill carries `"source": "manual-fallback-via-subagents"` (or a
custom label via `--source`). This makes it easy to distinguish skill-generated content from
the API-cron path or future automated paths in the data archive.

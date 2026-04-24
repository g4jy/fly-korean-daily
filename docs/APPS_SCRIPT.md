# Apps Script Extension (for Fly Korean Daily)

The existing Apps Script webhook (shared with sentence-builder + TOPIK repos) handles `POST` for batched events. Fly Korean Daily extends this with:

- `POST` with `action: "answer"` — student answer submissions
- `GET ?action=pending` — evening routine reads pending submissions
- `GET ?action=all&key=<any>` — teacher dashboard reads everything
- `POST` with feedback payloads — evening routine writes back grades

This document contains the code changes to add to your existing Apps Script. The webhook URL does NOT change.

## Required Sheet tabs

Add these tabs to the same Google Sheet the existing webhook writes to:

1. **`Submissions`** — columns:
   `timestamp | session_id | student | submission_id | action | date | topic_id | level | q_id | q_kr | answer_text | answer_mode | status | feedback_score | feedback_korean | feedback_english | grammar_corrections | flagged | graded_at`

2. **`Snapshots`** — one row per student, latest-wins for cross-device flashcard sync.
   Columns: `student | updated_at | marks_count | marks_json`

3. **`StrugglingWords`** (optional, for dashboards) — columns:
   `student | word_kr | count | first_seen | last_seen`

## Apps Script code to add

Paste this at the BOTTOM of your existing Apps Script project. It adds routing to the existing `doPost` and a new `doGet`.

```javascript
// === Fly Korean Daily extension ===

const FKD_SHEET_NAME = 'Submissions';

function doGet(e) {
  const action = (e.parameter.action || '').toLowerCase();
  const auth = e.parameter.key || '';
  const ACCESS_KEY = 'teacher';
  if (auth !== ACCESS_KEY) {
    return ContentService.createTextOutput(JSON.stringify({error:'unauthorized'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Snapshot endpoint: fetch latest flashcard state for a student (cross-device sync)
  if (action === 'snapshot') {
    const student = e.parameter.student || '';
    const snapSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Snapshots');
    if (!snapSheet) {
      return ContentService.createTextOutput(JSON.stringify({marks_json:'{}', marks_count:0}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const snapData = snapSheet.getDataRange().getValues();
    if (snapData.length <= 1) {
      return ContentService.createTextOutput(JSON.stringify({marks_json:'{}', marks_count:0}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const hdrs = snapData[0];
    const studentCol = hdrs.indexOf('student');
    const jsonCol = hdrs.indexOf('marks_json');
    const countCol = hdrs.indexOf('marks_count');
    const updatedCol = hdrs.indexOf('updated_at');
    for (let r = 1; r < snapData.length; r++) {
      if (snapData[r][studentCol] === student) {
        return ContentService.createTextOutput(JSON.stringify({
          student,
          marks_json: snapData[r][jsonCol] || '{}',
          marks_count: snapData[r][countCol] || 0,
          updated_at: snapData[r][updatedCol] || ''
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({marks_json:'{}', marks_count:0}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FKD_SHEET_NAME);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const headers = values[0];
  const rows = values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });

  let out = rows;
  if (action === 'pending') {
    out = rows.filter(r => r.action === 'answer' && r.status === 'submitted' && !r.feedback_score);
  } else if (action === 'all') {
    out = rows;
  } else if (action === 'student') {
    const s = e.parameter.student;
    out = rows.filter(r => r.student === s);
  }

  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// Snapshot writer (called by fkdHandlePost when it sees action === 'marks_snapshot')
function fkdWriteSnapshot(event) {
  const sheetName = 'Snapshots';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['student','updated_at','marks_count','marks_json']);
  }
  const data = sheet.getDataRange().getValues();
  const hdrs = data[0];
  const studentCol = hdrs.indexOf('student');
  for (let r = 1; r < data.length; r++) {
    if (data[r][studentCol] === event.student) {
      sheet.getRange(r + 1, hdrs.indexOf('updated_at') + 1).setValue(event.snapshot_at || new Date().toISOString());
      sheet.getRange(r + 1, hdrs.indexOf('marks_count') + 1).setValue(event.marks_count || 0);
      sheet.getRange(r + 1, hdrs.indexOf('marks_json') + 1).setValue(event.marks_json || '{}');
      return;
    }
  }
  // No existing row: append
  sheet.appendRow([event.student, event.snapshot_at || new Date().toISOString(), event.marks_count || 0, event.marks_json || '{}']);
}

// Modify your existing doPost to route based on payload:
// - If payload is an ARRAY: existing batch events (marks, flashcard reviews)
// - If payload is an OBJECT with action === 'answer' entries: submissions
// - If payload is an OBJECT with action === 'feedback_batch': grading results from evening routine

function fkdHandlePost(e) {
  const contents = e.postData.contents;
  let body;
  try { body = JSON.parse(contents); }
  catch { return ContentService.createTextOutput('bad json').setMimeType(ContentService.MimeType.TEXT); }

  // If the body is the evening routine's feedback batch:
  if (body && body.action === 'feedback_batch' && Array.isArray(body.items)) {
    return fkdWriteFeedback(body.items);
  }

  // Otherwise, array of events: route individual entries.
  if (Array.isArray(body)) {
    const answerEvents = body.filter(x => x.action === 'answer');
    const snapshotEvents = body.filter(x => x.action === 'marks_snapshot');
    const otherEvents = body.filter(x => x.action !== 'answer' && x.action !== 'marks_snapshot');
    if (answerEvents.length) fkdWriteSubmissions(answerEvents);
    // Snapshots: only keep latest per student → collapse batch to per-student latest
    if (snapshotEvents.length) {
      const latestByStudent = {};
      for (const ev of snapshotEvents) latestByStudent[ev.student] = ev;
      for (const ev of Object.values(latestByStudent)) fkdWriteSnapshot(ev);
    }
    // Existing behavior for the legacy batch events:
    if (otherEvents.length && typeof writeExistingBatch === 'function') {
      writeExistingBatch(otherEvents);
    }
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  }
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

function fkdWriteSubmissions(events) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FKD_SHEET_NAME)
    || SpreadsheetApp.getActiveSpreadsheet().insertSheet(FKD_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'timestamp','session_id','student','submission_id','action','date','topic_id','level',
      'q_id','q_kr','answer_text','answer_mode','status','feedback_score','feedback_korean',
      'feedback_english','grammar_corrections','flagged','graded_at'
    ]);
  }
  const rows = events.map(e => [
    e.timestamp || new Date().toISOString(),
    e.session_id || '',
    e.student || '',
    e.submission_id || '',
    e.action || 'answer',
    e.date || '',
    e.topic_id || '',
    e.level || '',
    e.q_id || '',
    e.q_kr || '',
    e.answer_text || '',
    e.answer_mode || '',
    e.status || 'submitted',
    '', '', '', '', '', ''
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function fkdWriteFeedback(items) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FKD_SHEET_NAME);
  if (!sheet) return ContentService.createTextOutput('no sheet').setMimeType(ContentService.MimeType.TEXT);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const subIdCol = headers.indexOf('submission_id');
  const scoreCol = headers.indexOf('feedback_score');
  const krCol = headers.indexOf('feedback_korean');
  const enCol = headers.indexOf('feedback_english');
  const corrCol = headers.indexOf('grammar_corrections');
  const flagCol = headers.indexOf('flagged');
  const gradedCol = headers.indexOf('graded_at');

  const byId = {};
  items.forEach(it => { byId[it.submission_id] = it; });

  for (let r = 1; r < values.length; r++) {
    const id = values[r][subIdCol];
    const item = byId[id];
    if (!item) continue;
    sheet.getRange(r + 1, scoreCol + 1).setValue(item.score ?? '');
    sheet.getRange(r + 1, krCol + 1).setValue(item.korean_feedback ?? '');
    sheet.getRange(r + 1, enCol + 1).setValue(item.english_note ?? '');
    sheet.getRange(r + 1, corrCol + 1).setValue(JSON.stringify(item.grammar_corrections || []));
    sheet.getRange(r + 1, flagCol + 1).setValue(item.flagged ? 'TRUE' : '');
    sheet.getRange(r + 1, gradedCol + 1).setValue(new Date().toISOString());
  }
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}
```

## Integrating with your existing `doPost`

Your current Apps Script has a `doPost(e)` that writes the incoming JSON array to a log sheet (or similar). Modify it to route `action === 'answer'` events to `fkdWriteSubmissions`, and call `fkdHandlePost(e)` at the top:

```javascript
function doPost(e) {
  return fkdHandlePost(e);  // handles both existing batch + new answer/feedback flows
}
```

If your existing code needs to keep running for the legacy batch events (flashcard responses, word marks), wrap it in a function named `writeExistingBatch(events)` — `fkdHandlePost` calls it when present.

## Deploying

1. Apps Script editor → Deploy → Manage deployments → Select your existing web app deployment
2. Click the pencil icon → Version: **New version** → Deploy
3. The URL stays the same. The new `GET` endpoint activates immediately.

## Test

- GET: `curl 'https://script.google.com/.../exec?action=pending&key=teacher'` → should return JSON (possibly empty array)
- POST a sample answer (test from the app's question UI); verify it appears in the `Submissions` sheet
- POST a sample feedback_batch; verify the `feedback_score` column updates for matching `submission_id`s

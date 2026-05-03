/* === Fly Korean Daily — Shared Utilities === */
/* Webhook, student identity, TTS, storage helpers, answer submission */

const Common = (() => {
  /**
   * === PORTABILITY CONTRACT ===
   * The *only* stable external dependency is the Apps Script webhook URL below.
   * Everything else (this repo, the Pages URL, the HTML filenames) can change
   * and students' data keeps working because:
   *   1. Source of truth = Google Sheet (via WEBHOOK_URL). All marks, answers,
   *      and SRS state stream there in real time.
   *   2. localStorage is a cache keyed by student name. On cold start, the app
   *      calls pullMarksSnapshot() which restores full state from the Sheet.
   *   3. The student name in ?student=<name> is the identity. As long as students
   *      visit any version of this app with their name, their data follows them.
   *
   * Schema migrations: bump SCHEMA_VERSION, add a migration step in migrate().
   */
  const SCHEMA_VERSION = 3;
  const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbw3f0cxkufdZkrG6kABkMy9djKGIrJvQX1qqqcFMFgt89ZhNGRlFVElYFUohA3z-tqoew/exec';
  const KEYS = {
    STUDENT: 'fkd_student',
    PENDING: 'fkd_pending',
    MARKS: 'fkd_marks',                  // per-student flashcards + SRS state
    RESPONSES: 'fkd_history',            // last 2000 events (local audit log)
    ANSWERS: 'fkd_answers',              // submitted answers (keyed by date+topic+q)
    STARRED_CATS: 'fkd_starred_cats',
    SCHEMA_VERSION: 'fkd_schema_version' // controls migration
  };

  // --- Korean morphology helpers (used by mark migration v2→v3 and exposed
  //     via Common.bestDictGuess for reading.js / flashcards.js callers).
  const JONG_JAMO_CODES = [
    0x0000, 0x3131, 0x3132, 0x3133, 0x3134, 0x3135, 0x3136, 0x3137,
    0x3139, 0x313A, 0x313B, 0x313C, 0x313D, 0x313E, 0x313F, 0x3140,
    0x3141, 0x3142, 0x3144, 0x3145, 0x3146, 0x3147, 0x3148, 0x314A,
    0x314B, 0x314C, 0x314D, 0x314E
  ];
  function dropFinalJongseong(s, targetJamo) {
    if (!s) return null;
    const last = s.charCodeAt(s.length - 1);
    if (last < 0xAC00 || last > 0xD7A3) return null;
    const offset = last - 0xAC00;
    const jong = offset % 28;
    if (jong === 0) return null;
    if (JONG_JAMO_CODES[jong] !== targetJamo.charCodeAt(0)) return null;
    return s.slice(0, -1) + String.fromCharCode(last - jong);
  }
  function bestDictGuess(stripped) {
    if (!stripped || stripped.length < 1) return null;
    const s = stripped;
    if (s.endsWith('한') && s.length > 1) return s.slice(0, -1) + '하다';
    if (s.endsWith('해서') && s.length > 2) return s.slice(0, -2) + '하다';
    if (s.endsWith('해')) return s.slice(0, -1) + '하다';
    if (s.endsWith('하려고') && s.length > 3) return s.slice(0, -3) + '하다';
    if (s.endsWith('려고') && s.length > 2) return s.slice(0, -2) + '다';
    if (s.endsWith('와')) return s.slice(0, -1) + '오다';
    if (s.endsWith('워')) return s.slice(0, -1) + '우다';
    if (s.endsWith('던') && s.length > 1) return s.slice(0, -1) + '다';
    if (s.endsWith('려')) return s.slice(0, -1) + '리다';
    if (/[어아여]서$/.test(s) && s.length > 1) return s.slice(0, -2) + '다';
    if (/[어아여]$/.test(s)) return s.slice(0, -1) + '다';
    if (s.endsWith('지만') && s.length > 2) return s.slice(0, -2) + '다';
    if (s.endsWith('지') && s.length > 1) return s.slice(0, -1) + '다';
    if (s.endsWith('니까') && s.length > 2) return s.slice(0, -2) + '다';
    if (s.endsWith('니') && s.length > 1) return s.slice(0, -1) + '다';
    if (s.endsWith('으면') && s.length > 2) return s.slice(0, -2) + '다';
    if (s.endsWith('면') && s.length > 1) return s.slice(0, -1) + '다';
    if (s.endsWith('게') && s.length > 1) return s.slice(0, -1) + '다';
    if (s.endsWith('고') && s.length > 1) return s.slice(0, -1) + '다';
    const lStem = dropFinalJongseong(s, 'ㄹ');
    if (lStem) return lStem + '다';
    return null;
  }

  /**
   * v2 → v3: rewrite mark keys whose surface form was saved as the dict.
   * Uses bestDictGuess; if it derives a different real dict form AND no
   * existing mark already lives at that key, the mark is rekeyed in place.
   * If a mark already exists at the new key, leave the legacy one alone
   * (we don't want to silently merge SRS state).
   */
  function migrateLegacyInflectedMarks(student) {
    if (!student) return { changed: 0, skipped: 'no-student' };
    const marks = JSON.parse(localStorage.getItem(KEYS.MARKS + ':' + student) || '{}');
    let changed = 0;
    const conflicts = [];
    for (const oldKey of Object.keys(marks)) {
      const guess = bestDictGuess(oldKey);
      if (!guess || guess === oldKey) continue;
      if (marks[guess]) { conflicts.push([oldKey, guess]); continue; }
      const m = marks[oldKey];
      m.kr = guess;
      if (!m.surface) m.surface = oldKey;
      marks[guess] = m;
      delete marks[oldKey];
      changed++;
    }
    if (changed > 0) {
      localStorage.setItem(KEYS.MARKS + ':' + student, JSON.stringify(marks));
    }
    return { changed, conflicts };
  }

  /** Run any schema migrations needed to bring local storage up to SCHEMA_VERSION.
   *  Only bumps the stored version after the per-student step actually succeeds,
   *  so a student who visits the page after their first cold-start (when no
   *  student name was set yet) still gets their marks migrated. */
  function migrate() {
    const cur = parseInt(localStorage.getItem(KEYS.SCHEMA_VERSION) || '1', 10);
    if (cur >= SCHEMA_VERSION) return { skipped: true, version: cur };
    const log = [];
    let allDone = true;
    if (cur < 3) {
      // v2 → v3: rekey inflected-surface marks (saved pre-be464ed) to dict forms.
      const student = (() => {
        const url = new URLSearchParams(location.search).get('student');
        return url || localStorage.getItem(KEYS.STUDENT) || '';
      })();
      if (student) {
        const r = migrateLegacyInflectedMarks(student);
        log.push(`v2→v3: rekeyed ${r.changed} marks for ${student} (${r.conflicts.length} conflicts left as-is)`);
      } else {
        log.push('v2→v3: no student yet — migration deferred to next visit');
        allDone = false;
      }
    }
    if (allDone) {
      localStorage.setItem(KEYS.SCHEMA_VERSION, String(SCHEMA_VERSION));
      log.push(`schema → v${SCHEMA_VERSION}`);
    }
    return { migrated: true, log };
  }
  migrate();

  let sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* --- Student identity --- */
  function getStudent() {
    const url = new URLSearchParams(location.search).get('student');
    if (url) { localStorage.setItem(KEYS.STUDENT, url); return url; }
    return localStorage.getItem(KEYS.STUDENT) || '';
  }
  function setStudent(name) { if (name) localStorage.setItem(KEYS.STUDENT, name.trim()); }
  function requireStudent(redirectTo = 'index.html') {
    const s = getStudent();
    if (!s) { location.href = redirectTo + '?gate=1'; return null; }
    return s;
  }

  /* --- Per-student marks (SRS state) --- */
  function marksKey(student) { return KEYS.MARKS + ':' + (student || getStudent()); }
  function getMarks(student) {
    student = student || getStudent();
    if (!student) return {};
    return JSON.parse(localStorage.getItem(marksKey(student)) || '{}');
  }
  function saveMarks(marks, student) {
    student = student || getStudent();
    if (!student) return;
    localStorage.setItem(marksKey(student), JSON.stringify(marks));
  }

  function addMark({ kr, dict_kr, surface, en, def, pos, gloss, context, source_sentence, category, source }) {
    const student = getStudent();
    if (!student || !kr) return null;
    const marks = getMarks(student);
    const existing = marks[kr];
    const entry = existing || {
      kr,
      dict_kr: dict_kr || '',
      surface: surface || '',
      en: en || '',
      def: def || '',
      pos: pos || '',
      gloss: gloss || '',
      context: context || '',
      source_sentence: source_sentence || '',
      category: category || '',
      source: source || 'reading',
      added: new Date().toISOString(),
      status: 'new',
      interval: 0,
      ease: 2.5,
      reviewCount: 0,
      nextReview: new Date().toISOString().slice(0, 10),
      lastSeen: null
    };
    if (dict_kr && !entry.dict_kr) entry.dict_kr = dict_kr;
    if (surface && !entry.surface) entry.surface = surface;
    if (en && !entry.en) entry.en = en;
    if (def && !entry.def) entry.def = def;
    if (pos && !entry.pos) entry.pos = pos;
    if (gloss && !entry.gloss) entry.gloss = gloss;
    if (context && !entry.context) entry.context = context;
    if (source_sentence && !entry.source_sentence) entry.source_sentence = source_sentence;
    if (category && !entry.category) entry.category = category;
    marks[kr] = entry;
    saveMarks(marks, student);
    queueWebhook({
      student, word_kr: kr, word_dict_kr: entry.dict_kr, word_en: entry.en,
      status: 'marked', category: entry.category, source: entry.source,
      context: entry.context, source_sentence: entry.source_sentence,
      pos: entry.pos, gloss: entry.gloss
    });
    pushMarksSnapshot();
    return entry;
  }

  function editMark(kr, patch) {
    const student = getStudent();
    if (!student || !kr) return;
    const marks = getMarks(student);
    const m = marks[kr];
    if (!m) return;
    Object.assign(m, patch);
    marks[kr] = m;
    saveMarks(marks, student);
    queueWebhook({
      student, word_kr: kr, word_en: m.en, status: 'edited',
      category: m.category || '', source: 'edit', context: m.context || ''
    });
    pushMarksSnapshot();
  }

  function removeMark(kr) {
    const student = getStudent();
    if (!student || !kr) return;
    const marks = getMarks(student);
    delete marks[kr];
    saveMarks(marks, student);
    queueWebhook({
      student, word_kr: kr, word_en: '', status: 'unmarked',
      category: '', source: 'reading', context: ''
    });
    pushMarksSnapshot();
  }

  function hasMark(kr) { return !!getMarks()[kr]; }

  /* --- SM-2 SRS --- */
  function updateSRS(kr, quality) {
    const student = getStudent();
    if (!student) return;
    const marks = getMarks(student);
    const m = marks[kr];
    if (!m) return;
    const q = quality === 'again' ? 0 : quality === 'hard' ? 3 : 5;
    m.reviewCount++;
    m.lastSeen = new Date().toISOString();
    if (q < 3) {
      m.interval = 0;
      m.status = 'learning';
      m.ease = Math.max(1.3, m.ease - 0.2);
    } else {
      if (m.interval === 0) m.interval = 1;
      else if (m.interval === 1) m.interval = 3;
      else m.interval = Math.round(m.interval * m.ease);
      if (q === 3) m.ease = Math.max(1.3, m.ease - 0.15);
      else m.ease = Math.min(2.8, m.ease + 0.1);
      m.status = m.interval >= 14 ? 'mastered' : 'reviewing';
    }
    const next = new Date();
    next.setDate(next.getDate() + m.interval);
    m.nextReview = next.toISOString().slice(0, 10);
    marks[kr] = m;
    saveMarks(marks, student);
    queueWebhook({
      student, word_kr: kr, word_en: m.en,
      status: quality === 'good' ? 'know' : quality === 'hard' ? 'unsure' : 'dont_know',
      category: m.category || '', source: 'flashcard', context: m.context || ''
    });
    pushMarksSnapshot();
  }

  function getDueCards() {
    const marks = getMarks();
    const today = new Date().toISOString().slice(0, 10);
    return Object.values(marks).filter(m => m.nextReview <= today);
  }

  function getStats() {
    const marks = getMarks();
    const list = Object.values(marks);
    const today = new Date().toISOString().slice(0, 10);
    return {
      total: list.length,
      due: list.filter(m => m.nextReview <= today).length,
      learning: list.filter(m => m.status === 'learning' || m.status === 'new').length,
      reviewing: list.filter(m => m.status === 'reviewing').length,
      mastered: list.filter(m => m.status === 'mastered').length
    };
  }

  /* --- Starred categories --- */
  function getStarredCats() {
    return JSON.parse(localStorage.getItem(KEYS.STARRED_CATS) || '[]');
  }
  function toggleStarredCat(cat) {
    const list = getStarredCats();
    const idx = list.indexOf(cat);
    if (idx >= 0) list.splice(idx, 1); else list.push(cat);
    localStorage.setItem(KEYS.STARRED_CATS, JSON.stringify(list));
    return list;
  }

  /* --- Liked passages (per student) ---
   * Keyed by `${date}|${topic_id}`. localStorage primary, webhook mirrors to
   * the Apps Script Sheet so the teacher can pull a per-student likes list.
   * Apps Script must accept POST with action="like_toggle" — see docs/APPS_SCRIPT.md.
   */
  function likesKey(student) { return 'fkd_likes:' + (student || getStudent() || ''); }
  function getLikes(student) {
    const k = likesKey(student);
    if (!k) return {};
    return JSON.parse(localStorage.getItem(k) || '{}');
  }
  function saveLikes(map, student) {
    const k = likesKey(student);
    if (!k) return;
    localStorage.setItem(k, JSON.stringify(map));
  }
  function isLiked(date, topicId) {
    const m = getLikes();
    return Boolean(m[`${date}|${topicId}`]);
  }
  function toggleLike(date, topicId, meta) {
    const student = getStudent();
    if (!student) return false;
    const m = getLikes(student);
    const key = `${date}|${topicId}`;
    const liked = !m[key];
    if (liked) {
      m[key] = {
        liked_at: new Date().toISOString(),
        category: (meta && meta.category) || '',
        title: (meta && meta.title) || ''
      };
    } else {
      delete m[key];
    }
    saveLikes(m, student);
    queueWebhook({
      action: 'like_toggle',
      student, date,
      topic_id: topicId,
      like_state: liked ? 'liked' : 'unliked',
      category: (meta && meta.category) || '',
      title: (meta && meta.title) || '',
      timestamp: new Date().toISOString()
    });
    return liked;
  }

  /* --- Answer submissions --- */
  function answerKey(student, date, topicId, level, qId) {
    return [student || getStudent(), date, topicId, level, qId].join('::');
  }
  function getLocalAnswer(date, topicId, level, qId) {
    const all = JSON.parse(localStorage.getItem(KEYS.ANSWERS) || '{}');
    return all[answerKey(getStudent(), date, topicId, level, qId)] || null;
  }
  function saveLocalAnswer(date, topicId, level, qId, data) {
    const all = JSON.parse(localStorage.getItem(KEYS.ANSWERS) || '{}');
    all[answerKey(getStudent(), date, topicId, level, qId)] = {
      ...data, saved_at: new Date().toISOString()
    };
    localStorage.setItem(KEYS.ANSWERS, JSON.stringify(all));
  }
  function submitAnswer({ date, topicId, level, qId, qKr, answerText, mode }) {
    const student = getStudent();
    if (!student) return;
    saveLocalAnswer(date, topicId, level, qId, { answerText, mode, qKr });
    const submission_id = [student, date, topicId, level, qId].join('::') + '@' + Date.now();
    queueWebhook({
      student,
      submission_id,
      action: 'answer',
      date,
      topic_id: topicId,
      level,
      q_id: qId,
      q_kr: qKr,
      answer_text: answerText,
      answer_mode: mode,
      status: 'submitted'
    });
    return submission_id;
  }

  /* --- Feedback (received from evening routine via GET or cached) --- */
  async function fetchFeedback(date) {
    const student = getStudent();
    if (!student) return {};
    try {
      const resp = await fetch(`data/_feedback/${date}_${student}.json?v=${Date.now()}`);
      if (resp.ok) return resp.json();
    } catch {}
    return {};
  }

  /* --- Recent feedback: scan last 7 days for unread feedback on this student --- */
  const SEEN_FEEDBACK_KEY = 'fkd_seen_fb';
  function seenFeedback() { return JSON.parse(localStorage.getItem(SEEN_FEEDBACK_KEY) || '{}'); }
  function markFeedbackSeen(date, qId) {
    const s = seenFeedback();
    s[`${date}::${qId}`] = new Date().toISOString();
    localStorage.setItem(SEEN_FEEDBACK_KEY, JSON.stringify(s));
  }

  async function fetchRecentFeedback(daysBack = 7) {
    const student = getStudent();
    if (!student) return [];
    // Also need the index to know which days to check
    let idx;
    try { idx = await fetchJSON('data/index.json'); } catch { idx = { dates: [] }; }
    const recent = (idx.dates || []).slice(-daysBack);
    const seen = seenFeedback();
    const out = [];
    for (const date of recent) {
      try {
        const fb = await fetch(`data/_feedback/${date}_${student}.json?v=${Date.now()}`);
        if (!fb.ok) continue;
        const data = await fb.json();
        // Also load that day's JSON to resolve topic/q context
        let daily = null;
        try { daily = await fetch(`data/${date}.json?v=${Date.now()}`).then(r => r.ok ? r.json() : null); } catch {}
        for (const [qId, fbItem] of Object.entries(data)) {
          if (!fbItem || !fbItem.korean_feedback) continue;
          const key = `${date}::${qId}`;
          const isUnread = !seen[key];
          // Resolve context
          let qKr = '', topicId = '', level = '', answerText = '';
          if (daily) {
            for (const t of daily.topics || []) {
              for (const [lk, lv] of Object.entries(t.levels || {})) {
                const q = (lv.questions || []).find(x => x.id === qId);
                if (q) { qKr = q.q_kr; topicId = t.id; level = lk; break; }
              }
              if (qKr) break;
            }
          }
          // Resolve my answer text
          const ans = getLocalAnswer(date, topicId, level, qId);
          answerText = ans?.answerText || '';
          out.push({ date, qId, topicId, level, qKr, answerText, feedback: fbItem, isUnread });
        }
      } catch {}
    }
    // Newest first, unread-first within each date
    out.sort((a, b) => (b.date + b.qId).localeCompare(a.date + a.qId));
    out.sort((a, b) => (b.isUnread ? 1 : 0) - (a.isUnread ? 1 : 0));
    return out;
  }

  /* --- Cross-device flashcard sync via snapshot --- */
  const SNAP_KEY = 'fkd_snap_pushed';
  let pendingSnapshotTimer = null;

  function pushMarksSnapshot(debounceMs = 8000) {
    // Debounced: many rapid SRS ratings → one snapshot at end
    clearTimeout(pendingSnapshotTimer);
    pendingSnapshotTimer = setTimeout(() => {
      const student = getStudent();
      if (!student) return;
      const marks = getMarks(student);
      const entry = {
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        action: 'marks_snapshot',
        student,
        snapshot_at: new Date().toISOString(),
        marks_json: JSON.stringify(marks),
        marks_count: Object.keys(marks).length
      };
      const pending = JSON.parse(localStorage.getItem(KEYS.PENDING) || '[]');
      pending.push(entry);
      localStorage.setItem(KEYS.PENDING, JSON.stringify(pending));
      localStorage.setItem(SNAP_KEY, new Date().toISOString());
      flushWebhook();
    }, debounceMs);
  }

  async function pullMarksSnapshot() {
    const student = getStudent();
    if (!student) return { pulled: false, reason: 'no-student' };
    try {
      const url = WEBHOOK_URL + '?action=snapshot&student=' + encodeURIComponent(student) + '&key=teacher';
      const resp = await fetch(url);
      if (!resp.ok) return { pulled: false, reason: 'fetch-failed:' + resp.status };
      const data = await resp.json();
      if (!data || !data.marks_json) return { pulled: false, reason: 'empty' };
      const remote = JSON.parse(data.marks_json);
      // Merge: if local has a key the remote doesn't have, keep local. If remote has a key local doesn't, add it. If both, pick the one with the later lastSeen.
      const local = getMarks(student);
      const merged = { ...remote };
      const localKeys = Object.keys(local);
      let added = 0, updated = 0;
      for (const k of localKeys) {
        const l = local[k], r = remote[k];
        if (!r) { merged[k] = l; added++; continue; }
        // Prefer the entry with the later lastSeen (or later added if lastSeen missing)
        const lTime = l.lastSeen || l.added || '';
        const rTime = r.lastSeen || r.added || '';
        if (lTime >= rTime) { merged[k] = l; if (lTime > rTime) updated++; }
      }
      saveMarks(merged, student);
      return { pulled: true, remote_count: Object.keys(remote).length, local_count: localKeys.length, merged_count: Object.keys(merged).length, added_from_local: added, updated };
    } catch (e) {
      return { pulled: false, reason: 'error:' + e.message };
    }
  }

  /* --- Webhook (batched) --- */
  function queueWebhook(payload) {
    const entry = { timestamp: new Date().toISOString(), session_id: sessionId, ...payload };
    const pending = JSON.parse(localStorage.getItem(KEYS.PENDING) || '[]');
    pending.push(entry);
    localStorage.setItem(KEYS.PENDING, JSON.stringify(pending));
    const history = JSON.parse(localStorage.getItem(KEYS.RESPONSES) || '[]');
    history.push(entry);
    if (history.length > 2000) history.splice(0, history.length - 2000);
    localStorage.setItem(KEYS.RESPONSES, JSON.stringify(history));
    if (pending.length >= 20) flushWebhook();
  }

  function flushWebhook() {
    const pending = JSON.parse(localStorage.getItem(KEYS.PENDING) || '[]');
    if (pending.length === 0) return;
    const body = JSON.stringify(pending);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'text/plain' });
      if (navigator.sendBeacon(WEBHOOK_URL, blob)) {
        localStorage.setItem(KEYS.PENDING, '[]'); return;
      }
    }
    fetch(WEBHOOK_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body })
      .then(() => localStorage.setItem(KEYS.PENDING, '[]'))
      .catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWebhook();
  });
  window.addEventListener('beforeunload', flushWebhook);
  setInterval(flushWebhook, 5 * 60 * 1000);

  /* --- TTS (audio file preferred, Web Speech fallback) --- */
  let currentAudio = null;
  function stopAudio() {
    if (currentAudio) { currentAudio.pause(); currentAudio.currentTime = 0; currentAudio = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  function playAudioFile(url) {
    return new Promise((resolve, reject) => {
      stopAudio();
      const a = new Audio(url);
      currentAudio = a;
      a.onended = () => resolve();
      a.onerror = () => reject(new Error('audio load failed'));
      a.play().catch(reject);
    });
  }

  function speakKorean(text) {
    if (!('speechSynthesis' in window) || !text) return;
    stopAudio();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 0.9;
    const voices = speechSynthesis.getVoices();
    const ko = voices.find(v => v.lang.startsWith('ko'));
    if (ko) u.voice = ko;
    speechSynthesis.speak(u);
  }

  async function playOrSpeak(audioUrl, fallbackText) {
    if (audioUrl) {
      try { await playAudioFile(audioUrl); return; }
      catch { /* file missing → fall through */ }
    }
    speakKorean(fallbackText);
  }

  /* --- Speech Recognition (for answer recording) --- */
  function createRecognizer(onTranscript, onError) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const rec = new SR();
    rec.lang = 'ko-KR';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      onTranscript(final, interim);
    };
    rec.onerror = (e) => onError && onError(e.error);
    return rec;
  }

  /* --- Data loading --- */
  async function fetchJSON(path) {
    const resp = await fetch(path + '?v=' + Date.now());
    if (!resp.ok) throw new Error('fetch ' + path + ' → ' + resp.status);
    return resp.json();
  }
  async function loadDaily(date) {
    const target = date === 'latest' || !date ? 'data/latest.json' : 'data/' + date + '.json';
    try { return await fetchJSON(target); }
    catch (e) { if (date !== 'latest') return loadDaily('latest'); throw e; }
  }
  async function loadIndex() {
    try { return await fetchJSON('data/index.json'); } catch { return { dates: [] }; }
  }
  async function loadStudentReview(date) {
    const student = getStudent();
    if (!student || !date) return null;
    try { return await fetchJSON(`data/${date}_review_${student}.json`); } catch { return null; }
  }

  /* --- Toast --- */
  let toastEl = null;
  function toast(msg, kind = 'info', ms = 1800) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'toast show ' + kind;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  /* --- Student chip --- */
  function renderStudentChip(containerSelector) {
    const host = document.querySelector(containerSelector);
    if (!host) return;
    const s = getStudent();
    host.innerHTML = '';
    if (s) {
      const chip = document.createElement('span');
      chip.className = 'student-chip';
      chip.textContent = s;
      host.appendChild(chip);
    }
  }

  /* --- Pre-warm TTS voices --- */
  if ('speechSynthesis' in window) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
  }

  /**
   * Belt-and-suspenders: download all of this student's local state as JSON.
   * Works even if webhook is unreachable; lets the student/teacher archive offline.
   */
  function exportStudentData() {
    const student = getStudent();
    if (!student) return null;
    const bundle = {
      schema: SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      student,
      marks: getMarks(student),
      answers: JSON.parse(localStorage.getItem(KEYS.ANSWERS) || '{}'),
      starred_categories: getStarredCats(),
      history_tail: JSON.parse(localStorage.getItem(KEYS.RESPONSES) || '[]').slice(-200)
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fly-korean_${student}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return bundle;
  }

  /**
   * Import a previously-exported bundle. Merges by per-word lastSeen (later wins),
   * so restoring an old export onto a newer state doesn't clobber recent work.
   */
  function importStudentData(bundle) {
    if (!bundle || !bundle.student || !bundle.marks) return { error: 'invalid bundle' };
    setStudent(bundle.student);
    const existing = getMarks(bundle.student);
    const merged = { ...existing };
    let added = 0, updated = 0;
    for (const [kr, m] of Object.entries(bundle.marks)) {
      const cur = existing[kr];
      if (!cur) { merged[kr] = m; added++; continue; }
      const curTime = cur.lastSeen || cur.added || '';
      const newTime = m.lastSeen || m.added || '';
      if (newTime > curTime) { merged[kr] = m; updated++; }
    }
    saveMarks(merged, bundle.student);
    // Also restore starred categories if not already set
    if (bundle.starred_categories && getStarredCats().length === 0) {
      localStorage.setItem(KEYS.STARRED_CATS, JSON.stringify(bundle.starred_categories));
    }
    pushMarksSnapshot(500);  // push the merged state back to the Sheet
    return { added, updated, merged_count: Object.keys(merged).length };
  }

  return {
    WEBHOOK_URL, SCHEMA_VERSION,
    getStudent, setStudent, requireStudent,
    getMarks, addMark, editMark, removeMark, hasMark,
    updateSRS, getDueCards, getStats,
    getStarredCats, toggleStarredCat,
    getLikes, isLiked, toggleLike,
    submitAnswer, getLocalAnswer, fetchFeedback, fetchRecentFeedback,
    markFeedbackSeen,
    pushMarksSnapshot, pullMarksSnapshot,
    exportStudentData, importStudentData,
    queueWebhook, flushWebhook,
    playOrSpeak, speakKorean, stopAudio,
    createRecognizer,
    fetchJSON, loadDaily, loadIndex, loadStudentReview,
    toast, renderStudentChip,
    // morphology helpers (also used by reading.js / migrations)
    bestDictGuess, dropFinalJongseong, migrateLegacyInflectedMarks
  };
})();

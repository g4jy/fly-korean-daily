/* === Fly Korean Daily — Shared Utilities === */
/* Webhook, student identity, TTS, storage helpers, answer submission */

const Common = (() => {
  const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbw3f0cxkufdZkrG6kABkMy9djKGIrJvQX1qqqcFMFgt89ZhNGRlFVElYFUohA3z-tqoew/exec';
  const KEYS = {
    STUDENT: 'fkd_student',
    PENDING: 'fkd_pending',
    MARKS: 'fkd_marks',
    RESPONSES: 'fkd_history',
    ANSWERS: 'fkd_answers',        // submitted answers (keyed by passage+q_id)
    STARRED_CATS: 'fkd_starred_cats'
  };

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

  function addMark({ kr, dict_kr, surface, en, def, pos, gloss, context, category, source }) {
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
    if (category && !entry.category) entry.category = category;
    marks[kr] = entry;
    saveMarks(marks, student);
    queueWebhook({
      student, word_kr: kr, word_dict_kr: entry.dict_kr, word_en: entry.en,
      status: 'marked', category: entry.category, source: entry.source,
      context: entry.context, pos: entry.pos, gloss: entry.gloss
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

  return {
    WEBHOOK_URL,
    getStudent, setStudent, requireStudent,
    getMarks, addMark, editMark, removeMark, hasMark,
    updateSRS, getDueCards, getStats,
    getStarredCats, toggleStarredCat,
    submitAnswer, getLocalAnswer, fetchFeedback, fetchRecentFeedback,
    markFeedbackSeen,
    pushMarksSnapshot, pullMarksSnapshot,
    queueWebhook, flushWebhook,
    playOrSpeak, speakKorean, stopAudio,
    createRecognizer,
    fetchJSON, loadDaily, loadIndex, loadStudentReview,
    toast, renderStudentChip
  };
})();

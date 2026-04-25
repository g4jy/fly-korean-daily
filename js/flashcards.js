/* === Flashcards — multi-mode practice ===
 * Modes:
 *   daily   — SRS-due cards (Again/Hard/Good, SM-2 schedule)
 *   browse  — every saved word, mark Don't Know / Unsure / Know
 *   known   — only mastered + reviewing words, verify mastery
 *   unknown — only weak words (new + learning), practice until known
 * Each non-SRS mode reuses Common.updateSRS() under the hood so progress
 * stays unified and webhook reporting stays consistent.
 */

(async function () {
  const app = document.getElementById('app');
  const student = Common.requireStudent();
  if (!student) return;
  Common.renderStudentChip('#top-right');

  // Pull cross-device snapshot before building the queue so we see marks from other devices
  await Common.pullMarksSnapshot();

  const MODES = {
    daily:   { label: 'Daily Review',   desc: 'SRS-scheduled words due now',         buttons: 'srs'   },
    browse:  { label: 'Browse All',      desc: 'Every saved word — go through them',  buttons: 'know3' },
    known:   { label: 'Review Known',    desc: 'Verify mastery of words you know',    buttons: 'know3' },
    unknown: { label: 'Practice Weak',   desc: 'Drill new + learning words',          buttons: 'know3' }
  };

  // Per-student preferences so two students sharing a browser don't bleed state
  const MODE_KEY = `fkd_fc_mode:${student}`;
  const DIR_KEY  = `fkd_fc_dir:${student}`;
  let mode = localStorage.getItem(MODE_KEY) || 'daily';
  if (!MODES[mode]) mode = 'daily';
  let direction = localStorage.getItem(DIR_KEY) || 'kr2en';   // kr2en | en2kr
  let queue = [];
  let idx = 0;
  let flipped = false;

  function isKnown(m) { return m.status === 'mastered' || m.status === 'reviewing'; }
  function isWeak(m)  { return m.status === 'new' || m.status === 'learning' || !m.status; }

  function buildQueue() {
    const marks = Object.values(Common.getMarks());
    const today = new Date().toISOString().slice(0, 10);
    let list = [];
    if (mode === 'daily') {
      list = marks.filter(m => (m.nextReview || '') <= today);
      list.sort((a, b) => {
        const aNew = a.status === 'new' ? 0 : 1;
        const bNew = b.status === 'new' ? 0 : 1;
        if (aNew !== bNew) return aNew - bNew;
        return (a.nextReview || '').localeCompare(b.nextReview || '');
      });
    } else if (mode === 'browse') {
      list = marks.slice();
      list.sort((a, b) => (b.added || '').localeCompare(a.added || ''));
    } else if (mode === 'known') {
      list = marks.filter(isKnown);
      list.sort((a, b) => (a.lastSeen || '').localeCompare(b.lastSeen || ''));
    } else if (mode === 'unknown') {
      list = marks.filter(isWeak);
      list.sort((a, b) => (a.lastSeen || '').localeCompare(b.lastSeen || ''));
    }
    return list;
  }

  function modeCounts() {
    const marks = Object.values(Common.getMarks());
    const today = new Date().toISOString().slice(0, 10);
    return {
      daily:    marks.filter(m => (m.nextReview || '') <= today).length,
      browse:   marks.length,
      known:    marks.filter(isKnown).length,
      unknown:  marks.filter(isWeak).length,
      reviewing: marks.filter(m => m.status === 'reviewing').length,
      mastered: marks.filter(m => m.status === 'mastered').length
    };
  }

  function render() {
    const counts = modeCounts();

    const tabs = Object.entries(MODES).map(([k, m]) => `
      <button class="fc-mode-tab ${k === mode ? 'active' : ''}" data-mode="${k}">
        <span class="fc-mode-label">${m.label}</span>
        <span class="fc-mode-count">${counts[k]}</span>
      </button>
    `).join('');

    const body = (queue.length === 0) ? renderEmpty() : renderCardBody(queue[idx]);

    // Mutually exclusive tiles: every saved word lands in exactly one bucket
    app.innerHTML = `
      <div class="fc-modes">${tabs}</div>
      <div class="fc-mode-desc">${MODES[mode].desc}</div>

      <div class="flash-summary">
        <div class="stat unknown"><span class="n">${counts.unknown}</span><div class="lbl">Weak</div></div>
        <div class="stat learning"><span class="n">${counts.reviewing}</span><div class="lbl">Reviewing</div></div>
        <div class="stat mastered"><span class="n">${counts.mastered}</span><div class="lbl">Mastered</div></div>
      </div>

      ${body}

      ${renderWordList()}
    `;

    document.querySelectorAll('.fc-mode-tab').forEach(b => {
      b.addEventListener('click', () => {
        if (mode === b.dataset.mode) return;
        mode = b.dataset.mode;
        localStorage.setItem(MODE_KEY, mode);
        flipped = false;
        idx = 0;
        queue = buildQueue();
        render();
      });
    });

    if (queue.length > 0) wireCard(queue[idx]);
    wireWordList();
  }

  function renderEmpty() {
    if (Object.keys(Common.getMarks()).length === 0) {
      return `
        <div class="empty-state">
          <span class="ic">🌱</span>
          <h3>No words saved yet</h3>
          <p>Open today's reading and tap any word you want to remember.</p>
          <a class="btn" href="reading.html">Go to reading</a>
        </div>`;
    }
    const labels = {
      daily:   { ic: '🎉', t: 'All caught up for today',           p: 'Switch tabs above to keep practicing — or save more words.' },
      browse:  { ic: '✨', t: 'Nothing to browse',                 p: 'Add words from today\'s reading first.' },
      known:   { ic: '⭐', t: 'No known words yet',                p: 'Mark cards "Know" a few times — they\'ll appear here once mastered.' },
      unknown: { ic: '👏', t: 'No weak words — every one is solid', p: 'Add new words from reading or browse the full list.' }
    }[mode];
    return `
      <div class="empty-state">
        <span class="ic">${labels.ic}</span>
        <h3>${labels.t}</h3>
        <p>${labels.p}</p>
        <a class="btn btn-ghost" href="reading.html">Save more words</a>
      </div>`;
  }

  function renderCardBody(card) {
    const front = direction === 'kr2en' ? (card.kr || '') : (card.en || '—');
    const back  = direction === 'kr2en' ? (card.en || '—') : (card.kr || '');

    const buttonsHtml = MODES[mode].buttons === 'srs' ? `
      <div class="srs-buttons">
        <button class="srs-btn srs-again" data-q="again">Again<span class="lbl-sub">0m</span></button>
        <button class="srs-btn srs-hard"  data-q="hard">Hard<span class="lbl-sub">${hardPreview(card)}</span></button>
        <button class="srs-btn srs-good"  data-q="good">Good<span class="lbl-sub">${goodPreview(card)}</span></button>
      </div>` : `
      <div class="srs-buttons">
        <button class="srs-btn srs-again" data-q="again">Don't Know</button>
        <button class="srs-btn srs-hard"  data-q="hard">Unsure</button>
        <button class="srs-btn srs-good"  data-q="good">Know</button>
      </div>`;

    // Front 🔊 only when the front is Korean (otherwise it spoils the answer)
    const frontListen = direction === 'kr2en'
      ? `<button class="fc-listen" id="listen" aria-label="Listen">🔊</button>` : '';
    // Hide shuffle in Daily mode — SM-2 scheduling shouldn't be reordered
    const shuffleBtn = mode === 'daily'
      ? '' : `<button class="fc-tool-btn" id="shuffle-btn" title="Shuffle this deck">🔀 Shuffle</button>`;

    return `
      <div class="fc-toolbar">
        <button class="fc-tool-btn" id="dir-toggle" title="Swap question side">${direction === 'kr2en' ? 'KR → EN' : 'EN → KR'}</button>
        ${shuffleBtn}
        <span class="fc-progress">${idx + 1} / ${queue.length}</span>
      </div>

      <div class="fc-stage">
        <div class="fc-card ${flipped ? 'flipped' : ''}" id="card">
          <div class="fc-face fc-front">
            <span class="fc-badge">${(card.status || 'new').toUpperCase()}</span>
            ${frontListen}
            <div class="fc-word">${front}</div>
            <div class="fc-hint">Tap to reveal</div>
          </div>
          <div class="fc-face fc-back">
            <span class="fc-badge">${card.category || ''}</span>
            <button class="fc-listen" id="listen-back" aria-label="Listen">🔊</button>
            <div class="fc-en">${back}</div>
            ${card.dict_kr && card.dict_kr !== card.kr ? `<div class="fc-def">dictionary form: <b>${card.dict_kr}</b></div>` : ''}
            ${card.def ? `<div class="fc-def">${card.def}</div>` : ''}
            ${card.context ? `<div class="fc-context">from: ${card.context}</div>` : ''}
          </div>
        </div>
      </div>

      ${buttonsHtml}
      <div class="fc-keyhint">Space = flip · 1 = ${MODES[mode].buttons === 'srs' ? 'Again' : "Don't Know"} · 2 = ${MODES[mode].buttons === 'srs' ? 'Hard' : 'Unsure'} · 3 = ${MODES[mode].buttons === 'srs' ? 'Good' : 'Know'}</div>
    `;
  }

  function wireCard(card) {
    const cardEl = document.getElementById('card');
    if (cardEl) {
      cardEl.addEventListener('click', e => {
        if (e.target.closest('.fc-listen')) return;
        flipped = !flipped;
        cardEl.classList.toggle('flipped');
      });
    }
    document.getElementById('listen')?.addEventListener('click', e => { e.stopPropagation(); Common.speakKorean(card.kr); });
    document.getElementById('listen-back')?.addEventListener('click', e => { e.stopPropagation(); Common.speakKorean(card.kr); });

    document.querySelectorAll('.srs-btn').forEach(b => {
      b.addEventListener('click', () => rate(b.dataset.q));
    });

    document.getElementById('dir-toggle')?.addEventListener('click', () => {
      direction = direction === 'kr2en' ? 'en2kr' : 'kr2en';
      localStorage.setItem(DIR_KEY, direction);
      flipped = false;
      render();
    });

    document.getElementById('shuffle-btn')?.addEventListener('click', () => {
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      idx = 0;
      flipped = false;
      render();
      Common.toast('Shuffled', 'info', 800);
    });
  }

  function rate(quality) {
    const card = queue[idx];
    if (!card) return;
    Common.updateSRS(card.kr, quality);
    flipped = false;

    if (mode === 'unknown' && quality === 'good') {
      // User just promoted a weak word to known — drop it from this run's queue
      queue.splice(idx, 1);
      if (idx >= queue.length) idx = 0;
    } else if (mode === 'known' && quality === 'again') {
      // User forgot a "known" word — it's no longer known, drop from this run
      queue.splice(idx, 1);
      if (idx >= queue.length) idx = 0;
    } else {
      idx++;
      if (idx >= queue.length) {
        // Loop back; rebuild in case statuses changed bucket membership
        queue = buildQueue();
        idx = 0;
      }
    }
    render();
  }

  function hardPreview(card) {
    if (card.status === 'new' || card.interval === 0) return '1d';
    if (card.interval === 1) return '3d';
    return Math.max(1, Math.round(card.interval * 0.6)) + 'd';
  }
  function goodPreview(card) {
    if (card.interval === 0) return '1d';
    if (card.interval === 1) return '3d';
    return Math.round(card.interval * card.ease) + 'd';
  }

  function renderWordList() {
    const marks = Common.getMarks();
    const all = Object.values(marks).sort((a, b) =>
      (b.added || '').localeCompare(a.added || '')
    );
    if (all.length === 0) return '';
    const rows = all.map(m => {
      const krEsc = encodeURIComponent(m.kr);
      const cls = isKnown(m) ? 'known' : 'weak';
      const label = isKnown(m) ? 'known' : (m.status || 'new');
      return `
      <div class="word-row" data-kr="${krEsc}">
        <span class="wr-kr">${m.kr}${m.dict_kr && m.dict_kr !== m.kr ? ` <small style="color:var(--text-soft)">(${m.dict_kr})</small>` : ''}</span>
        <span class="wr-en-cell">
          <input class="wr-en-edit" data-kr="${krEsc}" placeholder="뜻을 입력하세요…" value="${(m.en || '').replace(/"/g, '&quot;')}" />
        </span>
        <span class="wr-status ${cls}">${label}</span>
        <button class="wr-del" data-kr="${krEsc}" title="Remove">✕</button>
      </div>`;
    }).join('');
    return `
      <details class="word-list" ${all.length <= 5 ? 'open' : ''}>
        <summary>All saved words (${all.length})</summary>
        <div class="word-list-body">${rows}</div>
        <div class="portability-row">
          <button class="btn btn-ghost btn-small" id="export-data">💾 Export my flashcards</button>
          <label class="btn btn-ghost btn-small" for="import-file" style="cursor:pointer;">📁 Import from file</label>
          <input id="import-file" type="file" accept="application/json" hidden />
        </div>
      </details>`;
  }

  function wireWordList() {
    document.querySelectorAll('.wr-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const kr = decodeURIComponent(btn.dataset.kr);
        Common.removeMark(kr);
        Common.toast('Removed: ' + kr, 'info');
        queue = buildQueue();
        idx = Math.min(idx, Math.max(0, queue.length - 1));
        render();
      });
    });

    // Inline edit of English meaning — saves on blur or Enter
    document.querySelectorAll('.wr-en-edit').forEach(input => {
      const save = () => {
        const kr = decodeURIComponent(input.dataset.kr);
        const newEn = input.value.trim();
        const marks = Common.getMarks();
        const m = marks[kr];
        if (!m) return;
        if (m.en === newEn) return;
        Common.editMark(kr, { en: newEn });
        Common.toast('Saved: ' + kr + (newEn ? ' → ' + newEn : ' (cleared)'), 'success', 1200);
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });
    });

    document.getElementById('export-data')?.addEventListener('click', () => {
      const bundle = Common.exportStudentData();
      if (bundle) Common.toast(`Exported ${Object.keys(bundle.marks).length} words`, 'success');
    });

    document.getElementById('import-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const bundle = JSON.parse(ev.target.result);
          const res = Common.importStudentData(bundle);
          if (res.error) Common.toast('Import failed: ' + res.error, 'info');
          else {
            Common.toast(`Imported: +${res.added} new, ${res.updated} updated`, 'success', 2500);
            queue = buildQueue();
            idx = 0;
            render();
          }
        } catch {
          Common.toast('Invalid JSON file', 'info');
        }
      };
      reader.readAsText(file);
    });
  }

  // Keyboard shortcuts: Space = flip, 1/2/3 = grading buttons.
  // Skip when user is typing in an input (e.g. inline meaning edit).
  document.addEventListener('keydown', (e) => {
    if (queue.length === 0) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      const cardEl = document.getElementById('card');
      if (!cardEl) return;
      flipped = !flipped;
      cardEl.classList.toggle('flipped');
    } else if (e.key === '1') { e.preventDefault(); rate('again'); }
    else if (e.key === '2') { e.preventDefault(); rate('hard'); }
    else if (e.key === '3') { e.preventDefault(); rate('good'); }
  });

  // Boot
  queue = buildQueue();
  render();
})();

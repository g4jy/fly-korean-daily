/* === Flashcards — SM-2 SRS over saved words === */

(async function () {
  const app = document.getElementById('app');
  const student = Common.requireStudent();
  if (!student) return;
  Common.renderStudentChip('#top-right');

  // Pull cross-device snapshot before building the queue so we see marks from other devices
  await Common.pullMarksSnapshot();

  let queue = [];
  let idx = 0;
  let flipped = false;

  function buildQueue() {
    const due = Common.getDueCards();
    // Sort: new first, then by nextReview date
    due.sort((a, b) => {
      const aNew = a.status === 'new' ? 0 : 1;
      const bNew = b.status === 'new' ? 0 : 1;
      if (aNew !== bNew) return aNew - bNew;
      return (a.nextReview || '').localeCompare(b.nextReview || '');
    });
    return due;
  }

  function renderEmpty(totalAll) {
    if (totalAll === 0) {
      app.innerHTML = `
        <div class="empty-state">
          <span class="ic">🌱</span>
          <h3>No words saved yet</h3>
          <p>Open today's reading and tap any word you want to remember.</p>
          <a class="btn" href="reading.html">Go to reading</a>
        </div>`;
    } else {
      const stats = Common.getStats();
      app.innerHTML = `
        <div class="flash-summary">
          <div class="stat due"><span class="n">0</span><div class="lbl">Due now</div></div>
          <div class="stat learning"><span class="n">${stats.learning}</span><div class="lbl">Learning</div></div>
          <div class="stat mastered"><span class="n">${stats.mastered}</span><div class="lbl">Mastered</div></div>
        </div>
        <div class="empty-state">
          <span class="ic">🎉</span>
          <h3>All caught up for today</h3>
          <p>Come back tomorrow — scheduled reviews will appear as they become due.</p>
          <a class="btn" href="reading.html">Save more words</a>
        </div>
        ${renderWordList()}
      `;
      wireWordList();
    }
  }

  function renderCard(card) {
    const stats = Common.getStats();
    app.innerHTML = `
      <div class="flash-summary">
        <div class="stat due"><span class="n">${stats.due}</span><div class="lbl">Due now</div></div>
        <div class="stat learning"><span class="n">${stats.learning}</span><div class="lbl">Learning</div></div>
        <div class="stat mastered"><span class="n">${stats.mastered}</span><div class="lbl">Mastered</div></div>
      </div>

      <div class="fc-stage">
        <div class="fc-card ${flipped?'flipped':''}" id="card">
          <div class="fc-face fc-front">
            <span class="fc-badge">${(card.status||'new').toUpperCase()}</span>
            <button class="fc-listen" id="listen" aria-label="Listen">🔊</button>
            <div class="fc-word">${card.kr}</div>
            <div class="fc-hint">Tap to reveal</div>
          </div>
          <div class="fc-face fc-back">
            <span class="fc-badge">${card.category || ''}</span>
            <button class="fc-listen" id="listen-back" aria-label="Listen">🔊</button>
            <div class="fc-en">${card.en || '—'}</div>
            ${card.dict_kr ? `<div class="fc-def">dictionary form: <b>${card.dict_kr}</b></div>` : ''}
            ${card.def ? `<div class="fc-def">${card.def}</div>` : ''}
            ${card.context ? `<div class="fc-context">from: ${card.context}</div>` : ''}
          </div>
        </div>
      </div>

      <div class="srs-buttons">
        <button class="srs-btn srs-again" data-q="again">Again<span class="lbl-sub">0m</span></button>
        <button class="srs-btn srs-hard" data-q="hard">Hard<span class="lbl-sub">${hardPreview(card)}</span></button>
        <button class="srs-btn srs-good" data-q="good">Good<span class="lbl-sub">${goodPreview(card)}</span></button>
      </div>

      ${renderWordList()}
    `;

    document.getElementById('card').addEventListener('click', e => {
      if (e.target.closest('.fc-listen')) return;
      flipped = !flipped;
      document.getElementById('card').classList.toggle('flipped');
    });
    document.getElementById('listen').addEventListener('click', e => { e.stopPropagation(); Common.speak(card.kr); });
    document.getElementById('listen-back').addEventListener('click', e => { e.stopPropagation(); Common.speak(card.kr); });

    document.querySelectorAll('.srs-btn').forEach(b => {
      b.addEventListener('click', () => rate(b.dataset.q));
    });
    wireWordList();
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

  function rate(quality) {
    const card = queue[idx];
    if (!card) return;
    Common.updateSRS(card.kr, quality);
    flipped = false;
    idx++;
    if (idx >= queue.length) {
      queue = buildQueue();
      idx = 0;
    }
    if (queue.length === 0) {
      renderEmpty(Object.keys(Common.getMarks()).length);
    } else {
      renderCard(queue[idx]);
    }
  }

  function renderWordList() {
    const marks = Common.getMarks();
    const all = Object.values(marks).sort((a, b) =>
      (b.added || '').localeCompare(a.added || '')
    );
    if (all.length === 0) return '';
    const rows = all.map(m => `
      <div class="word-row">
        <span class="wr-kr">${m.kr}</span>
        <span class="wr-en">${m.en || '<i style="color:var(--text-soft)">no translation yet</i>'}</span>
        <button class="wr-del" data-kr="${encodeURIComponent(m.kr)}">remove</button>
      </div>`).join('');
    return `
      <details class="word-list" ${all.length<=5?'open':''}>
        <summary>All saved words (${all.length})</summary>
        <div class="word-list-body">${rows}</div>
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
        if (queue.length === 0) renderEmpty(Object.keys(Common.getMarks()).length);
        else renderCard(queue[idx]);
      });
    });
  }

  // Boot
  queue = buildQueue();
  if (queue.length === 0) {
    renderEmpty(Object.keys(Common.getMarks()).length);
  } else {
    renderCard(queue[idx]);
  }
})();

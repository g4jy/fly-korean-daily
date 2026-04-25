/* === Reading View === */
/* token_map lookup, level tabs, category filter + stars, questions, TTS, speech input */

(async function () {
  const app = document.getElementById('app');
  const student = Common.requireStudent();
  if (!student) return;
  Common.renderStudentChip('#top-right');

  // Punctuation regex (module-level, reused)
  const TRAILING_PUNCT = /[.,!?。、・「」『』"'"'\s:;…~\-]+$/u;
  const LEADING_PUNCT = /^[「」『』"'"'\s(\[]+/u;

  // Fallback heuristic particles (used only when token_map missing)
  const PARTICLES = [
    '이에요','예요','에서는','에서도','에게는','에게도','으로는','으로도','한테서',
    '에서','에게','한테','부터','까지','으로','이랑','하고',
    '을','를','이','가','은','는','의','에','로','과','와','랑','만','도','요','야'
  ];

  function cleanToken(tok) {
    return tok.replace(TRAILING_PUNCT, '').replace(LEADING_PUNCT, '');
  }

  function heuristicStrip(token) {
    let clean = cleanToken(token);
    if (!clean) return '';
    let stripping = true;
    while (stripping && clean.length > 1) {
      stripping = false;
      for (const p of PARTICLES) {
        if (clean.length > p.length && clean.endsWith(p)) {
          clean = clean.slice(0, -p.length);
          stripping = true;
          break;
        }
      }
    }
    return clean;
  }

  function tokenize(text) {
    return text.split(/\n\n+/).map(para =>
      para.split(/(\s+)/).map(t => ({ tok: t, space: /^\s+$/.test(t) }))
    );
  }

  // Look up a surface token in the current level's token_map first.
  // Returns { kr, en, def, pos, gloss, surface } for saving, or falls back to heuristic.
  function resolveTap(rawToken, level) {
    const clean = cleanToken(rawToken);
    const tm = level?.token_map || {};
    // Try exact clean match in token_map
    if (tm[clean]) {
      const m = tm[clean];
      return {
        kr: m.dict || clean,
        surface: clean,
        en: m.en || '',
        def: m.def || '',
        pos: m.pos || '',
        gloss: m.gloss || ''
      };
    }
    // Fallback: heuristic strip → try vocab list of this level, then all levels
    const stripped = heuristicStrip(rawToken);
    const v = (level?.vocab || []).find(x => x.kr === stripped);
    if (v) {
      return { kr: v.kr, surface: clean, en: v.en || '', def: v.def || '', pos: v.pos || '', gloss: '' };
    }
    // Last resort: save the stripped token with no metadata
    return { kr: stripped || clean, surface: clean, en: '', def: '', pos: '', gloss: '' };
  }

  function tokenMatchesAnyMark(tok, marks, level) {
    // For highlighting: a token on the page matches a mark if token_map resolves to it
    // OR heuristic variants do.
    const clean = cleanToken(tok);
    const tm = level?.token_map || {};
    const candidates = new Set();
    if (tm[clean]?.dict) candidates.add(tm[clean].dict);
    candidates.add(clean);
    const stripped = heuristicStrip(tok);
    if (stripped) {
      candidates.add(stripped);
      candidates.add(stripped + '다');
      if (/[어아여]$/.test(stripped)) candidates.add(stripped.slice(0, -1) + '다');
    }
    for (const c of candidates) if (marks[c]) return true;
    return false;
  }

  function findExistingMarkKeyForTap(rawToken, level, marks) {
    const resolved = resolveTap(rawToken, level);
    if (marks[resolved.kr]) return resolved.kr;
    // fallback: any heuristic candidate
    const clean = cleanToken(rawToken);
    const candidates = [resolved.kr, clean, heuristicStrip(rawToken)];
    for (const c of candidates) if (c && marks[c]) return c;
    return null;
  }

  let daily, currentLevel, currentTopicIdx, filterCategory, studentReview;

  function saveLevel(lvl) { localStorage.setItem('fkd_level', lvl); }
  function loadLevel() { return localStorage.getItem('fkd_level') || 'k2'; }

  function filteredTopics() {
    const topics = daily?.topics || [];
    if (!filterCategory || filterCategory === 'all') return topics;
    if (filterCategory === 'starred') {
      const starred = new Set(Common.getStarredCats());
      return topics.filter(t => starred.has(t.category));
    }
    return topics.filter(t => t.category === filterCategory);
  }

  function allCategories() {
    const set = new Set();
    (daily?.topics || []).forEach(t => set.add(t.category));
    return [...set].sort();
  }

  /* --- Rendering --- */
  function render() {
    if (!daily) return;
    const topics = filteredTopics();
    const allCats = allCategories();

    const catTabs = renderCategoryTabs(allCats);

    if (topics.length === 0) {
      app.innerHTML = `
        ${catTabs}
        <div class="empty-state"><span class="ic">📭</span><h3>No topics in this view</h3><p>Try another category or clear the filter.</p></div>
      `;
      wireCategoryTabs();
      return;
    }

    currentTopicIdx = Math.min(currentTopicIdx, topics.length - 1);
    const topic = topics[currentTopicIdx];
    // ALL 5 level tabs always shown for consistency. Missing levels = placeholder content.
    const ALL_LEVELS = ['k1','k2','k3','k4','k5'];
    const availableLevels = ALL_LEVELS.filter(l => topic.levels?.[l]);
    // Track whether the currently-shown level exists for this topic
    const lvlExists = !!topic.levels?.[currentLevel];
    const lvl = lvlExists ? topic.levels[currentLevel] : null;
    const shownLevel = currentLevel;
    const marks = Common.getMarks();

    // ALL 5 tabs always shown. Disabled visual state if topic doesn't have that level.
    const labels = { k1:'Starter', k2:'Elementary', k3:'Intermediate', k4:'Advanced', k5:'Academic' };
    const hints = { k1:'Short, present tense', k2:'Past tense, everyday', k3:'News light', k4:'Full newspaper', k5:'수능 / native' };
    const levelTabs = ALL_LEVELS.map(l => {
      const isActive = l === shownLevel;
      const isAvailable = !!topic.levels?.[l];
      return `<button class="level-tab ${isActive?'active':''} ${isAvailable?'':'unavailable'}" data-level="${l}" title="${hints[l] || ''}${isAvailable?'':' (not available for this topic)'}">
        <span class="lv">Level ${l.slice(1)}</span>${labels[l] || l}
      </button>`;
    }).join('');

    // If currently selected level is not available for this topic, show a placeholder card.
    if (!lvlExists) {
      app.innerHTML = `
        ${catTabs}
        <div class="reading-meta">
          <span class="topic-chip">${topic.category || 'News'}</span>
          <button class="star-cat ${isStarred(topic.category) ? 'starred' : ''}" data-cat="${topic.category}" aria-label="Star category">${isStarred(topic.category) ? '★' : '☆'}</button>
          <span>${daily.date || ''}</span>
          ${topic.source_title ? `<span class="src-title">· ${topic.source_title}</span>` : ''}
        </div>
        <div class="level-tabs">${levelTabs}</div>
        <div class="topic-nav">
          <button id="prev" ${currentTopicIdx===0?'disabled':''} aria-label="Previous">‹</button>
          <span class="topic-counter">${currentTopicIdx+1} / ${topics.length}</span>
          <button id="next" ${currentTopicIdx===topics.length-1?'disabled':''} aria-label="Next">›</button>
        </div>
        <div class="passage-card level-unavailable">
          <div class="empty-state">
            <span class="ic">🚫</span>
            <h3>이 토픽은 Level ${currentLevel.slice(1)}이 없어요</h3>
            <p>이 주제는 너무 추상적이라 Level ${currentLevel.slice(1)}로 만들기에 부자연스러워요. 위 탭에서 다른 레벨을 선택해 주세요.</p>
            <p style="font-size:0.85rem; color:var(--text-soft); margin-top:14px;">사용 가능한 레벨: ${availableLevels.map(l => `Level ${l.slice(1)} ${labels[l]}`).join(' · ')}</p>
          </div>
        </div>
      `;
      wireCategoryTabs();
      wireStarButtons();
      wireLevelTabs();
      wireTopicNav();
      return;
    }


    const paragraphs = tokenize(lvl.text).map(para => {
      const inner = para.map(({ tok, space }) => {
        if (space) return tok;
        const clean = cleanToken(tok);
        if (!clean) return tok;
        const marked = tokenMatchesAnyMark(tok, marks, lvl) ? ' marked' : '';
        const safe = tok.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<span class="w${marked}" data-tok="${encodeURIComponent(tok)}">${safe}</span>`;
      }).join('');
      return `<p>${inner}</p>`;
    }).join('');

    const vocabRows = (lvl.vocab || []).map(v =>
      `<div class="word-row">
        <span class="wr-kr">${v.kr}${v.pos ? ` <small class="pos-tag">${v.pos}</small>` : ''}</span>
        <span class="wr-en">${v.en || ''}</span>
        <button class="wr-del" data-add="${encodeURIComponent(v.kr)}">${marks[v.kr] ? '✓' : '+ save'}</button>
      </div>`
    ).join('');

    const audioUrl = lvl.audio || '';

    const questionsBlock = renderQuestionsBlock(lvl, daily.date, topic.id);

    const reviewBlock = renderReviewBlock();

    app.innerHTML = `
      ${catTabs}

      <div class="reading-meta">
        <span class="topic-chip">${topic.category || 'News'}</span>
        <button class="star-cat ${isStarred(topic.category) ? 'starred' : ''}" data-cat="${topic.category}" aria-label="Star category">${isStarred(topic.category) ? '★' : '☆'}</button>
        <span>${daily.date || ''}</span>
        ${topic.source_title ? `<span class="src-title">· ${topic.source_title}</span>` : ''}
      </div>

      <div class="level-tabs">${levelTabs}</div>

      <div class="topic-nav">
        <button id="prev" ${currentTopicIdx===0?'disabled':''} aria-label="Previous">‹</button>
        <span class="topic-counter">${currentTopicIdx+1} / ${topics.length}</span>
        <button id="next" ${currentTopicIdx===topics.length-1?'disabled':''} aria-label="Next">›</button>
      </div>

      <div class="passage-card">
        <div class="passage-header">
          <h2 class="passage-title">${lvl.title || ''}</h2>
          <button class="btn-listen" id="listen" aria-label="Listen">🔊</button>
        </div>
        <div class="passage-text">${paragraphs}</div>
      </div>

      ${questionsBlock}

      ${lvl.vocab && lvl.vocab.length ? `
        <details class="word-list">
          <summary>Vocabulary in this passage (${lvl.vocab.length})</summary>
          <div class="word-list-body">${vocabRows}</div>
        </details>
      ` : ''}

      ${reviewBlock}

      <div class="reading-actions">
        <a class="btn" href="flashcards.html">Review Saved Words (${Object.keys(marks).length})</a>
      </div>
    `;

    wireCategoryTabs();
    wireStarButtons();
    wireLevelTabs();
    wireTopicNav();
    wireListen(audioUrl, lvl.text);
    wireWordTaps(lvl, topic);
    wireVocabDrawer(lvl, topic);
    wireQuestions(lvl, daily.date, topic.id);
  }

  function renderCategoryTabs(cats) {
    const starred = Common.getStarredCats();
    const showStarred = starred.length > 0;
    return `
      <div class="cat-bar">
        <button class="cat-pill ${!filterCategory || filterCategory === 'all' ? 'active' : ''}" data-cat="all">All</button>
        ${showStarred ? `<button class="cat-pill ${filterCategory === 'starred' ? 'active' : ''}" data-cat="starred">★ Starred (${starred.length})</button>` : ''}
        ${cats.map(c => `<button class="cat-pill ${filterCategory === c ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}
      </div>
    `;
  }

  function renderQuestionsBlock(lvl, date, topicId) {
    if (!lvl.questions || lvl.questions.length === 0) return '';
    const rows = lvl.questions.map((q, i) => {
      const saved = Common.getLocalAnswer(date, topicId, currentLevel, q.id);
      return `
        <div class="q-row" data-qid="${q.id}">
          <div class="q-head">
            <span class="q-num">Q${i + 1}</span>
            <span class="q-type">${q.type}</span>
          </div>
          <div class="q-text">${q.q_kr}</div>
          ${q.answer_hint ? `<div class="q-hint">💡 ${q.answer_hint}</div>` : ''}
          <div class="q-input-wrap">
            <textarea class="q-input" data-qid="${q.id}" placeholder="Type your answer in Korean...">${saved?.answerText || ''}</textarea>
            <div class="q-controls">
              <button class="q-mic" data-qid="${q.id}" aria-label="Record">🎙️ Record</button>
              <button class="q-submit" data-qid="${q.id}">Submit</button>
            </div>
            <div class="q-status" data-qid="${q.id}">${saved ? `<span class="saved-label">saved ${new Date(saved.saved_at).toLocaleTimeString()}</span>` : ''}</div>
            <div class="q-feedback" data-qid="${q.id}"></div>
          </div>
        </div>
      `;
    }).join('');
    return `
      <details class="questions-panel" open>
        <summary>Questions (${lvl.questions.length})</summary>
        <div class="questions-body">${rows}</div>
      </details>
    `;
  }

  function renderReviewBlock() {
    if (!studentReview || !studentReview.items || studentReview.items.length === 0) return '';
    const rows = studentReview.items.map((r, i) => `
      <div class="rv-row">
        <div class="rv-word"><strong>${r.kr}</strong>${r.en ? ` <span class="rv-en">${r.en}</span>` : ''}</div>
        ${r.practice ? `<div class="rv-practice">${r.practice}</div>` : ''}
      </div>
    `).join('');
    return `
      <details class="review-panel">
        <summary>Your personalized review (${studentReview.items.length} words)</summary>
        <div class="review-body">${rows}</div>
      </details>
    `;
  }

  function isStarred(cat) {
    return Common.getStarredCats().includes(cat);
  }

  /* --- Event wiring --- */
  function wireCategoryTabs() {
    app.querySelectorAll('.cat-pill').forEach(btn =>
      btn.addEventListener('click', () => {
        filterCategory = btn.dataset.cat;
        localStorage.setItem('fkd_cat_filter', filterCategory);
        currentTopicIdx = 0;
        render();
      })
    );
  }

  function wireStarButtons() {
    app.querySelectorAll('.star-cat').forEach(btn =>
      btn.addEventListener('click', () => {
        Common.toggleStarredCat(btn.dataset.cat);
        render();
      })
    );
  }

  function wireLevelTabs() {
    app.querySelectorAll('.level-tab').forEach(b =>
      b.addEventListener('click', () => {
        currentLevel = b.dataset.level;
        saveLevel(currentLevel);
        render();
      })
    );
  }

  function wireTopicNav() {
    document.getElementById('prev')?.addEventListener('click', () => {
      if (currentTopicIdx > 0) { currentTopicIdx--; render(); }
    });
    document.getElementById('next')?.addEventListener('click', () => {
      const topics = filteredTopics();
      if (currentTopicIdx < topics.length - 1) { currentTopicIdx++; render(); }
    });
  }

  function wireListen(audioUrl, text) {
    const btn = document.getElementById('listen');
    if (!btn) return;
    let playing = false;
    btn.addEventListener('click', () => {
      if (playing) { Common.stopAudio(); btn.classList.remove('playing'); playing = false; return; }
      btn.classList.add('playing');
      playing = true;
      Common.playOrSpeak(audioUrl, text).finally(() => {
        btn.classList.remove('playing');
        playing = false;
      });
    });
  }

  function wireWordTaps(lvl, topic) {
    app.querySelectorAll('.w').forEach(span => {
      span.addEventListener('click', () => handleWordTap(span, lvl, topic));
    });
  }

  function wireVocabDrawer(lvl, topic) {
    app.querySelectorAll('.wr-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const kr = decodeURIComponent(btn.dataset.add);
        if (Common.hasMark(kr)) {
          Common.removeMark(kr);
          Common.toast(kr + ' removed', 'info');
        } else {
          const v = (lvl.vocab || []).find(x => x.kr === kr);
          Common.addMark({
            kr, en: v?.en, def: v?.def, pos: v?.pos,
            context: lvl.title, category: topic.category, source: 'reading-list'
          });
          Common.toast('Saved: ' + kr, 'success');
        }
        render();
      });
    });
  }

  function wireQuestions(lvl, date, topicId) {
    // Submit buttons
    app.querySelectorAll('.q-submit').forEach(btn => {
      btn.addEventListener('click', () => {
        const qId = btn.dataset.qid;
        const ta = app.querySelector(`.q-input[data-qid="${qId}"]`);
        const answerText = (ta?.value || '').trim();
        if (!answerText) { Common.toast('Please enter an answer', 'info'); return; }
        const q = (lvl.questions || []).find(x => x.id === qId);
        Common.submitAnswer({
          date, topicId, level: currentLevel, qId,
          qKr: q?.q_kr || '',
          answerText,
          mode: ta.dataset.mode || 'typed'
        });
        const status = app.querySelector(`.q-status[data-qid="${qId}"]`);
        if (status) status.innerHTML = `<span class="saved-label">✓ Submitted</span> <span class="wait-note">Feedback arrives by tomorrow morning.</span>`;
        Common.toast('Answer submitted · feedback arrives by tomorrow', 'success', 2200);
      });
    });

    // Mic buttons (speech recognition)
    app.querySelectorAll('.q-mic').forEach(btn => {
      btn.addEventListener('click', () => {
        const qId = btn.dataset.qid;
        const ta = app.querySelector(`.q-input[data-qid="${qId}"]`);
        if (!ta) return;
        if (btn.classList.contains('recording')) {
          btn.classList.remove('recording');
          btn._rec?.stop();
          return;
        }
        const rec = Common.createRecognizer(
          (final, interim) => {
            if (final) ta.value = (ta.value + ' ' + final).trim();
            ta.dataset.mode = 'spoken';
            if (interim) ta.placeholder = interim;
          },
          (err) => {
            Common.toast('Speech error: ' + err, 'info');
            btn.classList.remove('recording');
          }
        );
        if (!rec) { Common.toast('Speech recognition not supported in this browser', 'info'); return; }
        rec.onend = () => {
          btn.classList.remove('recording');
          ta.placeholder = 'Type your answer in Korean...';
        };
        btn._rec = rec;
        btn.classList.add('recording');
        try { rec.start(); } catch (e) { btn.classList.remove('recording'); }
      });
    });

    // Load saved feedback if any
    (async () => {
      const feedback = await Common.fetchFeedback(date);
      Object.entries(feedback).forEach(([qId, fb]) => {
        const host = app.querySelector(`.q-feedback[data-qid="${qId}"]`);
        if (!host || !fb) return;
        const score = fb.score ?? '?';
        const scoreCls = fb.score >= 4 ? 'ok' : fb.score >= 3 ? 'mid' : 'bad';
        host.innerHTML = `
          <div class="fb-card ${scoreCls}">
            <div class="fb-head">피드백 · ${score}/5</div>
            <div class="fb-body">${fb.korean_feedback || ''}</div>
            ${fb.grammar_corrections?.length ? `
              <div class="fb-corrections">
                ${fb.grammar_corrections.map(c => `
                  <div class="fb-corr">
                    <span class="fb-before">${c.before}</span>
                    <span class="fb-arrow">→</span>
                    <span class="fb-after">${c.after}</span>
                    ${c.why ? `<div class="fb-why">${c.why}</div>` : ''}
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
        `;
      });
    })();
  }

  function handleWordTap(span, lvl, topic) {
    const raw = decodeURIComponent(span.dataset.tok);
    const clean = cleanToken(raw);
    if (!clean) return;

    const marks = Common.getMarks();
    const existingKey = findExistingMarkKeyForTap(raw, lvl, marks);
    if (existingKey) {
      Common.removeMark(existingKey);
      syncMarkedStates(lvl);
      Common.toast('Removed: ' + existingKey, 'info', 1200);
      return;
    }

    const resolved = resolveTap(raw, lvl);
    Common.addMark({
      kr: resolved.kr,
      surface: resolved.surface,
      en: resolved.en,
      def: resolved.def,
      pos: resolved.pos,
      gloss: resolved.gloss,
      context: lvl.title || '',
      category: topic.category || '',
      source: 'reading-tap'
    });
    span.classList.add('saved-flash');
    setTimeout(() => span.classList.remove('saved-flash'), 500);
    syncMarkedStates(lvl);
    const surfaceNote = resolved.surface !== resolved.kr ? ` (${resolved.surface})` : '';
    Common.toast('Saved: ' + resolved.kr + surfaceNote + (resolved.en ? ' — ' + resolved.en : ''), 'success', 1500);
  }

  function syncMarkedStates(lvl) {
    const marks = Common.getMarks();
    app.querySelectorAll('.w').forEach(span => {
      const raw = decodeURIComponent(span.dataset.tok);
      span.classList.toggle('marked', tokenMatchesAnyMark(raw, marks, lvl));
    });
  }

  /* --- Boot --- */
  try {
    // Student flow: today-only (always latest). The `?date=` param is honored for Jay's archive view only.
    const params = new URLSearchParams(location.search);
    const date = params.get('date') || 'latest';
    // Pull cross-device marks snapshot BEFORE rendering so saved-state reflects other devices
    await Common.pullMarksSnapshot();
    daily = await Common.loadDaily(date);
    currentLevel = loadLevel();
    currentTopicIdx = 0;
    filterCategory = localStorage.getItem('fkd_cat_filter') || 'all';
    studentReview = await Common.loadStudentReview(daily.date);
    render();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty-state"><span class="ic">⚠️</span><h3>No content loaded yet</h3><p>Today's reading hasn't arrived yet. If this persists, the daily routine may need attention.</p><a class="btn" href="index.html">Back home</a></div>`;
  }
})();

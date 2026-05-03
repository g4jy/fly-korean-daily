/* === Archive view (teacher only) === */
/* Browse all past daily content; export/share any topic or passage. */

(async function () {
  const state = { index: null, currentDate: null, daily: null, selectedLevel: {}, catFilter: '' };

  // Populate category dropdown with the 12 canonical categories.
  const CATEGORIES = [
    'Business', 'Culture', 'Daily Life', 'Education', 'Entertainment',
    'Health', 'Korea', 'Politics', 'Science', 'Sports', 'Technology', 'Travel', 'World'
  ];
  const catSelect = document.getElementById('arch-cat-filter');
  if (catSelect) {
    CATEGORIES.forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      catSelect.appendChild(o);
    });
  }

  async function loadIndex() {
    try {
      const idx = await Common.fetchJSON('data/index.json');
      state.index = idx;
      renderDates();
    } catch (e) {
      document.getElementById('arch-dates').innerHTML =
        `<p style="color:var(--accent-hot);">Could not load data/index.json. Run a morning routine first.</p>`;
    }
  }

  function renderDates(filter = '') {
    const dates = (state.index?.dates || []).slice().reverse();
    const filtered = filter ? dates.filter(d => d.includes(filter)) : dates;
    const host = document.getElementById('arch-dates');
    if (filtered.length === 0) {
      host.innerHTML = `<p style="color:var(--text-light); text-align:center;">No dates match.</p>`;
      return;
    }
    host.innerHTML = filtered.map(d => `
      <button class="arch-day-btn ${state.currentDate === d ? 'active' : ''}" data-date="${d}">
        <span>${d}</span>
        <span class="arch-day-meta">loading…</span>
      </button>
    `).join('');
    host.querySelectorAll('.arch-day-btn').forEach(btn =>
      btn.addEventListener('click', () => selectDate(btn.dataset.date))
    );
    // Lazy-lookup metadata for each day (topics count)
    filtered.forEach(d => {
      fetch(`data/${d}.json`).then(r => r.ok ? r.json() : null).then(dd => {
        if (!dd) return;
        const b = host.querySelector(`[data-date="${d}"] .arch-day-meta`);
        if (b) {
          const cats = [...new Set((dd.topics || []).map(t => t.category))];
          b.textContent = `${dd.topics?.length || 0} topics · ${cats.length} cat`;
        }
      }).catch(() => {});
    });
  }

  async function selectDate(date) {
    state.currentDate = date;
    renderDates(document.getElementById('arch-search').value);
    const main = document.getElementById('arch-main');
    main.innerHTML = `<p style="color:var(--text-light); padding:20px 0;">Loading ${date}…</p>`;
    try {
      const daily = await Common.fetchJSON(`data/${date}.json`);
      state.daily = daily;
      renderDaily();
    } catch (e) {
      main.innerHTML = `<p style="color:var(--accent-hot);">Could not load data/${date}.json</p>`;
    }
  }

  function renderDaily() {
    const d = state.daily;
    if (!d) return;
    const main = document.getElementById('arch-main');
    const allTopics = d.topics || [];
    const topics = state.catFilter
      ? allTopics.filter(t => t.category === state.catFilter)
      : allTopics;
    const cats = [...new Set(allTopics.map(t => t.category))];
    const allText = estimateChars(topics);
    const filterNote = state.catFilter
      ? ` · <em>filter: ${state.catFilter} (${topics.length}/${allTopics.length})</em>`
      : '';

    main.innerHTML = `
      <div class="arch-summary">
        <strong>${d.date}</strong> · ${allTopics.length} topics · ${cats.length} categories
        (${cats.join(', ')}) · ~${allText.toLocaleString()} Korean characters total${filterNote}
      </div>
      <div id="arch-topics"></div>
    `;
    const host = document.getElementById('arch-topics');
    if (topics.length === 0) {
      host.innerHTML = `<p style="color:var(--text-light); padding:20px 0;">No topics in this date for category "${state.catFilter}".</p>`;
      return;
    }
    host.innerHTML = topics.map(renderTopic).join('');
    host.querySelectorAll('.arch-level-btn').forEach(b =>
      b.addEventListener('click', () => {
        const tid = b.dataset.topic;
        state.selectedLevel[tid] = b.dataset.level;
        renderDaily();  // re-render to update active state + text
      })
    );
    host.querySelectorAll('.arch-copy').forEach(b =>
      b.addEventListener('click', () => copyToClipboard(b.dataset.text, b))
    );
    host.querySelectorAll('.arch-share').forEach(b =>
      b.addEventListener('click', () => shareTopic(b.dataset.topic))
    );
    host.querySelectorAll('.arch-export').forEach(b =>
      b.addEventListener('click', () => exportTopic(b.dataset.topic))
    );
  }

  function estimateChars(topics) {
    let total = 0;
    for (const t of topics) {
      for (const lk of Object.keys(t.levels || {})) {
        total += (t.levels[lk].text || '').length;
      }
    }
    return total;
  }

  function renderTopic(t) {
    const curLvl = state.selectedLevel[t.id] || 'k2';
    const lvl = t.levels?.[curLvl] || Object.values(t.levels || {})[0] || {};
    const levelButtons = ['k1','k2','k3','k4'].filter(k => t.levels?.[k]).map(k => `
      <button class="arch-level-btn ${k === curLvl ? 'active' : ''}" data-topic="${t.id}" data-level="${k}">
        L${k.slice(1)} ${levelName(k)}
      </button>
    `).join('');
    const safeText = (lvl.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fullExport = buildFullExport(t);
    return `
      <div class="arch-topic">
        <div class="arch-topic-head">
          <div class="arch-topic-cat">${t.category}</div>
        </div>
        <div class="arch-topic-title">${lvl.title || t.source_title || t.id}</div>
        <div class="arch-topic-src">${t.source_title || ''}${t.source_url ? ` · <a href="${t.source_url}" target="_blank" rel="noopener">source</a>` : ''}</div>
        <div class="arch-level-btns">${levelButtons}</div>
        <div class="arch-passage">${safeText.replace(/\n\n/g, '<br><br>')}</div>
        <div class="arch-actions">
          <button class="arch-btn arch-copy" data-text="${encodeURIComponent(lvl.text || '')}">📋 Copy passage</button>
          <button class="arch-btn arch-copy" data-text="${encodeURIComponent(fullExport)}">📋 Copy all levels</button>
          <button class="arch-btn arch-share" data-topic="${t.id}">🔗 Share link</button>
          <button class="arch-btn arch-export" data-topic="${t.id}">💾 Download .txt</button>
        </div>
      </div>
    `;
  }

  function levelName(k) {
    return { k1:'Starter', k2:'Elementary', k3:'Intermediate', k4:'Advanced' }[k] || k;
  }

  function buildFullExport(topic) {
    const lines = [];
    lines.push(`[${topic.category}] ${topic.source_title || topic.id}`);
    if (topic.source_url) lines.push(`Source: ${topic.source_url}`);
    lines.push('');
    for (const lk of ['k1','k2','k3','k4']) {
      const lv = topic.levels?.[lk];
      if (!lv) continue;
      lines.push(`--- ${levelName(lk)} (L${lk.slice(1)}) ---`);
      lines.push(lv.title || '');
      lines.push(lv.text || '');
      lines.push('');
      if (lv.vocab?.length) {
        lines.push('Vocabulary:');
        for (const v of lv.vocab) lines.push(`  ${v.kr} — ${v.en || ''}`);
        lines.push('');
      }
      if (lv.questions?.length) {
        lines.push('Questions:');
        for (const q of lv.questions) lines.push(`  ${q.id}. ${q.q_kr}`);
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  async function copyToClipboard(encoded, btn) {
    try {
      await navigator.clipboard.writeText(decodeURIComponent(encoded));
      const original = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => btn.textContent = original, 1500);
    } catch {
      Common.toast('Copy failed', 'info');
    }
  }

  function shareTopic(tid) {
    const url = `${location.origin}${location.pathname.replace('archive.html','reading.html')}?date=${state.currentDate}&topic=${tid}`;
    navigator.clipboard.writeText(url).then(() => Common.toast('Link copied to clipboard', 'success')).catch(() => Common.toast(url, 'info', 4000));
  }

  function exportTopic(tid) {
    const t = state.daily.topics.find(x => x.id === tid);
    if (!t) return;
    const txt = buildFullExport(t);
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.currentDate}_${tid}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Wire search + category filter
  document.getElementById('arch-search').addEventListener('input', (e) => renderDates(e.target.value.trim()));
  if (catSelect) {
    catSelect.addEventListener('change', (e) => {
      state.catFilter = e.target.value;
      if (state.daily) renderDaily();
    });
  }

  loadIndex();
})();

'use strict';

(() => {
  const SECTIONS_KEY = 'pse-stocks:sections';
  const LEGACY_WATCHLIST_KEY = 'pse-stocks:watchlist';
  const SETTINGS_KEY = 'pse-stocks:settings';
  const DEFAULT_WATCHLIST = [
    { symbol: 'JFC', name: 'Jollibee Foods Corporation' },
    { symbol: 'SM', name: 'SM Investments Corporation' },
    { symbol: 'ALI', name: 'Ayala Land, Inc.' },
    { symbol: 'BDO', name: 'BDO Unibank, Inc.' },
    { symbol: 'TEL', name: 'PLDT Inc.' },
  ];
  // Must match lib/pse.js: the server flags PSE Edge outages with this code.
  const PSE_EDGE_DOWN = 'PSE_EDGE_DOWN';
  const PSE_EDGE_DOWN_MESSAGE = 'PSE Edge Website is currently down. Please try again later.';
  // Polling slows down outside trading hours, when PSE Edge prices don't move.
  const CLOSED_MARKET_INTERVAL_S = 300;
  // Columns in a stock row: drag handle, symbol, 9 data columns, remove.
  const COLUMN_COUNT = 12;

  const $ = (sel) => document.querySelector(sel);
  const els = {
    table: $('#watchlist'),
    tableWrap: $('.table-wrap'),
    dropIndicator: $('#drop-indicator'),
    search: $('#search-input'),
    results: $('#search-results'),
    browse: $('#browse'),
    addTarget: $('#add-target'),
    addTargetWrap: $('#add-target-wrap'),
    addSection: $('#add-section'),
    interval: $('#interval'),
    refresh: $('#refresh'),
    updated: $('#updated'),
    error: $('#error'),
    market: $('#market-status'),
    nextEvent: $('#next-event'),
    clock: $('#clock'),
    schedule: $('#schedule-phases'),
    demo: $('#demo-banner'),
  };

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: keep working in memory */
    }
  }

  const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** Loads the sections, upgrading the single flat list older versions saved. */
  function loadSections() {
    const saved = load(SECTIONS_KEY, null);
    if (Array.isArray(saved) && saved.length) return saved;
    return [{ id: newId(), name: 'My Watchlist', collapsed: false, items: load(LEGACY_WATCHLIST_KEY, DEFAULT_WATCHLIST) }];
  }

  const state = {
    sections: loadSections(),
    settings: { interval: 30, sort: null, asc: false, addTarget: null, ...load(SETTINGS_KEY, {}) },
    quotes: new Map(),
    history: new Map(),
    companies: null,
    companiesState: 'loading',
    browseKey: null,
    editingSection: null,
    drag: null,
    renderPending: false,
    timer: null,
    loading: false,
  };

  const saveSections = () => save(SECTIONS_KEY, state.sections);
  const saveSettings = () => save(SETTINGS_KEY, state.settings);

  const allItems = () => state.sections.flatMap((s) => s.items);
  const findSection = (id) => state.sections.find((s) => s.id === id);
  const sectionOf = (symbol) => state.sections.find((s) => s.items.some((i) => i.symbol === symbol));

  // ---------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------

  // Sub-peso stocks trade in fractions of a centavo, so show more decimals.
  function fmtPrice(n, ref = n) {
    if (n == null) return '–';
    const digits = Math.abs(ref) < 1 ? 4 : 2;
    return n.toLocaleString('en-PH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtSigned(n, suffix = '', fmt = fmtPrice) {
    if (n == null) return '–';
    const sign = n > 0 ? '+' : n < 0 ? '−' : '';
    return `${sign}${fmt(Math.abs(n))}${suffix}`;
  }

  function fmtVolume(n) {
    if (n == null) return '–';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  const dirClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ---------------------------------------------------------------------
  // Market schedule (Asia/Manila). Exchange holidays are not accounted for.
  // ---------------------------------------------------------------------

  const hm = (h, m) => h * 60 + m;
  const PHASES = [
    { key: 'preopen', label: 'Pre-open', start: hm(9, 0), end: hm(9, 30) },
    { key: 'trading', label: 'Trading', start: hm(9, 30), end: hm(12, 0) },
    { key: 'recess', label: 'Lunch recess', start: hm(12, 0), end: hm(13, 0) },
    { key: 'trading', label: 'Trading', start: hm(13, 0), end: hm(14, 45) },
    { key: 'preclose', label: 'Pre-close', start: hm(14, 45), end: hm(14, 50) },
    { key: 'runoff', label: 'Run-off', start: hm(14, 50), end: hm(15, 0) },
  ];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const meridiem = (minutes) => (minutes < 12 * 60 ? 'AM' : 'PM');

  /** 570 -> "9:30 AM"; pass false to leave off the AM/PM. */
  function fmtClock(minutes, withMeridiem = true) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const time = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`;
    return withMeridiem ? `${time} ${meridiem(minutes)}` : time;
  }

  /** "1:00–2:45 PM", or "9:30 AM–12:00 PM" when the range crosses noon. */
  function fmtRange(start, end) {
    const same = meridiem(start) === meridiem(end);
    return `${fmtClock(start, !same)}–${fmtClock(end)}`;
  }

  function fmtDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  function manilaNow() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return { day: WEEKDAYS.indexOf(get('weekday')), minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
  }

  /** Returns the current market phase (or null when closed) and what comes next. */
  function marketState() {
    const { day, minutes } = manilaNow();
    const weekday = day >= 1 && day <= 5;
    const index = weekday ? PHASES.findIndex((p) => minutes >= p.start && minutes < p.end) : -1;
    if (index !== -1) {
      const phase = PHASES[index];
      const next = PHASES[index + 1];
      const left = fmtDuration(phase.end - minutes);
      return { phase, index, next: next ? `${next.label} in ${left}` : `Closes in ${left}` };
    }
    if (weekday && minutes < PHASES[0].start) {
      return { phase: null, index: -1, next: `Pre-open in ${fmtDuration(PHASES[0].start - minutes)}` };
    }
    // After the close or on a weekend: the next session is the next weekday.
    const nextDay = day === 5 || day === 6 ? 1 : (day + 1) % 7;
    const when = nextDay === (day + 1) % 7 ? 'tomorrow' : WEEKDAYS[nextDay];
    return { phase: null, index: -1, next: `Opens ${when} ${fmtClock(PHASES[0].start)}` };
  }

  /** Prices move from pre-open through run-off, except over the lunch recess. */
  function isMarketActive() {
    const { phase } = marketState();
    return Boolean(phase && phase.key !== 'recess');
  }

  function renderSchedule() {
    els.schedule.innerHTML = PHASES.map((p, i) => `
      <li class="phase phase-${p.key}" data-index="${i}">
        <span class="phase-label">${p.label}</span>
        <span class="phase-time">${fmtRange(p.start, p.end)}</span>
      </li>`).join('');
  }

  function renderClock() {
    const { phase, index, next } = marketState();
    els.market.textContent = phase ? phase.label : 'Closed';
    els.market.className = `pill ${phase ? `phase-${phase.key}` : 'closed'}`;
    els.nextEvent.textContent = next;
    els.clock.textContent = new Date().toLocaleTimeString('en-PH', {
      timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit',
    }) + ' Manila';
    for (const li of els.schedule.children) {
      li.classList.toggle('current', Number(li.dataset.index) === index);
    }
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------

  async function api(path) {
    const res = await fetch(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A gateway error with no JSON (e.g. a hosting timeout while waiting on
      // PSE Edge) also means PSE Edge didn't answer in time.
      const down = data.code === PSE_EDGE_DOWN || (!data.error && [502, 503, 504].includes(res.status));
      const err = new Error(down ? PSE_EDGE_DOWN_MESSAGE : data.error || `Request failed (${res.status})`);
      err.code = down ? PSE_EDGE_DOWN : data.code;
      throw err;
    }
    return data;
  }

  function showError(message) {
    els.error.textContent = message || '';
    els.error.hidden = !message;
  }

  async function refresh() {
    if (state.loading) return;
    const items = allItems();
    if (!items.length) {
      render();
      return;
    }
    state.loading = true;
    els.refresh.disabled = true;
    try {
      const symbols = items.map((w) => w.symbol).join(',');
      const data = await api(`/api/quotes?symbols=${encodeURIComponent(symbols)}`);
      let edgeDown = false;
      for (let q of data.quotes) {
        const prev = state.quotes.get(q.symbol);
        if (q.code === PSE_EDGE_DOWN) {
          edgeDown = true;
          // Keep showing the last good price rather than blanking the row.
          if (prev && !prev.error) q = { ...prev, stale: true };
        }
        q.flash = prev && prev.last != null && q.last != null && q.last !== prev.last
          ? (q.last > prev.last ? 'flash-up' : 'flash-down')
          : '';
        state.quotes.set(q.symbol, q);
        // Fill in names for symbols saved before the name was known.
        const item = allItems().find((w) => w.symbol === q.symbol);
        if (item && !item.name && q.name) {
          item.name = q.name;
          saveSections();
        }
      }
      showError(edgeDown ? PSE_EDGE_DOWN_MESSAGE : '');
      // Only move the "Updated" time when at least one price really came in.
      if (data.quotes.some((q) => !q.error)) {
        const fetched = new Date(data.fetchedAt);
        const date = fetched.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        const time = fetched.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', second: '2-digit' });
        els.updated.textContent = `Updated ${date} · ${time}`;
      }
    } catch (err) {
      if (err.code === PSE_EDGE_DOWN) {
        showError(PSE_EDGE_DOWN_MESSAGE);
        for (const [symbol, q] of state.quotes) if (!q.error) state.quotes.set(symbol, { ...q, stale: true });
      } else {
        showError(`Couldn't update prices: ${err.message}`);
      }
    } finally {
      state.loading = false;
      els.refresh.disabled = false;
      render();
      loadMissingHistory();
    }
  }

  function loadMissingHistory() {
    for (const { symbol } of allItems()) {
      if (state.history.has(symbol)) continue;
      state.history.set(symbol, null);
      api(`/api/history?symbol=${encodeURIComponent(symbol)}&days=30`)
        .then((rows) => {
          state.history.set(symbol, rows.map((r) => r.close));
          const cell = els.table.querySelector(`tr[data-symbol="${CSS.escape(symbol)}"] .spark-cell`);
          if (cell) cell.innerHTML = sparkline(state.history.get(symbol));
        })
        .catch(() => state.history.set(symbol, []));
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    const chosen = Number(state.settings.interval);
    if (!chosen) return;
    const seconds = isMarketActive() ? chosen : Math.max(chosen, CLOSED_MARKET_INTERVAL_S);
    state.timer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, seconds * 1000);
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  const GRIP_ICON = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></g></svg>';
  const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  const TRASH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  const CARET_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function sparkline(values) {
    if (!values || values.length < 2) return '';
    const w = 96;
    const h = 28;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`);
    const color = values[values.length - 1] >= values[0] ? 'var(--up)' : 'var(--down)';
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="M${pts.join('L')}" stroke="${color}"/></svg>`;
  }

  /** Applies the column sort, if any, within one section. */
  function sortedItems(items) {
    const { sort, asc } = state.settings;
    if (!sort) return items;
    const dir = asc ? 1 : -1;
    return [...items].sort((a, b) => {
      if (sort === 'symbol') return a.symbol.localeCompare(b.symbol) * dir;
      const av = state.quotes.get(a.symbol)?.[sort];
      const bv = state.quotes.get(b.symbol)?.[sort];
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }

  function pseLink(q) {
    return q?.cmpyId ? `https://edge.pse.com.ph/companyPage/stockData.do?cmpy_id=${encodeURIComponent(q.cmpyId)}` : null;
  }

  function rowHtml(item) {
    const sym = escapeHtml(item.symbol);
    const q = state.quotes.get(item.symbol);
    const name = item.name || q?.name || '';
    const link = pseLink(q);
    const symHtml = `<span class="sym">${sym}</span><span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
    const handle = `<td class="handle-cell"><button class="drag-handle" type="button" data-drag="item" data-symbol="${sym}" title="Drag to move ${sym}" aria-label="Move ${sym}. Drag, or use the up and down arrow keys.">${GRIP_ICON}</button></td>`;
    const symCell = `<td class="sym-cell">${link ? `<a href="${link}" target="_blank" rel="noopener" title="Open on PSE Edge">${symHtml}</a>` : symHtml}</td>`;
    const remove = `<td><button class="remove" type="button" data-remove="${sym}" title="Remove ${sym}" aria-label="Remove ${sym}">×</button></td>`;

    if (!q) {
      return `<tr data-symbol="${sym}">${handle}${symCell}<td class="num muted" colspan="9">Loading…</td>${remove}</tr>`;
    }
    if (q.error) {
      const text = q.code === PSE_EDGE_DOWN ? 'Price unavailable' : q.error;
      return `<tr class="row-error" data-symbol="${sym}">${handle}${symCell}<td class="err" colspan="9">${escapeHtml(text)}</td>${remove}</tr>`;
    }
    const cls = dirClass(q.change);
    const stale = q.stale ? ' class="stale" title="Last known price. PSE Edge is not responding right now."' : '';
    return `<tr data-symbol="${sym}"${stale}>
      ${handle}
      ${symCell}
      <td class="num last ${q.flash || ''}" title="${q.asOf ? `As of ${escapeHtml(q.asOf)}` : ''}">${fmtPrice(q.last)}</td>
      <td class="num hide-sm ${cls}">${fmtSigned(q.change, '', (n) => fmtPrice(n, q.last ?? n))}</td>
      <td class="num ${cls}"><span class="chg-badge">${fmtSigned(q.changePercent, '%', (n) => n.toFixed(2))}</span></td>
      <td class="num hide-sm">${fmtPrice(q.open)}</td>
      <td class="num hide-sm">${fmtPrice(q.high)}</td>
      <td class="num hide-sm">${fmtPrice(q.low)}</td>
      <td class="num hide-md" title="${escapeHtml(q.prevCloseDate || '')}">${fmtPrice(q.prevClose)}</td>
      <td class="num hide-sm">${fmtVolume(q.volume)}</td>
      <td class="hide-md spark-cell">${sparkline(state.history.get(item.symbol))}</td>
      ${remove}
    </tr>`;
  }

  function sectionHtml(section) {
    const id = escapeHtml(section.id);
    const name = escapeHtml(section.name);
    const editing = state.editingSection === section.id;
    const canDelete = state.sections.length > 1;
    const title = editing
      ? `<input class="section-input" data-section-input="${id}" value="${name}" maxlength="40" aria-label="Section name">`
      : `<span class="section-name" data-rename="${id}" title="Double-click to rename">${name}</span>`;
    const head = `<tr class="section-head">
      <td class="handle-cell"><button class="drag-handle" type="button" data-drag="section" data-section-id="${id}" title="Drag to move this section" aria-label="Move section ${name}. Drag, or use the up and down arrow keys.">${GRIP_ICON}</button></td>
      <td colspan="${COLUMN_COUNT - 1}">
        <div class="section-bar">
          <button class="icon-btn collapse-btn" type="button" data-toggle="${id}" aria-expanded="${!section.collapsed}" title="${section.collapsed ? 'Expand' : 'Collapse'}">${CARET_ICON}</button>
          ${title}
          <span class="count">${section.items.length}</span>
          <span class="spacer"></span>
          <button class="icon-btn" type="button" data-rename="${id}" title="Rename section" aria-label="Rename section ${name}">${PENCIL_ICON}</button>
          ${canDelete ? `<button class="icon-btn danger" type="button" data-delete-section="${id}" title="Delete section" aria-label="Delete section ${name}">${TRASH_ICON}</button>` : ''}
        </div>
      </td>
    </tr>`;
    let body = '';
    if (!section.collapsed) {
      body = section.items.length
        ? sortedItems(section.items).map(rowHtml).join('')
        : `<tr class="section-empty"><td></td><td colspan="${COLUMN_COUNT - 1}" class="muted">No stocks yet. Search or pick from the list above, or drag a stock here.</td></tr>`;
    }
    return `<tbody class="section${section.collapsed ? ' collapsed' : ''}" data-section-id="${id}">${head}${body}</tbody>`;
  }

  function renderSortHeaders() {
    for (const th of els.table.querySelectorAll('th[data-sort]')) {
      const active = th.dataset.sort === state.settings.sort;
      th.classList.toggle('sorted', active);
      th.classList.toggle('asc', active && state.settings.asc);
    }
  }

  function renderAddTarget() {
    if (!findSection(state.settings.addTarget)) state.settings.addTarget = state.sections[0].id;
    els.addTarget.innerHTML = state.sections
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join('');
    els.addTarget.value = state.settings.addTarget;
    els.addTargetWrap.hidden = state.sections.length < 2;
  }

  function render() {
    // Re-rendering mid-drag would detach the element holding the pointer.
    if (state.drag) {
      state.renderPending = true;
      return;
    }
    const focused = document.activeElement?.closest?.('.drag-handle');
    const focusKey = focused && (focused.dataset.symbol ? `[data-symbol="${CSS.escape(focused.dataset.symbol)}"]` : `[data-section-id="${CSS.escape(focused.dataset.sectionId)}"]`);
    // Keep a half-typed section name when a price refresh re-renders.
    const oldInput = els.table.querySelector('.section-input');
    const typed = oldInput && { value: oldInput.value, start: oldInput.selectionStart, end: oldInput.selectionEnd, focused: document.activeElement === oldInput };
    if (oldInput) state.renderingRename = true;

    els.table.querySelectorAll('tbody').forEach((b) => b.remove());
    state.renderingRename = false;
    els.table.insertAdjacentHTML('beforeend', state.sections.map(sectionHtml).join(''));
    renderSortHeaders();
    renderAddTarget();
    renderBrowse();
    for (const q of state.quotes.values()) q.flash = '';

    if (focusKey) els.table.querySelector(`.drag-handle${focusKey}`)?.focus();
    const input = els.table.querySelector('.section-input');
    if (input && typed && input.dataset.sectionInput === oldInput.dataset.sectionInput) {
      input.value = typed.value;
      if (typed.focused) {
        input.focus();
        input.setSelectionRange(typed.start, typed.end);
      }
    } else if (input) {
      input.focus();
      input.select();
    }
  }

  // ---------------------------------------------------------------------
  // Watchlist and section editing
  // ---------------------------------------------------------------------

  function addToWatchlist(company) {
    if (sectionOf(company.symbol)) return;
    const section = findSection(state.settings.addTarget) || state.sections[0];
    section.items.push({ symbol: company.symbol, name: company.name });
    section.collapsed = false;
    saveSections();
    render();
    refresh();
  }

  function removeFromWatchlist(symbol) {
    for (const s of state.sections) s.items = s.items.filter((w) => w.symbol !== symbol);
    state.quotes.delete(symbol);
    saveSections();
    render();
  }

  function addSection() {
    const section = { id: newId(), name: 'New section', collapsed: false, items: [] };
    state.sections.push(section);
    state.settings.addTarget = section.id;
    state.editingSection = section.id;
    saveSections();
    saveSettings();
    render();
  }

  function finishRename(input, commit) {
    const section = findSection(input.dataset.sectionInput);
    if (!section || state.editingSection !== section.id) return;
    const name = input.value.trim();
    if (commit && name) section.name = name;
    state.editingSection = null;
    saveSections();
    render();
  }

  function deleteSection(id) {
    const section = findSection(id);
    if (!section || state.sections.length < 2) return;
    const n = section.items.length;
    if (n && !confirm(`Delete "${section.name}" and remove its ${n} stock${n === 1 ? '' : 's'} from your watchlist?`)) return;
    state.sections = state.sections.filter((s) => s !== section);
    saveSections();
    render();
  }

  /** Makes the on-screen (sorted) order the saved order, then turns sorting off. */
  function commitSortOrder() {
    if (!state.settings.sort) return;
    for (const s of state.sections) s.items = sortedItems(s.items);
    state.settings.sort = null;
    saveSections();
    saveSettings();
    renderSortHeaders();
  }

  els.table.addEventListener('click', (e) => {
    const t = e.target;
    const remove = t.closest('[data-remove]');
    if (remove) return removeFromWatchlist(remove.dataset.remove);
    const toggle = t.closest('[data-toggle]');
    if (toggle) {
      const section = findSection(toggle.dataset.toggle);
      section.collapsed = !section.collapsed;
      saveSections();
      return render();
    }
    const rename = t.closest('button[data-rename]');
    if (rename) {
      state.editingSection = rename.dataset.rename;
      return render();
    }
    const del = t.closest('[data-delete-section]');
    if (del) return deleteSection(del.dataset.deleteSection);
    const th = t.closest('th[data-sort]');
    if (th) return sortBy(th.dataset.sort);
  });

  els.table.addEventListener('dblclick', (e) => {
    const name = e.target.closest('.section-name[data-rename]');
    if (name) {
      state.editingSection = name.dataset.rename;
      render();
    }
  });

  els.table.addEventListener('keydown', (e) => {
    const input = e.target.closest('.section-input');
    if (input) {
      if (e.key === 'Enter') finishRename(input, true);
      if (e.key === 'Escape') finishRename(input, false);
      return;
    }
    const handle = e.target.closest('.drag-handle');
    if (handle && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveByKeyboard(handle, e.key === 'ArrowUp' ? -1 : 1);
    }
  });

  els.table.addEventListener('focusout', (e) => {
    const input = e.target.closest('.section-input');
    if (input && !state.renderingRename) finishRename(input, true);
  });

  function sortBy(key) {
    if (state.settings.sort !== key) {
      state.settings.sort = key;
      state.settings.asc = key === 'symbol';
    } else if (state.settings.asc === (key === 'symbol')) {
      state.settings.asc = !state.settings.asc;
    } else {
      state.settings.sort = null; // third click returns to your own order
    }
    saveSettings();
    render();
  }

  els.addSection.addEventListener('click', addSection);
  els.addTarget.addEventListener('change', () => {
    state.settings.addTarget = els.addTarget.value;
    saveSettings();
  });

  // ---------------------------------------------------------------------
  // Drag to reorder (pointer events, so it works with a mouse and on touch)
  // ---------------------------------------------------------------------

  function moveItem(symbol, toSectionId, index) {
    const from = sectionOf(symbol);
    const to = findSection(toSectionId);
    if (!from || !to) return;
    const item = from.items.find((i) => i.symbol === symbol);
    from.items = from.items.filter((i) => i !== item);
    to.items.splice(Math.min(index, to.items.length), 0, item);
  }

  function moveSection(id, index) {
    const section = findSection(id);
    const rest = state.sections.filter((s) => s !== section);
    rest.splice(Math.min(index, rest.length), 0, section);
    state.sections = rest;
  }

  function moveByKeyboard(handle, delta) {
    commitSortOrder();
    if (handle.dataset.drag === 'section') {
      const i = state.sections.findIndex((s) => s.id === handle.dataset.sectionId);
      if (i + delta < 0 || i + delta >= state.sections.length) return;
      moveSection(handle.dataset.sectionId, i + delta);
    } else {
      const symbol = handle.dataset.symbol;
      const section = sectionOf(symbol);
      const si = state.sections.indexOf(section);
      const i = section.items.findIndex((it) => it.symbol === symbol);
      if (i + delta >= 0 && i + delta < section.items.length) {
        moveItem(symbol, section.id, i + delta);
      } else {
        // At the edge of a section: hop into the neighbouring one.
        const neighbour = state.sections[si + delta];
        if (!neighbour) return;
        neighbour.collapsed = false;
        moveItem(symbol, neighbour.id, delta < 0 ? neighbour.items.length : 0);
      }
    }
    saveSections();
    render();
  }

  const rectOf = (el) => el.getBoundingClientRect();

  /** Works out where a dragged stock would land for pointer position y. */
  function itemDropTarget(y) {
    const bodies = [...els.table.querySelectorAll('tbody.section')];
    const body = bodies.find((b) => y < rectOf(b).bottom) || bodies[bodies.length - 1];
    const section = findSection(body.dataset.sectionId);
    if (section.collapsed) {
      return { sectionId: section.id, index: Infinity, lineY: rectOf(body).bottom };
    }
    const rows = [...body.querySelectorAll('tr[data-symbol]')].filter((r) => r.dataset.symbol !== state.drag.symbol);
    let index = rows.findIndex((r) => y < rectOf(r).top + rectOf(r).height / 2);
    if (index === -1) index = rows.length;
    let lineY;
    if (!rows.length) lineY = rectOf(body.querySelector('.section-head')).bottom;
    else if (index < rows.length) lineY = rectOf(rows[index]).top;
    else lineY = rectOf(rows[rows.length - 1]).bottom;
    return { sectionId: section.id, index, lineY };
  }

  /** Works out where a dragged section would land for pointer position y. */
  function sectionDropTarget(y) {
    const bodies = [...els.table.querySelectorAll('tbody.section')].filter((b) => b.dataset.sectionId !== state.drag.sectionId);
    if (!bodies.length) return null;
    let index = bodies.findIndex((b) => y < rectOf(b).top + rectOf(b).height / 2);
    if (index === -1) index = bodies.length;
    const lineY = index < bodies.length ? rectOf(bodies[index]).top : rectOf(bodies[bodies.length - 1]).bottom;
    return { index, lineY };
  }

  function updateDrag() {
    const drag = state.drag;
    if (!drag) return;
    drag.target = drag.type === 'item' ? itemDropTarget(drag.y) : sectionDropTarget(drag.y);
    if (!drag.target) {
      els.dropIndicator.hidden = true;
      return;
    }
    const wrap = rectOf(els.tableWrap);
    els.dropIndicator.style.top = `${drag.target.lineY - wrap.top + els.tableWrap.scrollTop - 1}px`;
    els.dropIndicator.hidden = false;
  }

  // Scrolls the page while a drag is held near the top or bottom edge.
  function autoScroll() {
    const drag = state.drag;
    if (!drag) return;
    const edge = 70;
    const speed = drag.y < edge ? -(edge - drag.y) / 4 : drag.y > innerHeight - edge ? (drag.y - (innerHeight - edge)) / 4 : 0;
    if (speed) {
      scrollBy(0, speed);
      updateDrag();
    }
    drag.frame = requestAnimationFrame(autoScroll);
  }

  els.table.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    handle.focus();
    commitSortOrder();
    handle.setPointerCapture(e.pointerId);
    const type = handle.dataset.drag;
    const source = type === 'item' ? handle.closest('tr') : handle.closest('tbody');
    source.classList.add('is-dragging');
    document.body.classList.add('dragging');
    state.drag = { type, handle, source, symbol: handle.dataset.symbol, sectionId: handle.dataset.sectionId, y: e.clientY, pointerId: e.pointerId, target: null };
    updateDrag();
    state.drag.frame = requestAnimationFrame(autoScroll);
  });

  els.table.addEventListener('pointermove', (e) => {
    if (!state.drag || e.pointerId !== state.drag.pointerId) return;
    state.drag.y = e.clientY;
    updateDrag();
  });

  function endDrag(e, apply) {
    const drag = state.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    cancelAnimationFrame(drag.frame);
    drag.source.classList.remove('is-dragging');
    document.body.classList.remove('dragging');
    els.dropIndicator.hidden = true;
    state.drag = null;
    if (apply && drag.target) {
      if (drag.type === 'item') moveItem(drag.symbol, drag.target.sectionId, drag.target.index);
      else moveSection(drag.sectionId, drag.target.index);
      saveSections();
    }
    if (apply || state.renderPending) {
      state.renderPending = false;
      render();
    }
  }

  els.table.addEventListener('pointerup', (e) => endDrag(e, true));
  els.table.addEventListener('pointercancel', (e) => endDrag(e, false));

  // ---------------------------------------------------------------------
  // Browse every listed stock (A–Z dropdown)
  // ---------------------------------------------------------------------

  async function loadCompanies() {
    state.companiesState = 'loading';
    state.browseKey = null;
    renderBrowse();
    try {
      state.companies = await api('/api/companies');
      state.companiesState = 'ready';
    } catch (err) {
      state.companiesState = 'error';
      // Short, since the dropdown is narrow; the full outage message shows above the table.
      state.companiesError = err.code === PSE_EDGE_DOWN ? 'Stock list unavailable.' : "Couldn't load the stock list.";
    }
    state.browseKey = null;
    renderBrowse();
  }

  function renderBrowse() {
    if (state.companiesState !== 'ready') {
      const message = state.companiesState === 'loading'
        ? 'Loading all PSE stocks…'
        : `${state.companiesError} Click to retry.`;
      els.browse.innerHTML = `<option value="">${escapeHtml(message)}</option>`;
      els.browse.disabled = state.companiesState === 'loading';
      els.browse.classList.toggle('is-error', state.companiesState === 'error');
      return;
    }
    els.browse.classList.remove('is-error');
    // Rebuild only when the watchlist's stocks change, so a price refresh
    // never closes the dropdown while someone is scrolling it.
    const added = new Set(allItems().map((i) => i.symbol));
    const key = [...added].sort().join(',');
    if (key === state.browseKey) return;
    state.browseKey = key;

    const groups = new Map();
    for (const c of state.companies) {
      const letter = /^[A-Z]/.test(c.symbol) ? c.symbol[0] : '#';
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(c);
    }
    const optgroups = [...groups].map(([letter, list]) => `<optgroup label="${letter}">${list.map((c) => {
      const isAdded = added.has(c.symbol);
      return `<option value="${escapeHtml(c.symbol)}"${isAdded ? ' disabled' : ''}>${escapeHtml(c.symbol)} — ${escapeHtml(c.name)}${isAdded ? ' ✓' : ''}</option>`;
    }).join('')}</optgroup>`).join('');
    els.browse.innerHTML = `<option value="">Or pick from all ${state.companies.length} PSE stocks (A–Z)</option>${optgroups}`;
    els.browse.disabled = false;
    els.browse.value = '';
  }

  els.browse.addEventListener('change', () => {
    const company = state.companies?.find((c) => c.symbol === els.browse.value);
    els.browse.value = '';
    if (company) addToWatchlist(company);
  });

  els.browse.addEventListener('pointerdown', () => {
    if (state.companiesState === 'error') loadCompanies();
  });

  // ---------------------------------------------------------------------
  // Search with autocomplete
  // ---------------------------------------------------------------------

  let searchSeq = 0;
  let searchTimer = null;
  let results = [];
  let active = -1;

  function renderResults(message, isError = false) {
    if (message) {
      els.results.innerHTML = `<li class="disabled${isError ? ' error-item' : ''}">${escapeHtml(message)}</li>`;
      els.results.hidden = false;
      return;
    }
    if (!results.length) {
      els.results.hidden = true;
      return;
    }
    els.results.innerHTML = results.map((r, i) => {
      const inSection = sectionOf(r.symbol);
      const tag = inSection ? `<span class="tag">In ${escapeHtml(inSection.name)}</span>` : '';
      return `<li role="option" data-index="${i}" aria-selected="${i === active}" class="${inSection ? 'disabled' : ''}">
        <span class="sym">${escapeHtml(r.symbol)}</span><span class="name">${escapeHtml(r.name)}</span>${tag}
      </li>`;
    }).join('');
    els.results.hidden = false;
  }

  function closeResults() {
    results = [];
    active = -1;
    els.results.hidden = true;
  }

  function choose(index) {
    const r = results[index];
    if (!r || sectionOf(r.symbol)) return;
    addToWatchlist(r);
    els.search.value = '';
    closeResults();
  }

  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = els.search.value.trim();
    if (!q) {
      closeResults();
      return;
    }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      renderResults('Searching…');
      try {
        const found = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (seq !== searchSeq) return;
        results = found;
        active = results.length ? 0 : -1;
        renderResults(results.length ? null : 'No matching stocks');
      } catch (err) {
        if (seq !== searchSeq) return;
        renderResults(err.code === PSE_EDGE_DOWN ? PSE_EDGE_DOWN_MESSAGE : `Search failed: ${err.message}`, true);
      }
    }, 250);
  });

  els.search.addEventListener('keydown', (e) => {
    if (els.results.hidden || !results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      closeResults();
    }
  });

  els.results.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-index]');
    if (li) {
      e.preventDefault();
      choose(Number(li.dataset.index));
    }
  });

  els.search.addEventListener('blur', () => setTimeout(closeResults, 100));

  // ---------------------------------------------------------------------
  // Controls and startup
  // ---------------------------------------------------------------------

  els.interval.value = String(state.settings.interval);
  els.interval.addEventListener('change', () => {
    state.settings.interval = Number(els.interval.value);
    saveSettings();
    schedule();
  });

  els.refresh.addEventListener('click', refresh);

  // Light/dark theme. With no saved choice the page follows the system
  // setting; the inline script in index.html applies a saved choice early.
  const THEME_KEY = 'pse-stocks:theme';
  const themeToggle = $('#theme-toggle');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function currentTheme() {
    return document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light');
  }

  function renderThemeToggle() {
    const dark = currentTheme() === 'dark';
    themeToggle.classList.toggle('is-dark', dark);
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    themeToggle.title = label;
    themeToggle.setAttribute('aria-label', label);
  }

  themeToggle.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable: the choice lasts for this visit only */
    }
    renderThemeToggle();
  });

  systemDark.addEventListener('change', renderThemeToggle);
  renderThemeToggle();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refresh();
      schedule();
    }
  });

  api('/api/config').then((cfg) => { els.demo.hidden = !cfg.demo; }).catch(() => {});

  // ---------------------------------------------------------------------
  // Announcement pop-up about the domain move: shown on every visit until
  // the move time set in index.html (11:59 PM, October 7), but not on the
  // new domain itself. Closes after 10 seconds or when closed; the countdown
  // pauses while the pointer or focus is on it, so there's time to read or
  // click the link.
  // ---------------------------------------------------------------------

  const ANNOUNCEMENT_MS = 10000;
  const announcement = $('#announcement');
  let announcementLeft = ANNOUNCEMENT_MS;
  let announcementStarted = 0;
  let announcementTimer = null;

  function closeAnnouncement() {
    if (announcement.hidden || announcement.classList.contains('closing')) return;
    clearTimeout(announcementTimer);
    document.removeEventListener('keydown', closeOnEscape);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      announcement.hidden = true;
      return;
    }
    announcement.classList.add('closing');
    announcement.addEventListener('animationend', () => { announcement.hidden = true; }, { once: true });
  }

  function runAnnouncementTimer() {
    if (announcement.hidden || announcement.classList.contains('closing')) return;
    clearTimeout(announcementTimer);
    announcementStarted = Date.now();
    announcementTimer = setTimeout(closeAnnouncement, announcementLeft);
    announcement.classList.remove('paused');
  }

  function pauseAnnouncementTimer() {
    if (announcement.classList.contains('paused')) return;
    clearTimeout(announcementTimer);
    announcementLeft = Math.max(0, announcementLeft - (Date.now() - announcementStarted));
    announcement.classList.add('paused');
  }

  function closeOnEscape(e) {
    if (e.key === 'Escape') closeAnnouncement();
  }

  const move = window.SITE_MOVE;
  const showAnnouncement = !move || (Date.now() < move.at && location.hostname !== new URL(move.newOrigin).hostname);

  announcement.style.setProperty('--announcement-duration', `${ANNOUNCEMENT_MS}ms`);
  announcement.hidden = !showAnnouncement;
  if (showAnnouncement) runAnnouncementTimer();
  $('#announcement-close').addEventListener('click', closeAnnouncement);
  document.addEventListener('keydown', closeOnEscape);
  announcement.addEventListener('pointerenter', pauseAnnouncementTimer);
  announcement.addEventListener('pointerleave', () => {
    if (!announcement.contains(document.activeElement)) runAnnouncementTimer();
  });
  announcement.addEventListener('focusin', pauseAnnouncementTimer);
  announcement.addEventListener('focusout', (e) => {
    if (!announcement.contains(e.relatedTarget) && !announcement.matches(':hover')) runAnnouncementTimer();
  });

  saveSections();
  loadCompanies();
  renderSchedule();
  renderClock();
  setInterval(renderClock, 15000);
  render();
  refresh();
  schedule();
})();

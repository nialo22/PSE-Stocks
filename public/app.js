'use strict';

(() => {
  const STORAGE_KEY = 'pse-stocks:watchlist';
  const SETTINGS_KEY = 'pse-stocks:settings';
  const DEFAULT_WATCHLIST = [
    { symbol: 'JFC', name: 'Jollibee Foods Corporation' },
    { symbol: 'SM', name: 'SM Investments Corporation' },
    { symbol: 'ALI', name: 'Ayala Land, Inc.' },
    { symbol: 'BDO', name: 'BDO Unibank, Inc.' },
    { symbol: 'TEL', name: 'PLDT Inc.' },
  ];
  // Polling slows down outside trading hours, when PSE Edge prices don't move.
  const CLOSED_MARKET_INTERVAL_S = 300;

  const $ = (sel) => document.querySelector(sel);
  const els = {
    tbody: $('#watchlist tbody'),
    table: $('#watchlist'),
    empty: $('#empty'),
    search: $('#search-input'),
    results: $('#search-results'),
    interval: $('#interval'),
    refresh: $('#refresh'),
    updated: $('#updated'),
    error: $('#error'),
    market: $('#market-status'),
    clock: $('#clock'),
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

  const state = {
    watchlist: load(STORAGE_KEY, DEFAULT_WATCHLIST),
    settings: { interval: 30, sort: null, asc: false, ...load(SETTINGS_KEY, {}) },
    quotes: new Map(),
    history: new Map(),
    timer: null,
    loading: false,
  };

  const saveWatchlist = () => save(STORAGE_KEY, state.watchlist);
  const saveSettings = () => save(SETTINGS_KEY, state.settings);

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

  // ---------------------------------------------------------------------
  // Market hours (Asia/Manila). Approximate: ignores exchange holidays.
  // ---------------------------------------------------------------------

  function manilaNow() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return { weekday: get('weekday'), minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
  }

  function isMarketOpen() {
    const { weekday, minutes } = manilaNow();
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    return minutes >= 9 * 60 + 30 && minutes < 15 * 60 + 10;
  }

  function renderClock() {
    const open = isMarketOpen();
    els.market.textContent = open ? 'Market open' : 'Market closed';
    els.market.classList.toggle('open', open);
    els.market.title = 'Approximate: PSE trades weekdays about 9:30 AM to 3:00 PM Manila time; holidays are not accounted for.';
    els.clock.textContent = new Date().toLocaleTimeString('en-PH', {
      timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit',
    }) + ' Manila';
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------

  async function api(path) {
    const res = await fetch(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function refresh() {
    if (state.loading) return;
    if (!state.watchlist.length) {
      render();
      return;
    }
    state.loading = true;
    els.refresh.disabled = true;
    try {
      const symbols = state.watchlist.map((w) => w.symbol).join(',');
      const data = await api(`/api/quotes?symbols=${encodeURIComponent(symbols)}`);
      for (const q of data.quotes) {
        const prev = state.quotes.get(q.symbol);
        q.flash = prev && prev.last != null && q.last != null && q.last !== prev.last
          ? (q.last > prev.last ? 'flash-up' : 'flash-down')
          : '';
        state.quotes.set(q.symbol, q);
        // Fill in names for symbols saved before the name was known.
        const item = state.watchlist.find((w) => w.symbol === q.symbol);
        if (item && !item.name && q.name) {
          item.name = q.name;
          saveWatchlist();
        }
      }
      els.error.hidden = true;
      els.updated.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    } catch (err) {
      els.error.textContent = `Could not reach PSE Edge: ${err.message}`;
      els.error.hidden = false;
    } finally {
      state.loading = false;
      els.refresh.disabled = false;
      render();
      loadMissingHistory();
    }
  }

  function loadMissingHistory() {
    for (const { symbol } of state.watchlist) {
      if (state.history.has(symbol)) continue;
      state.history.set(symbol, null);
      api(`/api/history?symbol=${encodeURIComponent(symbol)}&days=30`)
        .then((rows) => {
          state.history.set(symbol, rows.map((r) => r.close));
          const cell = els.tbody.querySelector(`tr[data-symbol="${CSS.escape(symbol)}"] .spark-cell`);
          if (cell) cell.innerHTML = sparkline(state.history.get(symbol));
        })
        .catch(() => state.history.set(symbol, []));
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    const chosen = Number(state.settings.interval);
    if (!chosen) return;
    const seconds = isMarketOpen() ? chosen : Math.max(chosen, CLOSED_MARKET_INTERVAL_S);
    state.timer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, seconds * 1000);
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

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

  function sortedWatchlist() {
    const { sort, asc } = state.settings;
    if (!sort) return state.watchlist;
    const dir = asc ? 1 : -1;
    return [...state.watchlist].sort((a, b) => {
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
    const q = state.quotes.get(item.symbol);
    const name = item.name || q?.name || '';
    const link = pseLink(q);
    const symHtml = `<span class="sym">${escapeHtml(item.symbol)}</span><span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
    const symCell = `<td class="sym-cell">${link ? `<a href="${link}" target="_blank" rel="noopener" title="Open on PSE Edge">${symHtml}</a>` : symHtml}</td>`;
    const remove = `<td><button class="remove" data-remove="${escapeHtml(item.symbol)}" title="Remove ${escapeHtml(item.symbol)}" aria-label="Remove ${escapeHtml(item.symbol)}">×</button></td>`;

    if (!q) {
      return `<tr data-symbol="${escapeHtml(item.symbol)}">${symCell}<td class="num muted" colspan="9">Loading…</td>${remove}</tr>`;
    }
    if (q.error) {
      return `<tr class="row-error" data-symbol="${escapeHtml(item.symbol)}">${symCell}<td class="err" colspan="9">${escapeHtml(q.error)}</td>${remove}</tr>`;
    }
    const cls = dirClass(q.change);
    return `<tr data-symbol="${escapeHtml(item.symbol)}">
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

  function render() {
    els.empty.hidden = state.watchlist.length > 0;
    els.table.querySelector('thead').hidden = state.watchlist.length === 0;
    els.tbody.innerHTML = sortedWatchlist().map(rowHtml).join('');
    for (const th of els.table.querySelectorAll('th[data-sort]')) {
      const active = th.dataset.sort === state.settings.sort;
      th.classList.toggle('sorted', active);
      th.classList.toggle('asc', active && state.settings.asc);
    }
    for (const q of state.quotes.values()) q.flash = '';
  }

  // ---------------------------------------------------------------------
  // Watchlist editing
  // ---------------------------------------------------------------------

  function addToWatchlist(company) {
    if (state.watchlist.some((w) => w.symbol === company.symbol)) return;
    state.watchlist.push({ symbol: company.symbol, name: company.name });
    saveWatchlist();
    render();
    refresh();
  }

  function removeFromWatchlist(symbol) {
    state.watchlist = state.watchlist.filter((w) => w.symbol !== symbol);
    state.quotes.delete(symbol);
    saveWatchlist();
    render();
  }

  els.tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) removeFromWatchlist(btn.dataset.remove);
  });

  els.table.querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
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
  });

  // ---------------------------------------------------------------------
  // Search with autocomplete
  // ---------------------------------------------------------------------

  let searchSeq = 0;
  let searchTimer = null;
  let results = [];
  let active = -1;

  function renderResults(message) {
    if (message) {
      els.results.innerHTML = `<li class="disabled">${escapeHtml(message)}</li>`;
      els.results.hidden = false;
      return;
    }
    if (!results.length) {
      els.results.hidden = true;
      return;
    }
    els.results.innerHTML = results.map((r, i) => {
      const added = state.watchlist.some((w) => w.symbol === r.symbol);
      return `<li role="option" data-index="${i}" aria-selected="${i === active}" class="${added ? 'disabled' : ''}">
        <span class="sym">${escapeHtml(r.symbol)}</span><span class="name">${escapeHtml(r.name)}</span>${added ? '<span class="tag">Added</span>' : ''}
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
    if (!r || state.watchlist.some((w) => w.symbol === r.symbol)) return;
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
        if (seq === searchSeq) renderResults(`Search failed: ${err.message}`);
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

  renderClock();
  setInterval(renderClock, 30000);
  render();
  refresh();
  schedule();
})();

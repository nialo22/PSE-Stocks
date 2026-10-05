'use strict';

// Client for PSE Edge (https://edge.pse.com.ph), the Philippine Stock Exchange's
// official disclosure and market data portal. PSE Edge has no public API, so
// this module uses the same endpoints its own pages call and parses the HTML.

const BASE_URL = 'https://edge.pse.com.ph';

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${BASE_URL}/`,
};

const REQUEST_TIMEOUT_MS = 15000;

async function request(path, { method = 'GET', body, headers = {}, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      method,
      body,
      headers: { ...DEFAULT_HEADERS, ...headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`PSE Edge responded ${res.status} for ${path}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCharCode(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9%]/g, '');
}

/**
 * Collects every `<th>label</th><td>value</td>` pair in the page. PSE Edge lays
 * out its stock data as a two-column table of these pairs. Returns a map from
 * normalized label to { text, html } of the value cell.
 */
function extractLabelValuePairs(html) {
  const pairs = new Map();
  const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td([^>]*)>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = normalizeLabel(stripTags(m[1]));
    if (label && !pairs.has(label)) {
      pairs.set(label, { text: stripTags(m[3]), html: `<td${m[2]}>${m[3]}</td>` });
    }
  }
  return pairs;
}

function parseNumber(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function findPair(pairs, ...labels) {
  for (const label of labels) {
    const hit = pairs.get(normalizeLabel(label));
    if (hit) return hit;
  }
  return null;
}

/** Determines the sign of a change cell from text, CSS class or arrow image. */
function changeDirection(cell) {
  const text = cell.text.trim();
  if (/^-/.test(text) || /\bdown\b/i.test(text)) return -1;
  if (/^\+/.test(text) || /\bup\b/i.test(text)) return 1;
  const html = cell.html.toLowerCase();
  if (/(class|src|alt)\s*=\s*["'][^"']*(down|_dn|minus|red)/.test(html)) return -1;
  if (/(class|src|alt)\s*=\s*["'][^"']*(up|plus|green)/.test(html)) return 1;
  return 0;
}

/** Parses the `<select id="security_id">` options: one per listed security. */
function parseSecurities(html) {
  const select = html.match(/<select[^>]*(?:name|id)\s*=\s*["']security_id["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!select) return [];
  const securities = [];
  const re = /<option([^>]*)value\s*=\s*["']?([^"'\s>]+)["']?([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(select[1])) !== null) {
    securities.push({
      securityId: m[2],
      symbol: stripTags(m[4]).toUpperCase(),
      selected: /\bselected\b/i.test(m[1] + m[3]),
    });
  }
  return securities;
}

function parseAsOf(html) {
  const text = stripTags(html);
  const m = text.match(/As of\s+([A-Za-z]{3,9}\.? \d{1,2},? \d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)?)/i);
  return m ? m[1].trim() : null;
}

/**
 * Parses the stock data page (`/companyPage/stockData.do`) into a quote.
 */
function parseStockData(html) {
  const pairs = extractLabelValuePairs(html);
  const value = (...labels) => findPair(pairs, ...labels)?.text ?? null;
  const number = (...labels) => parseNumber(value(...labels));

  const last = number('Last Traded Price', 'Last Price', 'Last');
  const prevCloseCell = value('Previous Close and Date', 'Previous Close', 'Prev. Close');
  const prevClose = parseNumber(prevCloseCell);
  const prevCloseDate = prevCloseCell?.match(/\(([^)]+)\)/)?.[1]?.trim() ?? null;

  let change = null;
  let changePercent = null;
  const changeCell = findPair(pairs, 'Change(% Change)', 'Change (% Change)', 'Change');
  if (changeCell) {
    const nums = changeCell.text.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
    const dir = changeDirection(changeCell);
    if (nums.length) change = Number(nums[0]) * (dir || 1);
    if (nums.length > 1) changePercent = Number(nums[1]) * (dir || 1);
  }
  // The price and previous close are the most reliable inputs; derive the
  // change from them so its sign never depends on how the page styles arrows.
  if (last != null && prevClose != null && prevClose !== 0) {
    change = round(last - prevClose, 4);
    changePercent = round(((last - prevClose) / prevClose) * 100, 2);
  }

  const securities = parseSecurities(html);
  const selected = securities.find((s) => s.selected) || securities[0] || null;

  return {
    symbol: selected?.symbol ?? null,
    securityId: selected?.securityId ?? null,
    securities,
    status: value('Status'),
    last,
    open: number('Open'),
    high: number('High'),
    low: number('Low'),
    prevClose,
    prevCloseDate,
    change,
    changePercent,
    volume: number('Volume'),
    value: number('Value'),
    weekHigh52: number('52-Week High', '52 Week High'),
    weekLow52: number('52-Week Low', '52 Week Low'),
    peRatio: number('P/E Ratio', 'PE Ratio'),
    marketCap: number('Market Capitalization', 'Market Cap'),
    asOf: parseAsOf(html),
  };
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Company search
// ---------------------------------------------------------------------------

/** Normalizes one autocomplete row; PSE Edge has used a few key spellings. */
function normalizeCompany(row) {
  if (!row || typeof row !== 'object') return null;
  const cmpyId = row.cmpyId ?? row.cmpy_id ?? row.companyId ?? row.id;
  const symbol = row.symbol ?? row.securitySymbol ?? row.stockSymbol;
  const name = row.cmpyNm ?? row.cmpy_nm ?? row.companyName ?? row.name ?? row.label ?? '';
  if (cmpyId == null || !symbol) return null;
  return { cmpyId: String(cmpyId), symbol: String(symbol).trim().toUpperCase(), name: String(name).trim() };
}

function parseSearchResults(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('PSE Edge search returned an unexpected response');
  }
  const rows = Array.isArray(data) ? data : data?.records ?? data?.data ?? [];
  return rows.map(normalizeCompany).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------

function formatChartDate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}-${dd}-${date.getFullYear()}`;
}

function parseHistory(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('PSE Edge chart data returned an unexpected response');
  }
  const rows = data?.chartData ?? [];
  return rows
    .map((r) => ({
      date: r.CHART_DATE ?? r.chartDate ?? null,
      open: parseNumber(r.OPEN),
      high: parseNumber(r.HIGH),
      low: parseNumber(r.LOW),
      close: parseNumber(r.CLOSE),
      value: parseNumber(r.VALUE),
    }))
    .filter((r) => r.close != null);
}

// ---------------------------------------------------------------------------
// Company directory (every listed company, about 50 per page)
// ---------------------------------------------------------------------------

/**
 * Parses one page of `/companyDirectory/search.ax`: a `table.list` whose rows
 * hold name, symbol, sector, subsector and listing date, with the company and
 * security ids in a `cmDetail('<cmpyId>','<securityId>')` onclick handler.
 */
function parseDirectoryPage(html) {
  const table = html.match(/<table[^>]*class\s*=\s*["'][^"']*\blist\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  const body = table ? (table[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? table[1]) : '';
  const companies = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(body)) !== null) {
    const ids = row[1].match(/cmDetail\(\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/);
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (!ids || cells.length < 2 || !cells[1]) continue;
    companies.push({
      cmpyId: ids[1],
      securityId: ids[2],
      name: cells[0],
      symbol: cells[1].toUpperCase(),
      sector: cells[2] || null,
      subsector: cells[3] || null,
      listingDate: cells[4] || null,
    });
  }

  const text = stripTags(html);
  const count = text.match(/\[\s*(\d+)\s*\/\s*(\d+)\s*\]\s*\[\s*Total\s+(\d+)\s*\]/i);
  let totalPages = count ? Number(count[2]) : 1;
  if (!count) {
    for (const m of html.matchAll(/goPage\((\d+)\)/g)) totalPages = Math.max(totalPages, Number(m[1]));
  }
  return { companies, totalPages, total: count ? Number(count[3]) : null };
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

function createClient({ fetchImpl = fetch } = {}) {
  const opts = { fetchImpl };

  async function searchCompanies(term) {
    const q = encodeURIComponent(term.trim());
    const text = await request(`/autoComplete/searchCompanyNameSymbol.ax?term=${q}`, {
      ...opts,
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    return parseSearchResults(text);
  }

  async function fetchStockData(cmpyId, securityId) {
    if (securityId == null) {
      return parseStockData(await request(`/companyPage/stockData.do?cmpy_id=${encodeURIComponent(cmpyId)}`, opts));
    }
    const body = new URLSearchParams({ cmpy_id: cmpyId, security_id: securityId }).toString();
    return parseStockData(
      await request('/companyPage/stockData.do', {
        ...opts,
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
  }

  /**
   * Fetches the quote for a specific symbol of a company. A company can list
   * several securities (e.g. common and preferred shares); the page shows the
   * first one by default, so a second request is made for any other.
   */
  async function fetchQuote(cmpyId, symbol) {
    let quote = await fetchStockData(cmpyId);
    const wanted = symbol.toUpperCase();
    if (quote.symbol && quote.symbol !== wanted) {
      const match = quote.securities.find((s) => s.symbol === wanted);
      if (match) quote = await fetchStockData(cmpyId, match.securityId);
    }
    return { ...quote, symbol: wanted, cmpyId: String(cmpyId) };
  }

  async function fetchHistory(cmpyId, securityId, days = 30) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const text = await request('/common/DisclosureCht.ax', {
      ...opts,
      method: 'POST',
      body: JSON.stringify({
        cmpy_id: String(cmpyId),
        security_id: String(securityId),
        startDate: formatChartDate(start),
        endDate: formatChartDate(end),
      }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    return parseHistory(text);
  }

  async function fetchDirectoryPage(pageNo) {
    return parseDirectoryPage(
      await request(`/companyDirectory/search.ax?pageNo=${pageNo}`, {
        ...opts,
        headers: { Referer: `${BASE_URL}/companyDirectory/form.do`, 'X-Requested-With': 'XMLHttpRequest' },
      }),
    );
  }

  /** Every listed company, sorted by symbol. */
  async function listCompanies() {
    const MAX_PAGES = 40;
    const first = await fetchDirectoryPage(1);
    const pages = [first];
    const remaining = [];
    for (let p = 2; p <= Math.min(first.totalPages, MAX_PAGES); p++) remaining.push(p);
    // A few pages at a time, to stay polite to PSE Edge.
    while (remaining.length) {
      pages.push(...(await Promise.all(remaining.splice(0, 3).map(fetchDirectoryPage))));
    }
    const bySymbol = new Map();
    for (const page of pages) for (const c of page.companies) if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, c);
    if (!bySymbol.size) throw new Error('PSE Edge company directory returned no companies');
    return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  return { searchCompanies, fetchQuote, fetchHistory, listCompanies };
}

module.exports = {
  BASE_URL,
  createClient,
  parseStockData,
  parseSearchResults,
  parseHistory,
  parseDirectoryPage,
  parseSecurities,
  extractLabelValuePairs,
  stripTags,
};

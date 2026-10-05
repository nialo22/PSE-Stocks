'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseStockData, parseSearchResults, parseHistory, parseDirectoryPage, createClient } = require('../lib/pse');
const { createService, TtlCache } = require('../lib/service');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'stockData.html'), 'utf8');
const directoryFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'companyDirectory.html'), 'utf8');

test('parseStockData extracts the quote fields', () => {
  const q = parseStockData(fixture);
  assert.equal(q.symbol, 'JFC');
  assert.equal(q.securityId, '158');
  assert.equal(q.status, 'OPEN');
  assert.equal(q.last, 230);
  assert.equal(q.open, 228);
  assert.equal(q.high, 232.4);
  assert.equal(q.low, 227.6);
  assert.equal(q.prevClose, 231.2);
  assert.equal(q.prevCloseDate, 'Oct 02, 2026');
  assert.equal(q.change, -1.2);
  assert.equal(q.changePercent, -0.52);
  assert.equal(q.volume, 1234560);
  assert.equal(q.value, 283948800);
  assert.equal(q.weekHigh52, 290);
  assert.equal(q.weekLow52, 205);
  assert.equal(q.peRatio, 24.31);
  assert.equal(q.marketCap, 259330416946.4);
  assert.equal(q.asOf, 'Oct 03, 2026 03:00 PM');
  assert.deepEqual(q.securities.map((s) => s.symbol), ['JFC', 'JFCPB']);
});

test('parseStockData reads the change sign from the page when prices are missing', () => {
  const html = '<table><tr><th>Change(% Change)</th><td class="down">1.20 (0.52%)</td></tr></table>';
  const q = parseStockData(html);
  assert.equal(q.change, -1.2);
  assert.equal(q.changePercent, -0.52);

  const up = parseStockData('<table><tr><th>Change(% Change)</th><td>up 0.50 (1.00%)</td></tr></table>');
  assert.equal(up.change, 0.5);
  assert.equal(up.changePercent, 1);
});

test('parseStockData returns nulls for a page without data', () => {
  const q = parseStockData('<html><body>No data</body></html>');
  assert.equal(q.last, null);
  assert.equal(q.change, null);
  assert.equal(q.symbol, null);
});

test('parseSearchResults normalizes autocomplete rows', () => {
  const rows = parseSearchResults(JSON.stringify([
    { cmpyId: 86, cmpyNm: 'Jollibee Foods Corporation', symbol: 'jfc ' },
    { cmpyId: 86, cmpyNm: 'Jollibee Foods Corporation', symbol: 'JFCPB' },
    { bogus: true },
  ]));
  assert.deepEqual(rows, [
    { cmpyId: '86', symbol: 'JFC', name: 'Jollibee Foods Corporation' },
    { cmpyId: '86', symbol: 'JFCPB', name: 'Jollibee Foods Corporation' },
  ]);
  assert.throws(() => parseSearchResults('<html>'), /unexpected response/);
});

test('parseHistory reads chart rows', () => {
  const rows = parseHistory(JSON.stringify({
    chartData: [
      { CHART_DATE: 'Oct 01, 2026 00:00:00', OPEN: 229, HIGH: 233, LOW: 228, CLOSE: 231.2, VALUE: 1000 },
      { CHART_DATE: 'Oct 02, 2026 00:00:00', OPEN: 231, HIGH: 232, LOW: 229, CLOSE: '230.00', VALUE: 900 },
    ],
  }));
  assert.deepEqual(rows.map((r) => r.close), [231.2, 230]);
});

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    for (const [pattern, body] of routes) {
      if (url.includes(pattern) && (typeof body !== 'function' || body(init) !== undefined)) {
        const text = typeof body === 'function' ? body(init) : body;
        return { ok: true, status: 200, text: async () => text };
      }
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

test('fetchQuote requests the matching security for non-default symbols', async () => {
  const preferred = fixture
    .replace('<option value="158" selected="selected">JFC</option>', '<option value="158">JFC</option>')
    .replace('<option value="602">JFCPB</option>', '<option value="602" selected>JFCPB</option>')
    .replace('<td>230.00</td>', '<td>1,010.00</td>');
  const calls = [];
  const client = createClient({
    fetchImpl: fakeFetch([
      ['/companyPage/stockData.do', (init) => (init.method === 'POST' ? preferred : fixture)],
    ], calls),
  });
  const q = await client.fetchQuote('86', 'JFCPB');
  assert.equal(q.symbol, 'JFCPB');
  assert.equal(q.securityId, '602');
  assert.equal(q.last, 1010);
  assert.equal(calls.length, 2);
  assert.match(calls[1].init.body, /security_id=602/);
});

test('service resolves symbols via search and caches quotes', async () => {
  let quoteCalls = 0;
  const client = {
    searchCompanies: async () => [{ cmpyId: '86', symbol: 'JFC', name: 'Jollibee Foods Corporation' }],
    fetchQuote: async (cmpyId, symbol) => {
      quoteCalls++;
      return { symbol, cmpyId, last: 230 };
    },
    fetchHistory: async () => [],
  };
  const service = createService(client);
  const [jfc, missing] = await service.quotes(['jfc', 'NOPE']);
  assert.equal(jfc.last, 230);
  assert.equal(jfc.name, 'Jollibee Foods Corporation');
  assert.match(missing.error, /Unknown PSE symbol/);
  await service.quotes(['JFC']);
  assert.equal(quoteCalls, 1);
});

test('TtlCache drops failed loads so they are retried', async () => {
  const cache = new TtlCache(60000);
  await assert.rejects(cache.get('k', async () => { throw new Error('boom'); }));
  assert.equal(await cache.get('k', async () => 'ok'), 'ok');
});

test('parseDirectoryPage reads companies and paging', () => {
  const page = parseDirectoryPage(directoryFixture);
  assert.equal(page.totalPages, 6);
  assert.equal(page.total, 282);
  assert.deepEqual(page.companies[0], {
    cmpyId: '86',
    securityId: '158',
    name: 'Jollibee Foods Corporation',
    symbol: 'JFC',
    sector: 'Industrial',
    subsector: 'Food, Beverage & Tobacco',
    listingDate: 'Jul 14, 1993',
  });
  assert.equal(page.companies[1].symbol, 'AC');
  assert.equal(page.companies[1].cmpyId, '57');
});

test('parseDirectoryPage falls back to goPage links for the page count', () => {
  const html = directoryFixture.replace(/<span class="count">.*?<\/span>/, '');
  assert.equal(parseDirectoryPage(html).totalPages, 6);
  assert.equal(parseDirectoryPage('<p>nothing</p>').companies.length, 0);
});

test('listCompanies fetches every page and sorts by symbol', async () => {
  const pageHtml = (n) => directoryFixture
    .replace(/\[1 \/ 6\] \[Total 282\]/, `[${n} / 3] [Total 6]`)
    .replace(/>JFC</g, `>JFC${n}<`)
    .replace(/>AC</g, n === 1 ? '>AC<' : `>AC${n}<`);
  const calls = [];
  const client = createClient({
    fetchImpl: async (url) => {
      calls.push(url);
      const n = Number(new URL(url).searchParams.get('pageNo'));
      return { ok: true, status: 200, text: async () => pageHtml(n) };
    },
  });
  const list = await client.listCompanies();
  assert.equal(calls.length, 3);
  assert.deepEqual(list.map((c) => c.symbol), ['AC', 'AC2', 'AC3', 'JFC1', 'JFC2', 'JFC3']);
});

test('service.companies caches the directory and resolves symbols from it', async () => {
  let listCalls = 0;
  let searchCalls = 0;
  const client = {
    listCompanies: async () => {
      listCalls++;
      return [{ cmpyId: '86', securityId: '158', symbol: 'JFC', name: 'Jollibee Foods Corporation', sector: 'Industrial' }];
    },
    searchCompanies: async () => {
      searchCalls++;
      return [];
    },
    fetchQuote: async (cmpyId, symbol) => ({ symbol, cmpyId, last: 1 }),
    fetchHistory: async () => [],
  };
  const service = createService(client);
  assert.deepEqual(await service.companies(), [{ symbol: 'JFC', name: 'Jollibee Foods Corporation', sector: 'Industrial' }]);
  await service.companies();
  assert.equal(listCalls, 1);
  const [q] = await service.quotes(['JFC']);
  assert.equal(q.cmpyId, '86');
  assert.equal(searchCalls, 0);
});

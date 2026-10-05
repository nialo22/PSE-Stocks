'use strict';

// Offline stand-in for the PSE Edge client (enabled with DEMO=1). It serves
// made-up, randomly moving prices so the app can be tried without network
// access to edge.pse.com.ph. The UI labels this data as demo data.

const COMPANIES = [
  ['1', 'AC', 'Ayala Corporation', 620],
  ['2', 'ALI', 'Ayala Land, Inc.', 28.5],
  ['3', 'BDO', 'BDO Unibank, Inc.', 145],
  ['4', 'BPI', 'Bank of the Philippine Islands', 118],
  ['5', 'JFC', 'Jollibee Foods Corporation', 232],
  ['6', 'SM', 'SM Investments Corporation', 880],
  ['7', 'SMPH', 'SM Prime Holdings, Inc.', 26.4],
  ['8', 'TEL', 'PLDT Inc.', 1320],
  ['9', 'GLO', 'Globe Telecom, Inc.', 1890],
  ['10', 'ICT', 'International Container Terminal Services, Inc.', 395],
  ['11', 'MER', 'Manila Electric Company', 520],
  ['12', 'URC', 'Universal Robina Corporation', 88],
  ['13', 'AEV', 'Aboitiz Equity Ventures, Inc.', 34],
  ['14', 'MBT', 'Metropolitan Bank & Trust Company', 72],
  ['15', 'CNVRG', 'Converge Information and Communications Technology Solutions, Inc.', 15.2],
].map(([cmpyId, symbol, name, base]) => ({ cmpyId, symbol, name, base }));

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function createDemoClient() {
  const state = new Map();

  function tick(company) {
    let s = state.get(company.symbol);
    if (!s) {
      const prevClose = company.base;
      const open = round(prevClose * (1 + (Math.random() - 0.5) * 0.01));
      s = { prevClose, open, last: open, high: open, low: open, volume: 0 };
      state.set(company.symbol, s);
    }
    s.last = round(Math.max(0.01, s.last * (1 + (Math.random() - 0.5) * 0.006)));
    s.high = Math.max(s.high, s.last);
    s.low = Math.min(s.low, s.last);
    s.volume += Math.round(Math.random() * 50000);
    return s;
  }

  async function searchCompanies(term) {
    const q = term.toUpperCase();
    return COMPANIES.filter((c) => c.symbol.includes(q) || c.name.toUpperCase().includes(q)).map(
      ({ cmpyId, symbol, name }) => ({ cmpyId, symbol, name }),
    );
  }

  async function fetchQuote(cmpyId, symbol) {
    const company = COMPANIES.find((c) => c.symbol === symbol);
    if (!company) throw new Error(`Unknown PSE symbol: ${symbol}`);
    const s = tick(company);
    const change = round(s.last - s.prevClose, 4);
    return {
      symbol,
      cmpyId,
      securityId: cmpyId,
      securities: [],
      status: 'Open',
      last: s.last,
      open: s.open,
      high: s.high,
      low: s.low,
      prevClose: s.prevClose,
      prevCloseDate: null,
      change,
      changePercent: round((change / s.prevClose) * 100),
      volume: s.volume,
      value: round(s.volume * s.last),
      weekHigh52: round(company.base * 1.25),
      weekLow52: round(company.base * 0.78),
      peRatio: null,
      marketCap: null,
      asOf: new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }),
    };
  }

  async function fetchHistory(cmpyId, securityId, days) {
    const company = COMPANIES.find((c) => c.cmpyId === cmpyId);
    let close = company.base * 0.95;
    const rows = [];
    for (let i = days; i > 0; i--) {
      close = round(close * (1 + (Math.random() - 0.48) * 0.03));
      rows.push({ date: new Date(Date.now() - i * 86400000).toDateString(), open: close, high: close, low: close, close, value: null });
    }
    return rows;
  }

  return { searchCompanies, fetchQuote, fetchHistory };
}

module.exports = { createDemoClient };

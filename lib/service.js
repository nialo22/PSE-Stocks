'use strict';

// Caching layer between the HTTP API and a PSE Edge client. Every browser tab
// polls on its own, so quotes are cached briefly to avoid hammering PSE Edge.

const QUOTE_TTL_MS = Number(process.env.QUOTE_TTL_MS) || 15000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 60 * 1000;
// New listings and delistings are rare, so the full list is refreshed slowly.
const DIRECTORY_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CONCURRENCY = 4;

class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  /** Returns the cached value or runs `load`, sharing one in-flight load per key. */
  async get(key, load) {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.promise;
    const promise = load();
    this.entries.set(key, { at: Date.now(), promise });
    promise.catch(() => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
    });
    return promise;
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function createService(client) {
  const searchCache = new TtlCache(SEARCH_TTL_MS);
  const quoteCache = new TtlCache(QUOTE_TTL_MS);
  const historyCache = new TtlCache(HISTORY_TTL_MS);
  const directoryCache = new TtlCache(DIRECTORY_TTL_MS);
  const companyBySymbol = new Map();

  async function search(term) {
    const key = term.trim().toUpperCase();
    if (!key) return [];
    const results = await searchCache.get(key, () => client.searchCompanies(key));
    for (const r of results) companyBySymbol.set(r.symbol, r);
    return results;
  }

  async function companies() {
    const list = await directoryCache.get('all', () => client.listCompanies());
    for (const c of list) if (!companyBySymbol.has(c.symbol)) companyBySymbol.set(c.symbol, c);
    return list.map(({ symbol, name, sector }) => ({ symbol, name, sector }));
  }

  async function resolve(symbol) {
    const sym = symbol.trim().toUpperCase();
    if (companyBySymbol.has(sym)) return companyBySymbol.get(sym);
    await search(sym);
    const company = companyBySymbol.get(sym);
    if (!company) throw new Error(`Unknown PSE symbol: ${sym}`);
    return company;
  }

  async function quote(symbol) {
    const company = await resolve(symbol);
    const q = await quoteCache.get(company.symbol, () => client.fetchQuote(company.cmpyId, company.symbol));
    return { ...q, name: company.name };
  }

  async function quotes(symbols) {
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    return mapWithConcurrency(unique, MAX_CONCURRENCY, async (symbol) => {
      try {
        return await quote(symbol);
      } catch (err) {
        if (err.detail) console.error(`${symbol}: ${err.detail}`);
        return { symbol, error: err.message, code: err.code };
      }
    });
  }

  async function history(symbol, days) {
    const q = await quote(symbol);
    if (!q.securityId) throw new Error(`No security id found for ${q.symbol}`);
    return historyCache.get(`${q.symbol}:${days}`, () => client.fetchHistory(q.cmpyId, q.securityId, days));
  }

  return { search, quotes, history, companies };
}

module.exports = { createService, TtlCache, mapWithConcurrency };

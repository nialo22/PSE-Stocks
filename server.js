'use strict';

// PSE Stocks: a small web app that shows near real-time Philippine Stock
// Exchange prices from PSE Edge for a user-chosen watchlist.
//
// The browser cannot call edge.pse.com.ph directly (no CORS), so this server
// fetches and parses PSE Edge pages and exposes them as a small JSON API.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('./lib/pse');
const { createDemoClient } = require('./lib/demo');
const { createService } = require('./lib/service');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_SYMBOLS = 60;

const service = createService(DEMO ? createDemoClient() : createClient());

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(url, res) {
  switch (url.pathname) {
    case '/api/config':
      return sendJson(res, 200, { demo: DEMO });

    case '/api/search': {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 1) return sendJson(res, 200, []);
      return sendJson(res, 200, (await service.search(q)).slice(0, 20));
    }

    case '/api/companies':
      return sendJson(res, 200, await service.companies());

    case '/api/quotes': {
      const symbols = (url.searchParams.get('symbols') || '').split(',').filter((s) => s.trim());
      if (symbols.length > MAX_SYMBOLS) {
        return sendJson(res, 400, { error: `At most ${MAX_SYMBOLS} symbols per request` });
      }
      const quotes = await service.quotes(symbols);
      return sendJson(res, 200, { fetchedAt: new Date().toISOString(), quotes });
    }

    case '/api/history': {
      const symbol = url.searchParams.get('symbol') || '';
      const days = Math.min(365, Math.max(5, Number(url.searchParams.get('days')) || 30));
      if (!symbol) return sendJson(res, 400, { error: 'symbol is required' });
      return sendJson(res, 200, await service.history(symbol, days));
    }

    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res, url.pathname);
    return;
  }
  try {
    await handleApi(url, res);
  } catch (err) {
    console.error(`${url.pathname}: ${err.message}`);
    sendJson(res, 502, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PSE Stocks running at http://${HOST}:${PORT}${DEMO ? ' (DEMO data, not from PSE Edge)' : ''}`);
});

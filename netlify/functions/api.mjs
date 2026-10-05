// Netlify Function serving the same /api/* JSON endpoints as server.js, so the
// app works when deployed to Netlify (which only serves static files otherwise).

import pse from '../../lib/pse.js';
import demo from '../../lib/demo.js';
import serviceLib from '../../lib/service.js';

const { createClient } = pse;
const { createDemoClient } = demo;
const { createService } = serviceLib;

const MAX_SYMBOLS = 60;

let service;
function getService() {
  // Kept across warm invocations so the quote/search caches still help.
  service ??= createService(isDemo() ? createDemoClient() : createClient());
  return service;
}

function isDemo() {
  return process.env.DEMO === '1';
}

function json(status, data) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function handle(url) {
  switch (url.pathname) {
    case '/api/config':
      return json(200, { demo: isDemo() });

    case '/api/search': {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 1) return json(200, []);
      return json(200, (await getService().search(q)).slice(0, 20));
    }

    case '/api/quotes': {
      const symbols = (url.searchParams.get('symbols') || '').split(',').filter((s) => s.trim());
      if (symbols.length > MAX_SYMBOLS) {
        return json(400, { error: `At most ${MAX_SYMBOLS} symbols per request` });
      }
      const quotes = await getService().quotes(symbols);
      return json(200, { fetchedAt: new Date().toISOString(), quotes });
    }

    case '/api/history': {
      const symbol = url.searchParams.get('symbol') || '';
      const days = Math.min(365, Math.max(5, Number(url.searchParams.get('days')) || 30));
      if (!symbol) return json(400, { error: 'symbol is required' });
      return json(200, await getService().history(symbol, days));
    }

    default:
      return json(404, { error: 'Not found' });
  }
}

export default async (req) => {
  if (req.method !== 'GET') return new Response(null, { status: 405 });
  const url = new URL(req.url);
  try {
    return await handle(url);
  } catch (err) {
    console.error(`${url.pathname}: ${err.message}`);
    return json(502, { error: err.message });
  }
};

export const config = {
  path: '/api/*',
};

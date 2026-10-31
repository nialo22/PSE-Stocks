'use strict';

// Backtests lib/signals.js on real PSE Edge history.
//   node scripts/backtest.js [--days 1095] [--demo] [SYMBOL ...]
// For each signal and horizon, compares the forward return after the signal
// with the forward return from any day (buy-and-hold baseline).

const { createClient } = require('../lib/pse');
const { createDemoClient } = require('../lib/demo');
const { createService } = require('../lib/service');
const { SIGNALS, signalEvents } = require('../lib/signals');

// PSEi constituents (2025 list).
const PSEI = 'AC ACEN AEV AGI ALI BDO BLOOM BPI CBC CNPF CNVRG DMC EMI GLO GTCAP ICT JFC JGS LTG MBT MER MONDE PGOLD SCC SM SMC SMPH TEL URC WLCON'.split(' ');
const HORIZONS = [5, 60];
const ROUND_TRIP_FEES = 0.007; // ~0.3% buy + ~0.4% sell incl. tax (see sellingFees in public/app.js)

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 1095;
const symbols = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--days');

function newStats() {
  return Object.fromEntries(HORIZONS.map((h) => [h, []]));
}

function summarize(returns, bullish) {
  if (!returns.length) return { n: 0 };
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const hits = returns.filter((r) => (bullish ? r > 0 : r < 0)).length;
  return { n: returns.length, hitRate: hits / returns.length, avg };
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

async function main() {
  const service = createService(demo ? createDemoClient() : createClient());
  const list = symbols.length ? symbols : PSEI;
  const baseline = newStats();
  const bySignal = Object.fromEntries(Object.keys(SIGNALS).map((k) => [k, newStats()]));

  for (const symbol of list) {
    let bars;
    try {
      bars = await service.history(symbol, days);
    } catch (err) {
      console.error(`${symbol}: skipped (${err.message})`);
      continue;
    }
    const events = signalEvents(bars);
    const close = bars.map((b) => b.close);
    for (const h of HORIZONS) {
      // Start at 200 so the baseline covers the same days every signal can fire on.
      for (let i = 200; i + h < close.length; i++) {
        const ret = close[i + h] / close[i] - 1;
        baseline[h].push(ret);
        for (const name of Object.keys(SIGNALS)) if (events[name][i]) bySignal[name][h].push(ret);
      }
    }
    console.error(`${symbol}: ${bars.length} days`);
  }

  console.log(`\nSignals on ${list.length} stocks, ${days} calendar days of history. Hit = moved the predicted way.`);
  console.log(`Avg returns are before fees; a round trip costs about ${pct(ROUND_TRIP_FEES)}.\n`);
  for (const h of HORIZONS) {
    const base = summarize(baseline[h], true);
    console.log(`${h}-day forward return — baseline (any day): up ${pct(base.hitRate)} of the time, avg ${pct(base.avg)} (n=${base.n})`);
    for (const [name, { bullish, label }] of Object.entries(SIGNALS)) {
      const s = summarize(bySignal[name][h], bullish);
      // Bullish signals beat the baseline by returning more; bearish ones by returning less.
      const beats = s.n ? (bullish ? s.avg > base.avg : s.avg < base.avg) : false;
      console.log(`  ${beats ? '✓' : '✗'} ${label.padEnd(56)} n=${String(s.n).padStart(4)}  hit ${pct(s.hitRate).padStart(6)}  avg ${pct(s.avg).padStart(6)}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

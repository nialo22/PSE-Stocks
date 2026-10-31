'use strict';

const { sma, rsi, macd } = require('./indicators');

// Signal events over daily bars (oldest first). Each signal returns true on
// the day it fires. `bullish` signals predict a rise, the rest a fall.
const SIGNALS = {
  goldenCross: { bullish: true, label: 'Golden cross (50-day SMA crosses above 200-day)' },
  deathCross: { bullish: false, label: 'Death cross (50-day SMA crosses below 200-day)' },
  rsiOversold: { bullish: true, label: 'RSI(14) drops below 30' },
  rsiOverbought: { bullish: false, label: 'RSI(14) rises above 70' },
  macdBullish: { bullish: true, label: 'MACD crosses above its signal line' },
  macdBearish: { bullish: false, label: 'MACD crosses below its signal line' },
  breakout: { bullish: true, label: 'New 52-week closing high on 1.5× average traded value' },
  aboveSma200: { bullish: true, label: 'Close crosses above the 200-day SMA' },
  belowSma200: { bullish: false, label: 'Close crosses below the 200-day SMA' },
};

const crossedAbove = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];

/** Returns { [signalName]: boolean[] } aligned with `bars`. */
function signalEvents(bars) {
  const close = bars.map((b) => b.close);
  const value = bars.map((b) => b.value ?? 0);
  const s50 = sma(close, 50);
  const s200 = sma(close, 200);
  const r = rsi(close, 14);
  const m = macd(close);
  const avgValue = sma(value, 20);
  const level = (n) => close.map(() => n);
  const out = Object.fromEntries(Object.keys(SIGNALS).map((k) => [k, close.map(() => false)]));
  for (let i = 1; i < close.length; i++) {
    out.goldenCross[i] = crossedAbove(s50, s200, i);
    out.deathCross[i] = crossedAbove(s200, s50, i);
    out.rsiOversold[i] = crossedAbove(level(30), r, i);
    out.rsiOverbought[i] = crossedAbove(r, level(70), i);
    out.macdBullish[i] = crossedAbove(m.line, m.signal, i);
    out.macdBearish[i] = crossedAbove(m.signal, m.line, i);
    out.aboveSma200[i] = crossedAbove(close, s200, i);
    out.belowSma200[i] = crossedAbove(s200, close, i);
    if (i >= 252 && avgValue[i - 1] > 0) {
      const prevHigh = Math.max(...close.slice(i - 252, i));
      out.breakout[i] = close[i] > prevHigh && value[i] >= 1.5 * avgValue[i - 1];
    }
  }
  return out;
}

// What happened 60 trading days after each signal the backtest kept, from
// `node scripts/backtest.js --days 1825` (30 PSEi stocks, Nov 2021 to Oct 2026).
// ponytail: copied by hand; rerun the backtest and update these now and then.
const TRACK_RECORD = {
  horizonDays: 60,
  baseline: { n: 32223, upRate: 0.452, avg: -0.006 },
  signals: {
    rsiOversold: { n: 468, upRate: 0.519, avg: 0.008 },
    breakout: { n: 324, upRate: 0.472, avg: 0.01 },
    rsiOverbought: { n: 433, upRate: 0.425, avg: -0.009 },
  },
};
const RECENT_BARS = 10;

/** Today's readings plus the kept signals that fired in the last 10 trading days. */
function currentSignals(bars) {
  if (!bars.length) throw new Error('No price history');
  const close = bars.map((b) => b.close);
  const events = signalEvents(bars);
  const last = bars.length - 1;
  const active = [];
  for (const name of Object.keys(TRACK_RECORD.signals)) {
    for (let i = last; i > last - RECENT_BARS && i > 0; i--) {
      if (events[name][i]) {
        active.push({ name, date: bars[i].date });
        break;
      }
    }
  }
  const high52 = Math.max(...close.slice(-252));
  return { rsi: rsi(close).at(-1), high52, fromHigh: close[last] / high52 - 1, active };
}

module.exports = { SIGNALS, TRACK_RECORD, signalEvents, currentSignals };

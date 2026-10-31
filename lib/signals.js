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

module.exports = { SIGNALS, signalEvents };

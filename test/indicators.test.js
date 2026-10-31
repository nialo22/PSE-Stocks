'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sma, ema, rsi, macd } = require('../lib/indicators');

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

test('sma averages the last N values', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema on a straight line lags it by exactly (N - 1) / 2', () => {
  const line = Array.from({ length: 40 }, (_, i) => i + 1);
  const e = ema(line, 3);
  assert.deepEqual(e.slice(0, 3), [null, null, 2]);
  for (let i = 2; i < line.length; i++) near(e[i], line[i] - 1, 1e-9);
});

test('rsi follows Wilder smoothing (hand-worked example)', () => {
  // Period 2, closes 10, 11, 10, 12 -> changes +1, -1, +2.
  // First averages (first 2 changes): gain 0.5, loss 0.5 -> RS 1 -> RSI 50.
  // Next: gain (0.5*1 + 2)/2 = 1.25, loss (0.5*1 + 0)/2 = 0.25 -> RS 5 -> RSI 83.33.
  const r = rsi([10, 11, 10, 12], 2);
  assert.deepEqual(r.slice(0, 2), [null, null]);
  near(r[2], 50, 1e-9);
  near(r[3], 100 - 100 / 6, 1e-9);
});

test('rsi is 100 with no losses and 0 with no gains', () => {
  const up = Array.from({ length: 20 }, (_, i) => i);
  assert.equal(rsi(up).at(-1), 100);
  assert.equal(rsi([...up].reverse()).at(-1), 0);
});

test('macd on a straight line: line = 7, signal = 7, histogram = 0', () => {
  // EMA(12) lags by 5.5 and EMA(26) by 12.5, so their gap is exactly 7.
  const line = Array.from({ length: 60 }, (_, i) => i + 1);
  const m = macd(line);
  assert.equal(m.line[24], null);
  near(m.line[25], 7, 1e-9);
  assert.equal(m.signal[32], null);
  near(m.signal[33], 7, 1e-9);
  near(m.histogram.at(-1), 0, 1e-9);
});

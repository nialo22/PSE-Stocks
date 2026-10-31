'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signalEvents } = require('../lib/signals');

test('golden cross fires once when a long fall turns into a long rise', () => {
  const closes = [...Array.from({ length: 250 }, (_, i) => 300 - i), ...Array.from({ length: 250 }, (_, i) => 51 + i)];
  const e = signalEvents(closes.map((close) => ({ close, value: 1 })));
  assert.equal(e.goldenCross.filter(Boolean).length, 1);
  assert.equal(e.deathCross.filter(Boolean).length, 0);
  assert.equal(e.aboveSma200.filter(Boolean).length, 1);
});

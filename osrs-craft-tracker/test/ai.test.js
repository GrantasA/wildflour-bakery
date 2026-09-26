'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeSeries } = require('../src/market');
const { SellAI } = require('../src/ai');

// Items whose price swings in a regular daily-ish cycle: a pattern the AI
// should learn to exploit (sell near the top of the swing, not at "now").
function cyclic(name, base, phase) {
  const raw = [];
  const end = 1_800_000_000 - (1_800_000_000 % 300);
  for (let k = 0; k < 365; k++) {
    const ts = end - (364 - k) * 300;
    const mid = base * (1 + 0.03 * Math.sin((k + phase) / 12));
    raw.push({ timestamp: ts, avgHighPrice: Math.round(mid * 1.003), highPriceVolume: 20,
      avgLowPrice: Math.round(mid * 0.997), lowPriceVolume: 20 });
  }
  const s = normalizeSeries(raw, 300);
  const last = s[s.length - 1];
  return { name, series5m: s, series1h: [], latest: { high: last.avgHigh, low: last.avgLow, highTime: 0, lowTime: 0 } };
}

const items = Array.from({ length: 12 }, (_, i) => cyclic(`Item ${i}`, 1e6 * (i + 1), i * 7));

test('AI beats undercutting on predictable swings and is honest about fill rate', () => {
  const ai = new SellAI();
  const bt = ai.runBacktest(items, 1, 2 * 3600, 0.5, 150);
  assert.ok(bt.tests > 50);
  assert.ok(bt.upliftVsUndercut > 0, `uplift ${bt.upliftVsUndercut}`);
  assert.ok(Math.abs(bt.predictedFill - bt.actualFill) < 0.25, `pred ${bt.predictedFill} actual ${bt.actualFill}`);
});

test('AI suggestion has a price, a fill chance and never over-promises', () => {
  const ai = new SellAI();
  const s = ai.suggest(items, 1, items[3], 5, 2 * 3600, 0.5);
  assert.ok(s && s.price > 0);
  assert.ok(s.pFill >= 0 && s.pFill <= 1);
  assert.ok(s.expectedNet >= s.undercut.expectedNet - 1e-6, 'best price is at least as good as undercutting');
  assert.ok(s.neighbours >= 10);
});

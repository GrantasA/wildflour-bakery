'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { taxPerItem, netSale } = require('../src/tax');
const { normalizeSeries, fillTimeStats, buyLimitSeconds, priceCurve } = require('../src/market');
const { evaluateRecipe } = require('../src/optimizer');

test('GE tax: 2%, floored, 5M cap, <50gp free, bonds exempt', () => {
  assert.strictEqual(taxPerItem(49), 0);
  assert.strictEqual(taxPerItem(50), 1);
  assert.strictEqual(taxPerItem(1_234_567), 24_691);
  assert.strictEqual(taxPerItem(2_000_000_000), 5_000_000);
  assert.strictEqual(taxPerItem(10_000_000, 'Old school bond'), 0);
  assert.strictEqual(netSale(100), 98);
});

test('normalizeSeries fills gaps with empty buckets', () => {
  const s = normalizeSeries([
    { timestamp: 0, avgHighPrice: 10, highPriceVolume: 1, avgLowPrice: 9, lowPriceVolume: 2 },
    { timestamp: 900 },
  ], 300);
  assert.strictEqual(s.length, 4);
  assert.strictEqual(s[1].highVol, 0);
  assert.strictEqual(s[1].avgHigh, null);
});

test('fillTimeStats: constant flow gives exact times, zero flow is infinite', () => {
  const v = new Array(10).fill(10); // 10/bucket, 50% share -> 5 per 300s
  assert.strictEqual(fillTimeStats(v, 5, 0.5, 300).median, 300);
  assert.strictEqual(fillTimeStats(v, 10, 0.5, 300).median, 600);
  // more than one window's worth wraps around cyclically
  assert.strictEqual(fillTimeStats(v, 75, 0.5, 300).median, 15 * 300);
  assert.strictEqual(fillTimeStats(new Array(10).fill(0), 1, 0.5, 300).median, Infinity);
});

test('fillTimeStats: sparse trades -> median reflects waiting for them', () => {
  const v = new Array(12).fill(0);
  v[0] = 100; // one burst per hour
  const st = fillTimeStats(v, 1, 1, 300);
  // starting at bucket s you wait until bucket 0 comes round again
  assert.ok(st.median >= 5 * 300 && st.median <= 8 * 300, String(st.median));
  assert.ok(st.p90 > st.median);
});

test('buy limit adds 4h windows', () => {
  assert.strictEqual(buyLimitSeconds(100, 100), 0);
  assert.strictEqual(buyLimitSeconds(101, 100), 4 * 3600);
  assert.strictEqual(buyLimitSeconds(450, 100), 4 * 4 * 3600);
});

function mkItem(name, mid, vol, extra = {}) {
  const raw = [];
  for (let k = 0; k < 100; k++) {
    raw.push({ timestamp: k * 300,
      avgHighPrice: mid + 2 + (k % 5), highPriceVolume: vol,
      avgLowPrice: mid - 2 - (k % 5), lowPriceVolume: vol });
  }
  return { id: name.length, name, limit: 1000, latest: { high: mid + 3, low: mid - 3, highTime: Date.now() / 1000, lowTime: Date.now() / 1000 },
    series5m: normalizeSeries(raw, 300), series1h: [], ...extra };
}

test('priceCurve: cheaper buys take longer, frontier is monotone', () => {
  const it = mkItem('Thing', 1000, 20);
  const { points } = priceCurve(it, 'buy', 50, { share: 0.5 });
  assert.ok(points.length > 2);
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].median > points[i - 1].median);
    assert.ok(points[i].price < points[i - 1].price);
  }
});

test('evaluateRecipe finds a profitable plan and accounts for tax', () => {
  const items = { A: mkItem('A', 1000, 30), B: mkItem('B', 500, 30), Out: mkItem('Out', 2000, 30) };
  const recipe = { id: 't', category: 'Test', inputs: [{ item: 'A', qty: 1 }, { item: 'B', qty: 1 }], output: { item: 'Out', qty: 1 }, batch: 10, craftSeconds: 1 };
  const r = evaluateRecipe(recipe, (n) => items[n], { share: 0.5, maxWaitHours: 24, capital: 1e9 });
  assert.strictEqual(r.status, 'ok');
  const p = r.plan;
  assert.strictEqual(p.sell.tax, Math.floor(p.sell.price * 0.02));
  assert.strictEqual(p.profit, p.revenue - p.taxTotal - p.cost);
  assert.ok(p.profit > 0 && r.viable);
  // the optimised plan is at least as good per hour as the instant one
  assert.ok(p.profitPerHour >= r.instant.profitPerHour - 1e-6);
});

test('evaluateRecipe reports unknown items', () => {
  const r = evaluateRecipe({ id: 'x', inputs: [{ item: 'Nope', qty: 1 }], output: { item: 'Also nope', qty: 1 } }, () => null);
  assert.strictEqual(r.status, 'missing');
  assert.deepStrictEqual(r.missing, ['Nope', 'Also nope']);
});

test('detrend maps an old price level onto the current one', () => {
  const { detrend } = require('../src/market');
  const b = [];
  for (let k = 0; k < 60; k++) b.push({ ts: k, avgHigh: 1000 + k * 10 + 5, avgLow: 1000 + k * 10 - 5, highVol: 1, lowVol: 1 });
  const out = detrend(b, { high: 1600, low: 1590 }, 5);
  // early buckets traded ~1000 but should now be expressed near today's ~1595
  assert.ok(Math.abs((out[0].avgHigh + out[0].avgLow) / 2 - 1595) < 60, String(out[0].avgHigh));
  assert.ok(out[0].avgHigh > out[0].avgLow);
});

test('active time excludes GE waiting; activeProfit objective takes the patient plan', () => {
  const items = { A: mkItem('A', 1000, 30), Out: mkItem('Out', 1100, 30) };
  const recipe = { id: 'p', category: 'Test', inputs: [{ item: 'A', qty: 1 }], output: { item: 'Out', qty: 1 }, batch: 20, craftSeconds: 2 };
  const fast = evaluateRecipe(recipe, (n) => items[n], { share: 0.5, maxWaitHours: 24, capital: 1e9, objective: 'profitPerHour' });
  const patient = evaluateRecipe(recipe, (n) => items[n], { share: 0.5, maxWaitHours: 24, capital: 1e9, objective: 'activeProfit' });
  assert.strictEqual(patient.plan.activeSeconds, 20 * 2 + 15 * 2);
  assert.ok(patient.plan.seconds > patient.plan.activeSeconds);
  assert.ok(patient.plan.profit >= fast.plan.profit);
  assert.ok(patient.plan.profitPerActiveHour >= fast.plan.profitPerActiveHour);
});

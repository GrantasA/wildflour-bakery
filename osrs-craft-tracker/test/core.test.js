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
  // 20 crafts: 2 bank trips (14 per inventory) x 15s + 20 x 2s of crafting, plus 2 GE offers x 15s
  assert.strictEqual(patient.plan.activeSeconds, 2 * 15 + 20 * 2 + 15 * 2);
  assert.ok(patient.plan.seconds > patient.plan.activeSeconds);
  assert.ok(patient.plan.profit >= fast.plan.profit);
  assert.ok(patient.plan.profitPerActiveHour >= fast.plan.profitPerActiveHour);
});

test('batch size is chosen for gp/h, within buy limits and the clicking limit', () => {
  // thin market: 3 units per 5 min each side, so huge batches take ages to fill
  const items = { A: mkItem('A', 1000, 3), Out: mkItem('Out', 1300, 3) };
  const recipe = { id: 'bs', category: 'T', inputs: [{ item: 'A', qty: 1 }], output: { item: 'Out', qty: 1 }, craftSeconds: 1 };
  const opts = { share: 0.5, maxWaitHours: 1e6, capital: 1e12, objective: 'profitPerHour' };
  const r = evaluateRecipe(recipe, (n) => items[n], opts);
  assert.strictEqual(r.status, 'ok');
  // ~1,728 trade per day; with a 2h sell window and a 50% share the market can take ~72
  assert.strictEqual(r.maxBatch, 72);
  const g = (x) => x.gph;
  const atMax = r.batchOptions.find((o) => o.batch === 72);
  const chosen = r.batchOptions.find((o) => o.batch === r.batch);
  assert.ok(r.batch <= 72, `chose ${r.batch}`);
  assert.ok(g(chosen) >= g(atMax));
  assert.ok(r.batchOptions.every((o) => g(o) <= g(chosen) + 1e-9));
  // clicking limit: 1 minute of work, 15s per offer x2 offers, 15s bank trip, 10s per craft -> 1 craft
  const r2 = evaluateRecipe({ ...recipe, craftSeconds: 10 }, (n) => items[n], { ...opts, maxActive: 1 });
  assert.ok(r2.batch <= 3 && r2.maxBatch <= 3, `batch ${r2.batch} max ${r2.maxBatch}`);
});

test('never plans more than the market trades: 280 of a 32/day item in 30 minutes is refused', () => {
  // ~32 trades per day (16 each side), spread thinly across the day
  const thin = (name, mid) => {
    const raw = [];
    for (let k = 0; k < 288; k++) {
      const trade = k % 18 === 0;
      raw.push({ timestamp: k * 300, avgHighPrice: trade ? mid + 5 : null, highPriceVolume: trade ? 1 : 0,
        avgLowPrice: trade ? mid - 5 : null, lowPriceVolume: trade ? 1 : 0 });
    }
    return { id: 1, name, limit: 10_000, latest: { high: mid + 5, low: mid - 5, highTime: Date.now() / 1000, lowTime: Date.now() / 1000 },
      series5m: normalizeSeries(raw, 300), series1h: [] };
  };
  const items = { Rare: thin('Rare', 50_000), Out: mkItem('Out', 80_000, 30) };
  const recipe = { id: 'rare', category: 'T', inputs: [{ item: 'Rare', qty: 1 }], output: { item: 'Out', qty: 1 }, craftSeconds: 1 };
  const opts = { share: 0.33, capital: 1e12, objective: 'profitPerHour', buyWithinHours: 0.5, sellWithinHours: 0.5, maxWaitHours: 1.25 };
  const r = evaluateRecipe(recipe, (n) => items[n], opts);
  assert.strictEqual(r.status, 'ok');
  assert.ok(r.batch <= 1, `batch ${r.batch}`);
  assert.strictEqual(r.viable, false);
  assert.ok(r.flags.some((f) => /Rare only trades ~32\/day/.test(f)), r.flags.join(' | '));
  // a user-forced batch of 280 is flagged too
  const forced = evaluateRecipe({ ...recipe, batch: 280 }, (n) => items[n], { ...opts, buyWithinHours: 24 * 30 });
  assert.strictEqual(forced.viable, false);
  assert.ok(forced.flags.some((f) => /more than the market trades/.test(f)), forced.flags.join(' | '));
  // and the plan shows the daily volume next to the ingredient
  assert.ok(Math.abs(r.plan.inputs[0].perDay - 32) < 1);
});

test('hands-on time counts steps, bank trips and travel to the station', () => {
  const { craftTime, maxCraftsWithin } = require('../src/effort');
  const ward = { steps: [['anvil', 1]], perInventory: 9, station: 'anvil' };
  // 100 wards: walk to the anvil and back (60s) + 12 bank trips (15s) + 100 x 3s smithing
  assert.strictEqual(craftTime(ward, 100), 60 + 12 * 15 + 100 * 3);
  const anguish = { steps: [['combine', 1], ['chisel', 1], ['furnace', 1], ['enchant', 1]], perInventory: 7, station: 'furnace' };
  // a 4-step chain costs 4 steps per craft, not 1
  assert.ok(Math.abs(craftTime(anguish, 7) - (60 + 15 + 7 * (1.8 + 1.2 + 3 + 1.8))) < 1e-9);
  assert.strictEqual(craftTime(ward, 0), 0);
  assert.strictEqual(maxCraftsWithin(ward, 60 + 15 + 3 - 1), 0);
  const m = maxCraftsWithin(ward, 600);
  assert.ok(craftTime(ward, m) <= 600 && craftTime(ward, m + 1) > 600);
});

test('"check every" = how often you can change offers, not how long you will wait', () => {
  const { buyWindowsFor, sellWindowsFor } = require('../src/optimizer');
  // checking every 8h (overnight): no offer priced for less than 8h, longer ones allowed
  const w8 = buyWindowsFor({ checkInHours: 8 });
  assert.strictEqual(Math.min(...w8), 8 * 3600);
  assert.ok(w8.some((w) => w > 8 * 3600));
  assert.deepStrictEqual(sellWindowsFor({ checkInHours: 8 }), [8 * 3600, 12 * 3600]);
  assert.deepStrictEqual(buyWindowsFor({ checkInHours: 0.5 }), [1800, 4 * 3600, 24 * 3600]);
  // checking every 5 minutes: quick windows available, and longer ones too
  const w5 = buyWindowsFor({ checkInHours: 5 / 60 });
  assert.strictEqual(Math.min(...w5), 300);
  assert.ok(Math.max(...w5) >= 24 * 3600);

  // A 32/day ingredient: with "check every 30m" it is no longer ruled out just
  // because it can't fill within 30 minutes; the batch is capped by a day's volume.
  const thin = (name, mid) => {
    const raw = [];
    for (let k = 0; k < 288; k++) {
      const trade = k % 18 === 0;
      raw.push({ timestamp: k * 300, avgHighPrice: trade ? mid + 5 : null, highPriceVolume: trade ? 1 : 0,
        avgLowPrice: trade ? mid - 5 : null, lowPriceVolume: trade ? 1 : 0 });
    }
    return { id: 1, name, limit: 10_000, latest: { high: mid + 5, low: mid - 5, highTime: Date.now() / 1000, lowTime: Date.now() / 1000 },
      series5m: normalizeSeries(raw, 300), series1h: [] };
  };
  const items = { Rare: thin('Rare', 50_000), Out: mkItem('Out', 80_000, 30) };
  const recipe = { id: 'rare', category: 'T', inputs: [{ item: 'Rare', qty: 1 }], output: { item: 'Out', qty: 1 }, craftSeconds: 1 };
  const r = evaluateRecipe(recipe, (n) => items[n], { share: 0.33, capital: 1e12, objective: 'profitPerHour',
    checkInHours: 0.5, sellWithinHours: 0.5, maxWaitHours: 24 * 14 });
  assert.strictEqual(r.status, 'ok');
  assert.ok(!r.flags.some((f) => /only trades/.test(f)), r.flags.join(' | '));
  assert.ok(r.maxBatch <= Math.floor(0.33 * 32), `max ${r.maxBatch}`); // a day's realistic share
  assert.ok(r.plan.buySeconds > 3600, 'honest: buying a 32/day item takes hours');
});

test('oathplate takes 15+ minutes of your time per piece and is still allowed as a single craft', () => {
  const { craftTime, withinClickLimit } = require('../src/effort');
  const recipes = require('../src/recipes.json').recipes;
  for (const id of ['oathplate-helm', 'oathplate-chest', 'oathplate-legs']) {
    const r = recipes.find((x) => x.id === id);
    assert.ok(craftTime(r, 1) >= 15 * 60, `${id}: ${craftTime(r, 1)}s`);
    assert.ok(craftTime(r, 2) >= 30 * 60);
    assert.ok(withinClickLimit(1, craftTime(r, 1) + 45, 15 * 60), 'one piece is allowed');
    assert.ok(!withinClickLimit(2, craftTime(r, 2) + 45, 15 * 60), 'two pieces exceed the limit');
  }
});

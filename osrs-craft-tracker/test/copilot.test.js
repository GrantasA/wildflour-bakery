'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { normalizeSeries } = require('../src/market');
const { evaluateRecipe } = require('../src/optimizer');
const { PositionStore, stats, breakEvenPrice } = require('../src/positions');
const { rankCrafts, advise } = require('../src/copilot');
const { taxPerItem } = require('../src/tax');

function mkItem(name, mid, vol) {
  const raw = [];
  const now = Math.floor(Date.now() / 1000);
  for (let k = 0; k < 100; k++) {
    raw.push({ timestamp: now - (100 - k) * 300,
      avgHighPrice: mid + 2 + (k % 5), highPriceVolume: vol,
      avgLowPrice: mid - 2 - (k % 5), lowPriceVolume: vol });
  }
  return { id: name.length, name, limit: 1000, icon: null,
    latest: { high: mid + 3, low: mid - 3, highTime: now, lowTime: now },
    series5m: normalizeSeries(raw, 300), series1h: [] };
}
const items = { A: mkItem('A', 1000, 30), B: mkItem('B', 500, 30), Out: mkItem('Out', 2000, 30) };
const getItem = (n) => items[n] || null;
const recipe = { id: 't', category: 'Test', inputs: [{ item: 'A', qty: 1 }, { item: 'B', qty: 1 }], output: { item: 'Out', qty: 1 }, batch: 5, craftSeconds: 1 };
const opts = { share: 0.5, maxWaitHours: 24, capital: 1e9, objective: 'activeProfit' };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), 'positions.json');

test('break-even price covers cost after tax', () => {
  for (const c of [10, 1000, 123456, 3e8]) {
    const s = breakEvenPrice(c, 1, 'x');
    assert.ok(s - taxPerItem(s) >= c);
    assert.ok(s - 1 - taxPerItem(s - 1) < c);
  }
});

test('trade lifecycle: buy -> ready -> selling -> done with profit after tax, persisted', () => {
  const file = tmpFile();
  const store = new PositionStore(file);
  const r = evaluateRecipe(recipe, getItem, opts);
  const pos = store.create({ recipe, batch: r.batch, plan: r.plan });
  assert.strictEqual(pos.status, 'buying');
  store.act(pos.id, { action: 'bought', index: 0, price: 990 });
  assert.strictEqual(store.get(pos.id).status, 'buying');
  store.act(pos.id, { action: 'bought', index: 1, price: 495 });
  assert.strictEqual(store.get(pos.id).status, 'ready');
  store.act(pos.id, { action: 'list', price: 2010 });
  const done = store.act(pos.id, { action: 'sold', price: 2005 });
  assert.strictEqual(done.status, 'done');
  const tax = taxPerItem(2005) * 5;
  assert.strictEqual(done.profit, 2005 * 5 - tax - (990 + 495) * 5);
  const again = new PositionStore(file);
  assert.strictEqual(again.get(pos.id).profit, done.profit);
  const st = stats(again.list());
  assert.strictEqual(st.trades, 1);
  assert.strictEqual(st.profit, done.profit);
  assert.strictEqual(st.tax, tax);
});

test('already-bought trade starts ready and gets a sell suggestion above break-even', () => {
  const store = new PositionStore(tmpFile());
  const r = evaluateRecipe(recipe, getItem, opts);
  const pos = store.create({ recipe, batch: r.batch, plan: r.plan, prices: [1000, 500], bought: true });
  assert.strictEqual(pos.status, 'ready');
  const a = advise(pos, recipe, getItem, opts);
  assert.strictEqual(a.kind, 'list');
  assert.ok(a.price >= a.breakEven);
  assert.ok(a.projectedProfit > 0);
});

test('buy advice: raise a lowball offer, cancel when the craft turns unprofitable', () => {
  const store = new PositionStore(tmpFile());
  const r = evaluateRecipe(recipe, getItem, opts);
  const pos = store.create({ recipe, batch: r.batch, plan: { ...r.plan, buySeconds: 600 }, prices: [800, 500] });
  const a = advise(pos, recipe, getItem, opts);
  assert.strictEqual(a.inputs[0].kind, 'raise');
  assert.ok(a.inputs[0].price > 800);

  const pricey = store.create({ recipe, batch: r.batch, plan: r.plan, prices: [1900, 900] });
  assert.strictEqual(advise(pricey, recipe, getItem, opts).kind, 'cancel');
});

test('rankCrafts scores viable crafts and respects the hands-on time limit', () => {
  const quick = evaluateRecipe(recipe, getItem, opts);
  const slow = evaluateRecipe({ ...recipe, id: 'slow', craftSeconds: 3600 }, getItem, opts);
  const ranked = rankCrafts([quick, slow], 15);
  assert.deepStrictEqual(ranked.map((r) => r.id), ['t']);
  assert.ok(ranked[0].score >= 0 && ranked[0].score <= 100);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { normalizeSeries } = require('../src/market');
const { PriceAI, tailMean } = require('../src/ai');
const { Journal } = require('../src/journal');
const { priceMoveRisk, warnings } = require('../src/risk');

// Items whose price swings in a regular cycle: a pattern the AI should learn
// to exploit (sell near the tops, buy near the bottoms).
const END = 1_800_000_000 - (1_800_000_000 % 300);
function cyclic(name, base, phase, amp = 0.03) {
  const raw = [];
  for (let k = 0; k < 365; k++) {
    const ts = END - (364 - k) * 300;
    const mid = base * (1 + amp * Math.sin((k + phase) / 12));
    raw.push({ timestamp: ts, avgHighPrice: Math.round(mid * 1.003), highPriceVolume: 20,
      avgLowPrice: Math.round(mid * 0.997), lowPriceVolume: 20 });
  }
  const s = normalizeSeries(raw, 300);
  const last = s[s.length - 1];
  return { name, series5m: s, series1h: [], latest: { high: last.avgHigh, low: last.avgLow, highTime: 0, lowTime: 0 } };
}
const items = Array.from({ length: 12 }, (_, i) => cyclic(`Item ${i}`, 1e6 * (i + 1), i * 7));

for (const side of ['sell', 'buy']) {
  test(`${side}: AI beats the simple rule on predictable swings and is honest about fill rate`, () => {
    const ai = new PriceAI();
    const bt = ai.runBacktest(items, 1, 2 * 3600, 0.5, { side, maxTests: 120 });
    assert.ok(bt.tests > 50);
    assert.ok(bt.uplift > 0, `uplift ${bt.uplift}`);
    assert.ok(Math.abs(bt.predictedFill - bt.actualFill) < 0.25, `pred ${bt.predictedFill} actual ${bt.actualFill}`);
    assert.ok([20, 40, 80, 160].includes(bt.k));
  });
}

test('sell suggestion: price, fill chance, at least as good as the rule', () => {
  const s = new PriceAI().suggest(items, 1, items[3], 5, 2 * 3600, 0.5, { side: 'sell' });
  assert.ok(s && s.price > 0 && s.pFill >= 0 && s.pFill <= 1);
  assert.ok(s.expected >= s.rule.expected - 1e-6);
  assert.ok(s.bad <= s.expected + 1e-6, 'bad case is never better than the average');
});

test('buy suggestion: expected cost no worse than bidding 1gp over the best bid', () => {
  const s = new PriceAI().suggest(items, 1, items[5], 5, 2 * 3600, 0.5, { side: 'buy' });
  assert.ok(s && s.side === 'buy' && s.price > 0);
  assert.ok(s.expected <= s.rule.expected + 1e-6);
  assert.ok(s.bad >= s.expected - 1e-6, 'bad case costs at least the average');
});

test('careful risk setting never picks a riskier sell than bold', () => {
  const ai = new PriceAI();
  const bold = ai.suggest(items, 1, items[2], 5, 2 * 3600, 0.5, { side: 'sell', riskAversion: 0 });
  const careful = new PriceAI().suggest(items, 1, items[2], 5, 2 * 3600, 0.5, { side: 'sell', riskAversion: 1 });
  assert.ok(careful.bad >= bold.bad - 1e-6);
});

test('tailMean averages the worst 20%', () => {
  // 50% chance of 100, otherwise 0 or 50 equally: worst 20% are all 0
  assert.strictEqual(tailMean(0.5, 100, [{ v: 0, w: 1 }, { v: 50, w: 1 }], 2, 0.2), 0);
  // buying: worst = most expensive
  assert.strictEqual(tailMean(0.5, 100, [{ v: 300, w: 1 }, { v: 50, w: 1 }], 2, 0.2, 'buy'), 300);
});

test('journal: records, grades against the real chart, calibrates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
  const j = new Journal(dir);
  const it = items[0];
  const t0 = it.series5m[100].ts;
  // an easy sell (well under the market) and an impossible one (way above)
  const mk = (price, side) => ({ side, price, pFill: 0.9, pRaw: 0.9, rule: { price: it.series5m[100].avgHigh - 1, pRaw: 0.5 } });
  j.record({ item: it.name, windowSec: 7200, qty: 1, share: 0.5, suggestion: mk(1, 'sell'), nowSec: t0 });
  j.record({ item: it.name, windowSec: 7200, qty: 1, share: 0.5, suggestion: mk(1e12, 'sell'), nowSec: t0 + 3600 });
  assert.strictEqual(j.entries.length, 2);
  // dedupe: same item/window within 30 min is skipped
  assert.strictEqual(j.record({ item: it.name, windowSec: 7200, qty: 1, share: 0.5, suggestion: mk(5, 'sell'), nowSec: t0 + 3700 }), null);
  const n = j.grade(() => it.series5m, END);
  assert.strictEqual(n, 2);
  const [a, b] = j.entries;
  assert.strictEqual(a.grade.hit, true);
  assert.strictEqual(b.grade.hit, false);
  const st = j.stats('sell');
  assert.strictEqual(st.graded, 2);
  assert.strictEqual(st.actual, 0.5);
  // reload from disk keeps grades
  const again = new Journal(dir);
  assert.strictEqual(again.stats('sell').graded, 2);
  // calibration is monotone and pulls 0.9 towards what really happened
  const cal = again.calibrator('sell');
  assert.ok(cal(0.95) < 0.95 && cal(0.95) >= cal(0.5));
});

test('risk: bigger swings mean a worse bad case; spikes are flagged', () => {
  const calm = cyclic('Calm', 1e6, 0, 0.005), wild = cyclic('Wild', 1e6, 0, 0.1);
  const rc = priceMoveRisk(calm, 4 * 3600), rw = priceMoveRisk(wild, 4 * 3600);
  assert.ok(rw.q10 < rc.q10);
  assert.ok(rw.probBelow(-0.05) > rc.probBelow(-0.05));
  const spiky = cyclic('Spiky', 1e6, 0, 0.005);
  spiky.latest = { high: 1.5e6, low: 1.4e6, highTime: END, lowTime: END };
  assert.ok(warnings(spiky, END).some((w) => w.kind === 'spike'));
  assert.ok(!warnings(calm, END).some((w) => w.kind === 'spike'));
});

test('tailMeanSorted matches tailMean', () => {
  const { tailMeanSorted } = require('../src/ai');
  const rnd = (() => { let x = 7; return () => ((x = (x * 16807) % 2147483647) / 2147483647); })();
  for (let trial = 0; trial < 200; trial++) {
    for (const side of ['sell', 'buy']) {
      const falls = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => ({ v: Math.round(rnd() * 1000), w: rnd() + 0.1 }));
      const fw = falls.reduce((a, d) => a + d.w, 0);
      const p = rnd(), fv = Math.round(rnd() * 1000);
      const sorted = [...falls].sort((a, b) => (side === 'sell' ? a.v - b.v : b.v - a.v));
      const a = tailMean(p, fv, falls, fw, 0.2, side), b = tailMeanSorted(p, fv, sorted, fw, 0.2, side);
      assert.ok(Math.abs(a - b) < 1e-6, `${side} ${a} vs ${b}`);
    }
  }
});

test('a trade started from the AI plan gets "keep" advice straight away (plan and advice agree)', () => {
  const { evaluateRecipe } = require('../src/optimizer');
  const { PositionStore } = require('../src/positions');
  const { advise } = require('../src/copilot');
  const now = END * 1000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const pool = items.map((it) => ({ ...it, id: it.name.length, limit: 10000, icon: null,
      latest: { ...it.latest, highTime: END, lowTime: END } }));
    const byName = new Map(pool.map((it) => [it.name, it]));
    const getItem = (n) => byName.get(n) || null;
    const ai = new PriceAI();
    const adv = (side) => (item, qty, w) => {
      const snap = [3600, 4 * 3600, 12 * 3600, 24 * 3600, 48 * 3600].find((x) => x >= w) || 48 * 3600;
      return ai.suggest(pool, 1, item, qty, snap, 0.5, { side });
    };
    const recipe = { id: 'x', category: 'T', inputs: [{ item: 'Item 1', qty: 1 }, { item: 'Item 2', qty: 1 }],
      output: { item: 'Item 5', qty: 1 }, batch: 2, craftSeconds: 1 };
    const opts = { share: 0.5, maxWaitHours: 24, capital: 1e12, objective: 'activeProfit', sellWithinHours: 2,
      buyAdvisor: adv('buy'), sellAdvisor: adv('sell') };
    const r = evaluateRecipe(recipe, getItem, opts);
    assert.strictEqual(r.status, 'ok');
    assert.ok(r.aiBuys);
    const store = new PositionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-')), 'p.json'));
    const pos = store.create({ recipe, batch: r.batch, plan: r.plan, now });
    const a = advise(pos, recipe, getItem, opts, now);
    for (const inp of a.inputs) assert.strictEqual(inp.kind, 'keep', inp.text);
  } finally {
    Date.now = realNow;
  }
});

test('context signals: market, related items and craft margin', () => {
  const { buildContext, contextFeatures, prepare } = require('../src/ai');
  // A (ingredient) jumps 10% in the last 6 buckets; B (product) is flat
  const mk = (name, jump) => {
    const b = Array.from({ length: 80 }, (_, k) => {
      const p = 1000 * (k >= 74 ? 1 + jump : 1) * (1 + 0.001 * Math.sin(k));
      return { ts: k * 300, avgHigh: p, avgLow: p * 0.99, highVol: 5, lowVol: 5 };
    });
    return prepare(name, b, 300);
  };
  const A = mk('A', 0.1), B = mk('B', 0), C = mk('C', 0);
  const ctx = buildContext([A, B, C], [{ inputs: [{ item: 'A', qty: 1 }], output: { item: 'B', qty: 1 } }]);
  const fB = contextFeatures(ctx, B, 79);
  assert.ok(fB[2] > 1, `related move for B should be strongly up, got ${fB[2]}`);
  assert.ok(fB[4] < -1, `B's margin (B vs cost of A) should look unusually narrow, got ${fB[4]}`);
  const fC = contextFeatures(ctx, C, 79);
  assert.strictEqual(fC[2], 0, 'C has no related items');
  assert.ok(fC[0] > 0, 'the whole market moved up because A did');
});

test('backtest decides whether the context signals earn their place', () => {
  const ai = new PriceAI();
  ai.setRecipes([{ inputs: [{ item: 'Item 0', qty: 1 }], output: { item: 'Item 1', qty: 1 } }]);
  const bt = ai.runBacktest(items, 1, 2 * 3600, 0.5, { side: 'sell', maxTests: 60 });
  assert.strictEqual(typeof bt.usesContext, 'boolean');
  assert.ok(bt.contextGain === null || Number.isFinite(bt.contextGain));
  const s = ai.suggest(items, 1, items[1], 2, 2 * 3600, 0.5, { side: 'sell' });
  assert.strictEqual(s.usesContext, bt.usesContext);
});

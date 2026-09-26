'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planSlots } = require('../src/portfolio');

// a craft whose risk-adjusted gp/h = gph (hours fixed at 1)
const craft = (id, inputs, cost, gph, batch = 10) => ({
  id, name: `Out ${id}`, status: 'ok', viable: true, batch, icon: null, warnings: [],
  ingredients: inputs.map((i) => ({ item: i, qty: 1 })),
  plan: { cost, profit: gph * 1.2, badProfit: gph * 0.5, riskAdjusted: gph, pLoss: 0.1,
    inputs: inputs.map((i) => ({ name: i })), buySeconds: 1800, activeSeconds: 60, hours: 1 },
});

test('picks the combination with the best total gp/h, not just the best single craft', () => {
  const results = [
    craft('a', ['A1'], 60, 10),  // best alone...
    craft('b', ['B1'], 50, 7),
    craft('c', ['C1'], 50, 6),   // ...but b + c together earn 13/h with the same GP
  ];
  const p = planSlots({ results, capital: 100, slots: 8, minGph: 0 });
  assert.deepStrictEqual(p.picks.map((x) => x.id).sort(), ['b', 'c']);
  assert.strictEqual(p.gph, 13);
});

test('GP management: a smaller batch can free GP for another craft', () => {
  const results = [craft('e', ['E1'], 100, 20), craft('f', ['F1'], 50, 9)];
  // half a batch of e costs 50 and earns 12/h (faster buys, so more than half the gp/h)
  const replan = (id, batch) => (id === 'e' ? craft('e', ['E1'], 10 * batch, batch === 5 ? 12 : 1, batch) : null);
  const p = planSlots({ results, capital: 100, slots: 8, replan, minGph: 0 });
  const e = p.picks.find((x) => x.id === 'e');
  assert.ok(e && e.batch === 5 && e.scaled, 'half batch of e');
  assert.ok(p.picks.some((x) => x.id === 'f'));
  assert.strictEqual(p.gph, 21); // beats full e alone (20)
});

test('respects slots, open trades and shared items', () => {
  const results = [
    craft('a', ['X', 'A2'], 10, 10),
    craft('b', ['X'], 10, 9),          // shares X with a
    craft('z', ['Z1'], 10, 50),        // clashes with the open trade
    craft('d', ['D1', 'D2', 'D3'], 10, 30),
  ];
  const openTrade = { id: 't', name: 'Out t', status: 'buying', coins: 0,
    inputs: [{ name: 'Z1', qty: 1, offerPrice: 10, bought: false }], sell: { name: 'Out t', qty: 1 } };
  const p = planSlots({ results, positions: [openTrade], capital: 1000, slots: 4, minGph: 0 });
  assert.strictEqual(p.freeSlots, 3);
  const ids = p.picks.map((x) => x.id);
  assert.ok(!ids.includes('z'));
  assert.ok(!(ids.includes('a') && ids.includes('b')));
  assert.ok(p.slotsPlanned <= 3);
  assert.deepStrictEqual(ids, ['d']); // d (3 slots, 30/h) beats a (2 slots, 10/h) + b-clash
});

test('never suggests low earners: floor is 50K gp/h or 5% of the best', () => {
  const big = (id, g) => craft(id, [`${id}1`], 10, g);
  const results = [big('a', 2_000_000), big('b', 90_000), big('c', 60_000), big('d', 629)];
  const p = planSlots({ results, capital: 1000, slots: 8 });
  // 5% of 2M = 100K, so only 'a' is worth it; 629 gp/h is never suggested
  assert.deepStrictEqual(p.picks.map((x) => x.id), ['a']);
  assert.strictEqual(p.minGph, 100_000);
  assert.match(p.note, /low earners/);
  const lonely = planSlots({ results: [big('d', 629)], capital: 1000, slots: 8 });
  assert.strictEqual(lonely.picks.length, 0);
  assert.match(lonely.note, /low earners/);
  const poor = planSlots({ results: [craft('e', ['E1'], 5000, 900_000, 1)], capital: 100, slots: 8 });
  assert.match(poor.note, /need more GP/);
});

test('an unaffordable craft does not raise the bar for the ones you can afford', () => {
  const results = [craft('rich', ['R1'], 2e9, 25_000_000, 1), craft('a', ['A1'], 50e6, 800_000), craft('b', ['B1'], 40e6, 600_000)];
  const p = planSlots({ results, capital: 100e6, slots: 8 });
  assert.deepStrictEqual(p.picks.map((x) => x.id).sort(), ['a', 'b']);
  assert.ok(p.minGph < 600_000, `floor ${p.minGph}`);
});

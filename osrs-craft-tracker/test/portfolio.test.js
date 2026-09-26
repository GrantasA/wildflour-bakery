'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planSlots } = require('../src/portfolio');

const craft = (id, inputs, cost, riskAdjusted, buyHours = 1, extra = {}) => ({
  id, name: `Out ${id}`, status: 'ok', viable: true, batch: 10, icon: null, warnings: [],
  ingredients: inputs.map((i) => ({ item: i, qty: 1 })),
  plan: { cost, profit: riskAdjusted * 1.2, badProfit: riskAdjusted * 0.5, riskAdjusted, pLoss: 0.1,
    inputs: inputs.map((i) => ({ name: i })), buySeconds: buyHours * 3600, activeSeconds: 60, hours: buyHours + 1 },
  ...extra,
});

test('fills slots with the best earners per slot-hour, within cash', () => {
  const results = [
    craft('a', ['A1', 'A2'], 40, 10),          // 5 per slot-hour
    craft('b', ['B1'], 30, 8),                 // 8 per slot-hour  (best)
    craft('c', ['C1', 'C2', 'C3'], 20, 9),     // 3 per slot-hour
    craft('d', ['D1'], 500, 50),               // too expensive, can't be scaled (no replan)
  ];
  const p = planSlots({ results, capital: 100, slots: 8 });
  assert.deepStrictEqual(p.picks.map((x) => x.id), ['b', 'a', 'c']);
  assert.strictEqual(p.slotsPlanned, 6);
  assert.ok(p.cashPlanned <= 100);
});

test('respects slot count, open trades and shared items; scales batches to fit cash', () => {
  const results = [
    craft('a', ['X', 'A2'], 40, 10),
    craft('b', ['X'], 30, 20),         // shares X with a: only one of them
    craft('e', ['E1'], 200, 30),       // too expensive -> replanned smaller
  ];
  const openTrade = { id: 't', name: 'Out z', status: 'buying', coins: 0,
    inputs: [{ name: 'Z1', qty: 1, offerPrice: 10, bought: false }, { name: 'Z2', qty: 1, offerPrice: 10, bought: false }],
    sell: { name: 'Out z', qty: 1 } };
  const replan = (id, batch) => ({ ...craft(id, ['E1'], 200 * batch / 10, 30 * batch / 10), batch });
  const p = planSlots({ results, positions: [openTrade], capital: 100, slots: 4, replan });
  assert.strictEqual(p.freeSlots, 2);
  assert.strictEqual(p.freeCash, 80);
  const ids = p.picks.map((x) => x.id);
  assert.ok(!(ids.includes('a') && ids.includes('b')), 'never two crafts sharing an item');
  const e = p.picks.find((x) => x.id === 'e');
  if (e) { assert.ok(e.scaled && e.cost <= 80); }
  assert.ok(p.slotsPlanned <= 2);
});

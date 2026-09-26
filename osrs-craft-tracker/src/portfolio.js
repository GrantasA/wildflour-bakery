'use strict';

const { costOf } = require('./positions');

// GE slot planner: fill your free GE slots and cash with the best mix of crafts.
//
// Each craft needs one slot per ingredient while buying (then one to sell), and
// ties up its buy cost. Slots and cash are the limits, so crafts are picked by
// risk-adjusted profit per slot-hour: how much each slot earns for the time it
// is busy. Two crafts that trade the same item are never picked together (they
// would compete for the same sellers and buy limit), and nothing is picked that
// clashes with your open trades. If a craft doesn't fit your remaining cash its
// batch is scaled down and re-planned.

const OPEN = new Set(['buying', 'ready', 'selling']);

function itemsOf(r) {
  return [r.name, ...(r.ingredients || []).map((i) => i.item)];
}

// What your open trades already use.
function inUse(positions) {
  let cash = 0, slots = 0;
  const items = new Set();
  const trades = [];
  for (const p of positions) {
    if (!OPEN.has(p.status)) continue;
    const s = p.status === 'buying' ? p.inputs.filter((i) => !i.bought).length : p.status === 'selling' ? 1 : 0;
    cash += costOf(p);
    slots += s;
    items.add(p.name);
    for (const i of p.inputs) items.add(i.name);
    trades.push({ id: p.id, name: p.name, slots: s, status: p.status });
  }
  return { cash, slots, items, trades };
}

// results: evaluated crafts (with .plan). replan(recipeId, batch) re-evaluates a
// craft at a smaller batch, or returns null.
function planSlots({ results, positions = [], capital, slots = 8, maxActiveMinutes = 15, replan }) {
  const used = inUse(positions);
  const freeCash = Math.max(0, capital - used.cash);
  const freeSlots = Math.max(0, slots - used.slots);
  const eligible = results.filter((r) => r.status === 'ok' && r.viable && r.plan.riskAdjusted > 0 &&
    r.plan.activeSeconds <= maxActiveMinutes * 60 &&
    !(r.warnings || []).some((w) => w.kind === 'spike' || w.kind === 'crash') &&
    !itemsOf(r).some((n) => used.items.has(n)));
  const perSlotHour = (r) => r.plan.riskAdjusted / (r.plan.inputs.length * Math.max(0.25, r.plan.buySeconds / 3600));
  eligible.sort((a, b) => perSlotHour(b) - perSlotHour(a));

  const picks = [];
  const taken = new Set();
  let cash = freeCash, left = freeSlots;
  for (const r0 of eligible) {
    if (left <= 0 || cash <= 0) break;
    const need = r0.plan.inputs.length;
    if (need > left) continue;
    if (itemsOf(r0).some((n) => taken.has(n))) continue;
    let r = r0;
    if (r.plan.cost > cash) {
      const batch = Math.floor((r.batch * cash) / r.plan.cost);
      if (batch < 1 || !replan) continue;
      r = replan(r.id, batch);
      if (!r || r.status !== 'ok' || r.plan.cost > cash || !(r.plan.riskAdjusted > 0)) continue;
    }
    picks.push({
      id: r.id, name: r.name, icon: r.icon, batch: r.batch, slots: need,
      cost: r.plan.cost, profit: r.plan.profit, badProfit: r.plan.badProfit, riskAdjusted: r.plan.riskAdjusted,
      pLoss: r.plan.pLoss, hours: r.plan.hours, scaled: r !== r0,
      perSlotHour: perSlotHour(r),
    });
    for (const n of itemsOf(r)) taken.add(n);
    cash -= r.plan.cost;
    left -= need;
  }
  return {
    slots, capital,
    usedByTrades: { slots: used.slots, cash: used.cash, trades: used.trades },
    freeSlots, freeCash,
    picks,
    slotsPlanned: picks.reduce((a, p) => a + p.slots, 0),
    cashPlanned: picks.reduce((a, p) => a + p.cost, 0),
    profit: picks.reduce((a, p) => a + p.profit, 0),
    badProfit: picks.reduce((a, p) => a + p.badProfit, 0),
  };
}

module.exports = { planSlots, inUse };

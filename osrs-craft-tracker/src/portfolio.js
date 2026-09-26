'use strict';

const { costOf } = require('./positions');

// GP / slot planner: what to run in your free GE slots with your free GP so the
// total gp/h is as high as possible.
//
// Crafts run side by side, so their gp/h add up. Each one needs a slot per
// ingredient while buying and ties up its buy cost. Two crafts that trade the
// same item are never combined (they'd compete for the same sellers and buy
// limit), and nothing clashing with your open trades is picked.
//
// GP management: every craft is also tried at smaller batch sizes. A smaller
// batch buys faster and frees GP for another craft, so sometimes two half-size
// crafts earn more per hour than one big one, and sometimes one big batch wins.
// A small search picks the combination with the best total gp/h.

const OPEN = new Set(['buying', 'ready', 'selling']);
const TOP_CANDIDATES = 12;
const MAX_STEPS = 200_000;

const gph = (r) => r.plan.riskAdjusted / Math.max(r.plan.hours, 1 / 60);

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

function eligible(results, busyItems, maxActiveMinutes) {
  return results.filter((r) => r.status === 'ok' && r.viable && r.plan.riskAdjusted > 0 &&
    r.plan.activeSeconds <= maxActiveMinutes * 60 &&
    !(r.warnings || []).some((w) => w.kind === 'spike' || w.kind === 'crash') &&
    !itemsOf(r).some((n) => busyItems.has(n)));
}

// results: evaluated crafts. replan(recipeId, batch) re-evaluates a craft at
// another batch size (or returns null).
function planSlots({ results, positions = [], capital, slots = 8, maxActiveMinutes = 15, replan }) {
  const used = inUse(positions);
  const freeCash = Math.max(0, capital - used.cash);
  const freeSlots = Math.max(0, slots - used.slots);
  const pool = eligible(results, used.items, maxActiveMinutes)
    .sort((a, b) => gph(b) - gph(a)).slice(0, TOP_CANDIDATES);

  // batch options per craft: full, half, quarter, and "whatever GP is free"
  const options = pool.map((r) => {
    const opts = [r];
    const want = new Set();
    for (const f of [0.5, 0.25]) want.add(Math.floor(r.batch * f));
    if (r.plan.cost > freeCash) want.add(Math.floor((r.batch * freeCash) / r.plan.cost));
    for (const b of want) {
      if (b < 1 || b >= r.batch || !replan) continue;
      const alt = replan(r.id, b);
      if (alt && alt.status === 'ok' && alt.plan.riskAdjusted > 0) opts.push(alt);
    }
    return opts.filter((o) => o.plan.cost <= freeCash).map((o) => ({
      r: o, gph: gph(o), cost: o.plan.cost, slots: o.plan.inputs.length, items: itemsOf(o),
    })).filter((o) => o.gph > 0);
  });

  // depth-first search with a simple upper bound
  const bestPerSlot = Math.max(0, ...options.flat().map((o) => o.gph / o.slots));
  let best = { gph: 0, picks: [] };
  let steps = 0;
  const chosen = [];
  const taken = new Set();
  const dfs = (i, cash, left, total) => {
    if (++steps > MAX_STEPS) return;
    if (total > best.gph) best = { gph: total, picks: [...chosen] };
    if (i >= options.length || left <= 0 || total + left * bestPerSlot <= best.gph) return;
    for (const o of options[i]) {
      if (o.cost > cash || o.slots > left || o.items.some((n) => taken.has(n))) continue;
      chosen.push(o);
      for (const n of o.items) taken.add(n);
      dfs(i + 1, cash - o.cost, left - o.slots, total + o.gph);
      for (const n of o.items) taken.delete(n);
      chosen.pop();
    }
    dfs(i + 1, cash, left, total); // skip this craft
  };
  dfs(0, freeCash, freeSlots, 0);

  const picks = best.picks.map(({ r, gph: g }) => ({
    id: r.id, name: r.name, icon: r.icon, batch: r.batch, slots: r.plan.inputs.length,
    cost: r.plan.cost, profit: r.plan.profit, badProfit: r.plan.badProfit, riskAdjusted: r.plan.riskAdjusted,
    pLoss: r.plan.pLoss, hours: r.plan.hours, activeSeconds: r.plan.activeSeconds, gph: g,
    scaled: r.batch < (pool.find((p) => p.id === r.id) || r).batch,
  }));
  return {
    slots, capital,
    usedByTrades: { slots: used.slots, cash: used.cash, trades: used.trades },
    freeSlots, freeCash,
    picks,
    gph: picks.reduce((a, p) => a + p.gph, 0),
    slotsPlanned: picks.reduce((a, p) => a + p.slots, 0),
    cashPlanned: picks.reduce((a, p) => a + p.cost, 0),
    profit: picks.reduce((a, p) => a + p.profit, 0),
    badProfit: picks.reduce((a, p) => a + p.badProfit, 0),
    searchSteps: steps,
  };
}

module.exports = { planSlots, inUse, eligible, gph, itemsOf };

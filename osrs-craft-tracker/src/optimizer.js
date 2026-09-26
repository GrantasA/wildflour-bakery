'use strict';

const { priceCurve, fillAt } = require('./market');
const { taxPerItem } = require('./tax');

const DEFAULTS = {
  share: 0.5,          // fraction of matching market flow your offer captures
  maxWaitHours: 24,    // ignore plans slower than this
  capital: 100_000_000,
  objective: 'profitPerHour', // or 'profit', or 'activeProfit'
};

// Hands-on time to place and collect one GE offer.
const OFFER_SECONDS = 15;

// How many crafts to plan per cycle: as many as every input's 4-hour buy limit
// allows, capped by the capital you're willing to tie up.
function batchSize(recipe, inputs, capital) {
  if (recipe.batch) return recipe.batch;
  let n = Infinity;
  for (const inp of inputs) {
    if (inp.item.limit) n = Math.min(n, Math.floor(inp.item.limit / inp.qty));
  }
  if (!Number.isFinite(n)) n = 1;
  const unitCost = inputs.reduce((a, i) => a + i.qty * (i.item.latest.high || i.item.latest.low || 0), 0)
    + (recipe.coins || 0);
  if (unitCost > 0) n = Math.min(n, Math.floor(capital / unitCost));
  return Math.max(1, n);
}

function evaluatePlan(recipe, inputs, output, n, buys, sell) {
  const outQty = recipe.output.qty * n;
  const cost = buys.reduce((a, b, i) => a + b.price * inputs[i].qty * n, 0) + (recipe.coins || 0) * n;
  const taxEach = taxPerItem(sell.price, output.name);
  const revenue = sell.price * outQty;
  const taxTotal = taxEach * outQty;
  const profit = revenue - taxTotal - cost;
  const buySeconds = Math.max(...buys.map((b) => b.median));
  const craftSeconds = (recipe.craftSeconds || 3) * n;
  const seconds = buySeconds + craftSeconds + sell.median;
  // Time you actually spend at the keyboard: placing/collecting offers and
  // crafting. GE waiting is passive, so it doesn't count here.
  const activeSeconds = craftSeconds + OFFER_SECONDS * (inputs.length + 1);
  return {
    inputs: inputs.map((inp, i) => ({
      name: inp.item.name, id: inp.item.id, icon: inp.item.icon, qty: inp.qty * n, price: buys[i].price,
      median: buys[i].median, p90: buys[i].p90,
      instaBuy: inp.item.latest.high, instaSell: inp.item.latest.low,
    })),
    sell: { name: output.name, id: output.id, icon: output.icon, qty: outQty, price: sell.price, tax: taxEach,
      median: sell.median, p90: sell.p90, instaBuy: output.latest.high, instaSell: output.latest.low },
    cost, revenue, taxTotal, profit,
    profitPerCraft: profit / n,
    buySeconds, seconds,
    hours: seconds / 3600,
    profitPerHour: profit / (seconds / 3600),
    craftSeconds, activeSeconds,
    profitPerActiveHour: profit / (activeSeconds / 3600),
    roi: cost > 0 ? profit / cost : 0,
  };
}

function score(plan, objective) {
  // Active time is fixed for a given batch, so maximising profit per active
  // hour means taking the most profit the max-wait allows: patient buys.
  return objective === 'profitPerHour' ? plan.profitPerHour : plan.profit;
}

function evaluateRecipe(recipe, getItem, settings = {}) {
  const opts = { ...DEFAULTS, ...settings };
  const base = {
    id: recipe.id, category: recipe.category, skills: recipe.skills, notes: recipe.notes,
    name: recipe.output.item, outputQty: recipe.output.qty,
    icon: getItem(recipe.output.item)?.icon || null,
    ingredients: recipe.inputs.map((i) => ({ item: i.item, qty: i.qty })), coins: recipe.coins || 0,
  };

  const missing = [];
  const inputs = recipe.inputs.map((i) => {
    const item = getItem(i.item);
    if (!item) missing.push(i.item);
    return { item, qty: i.qty };
  });
  const output = getItem(recipe.output.item);
  if (!output) missing.push(recipe.output.item);
  if (missing.length) return { ...base, status: 'missing', missing };

  const noPrice = [...inputs.map((i) => i.item), output].filter((it) => !it.latest || (!it.latest.high && !it.latest.low));
  if (noPrice.length) return { ...base, status: 'nodata', missing: noPrice.map((i) => i.name) };

  const n = batchSize(recipe, inputs, opts.capital);
  const buyCurves = inputs.map((inp) => priceCurve(inp.item, 'buy', inp.qty * n, opts));
  const sellCurve = priceCurve(output, 'sell', recipe.output.qty * n, opts);
  const empty = [...buyCurves.map((c, i) => [c, inputs[i].item.name]), [sellCurve, output.name]]
    .filter(([c]) => c.points.length === 0).map(([, name]) => name);
  if (empty.length) return { ...base, status: 'nodata', batch: n, missing: empty };

  // Instant plan: pay the current ask for inputs, dump output into the current bid.
  const instantBuys = inputs.map((inp) => ({
    price: inp.item.latest.high || inp.item.latest.low,
    ...fillAt(inp.item, 'buy', inp.qty * n, inp.item.latest.high || inp.item.latest.low, opts),
  }));
  const instaSellPrice = output.latest.low || output.latest.high;
  const instant = evaluatePlan(recipe, inputs, output, n,
    instantBuys, { price: instaSellPrice, ...fillAt(output, 'sell', recipe.output.qty * n, instaSellPrice, opts) });

  // Inputs are bought in parallel GE slots, so the buy phase lasts as long as the
  // slowest input. For every possible buy-phase time budget, take the cheapest
  // price per input that fills within it, then pair with every sell option.
  const budgets = [...new Set(buyCurves.flatMap((c) => c.points.map((p) => p.median)))].sort((a, b) => a - b);
  const maxSec = opts.maxWaitHours * 3600;
  let best = null, fastest = null;
  for (const budget of budgets) {
    const buys = [];
    for (const c of buyCurves) {
      let choice = null;
      for (const p of c.points) if (p.median <= budget) choice = p; // frontier: later = cheaper
      if (!choice) break;
      buys.push(choice);
    }
    if (buys.length !== buyCurves.length) continue;
    for (const s of sellCurve.points) {
      const plan = evaluatePlan(recipe, inputs, output, n, buys, s);
      if (!fastest || plan.seconds < fastest.seconds) fastest = plan;
      if (plan.seconds > maxSec) continue;
      if (!best || score(plan, opts.objective) > score(best, opts.objective)) best = plan;
    }
  }
  const withinWait = !!best;
  if (!best) best = fastest;

  const flags = [];
  if (!withinWait) flags.push(`slower than ${opts.maxWaitHours}h max wait`);
  const series = [...buyCurves.map((c) => c.series), sellCurve.series];
  if (series.includes('1h')) flags.push('thin market (hourly data)');
  const staleCutoff = Date.now() / 1000 - 6 * 3600;
  const stale = [...inputs.map((i) => i.item), output].filter((it) =>
    Math.max(it.latest.highTime || 0, it.latest.lowTime || 0) < staleCutoff);
  if (stale.length) flags.push(`no trades in 6h: ${stale.map((s) => s.name).join(', ')}`);

  return {
    ...base,
    status: 'ok',
    batch: n,
    viable: withinWait && best.profit > 0,
    plan: best,
    instant,
    flags,
    curves: {
      inputs: buyCurves.map((c, i) => ({ name: inputs[i].item.name, series: c.series, points: c.points })),
      output: { name: output.name, series: sellCurve.series, points: sellCurve.points },
    },
  };
}

module.exports = { evaluateRecipe, batchSize, DEFAULTS, OFFER_SECONDS };

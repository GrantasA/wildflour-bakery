'use strict';

const { priceCurve, fillAt, sellOptions, buyLimitSeconds } = require('./market');
const { priceMoveRisk, warnings } = require('./risk');
const { taxPerItem } = require('./tax');

const DEFAULTS = {
  share: 0.5,          // fraction of matching market flow your offer captures
  maxWaitHours: 24,    // ignore plans slower than this
  sellWithinHours: 2,  // list at a price that sells within this, even in the slow case
  riskAversion: 0.4,   // 0 = chase the average, 1 = weigh the bad case fully
  capital: 100_000_000,
  objective: 'profitPerHour', // or 'profit', or 'activeProfit'
};

// Buy windows the price AI is asked about when building an input's options.
const AI_BUY_WINDOWS = [1, 4, 12, 24, 48].map((h) => h * 3600);

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

// buys[i] / sell: offer options. Optional fields from the price AI:
//   buy.cost  expected cost per unit (includes buying at market if the offer doesn't fill)
//   sell.net  expected net per unit after tax (includes dumping if it doesn't sell)
//   sell.bad  bad-case net per unit (average of its worst 20% outcomes)
function evaluatePlan(recipe, inputs, output, n, buys, sell, opts = DEFAULTS) {
  const outQty = recipe.output.qty * n;
  const cost = buys.reduce((a, b, i) => a + (b.cost ?? b.price) * inputs[i].qty * n, 0) + (recipe.coins || 0) * n;
  const taxEach = taxPerItem(sell.price, output.name);
  const netEach = sell.net ?? sell.price - taxEach;
  const revenue = sell.price * outQty;
  const taxTotal = taxEach * outQty;
  const profit = netEach * outQty - cost;
  const buySeconds = Math.max(...buys.map((b) => b.median));
  const craftSeconds = (recipe.craftSeconds || 3) * n;
  const seconds = buySeconds + craftSeconds + sell.median;
  // Time you actually spend at the keyboard: placing/collecting offers and
  // crafting. GE waiting is passive, so it doesn't count here.
  const activeSeconds = craftSeconds + OFFER_SECONDS * (inputs.length + 1);

  // Risk: the product's price can move while you buy and craft.
  const move = priceMoveRisk(output, buySeconds + craftSeconds);
  const badEach = (sell.bad ?? netEach) * (move ? Math.exp(move.q10) : 1);
  const badProfit = badEach * outQty - cost;
  const breakEvenEach = cost / outQty;
  let pLoss;
  if (netEach <= 0 || breakEvenEach >= netEach) pLoss = profit < 0 ? 1 : 0.5;
  else pLoss = move ? move.probBelow(Math.log(breakEvenEach / netEach)) : (profit < 0 ? 1 : 0);
  const riskAdjusted = profit - opts.riskAversion * Math.max(0, profit - badProfit);

  return {
    inputs: inputs.map((inp, i) => ({
      name: inp.item.name, id: inp.item.id, icon: inp.item.icon, qty: inp.qty * n, price: buys[i].price,
      expectedCost: buys[i].cost ?? null, ai: !!buys[i].ai, pFill: buys[i].pFill ?? null,
      windowSec: buys[i].windowSec ?? null,
      median: buys[i].median, p90: buys[i].p90,
      instaBuy: inp.item.latest.high, instaSell: inp.item.latest.low,
    })),
    sell: { name: output.name, id: output.id, icon: output.icon, qty: outQty, price: sell.price, tax: taxEach,
      expectedNet: sell.net ?? null, ai: !!sell.ai, pFill: sell.pFill ?? null,
      median: sell.median, p90: sell.p90, instaBuy: output.latest.high, instaSell: output.latest.low },
    cost, revenue, taxTotal, profit,
    profitPerCraft: profit / n,
    buySeconds, seconds,
    hours: seconds / 3600,
    profitPerHour: profit / (seconds / 3600),
    craftSeconds, activeSeconds,
    profitPerActiveHour: profit / (activeSeconds / 3600),
    roi: cost > 0 ? profit / cost : 0,
    badProfit, pLoss, riskAdjusted,
    riskSource: move ? move.source : null,
  };
}

function score(plan, objective) {
  // Active time is fixed for a given batch, so maximising profit per active
  // hour means taking the most (risk-adjusted) profit the max-wait allows.
  return objective === 'profitPerHour' ? plan.riskAdjusted / plan.hours : plan.riskAdjusted;
}

// Buy options for one input from the price AI: ask what it would offer for
// several time windows, and keep the ones where waiting longer is cheaper.
// (No separate "pay the ask now" option: the AI's shortest window already
// covers quick buys, priced with its own view of how likely they are to fill.)
function aiBuyCurve(advisor, item, qty, maxSec, opts) {
  const windows = AI_BUY_WINDOWS.filter((w) => w <= Math.max(maxSec, AI_BUY_WINDOWS[0]));
  const limitSec = buyLimitSeconds(qty, item.limit);
  const pts = [];
  for (const w of windows) {
    const a = advisor(item, qty, w);
    if (!a) continue;
    // expected time: fills at its typical time, otherwise you buy at the end of the window
    const fillT = Number.isFinite(a.median) ? a.median : w;
    const t = Math.max(60, a.pFill * fillT + (1 - a.pFill) * w, limitSec);
    pts.push({ price: a.price, cost: a.expected, median: t, p90: Math.max(w, limitSec), pFill: a.pFill, ai: true, windowSec: w });
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a.median - b.median || a.cost - b.cost);
  const frontier = [];
  for (const p of pts) if (!frontier.length || p.cost < frontier[frontier.length - 1].cost) frontier.push(p);
  return { points: frontier, series: 'ai' };
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
  // Let the price AI pick buy prices where it can; otherwise use the fill-time model.
  const buyCurves = inputs.map((inp) => (opts.buyAdvisor
    ? aiBuyCurve(opts.buyAdvisor, inp.item, inp.qty * n, opts.maxWaitHours * 3600, opts) : null)
    || priceCurve(inp.item, 'buy', inp.qty * n, opts));
  const sellCurve = priceCurve(output, 'sell', recipe.output.qty * n, opts);
  // If the sell-price AI is available, let it pick the sell price; otherwise
  // list at or under the market within the sell window.
  const ai = opts.sellAdvisor ? opts.sellAdvisor(output, recipe.output.qty * n, opts.sellWithinHours * 3600) : null;
  let sellChoices;
  if (!ai) {
    sellChoices = sellOptions(output, recipe.output.qty * n, opts, undefined, undefined, sellCurve).points;
  } else {
    const w = opts.sellWithinHours * 3600;
    const t = Math.max(60, ai.pFill * (Number.isFinite(ai.median) ? ai.median : w) + (1 - ai.pFill) * w);
    sellChoices = [{ price: ai.price, net: ai.expected, bad: ai.bad, median: t, p90: w, pFill: ai.pFill, ai: true }];
  }
  const empty = [...buyCurves.map((c, i) => [c, inputs[i].item.name]), [sellCurve, output.name]]
    .filter(([c]) => c.points.length === 0).map(([, name]) => name);
  if (empty.length) return { ...base, status: 'nodata', batch: n, missing: empty };

  // Reference plan at the last traded prices (last price buyers paid for inputs,
  // last price sellers took for the output). Recent trades, not guaranteed fills,
  // so its times come from the same fill model as everything else.
  const instantBuys = inputs.map((inp) => ({
    price: inp.item.latest.high || inp.item.latest.low,
    ...fillAt(inp.item, 'buy', inp.qty * n, inp.item.latest.high || inp.item.latest.low, opts),
  }));
  const instaSellPrice = output.latest.low || output.latest.high;
  const instant = evaluatePlan(recipe, inputs, output, n,
    instantBuys, { price: instaSellPrice, ...fillAt(output, 'sell', recipe.output.qty * n, instaSellPrice, opts) }, opts);

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
    for (const s of sellChoices) {
      const plan = evaluatePlan(recipe, inputs, output, n, buys, s, opts);
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
  const warn = [output, ...inputs.map((i) => i.item)].flatMap((it) =>
    warnings(it).map((w) => ({ ...w, item: it.name })));
  for (const w of warn) flags.push(`${w.item}: ${w.text}`);
  const staleCutoff = Date.now() / 1000 - 6 * 3600;
  const stale = [...inputs.map((i) => i.item), output].filter((it) =>
    Math.max(it.latest.highTime || 0, it.latest.lowTime || 0) < staleCutoff);
  if (stale.length) flags.push(`no trades in 6h: ${stale.map((s) => s.name).join(', ')}`);

  return {
    ...base,
    status: 'ok',
    batch: n,
    viable: withinWait && best.profit > 0 && best.riskAdjusted > 0,
    warnings: warn,
    ai: ai ? { price: ai.price, pFill: ai.pFill, rule: ai.rule, neighbours: ai.neighbours } : null,
    aiBuys: buyCurves.some((c) => c.series === 'ai'),
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

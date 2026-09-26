'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { taxPerItem, TAX_CAP, TAX_RATE } = require('./tax');

// Your trades ("positions"), saved to a JSON file so they survive restarts.
//
// Lifecycle:  buying -> ready (all inputs bought, go craft) -> selling -> done
//             any open state -> cancelled
class PositionStore {
  constructor(file) {
    this.file = file;
    this.positions = [];
    try {
      this.positions = JSON.parse(fs.readFileSync(file, 'utf8')).positions || [];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ positions: this.positions }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.positions;
  }

  get(id) {
    return this.positions.find((p) => p.id === id) || null;
  }

  // plan: an optimizer plan for this recipe/batch. prices: optional per-input
  // prices the user typed. bought: the user already owns the inputs.
  create({ recipe, batch, plan, prices, bought, now = Date.now() }) {
    const pos = {
      id: crypto.randomUUID(),
      recipeId: recipe.id,
      name: recipe.output.item,
      batch,
      coins: (recipe.coins || 0) * batch,
      createdAt: now,
      status: bought ? 'ready' : 'buying',
      plannedBuySeconds: plan.buySeconds,
      plannedSellSeconds: plan.sell.median,
      inputs: plan.inputs.map((inp, i) => {
        const price = validPrice(prices && prices[i]) || inp.price;
        return {
          name: inp.name, qty: inp.qty, offerPrice: price, placedAt: now,
          // what we predicted (before any learned timing correction), to learn from later;
          // only when you use the suggested price
          predictedSec: !bought && !validPrice(prices && prices[i]) ? inp.median / (plan.timeFactor || 1) : null,
          // how long this offer was planned to take (the AI window it was priced for)
          windowSec: inp.windowSec || plan.buySeconds,
          bought: !!bought, boughtPrice: bought ? price : null,
        };
      }),
      sell: { name: plan.sell.name, qty: plan.sell.qty, offerPrice: null, placedAt: null, soldPrice: null, predictedSec: null },
    };
    this.positions.unshift(pos);
    this.save();
    return pos;
  }

  // predictedSec: how long we predicted this offer would take at this price
  // (null when you picked your own price), used to learn real fill times.
  act(id, { action, index, price, predictedSec = null, windowSec = null }, now = Date.now()) {
    const pos = this.get(id);
    if (!pos) throw httpError(404, 'No such trade');
    if (action === 'delete') {
      this.positions = this.positions.filter((p) => p !== pos);
      this.save();
      return null;
    }
    const open = ['buying', 'ready', 'selling'].includes(pos.status);
    const inp = Number.isInteger(index) ? pos.inputs[index] : null;
    const p = validPrice(price);
    switch (action) {
      case 'reprice-buy':
        if (pos.status !== 'buying' || !inp || inp.bought || !p) throw httpError(400, 'Cannot reprice');
        inp.offerPrice = p;
        inp.placedAt = now;
        inp.predictedSec = predictedSec;
        break;
      case 'bought':
        if (pos.status !== 'buying' || !inp) throw httpError(400, 'Cannot mark bought');
        inp.bought = true;
        inp.boughtPrice = p || inp.offerPrice;
        inp.boughtAt = now;
        if (pos.inputs.every((i) => i.bought)) pos.status = 'ready';
        break;
      case 'list':
        if (!['ready', 'selling'].includes(pos.status) || !p) throw httpError(400, 'Cannot list');
        pos.status = 'selling';
        pos.sell.offerPrice = p;
        pos.sell.placedAt = now;
        pos.sell.predictedSec = predictedSec;
        // the window this listing was priced for (advice uses it to judge progress)
        pos.sell.windowSec = windowSec;
        break;
      case 'sold': {
        if (pos.status !== 'selling' && pos.status !== 'ready') throw httpError(400, 'Nothing to sell');
        const sp = p || pos.sell.offerPrice;
        if (!sp) throw httpError(400, 'Sale price needed');
        pos.sell.soldPrice = sp;
        pos.sell.soldAt = now;
        pos.status = 'done';
        pos.closedAt = now;
        Object.assign(pos, settle(pos));
        break;
      }
      case 'cancel':
        if (!open) throw httpError(400, 'Trade already closed');
        pos.status = 'cancelled';
        pos.closedAt = now;
        break;
      default:
        throw httpError(400, 'Unknown action');
    }
    this.save();
    return pos;
  }
}

function costOf(pos) {
  return pos.inputs.reduce((a, i) => a + (i.bought ? i.boughtPrice : i.offerPrice) * i.qty, 0) + (pos.coins || 0);
}

function settle(pos) {
  const cost = costOf(pos);
  const tax = taxPerItem(pos.sell.soldPrice, pos.sell.name) * pos.sell.qty;
  const revenue = pos.sell.soldPrice * pos.sell.qty;
  return { cost, revenue, tax, profit: revenue - tax - cost };
}

// Lowest sale price per item that doesn't lose money once tax is paid.
function breakEvenPrice(cost, qty, itemName) {
  const each = cost / qty;
  // Above 250M the 2% tax hits its 5M cap, so break-even is just cost + 5M.
  let s = taxPerItem(1e9, itemName) === 0 ? Math.ceil(each)
    : each + TAX_CAP >= TAX_CAP / TAX_RATE ? Math.ceil(each + TAX_CAP)
    : Math.ceil(each / (1 - TAX_RATE));
  // floor() in the tax can leave us a gp or two off; nudge to the exact value.
  while (s - taxPerItem(s, itemName) < each) s++;
  while (s > 1 && s - 1 - taxPerItem(s - 1, itemName) >= each) s--;
  return s;
}

function stats(positions) {
  const done = positions.filter((p) => p.status === 'done').sort((a, b) => a.closedAt - b.closedAt);
  let cum = 0;
  const series = done.map((p) => ({ t: p.closedAt, profit: p.profit, cum: (cum += p.profit), name: p.name }));
  return {
    trades: done.length,
    wins: done.filter((p) => p.profit > 0).length,
    profit: cum,
    tax: done.reduce((a, p) => a + p.tax, 0),
    invested: done.reduce((a, p) => a + p.cost, 0),
    open: positions.filter((p) => ['buying', 'ready', 'selling'].includes(p.status)).length,
    series,
  };
}

// How much longer (or shorter) your real offers take than predicted.
// Each offer you place at a suggested price and later mark Bought / Sold is a
// sample: actual time / predicted time. The typical ratio (geometric mean,
// pulled towards 1 while there are only a few samples) becomes a factor that
// every time estimate is multiplied by.
const TIMING_PRIOR = 3;
function timingFactor(positions) {
  const ratios = [];
  const add = (placedAt, doneAt, predicted) => {
    if (!placedAt || !doneAt || !predicted || !Number.isFinite(predicted)) return;
    const actual = (doneAt - placedAt) / 1000;
    ratios.push(Math.max(actual, 60) / Math.max(predicted, 60));
  };
  for (const p of positions) {
    for (const i of p.inputs || []) if (i.bought) add(i.placedAt, i.boughtAt, i.predictedSec);
    if (p.sell && p.sell.soldAt) add(p.sell.placedAt, p.sell.soldAt, p.sell.predictedSec);
  }
  if (!ratios.length) return { factor: 1, samples: 0, raw: null };
  const logs = ratios.map(Math.log);
  const factor = Math.exp(logs.reduce((a, v) => a + v, 0) / (ratios.length + TIMING_PRIOR));
  const raw = Math.exp(logs.reduce((a, v) => a + v, 0) / ratios.length);
  return { factor: Math.min(20, Math.max(0.5, factor)), samples: ratios.length, raw };
}

function validPrice(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { PositionStore, costOf, settle, breakEvenPrice, stats, timingFactor };

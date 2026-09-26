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
          // how long this offer was planned to take (the AI window it was priced for)
          windowSec: inp.windowSec || plan.buySeconds,
          bought: !!bought, boughtPrice: bought ? price : null,
        };
      }),
      sell: { name: plan.sell.name, qty: plan.sell.qty, offerPrice: null, placedAt: null, soldPrice: null },
    };
    this.positions.unshift(pos);
    this.save();
    return pos;
  }

  act(id, { action, index, price }, now = Date.now()) {
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
        break;
      case 'bought':
        if (pos.status !== 'buying' || !inp) throw httpError(400, 'Cannot mark bought');
        inp.bought = true;
        inp.boughtPrice = p || inp.offerPrice;
        if (pos.inputs.every((i) => i.bought)) pos.status = 'ready';
        break;
      case 'list':
        if (!['ready', 'selling'].includes(pos.status) || !p) throw httpError(400, 'Cannot list');
        pos.status = 'selling';
        pos.sell.offerPrice = p;
        pos.sell.placedAt = now;
        break;
      case 'sold': {
        if (pos.status !== 'selling' && pos.status !== 'ready') throw httpError(400, 'Nothing to sell');
        const sp = p || pos.sell.offerPrice;
        if (!sp) throw httpError(400, 'Sale price needed');
        pos.sell.soldPrice = sp;
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

function validPrice(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { PositionStore, costOf, settle, breakEvenPrice, stats };

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { taxPerItem } = require('./tax');

// The AI's self-check journal.
//
// Every buy and sell price the AI suggests is written down together with what
// it predicted (the chance the offer fills within the window). Once that window
// has passed, the journal reads the real chart for that stretch of time and
// grades the suggestion: for a sell, did buyers pay at least that price; for a
// buy, did sellers let it go at or below that price; in both cases with enough
// volume for the quantity. It grades the simple rule (sell 1gp under the ask /
// buy 1gp over the bid) the same way, to measure the AI's real edge.
//
// The graded record calibrates the AI, per side: if it says "80%" but only 65%
// of those actually filled, future 80%s are corrected towards 65%.
//
// Stored as two append-only JSONL files so writes stay cheap:
//   ai-journal.jsonl  one line per suggestion
//   ai-grades.jsonl   one line per graded outcome

const DEDUPE_SECONDS = 30 * 60; // one entry per item + window per half hour
const MAX_ENTRIES = 50_000;
const BINS = 10;
const PRIOR = 20; // how many "virtual" samples trust the AI's own number per bin

class Journal {
  constructor(dir, suffix = '') {
    this.entriesFile = path.join(dir, `ai-journal${suffix}.jsonl`);
    this.gradesFile = path.join(dir, `ai-grades${suffix}.jsonl`);
    this.dir = dir;
    this.entries = [];
    this.byId = new Map();
    this.lastByKey = new Map();
    this.calCache = null;
    for (const e of readJsonl(this.entriesFile)) this.addEntry(e);
    for (const g of readJsonl(this.gradesFile)) {
      const e = this.byId.get(g.id);
      if (e) e.grade = g;
    }
    if (this.entries.length > MAX_ENTRIES) this.compact();
  }

  addEntry(e) {
    this.entries.push(e);
    this.byId.set(e.id, e);
    const key = `${e.side || 'sell'}:${e.item}:${e.windowSec}`;
    this.lastByKey.set(key, Math.max(this.lastByKey.get(key) || 0, e.ts));
  }

  // s: an AI suggestion; returns the entry, or null if deduplicated.
  record({ item, windowSec, qty, share, suggestion, nowSec = Math.floor(Date.now() / 1000) }) {
    const side = suggestion.side || 'sell';
    const key = `${side}:${item}:${windowSec}`;
    if (nowSec - (this.lastByKey.get(key) || 0) < DEDUPE_SECONDS) return null;
    const e = {
      id: crypto.randomUUID(),
      ts: nowSec,
      side,
      item,
      windowSec,
      qty,
      share,
      price: suggestion.price,
      pRaw: suggestion.pRaw,
      pFill: suggestion.pFill,
      rule: suggestion.rule.price,
      rulePRaw: suggestion.rule.pRaw,
    };
    this.addEntry(e);
    append(this.entriesFile, e, this.dir);
    return e;
  }

  // getBuckets(item, windowSec) -> normalized buckets ({ts, avgHigh, highVol, avgLow, lowVol})
  grade(getBuckets, nowSec = Math.floor(Date.now() / 1000)) {
    let graded = 0;
    for (const e of this.entries) {
      if (e.grade || e.ts + e.windowSec > nowSec - 300) continue; // wait for the last bucket to land
      const buckets = getBuckets(e.item, e.windowSec);
      if (!buckets || !buckets.length) continue;
      const step = buckets.length > 1 ? buckets[1].ts - buckets[0].ts : 300;
      if (buckets[0].ts > e.ts) { this.saveGrade(e, { id: e.id, status: 'nodata' }); continue; }
      const last = buckets[buckets.length - 1].ts;
      if (last + step < e.ts + e.windowSec) continue; // chart hasn't caught up yet
      const side = e.side || 'sell';
      const win = buckets.filter((b) => b.ts >= e.ts && b.ts < e.ts + e.windowSec);
      const ai = outcome(win, e.price, e.qty, e.share, step, side);
      const rule = outcome(win, e.rule, e.qty, e.share, step, side);
      // if the offer never filled you'd have to cross the spread at the end
      const endLow = [...win].reverse().find((b) => b.avgLow)?.avgLow || null;
      const endHigh = [...win].reverse().find((b) => b.avgHigh)?.avgHigh || null;
      const value = (p, hit) => {
        const s = hit ? p : side === 'sell' ? endLow : endHigh;
        if (!s) return null;
        return side === 'sell' ? s - taxPerItem(s, e.item) : s;
      };
      const aiV = value(e.price, ai.hit), ruleV = value(e.rule, rule.hit);
      this.saveGrade(e, {
        id: e.id, status: 'ok', gradedAt: nowSec,
        hit: ai.hit, fillSec: ai.fillSec, endLow, endHigh,
        ruleHit: rule.hit, aiValue: aiV, ruleValue: ruleV,
        // positive = the AI did better than the simple rule (more received / less paid)
        gain: aiV != null && ruleV != null ? (side === 'sell' ? aiV - ruleV : ruleV - aiV) / e.rule : null,
      });
      graded++;
    }
    if (graded) this.calCache = null;
    return graded;
  }

  saveGrade(e, g) {
    e.grade = g;
    append(this.gradesFile, g, this.dir);
  }

  graded(side) {
    return this.entries.filter((e) => e.grade && e.grade.status === 'ok' && (!side || (e.side || 'sell') === side));
  }

  // Monotone correction curve: predicted chance -> chance that actually came true.
  calibrator(side = 'sell') {
    this.calCache = this.calCache || {};
    if (this.calCache[side]) return this.calCache[side];
    const bins = Array.from({ length: BINS }, () => ({ n: 0, hits: 0, pred: 0 }));
    for (const e of this.graded(side)) {
      if (e.pRaw == null) continue;
      const b = bins[Math.min(BINS - 1, Math.floor(e.pRaw * BINS))];
      b.n++; b.hits += e.grade.hit ? 1 : 0; b.pred += e.pRaw;
    }
    // Bayesian smoothing towards "the AI was right", then force it to be
    // non-decreasing (a higher predicted chance never maps lower).
    const pts = bins.map((b, i) => {
      const mid = (i + 0.5) / BINS;
      return { x: mid, y: (b.hits + PRIOR * mid) / (b.n + PRIOR), n: b.n };
    });
    for (let i = 1; i < pts.length; i++) pts[i].y = Math.max(pts[i].y, pts[i - 1].y);
    const total = bins.reduce((a, b) => a + b.n, 0);
    const fn = (p) => {
      if (total === 0) return p;
      if (p <= pts[0].x) return pts[0].y * (p / pts[0].x);
      for (let i = 1; i < pts.length; i++) {
        if (p <= pts[i].x) {
          const t = (p - pts[i - 1].x) / (pts[i].x - pts[i - 1].x);
          return pts[i - 1].y + t * (pts[i].y - pts[i - 1].y);
        }
      }
      const lastPt = pts[pts.length - 1];
      return lastPt.y + (p - lastPt.x) * ((1 - lastPt.y) / (1 - lastPt.x));
    };
    fn.bins = bins.map((b, i) => ({ lo: i / BINS, hi: (i + 1) / BINS, n: b.n,
      predicted: b.n ? b.pred / b.n : null, actual: b.n ? b.hits / b.n : null }));
    fn.samples = total;
    this.calCache[side] = fn;
    return fn;
  }

  stats(side = 'sell') {
    const g = this.graded(side);
    const all = this.entries.filter((e) => (e.side || 'sell') === side);
    const pending = all.filter((e) => !e.grade).length;
    if (!g.length) return { side, recorded: all.length, graded: 0, pending };
    const withGain = g.filter((e) => e.grade.gain != null);
    return {
      side,
      recorded: all.length,
      graded: g.length,
      pending,
      predicted: g.reduce((a, e) => a + e.pFill, 0) / g.length,
      predictedRaw: g.reduce((a, e) => a + (e.pRaw ?? e.pFill), 0) / g.length,
      actual: g.filter((e) => e.grade.hit).length / g.length,
      ruleActual: g.filter((e) => e.grade.ruleHit).length / g.length,
      uplift: withGain.reduce((a, e) => a + e.grade.gain, 0) / Math.max(1, withGain.length),
      winRate: withGain.filter((e) => e.grade.gain >= 0).length / Math.max(1, withGain.length),
      calibration: this.calibrator(side).bins,
    };
  }

  compact() {
    this.entries = this.entries.slice(-MAX_ENTRIES);
    this.byId = new Map(this.entries.map((e) => [e.id, e]));
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.entriesFile, this.entries.map((e) => JSON.stringify(stripGrade(e))).join('\n') + '\n');
    fs.writeFileSync(this.gradesFile, this.entries.filter((e) => e.grade).map((e) => JSON.stringify(e.grade)).join('\n') + '\n');
  }
}

// Did an offer at `price` for `qty` fill inside these buckets?
// A sell fills from trades at or above the price, a buy from trades at or below.
function outcome(win, price, qty, share, step, side = 'sell') {
  const ok = side === 'sell' ? (p) => p != null && p >= price : (p) => p != null && p <= price;
  let cum = 0;
  for (let k = 0; k < win.length; k++) {
    const b = win[k];
    const v = share * ((ok(b.avgHigh) ? b.highVol : 0) + (ok(b.avgLow) ? b.lowVol : 0));
    if (cum + v >= qty) return { hit: true, fillSec: (k + (v > 0 ? (qty - cum) / v : 1)) * step };
    cum += v;
  }
  return { hit: false, fillSec: null };
}

function stripGrade(e) {
  const { grade, ...rest } = e;
  return rest;
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* skip a torn last line */ }
  }
  return out;
}

function append(file, obj, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(stripGrade(obj)) + '\n');
}

module.exports = { Journal, outcome };

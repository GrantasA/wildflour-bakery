'use strict';

const { normalizeSeries } = require('./market');

const API_BASE = 'https://prices.runescape.wiki/api/v1/osrs';
const STEP_SECONDS = { '5m': 300, '1h': 3600 };
// The fill-time model looks at recent history only...
const MAX_POINTS = 365;
// ...but we keep (and save to disk) much more for the AI to learn from.
const RETAIN_POINTS = { '5m': 7 * 288, '1h': 60 * 24 }; // 7 days of 5-minute, 60 days of hourly
const TICK_RETAIN_SECONDS = 7 * 86400;

// Client + in-memory store for the OSRS Wiki real-time prices API.
// https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices
// The Wiki asks every client to send a descriptive User-Agent.
//
// Besides the 5-minute and hourly buckets (which only carry average prices),
// the store polls /latest often and keeps every distinct trade price it sees
// ("ticks"). /latest reports the price and time of the most recent insta-buy
// and insta-sell trade for each item, so polling it every few seconds catches
// individual trade prices, including the peaks and dips that averages hide.
class PriceStore {
  constructor({ userAgent, fetchImpl = globalThis.fetch, baseUrl = API_BASE, persist = null } = {}) {
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.persist = persist;
    this.byId = new Map();
    this.byName = new Map();
    this.latest = new Map();
    this.raw = { '5m': new Map(), '1h': new Map() };     // id -> Map(ts -> record)
    this.lastBucket = { '5m': 0, '1h': 0 };
    this.backfilledAt = { '5m': new Map(), '1h': new Map() }; // id -> ms
    // id -> Map(5-minute bucket ts -> { h: Map(price -> count), l: Map(price -> count) })
    this.ticks = new Map();
    this.tickCount = 0;
    this.normCache = new Map();
    this.version = 0;
  }

  async get(path) {
    const res = await this.fetch(this.baseUrl + path, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  async loadMapping() {
    const items = await this.get('/mapping');
    this.byId.clear();
    this.byName.clear();
    for (const it of items) {
      this.byId.set(it.id, it);
      this.byName.set(it.name.toLowerCase(), it);
    }
    return items.length;
  }

  // Minute refresh: new latest prices, and a new data version (results get recomputed).
  async refreshLatest() {
    await this.pollTicks();
    this.version++;
  }

  // Fast poll: record any trade prices that changed since last time. Doesn't
  // bump the version, so it's cheap to run every few seconds.
  async pollTicks() {
    const { data } = await this.get('/latest');
    let seen = 0;
    for (const [idStr, v] of Object.entries(data)) {
      const id = Number(idStr);
      const prev = this.latest.get(id);
      this.latest.set(id, v);
      if (!this.raw['5m'].has(id)) continue; // only tracked items
      if (v.high && v.highTime && (!prev || v.highTime !== prev.highTime || v.high !== prev.high)) {
        this.addTick(id, v.highTime, 'h', v.high, true);
        seen++;
      }
      if (v.low && v.lowTime && (!prev || v.lowTime !== prev.lowTime || v.low !== prev.low)) {
        this.addTick(id, v.lowTime, 'l', v.low, true);
        seen++;
      }
    }
    if (seen) this.normCache.clear();
    return seen;
  }

  addTick(id, time, side, price, save = false) {
    const bucket = time - (time % 300);
    let byBucket = this.ticks.get(id);
    if (!byBucket) this.ticks.set(id, (byBucket = new Map()));
    let b = byBucket.get(bucket);
    if (!b) byBucket.set(bucket, (b = { h: new Map(), l: new Map() }));
    b[side].set(price, (b[side].get(price) || 0) + 1);
    this.tickCount++;
    if (save && this.persist) this.persist.tick(id, bucket, side, price);
  }

  // Bulk endpoint: the most recent complete bucket for every item in one call.
  async refreshBucket(step) {
    const { data, timestamp } = await this.get(`/${step}`);
    if (!timestamp || timestamp <= this.lastBucket[step]) return false;
    this.lastBucket[step] = timestamp;
    const saved = [];
    for (const [id, rec] of Object.entries(data)) {
      const store = this.raw[step].get(Number(id));
      if (store) {
        const r = { ...rec, timestamp };
        store.set(timestamp, r);
        saved.push([Number(id), r]);
      }
    }
    if (this.persist) this.persist.records(step, saved);
    this.prune(step);
    this.normCache.clear();
    this.version++;
    return true;
  }

  async backfill(id, step) {
    const { data } = await this.get(`/timeseries?timestep=${step}&id=${id}`);
    const store = this.raw[step].get(id) || new Map();
    const fresh = [];
    for (const rec of data || []) {
      if (!store.has(rec.timestamp)) fresh.push([id, rec]);
      store.set(rec.timestamp, rec);
    }
    this.raw[step].set(id, store);
    if (this.persist && fresh.length) this.persist.records(step, fresh);
    const newest = (data || []).reduce((a, r) => Math.max(a, r.timestamp), 0);
    if (newest > this.lastBucket[step]) this.lastBucket[step] = newest;
    this.backfilledAt[step].set(id, Date.now());
    this.prune(step);
    this.normCache.clear();
    this.version++;
  }

  // Load previously saved history (see history.js) before the first refresh.
  loadRecords(step, records) {
    for (const [id, rec] of records) {
      let store = this.raw[step].get(id);
      if (!store) this.raw[step].set(id, (store = new Map()));
      store.set(rec.timestamp, rec);
      if (rec.timestamp > this.lastBucket[step]) this.lastBucket[step] = rec.timestamp;
    }
    this.prune(step);
    this.normCache.clear();
  }

  prune(step) {
    const cutoff = this.lastBucket[step] - RETAIN_POINTS[step] * STEP_SECONDS[step];
    for (const store of this.raw[step].values()) {
      for (const ts of store.keys()) if (ts <= cutoff) store.delete(ts);
    }
    if (step === '5m') {
      const tickCutoff = this.lastBucket['5m'] - TICK_RETAIN_SECONDS;
      for (const byBucket of this.ticks.values()) {
        for (const ts of byBucket.keys()) if (ts <= tickCutoff) byBucket.delete(ts);
      }
    }
  }

  // Normalized buckets for `id`, newest `points` of them, with the distinct
  // trade prices seen in each bucket attached as hiTicks / loTicks
  // ([[price, count], ...], only when ticks were captured).
  buckets(id, step, points) {
    const key = `${step}:${id}:${points}`;
    if (this.normCache.has(key)) return this.normCache.get(key);
    const store = this.raw[step].get(id);
    let out = [];
    if (store && store.size) {
      // Pin the end of the grid to the newest known bucket so quiet items get
      // empty buckets up to "now" instead of ending at their last trade.
      const recs = [...store.values()];
      if (!store.has(this.lastBucket[step])) recs.push({ timestamp: this.lastBucket[step] });
      out = normalizeSeries(recs, STEP_SECONDS[step], points);
      const byBucket = this.ticks.get(id);
      if (byBucket && byBucket.size) attachTicks(out, byBucket, STEP_SECONDS[step]);
    }
    this.normCache.set(key, out);
    return out;
  }

  series(id, step) {
    return this.buckets(id, step, MAX_POINTS);
  }

  history(id, step) {
    return this.buckets(id, step, RETAIN_POINTS[step]);
  }

  resolve(name) {
    return this.byName.get(String(name).toLowerCase()) || null;
  }

  getItem(name) {
    const m = this.resolve(name);
    if (!m) return null;
    const self = this;
    return {
      id: m.id,
      name: m.name,
      limit: m.limit || null,
      icon: m.icon ? 'https://oldschool.runescape.wiki/images/' + encodeURIComponent(m.icon.replace(/ /g, '_')) : null,
      latest: this.latest.get(m.id) || {},
      series5m: this.series(m.id, '5m'),
      series1h: this.series(m.id, '1h'),
      // long history, computed only when something asks for it
      get history5m() { return self.history(m.id, '5m'); },
      get history1h() { return self.history(m.id, '1h'); },
    };
  }

  memoryStats() {
    const span = (step) => {
      let pts = 0;
      for (const s of this.raw[step].values()) pts = Math.max(pts, s.size);
      return (pts * STEP_SECONDS[step]) / 86400;
    };
    return { days5m: span('5m'), days1h: span('1h'), ticks: this.tickCount };
  }
}

function attachTicks(buckets, byBucket, step) {
  for (const b of buckets) {
    const hi = new Map(), lo = new Map();
    for (let t = b.ts; t < b.ts + step; t += 300) {
      const tk = byBucket.get(t);
      if (!tk) continue;
      for (const [p, c] of tk.h) hi.set(p, (hi.get(p) || 0) + c);
      for (const [p, c] of tk.l) lo.set(p, (lo.get(p) || 0) + c);
    }
    if (hi.size) b.hiTicks = [...hi].sort((a, c) => a[0] - c[0]);
    if (lo.size) b.loTicks = [...lo].sort((a, c) => a[0] - c[0]);
  }
}

module.exports = { PriceStore, API_BASE, STEP_SECONDS, RETAIN_POINTS };

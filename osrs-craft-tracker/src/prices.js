'use strict';

const { normalizeSeries } = require('./market');

const API_BASE = 'https://prices.runescape.wiki/api/v1/osrs';
const STEP_SECONDS = { '5m': 300, '1h': 3600 };
const MAX_POINTS = 365;

// Client + in-memory store for the OSRS Wiki real-time prices API.
// https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices
// The Wiki asks every client to send a descriptive User-Agent.
class PriceStore {
  constructor({ userAgent, fetchImpl = globalThis.fetch, baseUrl = API_BASE } = {}) {
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.byId = new Map();
    this.byName = new Map();
    this.latest = new Map();
    this.raw = { '5m': new Map(), '1h': new Map() };     // id -> Map(ts -> record)
    this.lastBucket = { '5m': 0, '1h': 0 };
    this.backfilledAt = { '5m': new Map(), '1h': new Map() }; // id -> ms
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

  async refreshLatest() {
    const { data } = await this.get('/latest');
    for (const [id, v] of Object.entries(data)) this.latest.set(Number(id), v);
    this.version++;
  }

  // Bulk endpoint: the most recent complete bucket for every item in one call.
  async refreshBucket(step) {
    const { data, timestamp } = await this.get(`/${step}`);
    if (!timestamp || timestamp <= this.lastBucket[step]) return false;
    this.lastBucket[step] = timestamp;
    for (const [id, rec] of Object.entries(data)) {
      const store = this.raw[step].get(Number(id));
      if (store) store.set(timestamp, { ...rec, timestamp });
    }
    this.prune(step);
    this.normCache.clear();
    this.version++;
    return true;
  }

  async backfill(id, step) {
    const { data } = await this.get(`/timeseries?timestep=${step}&id=${id}`);
    const store = this.raw[step].get(id) || new Map();
    for (const rec of data || []) store.set(rec.timestamp, rec);
    this.raw[step].set(id, store);
    const newest = (data || []).reduce((a, r) => Math.max(a, r.timestamp), 0);
    if (newest > this.lastBucket[step]) this.lastBucket[step] = newest;
    this.backfilledAt[step].set(id, Date.now());
    this.prune(step);
    this.normCache.clear();
    this.version++;
  }

  prune(step) {
    const cutoff = this.lastBucket[step] - MAX_POINTS * STEP_SECONDS[step];
    for (const store of this.raw[step].values()) {
      for (const ts of store.keys()) if (ts <= cutoff) store.delete(ts);
    }
  }

  series(id, step) {
    const key = `${step}:${id}`;
    if (this.normCache.has(key)) return this.normCache.get(key);
    const store = this.raw[step].get(id);
    let out = [];
    if (store && store.size) {
      // Pin the end of the grid to the newest known bucket so quiet items get
      // empty buckets up to "now" instead of ending at their last trade.
      const recs = [...store.values()];
      if (!store.has(this.lastBucket[step])) recs.push({ timestamp: this.lastBucket[step] });
      out = normalizeSeries(recs, STEP_SECONDS[step], MAX_POINTS);
    }
    this.normCache.set(key, out);
    return out;
  }

  resolve(name) {
    return this.byName.get(String(name).toLowerCase()) || null;
  }

  getItem(name) {
    const m = this.resolve(name);
    if (!m) return null;
    return {
      id: m.id,
      name: m.name,
      limit: m.limit || null,
      latest: this.latest.get(m.id) || {},
      series5m: this.series(m.id, '5m'),
      series1h: this.series(m.id, '1h'),
    };
  }
}

module.exports = { PriceStore, API_BASE, STEP_SECONDS };

'use strict';

// Offline stand-in for the Wiki price API (run with --mock). Generates random
// but plausible prices and volumes for every item the recipes mention, so the
// dashboard and optimizer can be exercised without network access.
// Numbers are fake: never trade off them.

function hash(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function rng(seed) {
  let s = seed || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0) / 4294967296;
}

function createMockFetch(getRecipes) {
  const items = new Map(); // name -> { id, name, base, limit, liquidity }
  const itemFor = (name) => {
    if (!items.has(name)) {
      const r = rng(hash(name));
      const base = Math.round(10 ** (1 + r() * 7));
      items.set(name, {
        id: 100000 + items.size, name, base,
        limit: base > 1e6 ? 8 : base > 1e4 ? 100 : 10000,
        liquidity: base > 1e6 ? 0.05 + r() * 0.5 : 2 + r() * 200,
      });
    }
    return items.get(name);
  };
  const ensure = () => {
    for (const rec of getRecipes()) {
      rec.inputs.forEach((i) => itemFor(i.item));
      const out = itemFor(rec.output.item);
      // Make outputs roughly worth their inputs so some crafts are profitable.
      const cost = rec.inputs.reduce((a, i) => a + itemFor(i.item).base * i.qty, 0);
      out.base = Math.max(1, Math.round((cost * (0.97 + (hash(rec.id) % 100) / 1000)) / rec.output.qty));
    }
  };

  const bucket = (it, ts, step) => {
    const r = rng(hash(it.name) ^ ts);
    const drift = 1 + 0.02 * Math.sin(ts / 40000 + it.id);
    const mid = it.base * drift;
    const spread = 0.01 + r() * 0.03;
    const lambda = it.liquidity * (step / 300);
    const vol = () => (r() < Math.min(1, lambda) || lambda > 1 ? Math.round(lambda * (0.3 + r() * 1.4)) : 0);
    const hv = vol(), lv = vol();
    return {
      timestamp: ts,
      avgHighPrice: hv ? Math.round(mid * (1 + spread * r())) : null,
      highPriceVolume: hv,
      avgLowPrice: lv ? Math.round(mid * (1 - spread * r())) : null,
      lowPriceVolume: lv,
    };
  };

  const json = (body) => ({ ok: true, status: 200, json: async () => body });

  return async (url) => {
    ensure();
    const u = new URL(url);
    const p = u.pathname.replace(/^.*\/osrs/, '');
    const nowSec = Math.floor(Date.now() / 1000);
    if (p === '/mapping') {
      return json([...items.values()].map((i) => ({ id: i.id, name: i.name, limit: i.limit, members: true })));
    }
    if (p === '/latest') {
      const data = {};
      for (const it of items.values()) {
        const b = bucket(it, nowSec - (nowSec % 60), 300);
        data[it.id] = {
          high: b.avgHighPrice || Math.round(it.base * 1.02), highTime: nowSec - 30,
          low: b.avgLowPrice || Math.round(it.base * 0.98), lowTime: nowSec - 45,
        };
      }
      return json({ data });
    }
    if (p === '/5m' || p === '/1h') {
      const step = p === '/5m' ? 300 : 3600;
      const ts = nowSec - (nowSec % step) - step;
      const data = {};
      for (const it of items.values()) data[it.id] = bucket(it, ts, step);
      return json({ data, timestamp: ts });
    }
    if (p === '/timeseries') {
      const step = u.searchParams.get('timestep') === '1h' ? 3600 : 300;
      const id = Number(u.searchParams.get('id'));
      const it = [...items.values()].find((i) => i.id === id);
      if (!it) return json({ data: [] });
      const end = nowSec - (nowSec % step) - step;
      const data = [];
      for (let k = 364; k >= 0; k--) data.push(bucket(it, end - k * step, step));
      return json({ data, itemId: id });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

module.exports = { createMockFetch };

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PriceStore } = require('./prices');
const { evaluateRecipe, DEFAULTS } = require('./optimizer');

const PORT = Number(process.env.PORT) || 3000;
const REFRESH_MS = 60_000;                // prices + viability every minute
const HOURLY_BUCKET_MS = 10 * 60_000;
const BACKFILL_MAX_AGE_MS = 6 * 3600_000; // re-pull full history every 6h
const MAPPING_MAX_AGE_MS = 24 * 3600_000;
const RECIPES_FILE = process.env.RECIPES_FILE || path.join(__dirname, 'recipes.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1';
const USER_AGENT = process.env.OSRS_USER_AGENT ||
  'osrs-craft-profit-tracker/1.0 (personal GE crafting profit tool; set OSRS_USER_AGENT to add your contact)';

const fetchImpl = MOCK ? require('./mock').createMockFetch(() => loadRecipes().recipes) : globalThis.fetch;
const store = new PriceStore({ userAgent: USER_AGENT, fetchImpl });

const state = {
  startedAt: Date.now(),
  lastRefresh: null,
  nextRefresh: null,
  mappingAt: 0,
  lastHourly: 0,
  errors: [],
  backfill: { done: 0, total: 0 },
};

let recipesCache = { mtime: 0, recipes: [] };
function loadRecipes() {
  const mtime = fs.statSync(RECIPES_FILE).mtimeMs;
  if (mtime !== recipesCache.mtime) {
    const { recipes } = JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf8'));
    recipesCache = { mtime, recipes };
  }
  return recipesCache;
}

function logError(where, err) {
  const msg = `${new Date().toISOString()} ${where}: ${err.message || err}`;
  console.error(msg);
  state.errors.unshift(msg);
  state.errors.length = Math.min(state.errors.length, 20);
}

function trackedIds() {
  const ids = new Set();
  for (const r of loadRecipes().recipes) {
    for (const name of [...r.inputs.map((i) => i.item), r.output.item]) {
      const m = store.resolve(name);
      if (m) ids.add(m.id);
    }
  }
  return [...ids];
}

// Pull full timeseries history for any tracked item that's new or stale.
// Runs a couple of requests at a time so we stay polite to the Wiki API.
let backfilling = false;
async function backfillPending() {
  if (backfilling) return;
  backfilling = true;
  try {
    const now = Date.now();
    const jobs = [];
    for (const id of trackedIds()) {
      for (const step of ['5m', '1h']) {
        const at = store.backfilledAt[step].get(id);
        if (!at || now - at > BACKFILL_MAX_AGE_MS) jobs.push([id, step]);
      }
    }
    const total = trackedIds().length * 2;
    state.backfill.total = total;
    state.backfill.done = total - jobs.length;
    const worker = async () => {
      while (jobs.length) {
        const [id, step] = jobs.shift();
        try { await store.backfill(id, step); } catch (e) { logError(`backfill ${id} ${step}`, e); }
        state.backfill.done++;
        await new Promise((r) => setTimeout(r, MOCK ? 0 : 250));
      }
    };
    await Promise.all([worker(), worker()]);
  } finally {
    backfilling = false;
  }
}

async function refresh() {
  const now = Date.now();
  try {
    if (now - state.mappingAt > MAPPING_MAX_AGE_MS) {
      await store.loadMapping();
      state.mappingAt = now;
    }
    await store.refreshLatest();
    await store.refreshBucket('5m');
    if (now - state.lastHourly > HOURLY_BUCKET_MS) {
      await store.refreshBucket('1h');
      state.lastHourly = now;
    }
    state.lastRefresh = Date.now();
  } catch (e) {
    logError('refresh', e);
  }
  state.nextRefresh = Date.now() + REFRESH_MS;
  resultsCache.clear();
  backfillPending().catch((e) => logError('backfill', e));
}

const resultsCache = new Map();
function parseSettings(q) {
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v != null ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    share: num(q.get('share'), DEFAULTS.share, 0.01, 1),
    maxWaitHours: num(q.get('maxWait'), DEFAULTS.maxWaitHours, 0.05, 24 * 14),
    capital: num(q.get('capital'), DEFAULTS.capital, 1000, 1e11),
    objective: ['profit', 'activeProfit'].includes(q.get('objective')) ? q.get('objective') : 'profitPerHour',
  };
}

function computeResults(settings) {
  const key = JSON.stringify(settings) + ':' + store.version + ':' + recipesCache.mtime;
  if (resultsCache.has(key)) return resultsCache.get(key);
  const results = loadRecipes().recipes.map((r) => {
    try {
      return evaluateRecipe(r, (n) => store.getItem(n), settings);
    } catch (e) {
      logError(`recipe ${r.id}`, e);
      return { id: r.id, name: r.output.item, category: r.category, status: 'error', missing: [e.message] };
    }
  });
  resultsCache.set(key, results);
  return results;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') {
    const settings = parseSettings(url.searchParams);
    const body = {
      mock: MOCK,
      now: Date.now(),
      lastRefresh: state.lastRefresh,
      nextRefresh: state.nextRefresh,
      backfill: state.backfill,
      errors: state.errors.slice(0, 5),
      settings,
      results: state.lastRefresh ? computeResults(settings) : [],
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log(`OSRS craft tracker on http://localhost:${PORT}${MOCK ? ' (MOCK DATA)' : ''}`);
  refresh();
  setInterval(refresh, REFRESH_MS);
});

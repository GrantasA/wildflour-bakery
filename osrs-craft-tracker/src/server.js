'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PriceStore } = require('./prices');
const { evaluateRecipe, DEFAULTS } = require('./optimizer');
const { PositionStore, stats } = require('./positions');
const { rankCrafts, advise } = require('./copilot');
const { SellAI } = require('./ai');

const PORT = Number(process.env.PORT) || 3000;
// The page can create and edit your trades, so only listen on this machine.
const HOST = process.env.HOST || '127.0.0.1';
const POSITIONS_FILE = process.env.POSITIONS_FILE ||
  path.join(__dirname, '..', 'data', process.argv.includes('--mock') ? 'positions-mock.json' : 'positions.json');
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
const positions = new PositionStore(POSITIONS_FILE);
const sellAI = new SellAI();

// ---- sell-price AI plumbing ----
// Windows are snapped to a few sizes so the AI's training sets can be reused.
const AI_WINDOWS = [0.5, 1, 2, 4, 6, 12, 24, 48].map((h) => h * 3600);
const snapWindow = (sec) => AI_WINDOWS.find((w) => w >= sec) || AI_WINDOWS[AI_WINDOWS.length - 1];
const aiWindowsInUse = new Set([2 * 3600]);
const backtests = new Map(); // windowSec -> result

let aiItemsCache = { version: -1, items: [] };
function aiItems() {
  if (aiItemsCache.version !== store.version) {
    const items = trackedIds().map((id) => store.getItem(store.byId.get(id).name)).filter(Boolean);
    aiItemsCache = { version: store.version, items };
  }
  return aiItemsCache.items;
}

function sellAdvisorFor(settings) {
  if (!settings.useAI) return null;
  return (item, qty, windowSec) => {
    const w = snapWindow(windowSec);
    aiWindowsInUse.add(w);
    const bt = backtests.get(w);
    // Safety switch: if the AI lost to plain undercutting in its latest
    // backtest, don't use it for this window.
    if (bt && bt.upliftVsUndercut < 0) return null;
    try {
      return sellAI.suggest(aiItems(), store.version, item, qty, w, settings.share);
    } catch (e) {
      logError('ai', e);
      return null;
    }
  };
}

let backtesting = false;
function runBacktests() {
  if (backtesting || !state.lastRefresh) return;
  backtesting = true;
  const windows = [...aiWindowsInUse];
  const next = () => {
    const w = windows.shift();
    if (w == null) { backtesting = false; resultsCache.clear(); return; }
    try {
      const res = sellAI.runBacktest(aiItems(), store.version, w, DEFAULTS.share);
      if (res) backtests.set(w, res);
    } catch (e) {
      logError('ai backtest', e);
    }
    setImmediate(next);
  };
  setImmediate(next);
}
setInterval(runBacktests, 10 * 60_000);

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
  backfillPending().then(() => {
    if (!backtests.size) runBacktests();
  }).catch((e) => logError('backfill', e));
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
    maxActive: num(q.get('maxActive'), 15, 0.5, 24 * 60),
    sellWithinHours: num(q.get('sellWithin'), DEFAULTS.sellWithinHours, 0.05, 24 * 7),
    useAI: q.get('ai') !== '0',
  };
}

function computeResults(settings) {
  const key = JSON.stringify(settings) + ':' + store.version + ':' + recipesCache.mtime;
  if (resultsCache.has(key)) return resultsCache.get(key);
  const advisor = sellAdvisorFor(settings);
  const results = loadRecipes().recipes.map((r) => {
    try {
      return evaluateRecipe(r, (n) => store.getItem(n), { ...settings, sellAdvisor: advisor });
    } catch (e) {
      logError(`recipe ${r.id}`, e);
      return { id: r.id, name: r.output.item, category: r.category, status: 'error', missing: [e.message] };
    }
  });
  const ranked = rankCrafts(results, settings.maxActive);
  const out = { results, best: ranked.slice(0, 5).map((r) => r.id) };
  resultsCache.set(key, out);
  return out;
}

function aiStatus(settings) {
  const w = snapWindow(settings.sellWithinHours * 3600);
  const bt = backtests.get(w) || null;
  return {
    on: settings.useAI,
    windowSec: w,
    backtest: bt,
    active: settings.useAI && !(bt && bt.upliftVsUndercut < 0),
  };
}

function recipeById(id) {
  return loadRecipes().recipes.find((r) => r.id === id) || null;
}

function positionsView(settings) {
  const getItem = (n) => store.getItem(n);
  return positions.list().map((p) => {
    if (!['buying', 'ready', 'selling'].includes(p.status) || !state.lastRefresh) return p;
    try {
      return { ...p, advice: advise(p, recipeById(p.recipeId), getItem, { ...settings, sellAdvisor: sellAdvisorFor(settings) }) };
    } catch (e) {
      logError(`advice ${p.id}`, e);
      return { ...p, advice: { kind: 'info', text: 'Could not compute advice: ' + e.message } };
    }
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 100_000) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); }
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handlePositions(req, res, url) {
  const settings = parseSettings(url.searchParams);
  const m = url.pathname.match(/^\/api\/positions(?:\/([\w-]+))?$/);
  if (!m || req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
  const body = await readJson(req);
  if (!m[1]) {
    const recipe = recipeById(body.recipeId);
    if (!recipe) return sendJson(res, 400, { error: 'Unknown craft' });
    const batch = Math.max(1, Math.min(1_000_000, Math.round(Number(body.batch)) || 0)) || undefined;
    const r = evaluateRecipe(batch ? { ...recipe, batch } : recipe, (n) => store.getItem(n), settings);
    if (r.status !== 'ok') return sendJson(res, 400, { error: 'No price data for this craft yet' });
    const pos = positions.create({ recipe, batch: r.batch, plan: r.plan, prices: body.prices, bought: !!body.bought });
    return sendJson(res, 200, pos);
  }
  const pos = positions.act(m[1], body);
  return sendJson(res, 200, pos || { deleted: true });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/positions')) {
    handlePositions(req, res, url).catch((e) => {
      if (!e.status) logError('positions', e);
      sendJson(res, e.status || 500, { error: e.message });
    });
    return;
  }
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
      ...(state.lastRefresh ? computeResults(settings) : { results: [], best: [] }),
      positions: positionsView(settings),
      ai: aiStatus(settings),
      stats: stats(positions.list()),
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

server.listen(PORT, HOST, () => {
  console.log(`OSRS craft tracker on http://localhost:${PORT}${MOCK ? ' (MOCK DATA)' : ''}`);
  refresh();
  setInterval(refresh, REFRESH_MS);
});

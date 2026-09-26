'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  rows: $('rows'), picks: $('picks'), positions: $('positions'), history: $('history'), chart: $('chart'),
  live: $('live'), liveText: $('liveText'), mock: $('mock'), hidden: $('hidden'), tooltip: $('tooltip'),
  settings: $('settings'), settingsBtn: $('settingsBtn'),
  aiBar: $('aiBar'), useAI: $('useAI'), risk: $('risk'),
  objective: $('objective'), sellWithin: $('sellWithin'), maxWait: $('maxWait'), maxActive: $('maxActive'), capital: $('capital'), share: $('share'),
  search: $('search'), category: $('category'), viableOnly: $('viableOnly'),
  dialog: $('startDialog'), form: $('startForm'), startRecipe: $('startRecipe'), startBatch: $('startBatch'),
  startBought: $('startBought'), startInputs: $('startInputs'), startInfo: $('startInfo'), startError: $('startError'),
  startTitle: $('startTitle'), startSubmit: $('startSubmit'),
};

let data = null;
let sortKey = 'score';
let sortAsc = false;
const expanded = new Set();
const drafts = {}; // text typed into trade price boxes, kept across refreshes

// ---------- formatting ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function gp(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 1 : 2) + 'M';
  if (a >= 1e4) return s + (a / 1e3).toFixed(1) + 'K';
  return s + Math.round(a).toLocaleString();
}
const gpSigned = (n) => (n > 0 ? '+' : '') + gp(n);
const gpExact = (n) => (n == null ? '–' : Math.round(n).toLocaleString());
function dur(sec) {
  if (!Number.isFinite(sec)) return '∞';
  const m = Math.round(sec / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '–');
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const icon = (url, big) => (url ? `<img class="icon${big ? ' lg' : ''}" src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : '');
function parseGp(s) {
  const m = String(s).trim().toLowerCase().replace(/[, ]/g, '').match(/^([\d.]+)([kmb]?)$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
}
function when(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- settings ----------
const SETTINGS = ['objective', 'risk', 'sellWithin', 'maxWait', 'maxActive', 'capital', 'share'];
function query() {
  const p = new URLSearchParams({
    objective: els.objective.value, maxWait: els.maxWait.value, sellWithin: els.sellWithin.value, risk: els.risk.value,
    maxActive: els.maxActive.value, share: els.share.value, ai: els.useAI.checked ? '1' : '0',
  });
  const cap = parseGp(els.capital.value);
  if (cap) p.set('capital', cap);
  return p.toString();
}
function saveSettings() {
  try {
    const s = { sortKey, sortAsc };
    for (const k of SETTINGS) s[k] = els[k].value;
    s.useAI = els.useAI.checked;
    localStorage.setItem('craft-copilot-settings', JSON.stringify(s));
  } catch (e) { /* storage unavailable */ }
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('craft-copilot-settings') || 'null');
    if (!s) return;
    for (const k of SETTINGS) if (s[k] != null && s[k] !== '') els[k].value = s[k];
    if (s.useAI != null) els.useAI.checked = s.useAI;
    if (s.sortKey) { sortKey = s.sortKey; sortAsc = !!s.sortAsc; }
  } catch (e) { /* storage unavailable */ }
}

// ---------- data ----------
let inflight = null;
async function load() {
  const q = query();
  inflight = q;
  try {
    const res = await fetch('/api/state?' + q);
    const body = await res.json();
    if (inflight !== q) return;
    data = body;
    render();
  } catch (e) {
    els.live.className = 'pill live err';
    els.liveText.textContent = 'Tracker server not reachable';
  }
}

async function post(path, body) {
  const res = await fetch(path + '?' + query(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

const resultsById = () => new Map((data?.results || []).map((r) => [r.id, r]));
const maxActiveSec = () => (parseFloat(els.maxActive.value) || 15) * 60;
// Crafts that need more of your own time than the limit are left out everywhere.
const tooMuchWork = (r) => r.status === 'ok' && r.plan.activeSeconds > maxActiveSec();

// ---------- render ----------
function render() {
  renderStatus();
  renderKpis();
  renderAI();
  renderPicks();
  renderPositions();
  renderTable();
  renderHistory();
}

function renderStatus() {
  if (!data) return;
  els.mock.hidden = !data.mock;
  const parts = [];
  if (data.lastRefresh) {
    parts.push(`Live · updated ${Math.round((Date.now() - data.lastRefresh) / 1000)}s ago`);
    els.live.className = 'pill live ok';
  } else {
    parts.push('Fetching prices…');
    els.live.className = 'pill live';
  }
  const b = data.backfill;
  if (b.total && b.done < b.total) parts.push(`history ${Math.round((100 * b.done) / b.total)}%`);
  if (data.errors.length) { els.live.className = 'pill live err'; els.live.title = data.errors[0]; }
  els.liveText.textContent = parts.join(' · ');
}

function renderKpis() {
  const s = data.stats;
  $('kpiProfit').textContent = gpSigned(s.profit);
  $('kpiProfit').className = 'kpi-value ' + cls(s.profit);
  $('kpiProfitSub').textContent = s.invested ? `${pct(s.profit / s.invested)} return on ${gp(s.invested)}` : 'Log trades to track profit';
  $('kpiTrades').textContent = s.trades;
  $('kpiTradesSub').textContent = s.trades ? `${s.wins} profitable (${Math.round((100 * s.wins) / s.trades)}%)` : '';
  $('kpiOpen').textContent = s.open;
  const act = (data.positions || []).filter(needsAction).length;
  $('kpiOpenSub').textContent = act ? `${act} need${act > 1 ? '' : 's'} your attention` : s.open ? 'All on track' : '';
  $('kpiTax').textContent = gp(s.tax);
  $('kpiTaxSub').textContent = s.trades ? `avg ${gp(s.tax / s.trades)} per trade` : '';
  document.title = act ? `(${act}) Action needed · Craft Copilot` : 'Craft Copilot';
}

function renderAI() {
  const a = data.ai;
  if (!a || !data.lastRefresh) { els.aiBar.hidden = true; return; }
  els.aiBar.hidden = false;
  els.aiBar.className = 'ai-bar' + (a.on && a.sell.active && a.buy.active ? '' : ' paused');
  const side = (name, x, rule) => {
    const bt = x.backtest, j = x.journal;
    let status;
    if (!a.on) status = `off (using ${rule})`;
    else if (!bt) status = 'testing itself on recent history…';
    else if (!x.active) status = `paused: lost to ${rule} in its latest test, so the app uses that instead`;
    else status = 'active';
    const facts = [];
    if (bt) {
      const up = bt.uplift * 100;
      facts.push(`Backtest (${bt.tests} moments, ${dur(bt.windowSec)} window): <b class="${cls(up)}">${up >= 0 ? '+' : ''}${up.toFixed(2)}%</b> vs ${rule}, won <b>${Math.round(bt.winRate * 100)}%</b>, ` +
        `said it'd fill <b>${Math.round(bt.predictedFill * 100)}%</b> → filled <b>${Math.round(bt.actualFill * 100)}%</b> · uses ${bt.k} similar charts`);
    }
    if (j && j.graded) {
      const up = j.uplift * 100;
      facts.push(`Live self-check: <b>${j.graded}</b> of its own suggestions graded on the real chart: said <b>${Math.round(j.predicted * 100)}%</b> → filled <b>${Math.round(j.actual * 100)}%</b>, ` +
        `<b class="${cls(up)}">${up >= 0 ? '+' : ''}${up.toFixed(2)}%</b> vs ${rule}`);
    } else if (j) {
      facts.push(`Live self-check: ${j.recorded} suggestions recorded, first grades once their window has passed`);
    }
    return `<div class="ai-side"><div><b>${name}</b> <span class="muted">${esc(status)}</span></div>${facts.map((f) => `<div class="ai-fact">${f}</div>`).join('')}</div>`;
  };
  const cal = (a.sell.journal && a.sell.journal.calibration) || [];
  const calRows = cal.filter((b) => b.n).map((b) => `<tr><td>${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%</td>
    <td class="num">${b.n}</td><td class="num">${Math.round(b.actual * 100)}%</td></tr>`).join('');
  els.aiBar.innerHTML = `<div class="ai-title">🤖 Price AI <span class="muted small">risk: ${esc(a.risk)}</span></div>
    <div class="ai-sides">${side('Sell prices', a.sell, 'undercutting by 1gp')}${side('Buy prices', a.buy, 'bidding 1gp over the best bid')}</div>
    ${calRows ? `<details class="small"><summary>How well its sell predictions came true</summary>
      <table class="cal"><thead><tr><th>It said</th><th class="num">Times</th><th class="num">Actually filled</th></tr></thead><tbody>${calRows}</tbody></table>
      <p class="muted">The AI uses this record to correct its future predictions.</p></details>` : ''}`;
}

// Small chart of what buyers paid recently, with the AI's price and break-even.
function sparkHtml(ai, breakEven) {
  const pts = (ai.spark || []).filter((p) => p[1]);
  if (pts.length < 4) return '';
  const W = 520, H = 90, m = { l: 4, r: 64, t: 8, b: 14 };
  const vals = [...pts.map((p) => p[1]), ai.price, ...(breakEven ? [breakEven] : [])];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) hi = lo + 1;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const x = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const hrs = Math.round((t1 - t0) / 3600);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price buyers paid over the last ${hrs} hours, with the AI's suggested price">
    <path class="s-line" d="${d}"/>
    ${breakEven ? `<line class="s-be" x1="${m.l}" x2="${W - m.r}" y1="${y(breakEven)}" y2="${y(breakEven)}"/><text x="${W - m.r + 4}" y="${y(breakEven) + 3}">break-even</text>` : ''}
    <line class="s-ai" x1="${m.l}" x2="${W - m.r}" y1="${y(ai.price)}" y2="${y(ai.price)}"/>
    <text class="s-ai-label" x="${W - m.r + 4}" y="${y(ai.price) + 3}">AI ${esc(gp(ai.price))}</text>
    <text x="${m.l}" y="${H - 2}">${hrs}h ago</text><text x="${W - m.r}" y="${H - 2}" text-anchor="end">now</text>
  </svg>`;
}

function renderPicks() {
  if (!data.lastRefresh) return;
  const byId = resultsById();
  const picks = data.best.map((id) => byId.get(id)).filter(Boolean);
  if (!picks.length) {
    els.picks.innerHTML = '<p class="empty">No craft is profitable within your limits right now. Try a longer max GE wait or more hands-on time in Settings.</p>';
    return;
  }
  const [top, ...rest] = picks;
  const p = top.plan;
  els.picks.innerHTML = `
    <div class="pick-top">
      <div class="pick-title">
        ${icon(top.icon, true)}
        <div><div class="rank">Best pick</div><h3>${esc(top.name)}${top.outputQty > 1 ? ` ×${top.outputQty}` : ''}</h3>
          <div class="muted small">${esc(top.category)} · ${esc(top.skills || '')}</div></div>
        <div class="score" title="All-round score out of 100">${top.score}<small>score</small></div>
      </div>
      <div class="chips">${top.reasons.map((r) => `<span class="chip">✓ ${esc(r)}</span>`).join('')}
        ${top.flags.map((f) => `<span class="chip warn">${esc(f)}</span>`).join('')}</div>
      <div class="stats">
        <div class="stat"><b class="pos">${gp(p.profit)}</b><span>profit (batch of ${top.batch})</span></div>
        <div class="stat"><b>${dur(p.seconds)}</b><span>GE wait (median)</span></div>
        <div class="stat"><b>${dur(p.activeSeconds)}</b><span>your time</span></div>
        <div class="stat"><b>${pct(p.roi)}</b><span>return</span></div>
        <div class="stat"><b class="${cls(p.badProfit)}">${gp(p.badProfit)}</b><span>bad case (worst 10%)</span></div>
        <div class="stat"><b>${Math.round(p.pLoss * 100)}%</b><span>chance of a loss</span></div>
      </div>
      <table class="orders"><tbody>
        ${p.inputs.map((i) => `<tr><td>BUY</td><td><span class="item">${icon(i.icon)}${esc(i.name)} ×${i.qty.toLocaleString()}</span></td>
          <td class="num"><b>${gpExact(i.price)}</b> ea${i.ai ? `<span class="tag-ai" title="${Math.round(i.pFill * 100)}% chance it fills in time">AI</span>` : ''}</td><td class="num muted">~${dur(i.median)}</td></tr>`).join('')}
        <tr><td>SELL</td><td><span class="item">${icon(p.sell.icon)}${esc(p.sell.name)} ×${p.sell.qty.toLocaleString()}</span></td>
          <td class="num"><b>${gpExact(p.sell.price)}</b> ea${top.ai ? `<span class="tag-ai" title="${Math.round(top.ai.pFill * 100)}% chance to sell in time, from ${top.ai.neighbours} similar charts">AI</span>` : ''}</td><td class="num muted">~${dur(p.sell.median)}</td></tr>
      </tbody></table>
      <div class="pick-actions"><button class="btn primary" data-start="${esc(top.id)}">Start this craft</button></div>
    </div>
    ${rest.length ? `<div class="runners">${rest.map((r, i) => `
      <div class="runner">
        <span class="muted small">#${i + 2}</span>${icon(r.icon)}
        <span class="name">${esc(r.name)}</span>
        <span class="meta"><b class="pos">${gp(r.plan.profit)}</b> · ${dur(r.plan.seconds)} wait<br>score ${r.score}</span>
        <button class="btn small" data-start="${esc(r.id)}">Start</button>
      </div>`).join('')}</div>` : ''}`;
}

// ---------- positions ----------
const STEPS = ['Buy', 'Craft', 'Sell', 'Done'];
const STEP_OF = { buying: 0, ready: 1, selling: 2, done: 3 };
const ADVICE_ICON = { keep: '✓', list: '→', adjust: '!', raise: '↑', lower: '↓', cancel: '✕', info: 'i' };

function needsAction(p) {
  const a = p.advice;
  return a && ['cancel', 'adjust', 'raise', 'lower'].includes(a.kind);
}

function draft(key, fallback) {
  return drafts[key] != null ? drafts[key] : fallback != null ? String(fallback) : '';
}

function renderPositions() {
  // Don't yank the box out from under someone who's typing.
  if (els.positions.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const open = (data.positions || []).filter((p) => STEP_OF[p.status] != null && p.status !== 'done');
  if (!open.length) {
    els.positions.innerHTML = '<p class="empty">No open trades. Start one from a Copilot pick, or log a trade you\'ve already made.</p>';
    return;
  }
  const byId = resultsById();
  els.positions.innerHTML = `<div class="positions">${open.map((p) => positionHtml(p, byId.get(p.recipeId))).join('')}</div>`;
}

function positionHtml(p, r) {
  const a = p.advice || {};
  const step = STEP_OF[p.status];
  const steps = STEPS.map((s, i) => `<span class="step ${i < step ? 'done' : i === step ? 'now' : ''}">${s}</span>`).join('');
  let body = '';
  if (p.status === 'buying') {
    body = `<div class="lines">${p.inputs.map((inp, i) => {
      const adv = (a.inputs || [])[i] || {};
      const key = `${p.id}:b${i}`;
      if (inp.bought) {
        return `<div class="line"><span class="what">${esc(inp.name)} ×${inp.qty.toLocaleString()}</span>
          <span class="ctrl muted small">bought @ ${gpExact(inp.boughtPrice)}</span></div>`;
      }
      const apply = adv.price ? `<button class="btn small" data-act="reprice-buy" data-pos="${p.id}" data-index="${i}" data-price="${adv.price}">Set to ${gpExact(adv.price)}</button>` : '';
      return `<div class="line">
        <span class="what">${esc(inp.name)} ×${inp.qty.toLocaleString()} · your offer <b>${gpExact(inp.offerPrice)}</b></span>
        <span class="ctrl">${apply}
          <input data-draft="${key}" inputmode="numeric" value="${esc(draft(key, inp.offerPrice))}" aria-label="Price paid">
          <button class="btn small" data-act="bought" data-pos="${p.id}" data-index="${i}" data-from="${key}">Bought</button></span>
        <span class="hint ${adv.kind || ''}">${esc(adv.text || '')}</span></div>`;
    }).join('')}</div>`;
  } else if (p.status === 'ready') {
    const key = `${p.id}:list`;
    body = `<div class="lines"><div class="line">
      <span class="what">Sell ${esc(p.sell.name)} ×${p.sell.qty.toLocaleString()}${a.breakEven ? ` · break-even <b>${gpExact(a.breakEven)}</b>` : ''}</span>
      <span class="ctrl"><input data-draft="${key}" inputmode="numeric" value="${esc(draft(key, a.price))}" aria-label="Sell price">
        <button class="btn small primary" data-act="list" data-pos="${p.id}" data-from="${key}">Listed</button>
        <button class="btn small" data-act="sold" data-pos="${p.id}" data-from="${key}">Sold</button></span>
      ${a.ai ? `<span class="hint" style="grid-column:1/-1">${sparkHtml(a.ai, a.breakEven)}Similar charts peaked around ${gp(a.ai.peaks.q25)} to ${gp(a.ai.peaks.q75)} (typical ${gp(a.ai.peaks.q50)}) within the window.</span>` : ''}
      ${a.quick ? `<span class="hint">Quick sale: ${gpExact(a.quick.price)} sells in ~${dur(a.quick.median)} (${gpSigned(a.quick.profit)})</span>` : ''}
    </div></div>`;
  } else if (p.status === 'selling') {
    const key = `${p.id}:sold`;
    const apply = a.price ? `<button class="btn small" data-act="list" data-pos="${p.id}" data-price="${a.price}">Relist at ${gpExact(a.price)}</button>` : '';
    body = `<div class="lines"><div class="line">
      <span class="what">Listed ${esc(p.sell.name)} ×${p.sell.qty.toLocaleString()} at <b>${gpExact(p.sell.offerPrice)}</b>${a.breakEven ? ` · break-even ${gpExact(a.breakEven)}` : ''}</span>
      <span class="ctrl">${apply}<input data-draft="${key}" inputmode="numeric" value="${esc(draft(key, p.sell.offerPrice))}" aria-label="Sold price">
        <button class="btn small primary" data-act="sold" data-pos="${p.id}" data-from="${key}">Sold</button></span>
      ${a.ai ? `<span class="hint" style="grid-column:1/-1">${sparkHtml(a.ai, a.breakEven)}</span>` : ''}
    </div></div>`;
  }
  const projected = a.projectedProfit;
  return `<div class="position ${needsAction(p) ? 'attention' : ''}">
    <div class="pos-head">${icon(r?.icon, true)}<h3>${esc(p.name)} <span class="muted">×${p.batch}</span></h3><span class="spacer"></span>
      ${projected != null ? `<span class="small">projected <b class="${cls(projected)}">${gpSigned(projected)}</b></span>` : ''}</div>
    <div class="steps">${steps}</div>
    ${a.text ? `<div class="advice ${a.kind}"><span class="ico">${ADVICE_ICON[a.kind] || '•'}</span><span>${esc(a.text)}</span></div>` : ''}
    ${body}
    <div class="pos-foot"><span>Started ${when(p.createdAt)}${a.checkInSeconds ? ` · check back in ~${dur(a.checkInSeconds)}` : ''}</span>
      <span class="btns"><button class="btn small ghost" data-act="cancel" data-pos="${p.id}">Cancel trade</button></span></div>
  </div>`;
}

// ---------- crafts table ----------
function sortValue(r) {
  if (r.status !== 'ok') return -Infinity;
  const p = r.plan;
  switch (sortKey) {
    case 'name': return r.name.toLowerCase();
    case 'score': return r.score ?? -1;
    case 'cost': return p.cost;
    case 'sell': return p.sell.price;
    case 'pLoss': return -p.pLoss;
    default: return p[sortKey];
  }
}

function renderTable() {
  const cats = [...new Set(data.results.map((r) => r.category))].sort();
  if (els.category.options.length - 1 !== cats.length) {
    const cur = els.category.value;
    els.category.innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
    els.category.value = cur;
  }
  if (!data.lastRefresh) {
    els.rows.innerHTML = '<tr><td colspan="12" class="empty">Waiting for the first price pull…</td></tr>';
    return;
  }
  const untradeable = data.results.filter((r) => r.status === 'missing');
  const busy = data.results.filter(tooMuchWork);
  const notes = [];
  if (busy.length) notes.push(`Hidden ${busy.length} craft(s) needing more than ${els.maxActive.value} min of your time: ${busy.map((r) => r.name).join(', ')}.`);
  if (untradeable.length) notes.push(`Hidden ${untradeable.length} craft(s) with items not on the GE: ${untradeable.map((r) => `${r.name} (${r.missing.join(', ')})`).join('; ')}.`);
  els.hidden.textContent = notes.join(' ');

  const term = els.search.value.trim().toLowerCase();
  const rows = data.results.filter((r) => {
    if (r.status === 'missing' || tooMuchWork(r)) return false;
    if (els.category.value && r.category !== els.category.value) return false;
    if (els.viableOnly.checked && !r.viable) return false;
    if (term && !(r.name.toLowerCase().includes(term) || (r.ingredients || []).some((i) => i.item.toLowerCase().includes(term)))) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (!!a.viable !== !!b.viable) return a.viable ? -1 : 1;
    const va = sortValue(a), vb = sortValue(b);
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return sortAsc ? c : -c;
  });
  document.querySelectorAll('#table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.classList.toggle('asc', th.dataset.sort === sortKey && sortAsc);
  });
  els.rows.innerHTML = rows.map(rowHtml).join('') || '<tr><td colspan="12" class="empty">No crafts match.</td></tr>';
}

function rowHtml(r) {
  const open = expanded.has(r.id);
  const title = `<span class="item">${icon(r.icon)}<span>${esc(r.name)}${r.outputQty > 1 ? ` ×${r.outputQty}` : ''}<br><span class="cat">${esc(r.category)}</span></span></span>`;
  if (r.status !== 'ok') {
    return `<tr class="row dim"><td>${title}</td><td colspan="11" class="muted">${esc(r.status === 'nodata' ? 'Loading price history: ' : 'Error: ')}${esc((r.missing || []).join(', '))}</td></tr>`;
  }
  const p = r.plan;
  const flags = r.flags.length ? `<div class="flagline">${r.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join('')}</div>` : '';
  const score = r.score != null ? `<span class="scorebar"><i style="width:${r.score}%"></i></span>${r.score}` : '<span class="muted">–</span>';
  return `<tr class="row ${r.viable ? '' : 'dim'}" data-id="${esc(r.id)}">
    <td>${title}${flags}</td>
    <td class="num">${score}</td>
    <td class="num">${gp(p.cost)}${r.aiBuys ? '<span class="tag-ai">AI</span>' : ''}</td>
    <td class="num">${gp(p.sell.price)}${r.ai ? '<span class="tag-ai">AI</span>' : ''}</td>
    <td class="num ${cls(p.profit)}"><b>${gp(p.profit)}</b></td>
    <td class="num ${cls(p.roi)}">${pct(p.roi)}</td>
    <td class="num">${dur(p.seconds)}</td>
    <td class="num">${dur(p.activeSeconds)}</td>
    <td class="num ${cls(p.profitPerActiveHour)}">${gp(p.profitPerActiveHour)}</td>
    <td class="num ${cls(p.badProfit)}">${gp(p.badProfit)}</td>
    <td class="num">${Math.round(p.pLoss * 100)}%</td>
    <td class="num"><button class="btn small" data-start="${esc(r.id)}">Start</button></td>
  </tr>${open ? detailHtml(r) : ''}`;
}

function ladderHtml(title, curve, side, chosen, qty) {
  let pts = curve.points.slice(0, 12);
  if (!pts.some((pt) => pt.price === chosen)) {
    const pick = curve.points.find((pt) => pt.price === chosen);
    if (pick) pts = [...pts.slice(0, 11), pick];
  }
  return `<div class="scroll"><h4>${esc(title)} <span class="muted">(${side} ${qty.toLocaleString()}, ${esc(curve.series)} data)</span></h4>
    <table class="ladder"><thead><tr><th class="num">Offer price</th><th class="num">Median fill</th><th class="num">Slow case</th></tr></thead><tbody>
    ${pts.map((pt) => `<tr><td class="num ${pt.price === chosen ? 'best' : ''}">${gpExact(pt.price)}</td><td class="num">${dur(pt.median)}</td><td class="num">${dur(pt.p90)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function detailHtml(r) {
  const p = r.plan, s = p.sell, i = r.instant;
  return `<tr class="detail"><td colspan="12"><div class="detail">
    <p class="muted">${esc(r.skills || '')}${r.notes ? ' · ' + esc(r.notes) : ''}${r.coins ? ` · ${gpExact(r.coins)} gp fee per craft` : ''}</p>
    <p>Batch of ${r.batch}: cost ${gpExact(p.cost)} · revenue ${gpExact(p.revenue)} · tax ${gpExact(p.taxTotal)} ·
      <b class="${cls(p.profit)}">profit ${gpExact(p.profit)}</b> · buy ~${dur(p.buySeconds)}, craft ${dur(p.craftSeconds)}, sell ~${dur(s.median)}</p>
    <p class="muted">At the last traded prices (buy at the last price buyers paid, sell at the last price sellers took; these are recent trades, not guaranteed instant fills): ${gpSigned(i.profit)}, likely ~${dur(i.seconds)}</p>
    <div class="detail-grid">
      ${ladderHtml('Sell ' + r.curves.output.name, r.curves.output, 'sell', s.price, s.qty)}
      ${r.curves.inputs.map((c, k) => ladderHtml(c.name, c, 'buy', p.inputs[k].price, p.inputs[k].qty)).join('')}
    </div>
  </div></td></tr>`;
}

// ---------- history + chart ----------
function renderHistory() {
  const closed = (data.positions || []).filter((p) => p.status === 'done' || p.status === 'cancelled')
    .sort((a, b) => b.closedAt - a.closedAt);
  els.history.innerHTML = closed.map((p) => `<tr>
      <td>${when(p.closedAt)}</td><td>${esc(p.name)}${p.status === 'cancelled' ? ' <span class="flag">cancelled</span>' : ''}</td>
      <td class="num">${p.batch}</td><td class="num">${p.cost != null ? gp(p.cost) : '–'}</td>
      <td class="num">${p.sell.soldPrice ? gpExact(p.sell.soldPrice) : '–'}</td><td class="num">${p.tax != null ? gp(p.tax) : '–'}</td>
      <td class="num ${cls(p.profit)}"><b>${p.profit != null ? gpSigned(p.profit) : '–'}</b></td>
      <td class="num"><button class="btn small ghost danger" data-act="delete" data-pos="${p.id}" title="Delete from history">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">Completed trades show up here.</td></tr>';
  renderChart(data.stats.series);
}

function renderChart(series) {
  const el = els.chart;
  if (!series.length) {
    el.innerHTML = '<p class="empty">Your cumulative profit chart appears after your first completed trade.</p>';
    el.style.height = 'auto';
    return;
  }
  el.style.height = '';
  const pts = [{ i: 0, cum: 0 }, ...series.map((s, k) => ({ ...s, i: k + 1 }))];
  const W = el.clientWidth || 600, H = el.clientHeight || 240;
  const m = { l: 56, r: 12, t: 10, b: 24 };
  const ys = pts.map((p) => p.cum);
  let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  if (lo === hi) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  lo -= lo < 0 ? pad : 0; hi += pad;
  const x = (i) => m.l + (i / Math.max(1, pts.length - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const ticks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * k) / 4);
  const path = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.cum).toFixed(1)}`).join('');
  const area = `${path}L${x(pts[pts.length - 1].i).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const xTicks = [...new Set([0, Math.round((pts.length - 1) / 2), pts.length - 1])];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit after each trade">
    <g class="axis">${ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>
      <text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${gp(t)}</text>`).join('')}
      ${xTicks.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${i === 0 ? 'start' : `trade ${i}`}</text>`).join('')}</g>
    <line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>
    <path class="area" d="${area}"/>
    <path class="line" d="${path}"/>
    <line class="cross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <circle class="hover-dot" r="5" visibility="hidden"/>
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/>
  </svg>`;
  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.cross'), dot = svg.querySelector('.hover-dot');
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const idx = Math.max(0, Math.min(pts.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (pts.length - 1))));
    const pt = pts[idx];
    cross.setAttribute('x1', x(pt.i)); cross.setAttribute('x2', x(pt.i)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(pt.i)); dot.setAttribute('cy', y(pt.cum)); dot.setAttribute('visibility', 'visible');
    els.tooltip.hidden = false;
    els.tooltip.innerHTML = idx === 0 ? 'Start: 0 gp'
      : `<b>${esc(pt.name)}</b><br>${when(pt.t)}<br>Trade: <span class="${cls(pt.profit)}">${gpSigned(pt.profit)}</span><br>Total: <b>${gpSigned(pt.cum)}</b>`;
    els.tooltip.style.left = Math.min(window.innerWidth - 270, ev.clientX + 14) + 'px';
    els.tooltip.style.top = ev.clientY + 14 + 'px';
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); els.tooltip.hidden = true;
  });
}

// ---------- start / log dialog ----------
function openStart(recipeId) {
  const ok = data.results.filter((r) => r.status === 'ok' && !tooMuchWork(r)).sort((a, b) => a.name.localeCompare(b.name));
  if (!ok.length) return;
  els.startRecipe.innerHTML = ok.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.outputQty > 1 ? ` ×${r.outputQty}` : ''} (${esc(r.category)})</option>`).join('');
  els.startRecipe.value = recipeId && ok.some((r) => r.id === recipeId) ? recipeId : ok[0].id;
  els.startTitle.textContent = recipeId ? 'Start this craft' : 'Log a trade';
  els.startBought.checked = false;
  els.startError.hidden = true;
  fillStart(true);
  els.dialog.showModal();
}

function fillStart(resetBatch) {
  const r = resultsById().get(els.startRecipe.value);
  if (!r) return;
  if (resetBatch) els.startBatch.value = r.batch;
  const n = parseInt(els.startBatch.value, 10) || r.batch;
  const bought = els.startBought.checked;
  els.startInputs.innerHTML = r.plan.inputs.map((i, k) => `<label>${icon(i.icon)}<span style="flex:1">${esc(i.name)} ×${Math.round((i.qty / r.batch) * n).toLocaleString()}</span>
    <input data-k="${k}" inputmode="numeric" value="${i.price}" aria-label="${bought ? 'Price paid' : 'Offer price'} for ${esc(i.name)}"></label>`).join('');
  els.startInfo.textContent = bought
    ? 'Enter what you actually paid each. You\'ll get a sell price suggestion next.'
    : `Suggested offer prices are filled in. Place these buy offers on the GE, then mark each one bought as it fills. Expected profit for ${r.batch}: ${gpSigned(r.plan.profit)}.`;
  els.startSubmit.textContent = bought ? 'Get sell price' : 'Start tracking';
}

els.startRecipe.addEventListener('change', () => fillStart(true));
els.startBatch.addEventListener('input', () => fillStart(false));
els.startBought.addEventListener('change', () => fillStart(false));
$('logBtn').addEventListener('click', () => data && openStart());
$('startCancel').addEventListener('click', () => els.dialog.close());
els.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const prices = [...els.startInputs.querySelectorAll('input')].map((i) => parseGp(i.value));
  try {
    await post('/api/positions', {
      recipeId: els.startRecipe.value, batch: parseInt(els.startBatch.value, 10),
      bought: els.startBought.checked, prices,
    });
    els.dialog.close();
    await load();
    els.positions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    els.startError.textContent = e.message;
    els.startError.hidden = false;
  }
});

// ---------- events ----------
document.addEventListener('click', async (ev) => {
  const start = ev.target.closest('[data-start]');
  if (start) { ev.stopPropagation(); openStart(start.dataset.start); return; }
  const act = ev.target.closest('[data-act]');
  if (act) {
    const { act: action, pos, index, from } = act.dataset;
    let price = act.dataset.price ? Number(act.dataset.price) : undefined;
    if (from) price = parseGp(drafts[from] ?? document.querySelector(`[data-draft="${from}"]`)?.value) || undefined;
    if (action === 'cancel' && !confirm('Cancel this trade? It moves to history with no profit recorded.')) return;
    if (action === 'delete' && !confirm('Delete this trade from your history?')) return;
    try {
      await post(`/api/positions/${pos}`, { action, index: index != null ? Number(index) : undefined, price });
      if (from) delete drafts[from];
      document.activeElement?.blur();
      await load();
    } catch (e) { alert(e.message); }
    return;
  }
  const row = ev.target.closest('tr.row[data-id]');
  if (row) {
    const id = row.dataset.id;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    renderTable();
  }
});
document.addEventListener('input', (ev) => {
  if (ev.target.dataset.draft) drafts[ev.target.dataset.draft] = ev.target.value;
});
document.querySelectorAll('#table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  if (sortKey === th.dataset.sort) sortAsc = !sortAsc;
  else { sortKey = th.dataset.sort; sortAsc = ['name', 'hours', 'activeSeconds'].includes(sortKey); }
  saveSettings();
  renderTable();
}));
els.settingsBtn.addEventListener('click', () => {
  els.settings.hidden = !els.settings.hidden;
  els.settingsBtn.setAttribute('aria-expanded', String(!els.settings.hidden));
});
let debounce;
els.useAI.addEventListener('change', () => { saveSettings(); load(); });
els.risk.addEventListener('change', () => { saveSettings(); load(); });
for (const k of SETTINGS) {
  els[k].addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { saveSettings(); load(); }, 300); });
}
for (const k of ['search', 'category', 'viableOnly']) els[k].addEventListener('input', () => data && renderTable());
window.addEventListener('resize', () => data && renderChart(data.stats.series));

loadSettings();
load();
setInterval(load, 15_000);
setInterval(renderStatus, 1000);

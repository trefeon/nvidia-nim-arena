// ─── Constants ───────────────────────────────────────────────────────────────
const PROVIDER_META = {
  'deepseek-ai': { name: 'DeepSeek', color: '#4d9de0' },
  'z-ai':        { name: 'Z-AI',     color: '#11a883' },
  'minimaxai':   { name: 'MiniMax',  color: '#7c3aed' },
  'nvidia':      { name: 'NVIDIA',   color: '#76b900' },
  'moonshotai':  { name: 'Moonshot', color: '#0891b2' },
  'openai':      { name: 'OpenAI',   color: '#2563eb' },
  'google':      { name: 'Google',   color: '#ea4335' },
  'qwen':        { name: 'Qwen',     color: '#d97706' },
  'mistralai':   { name: 'Mistral',  color: '#7e22ce' },
  'meta':        { name: 'Meta',     color: '#1877f2' },
  '01-ai':       { name: '01-AI',    color: '#ff6000' },
  'ai21labs':    { name: 'AI21 Labs', color: '#6d28d9' },
  'databricks':  { name: 'Databricks', color: '#ff3621' },
  'ibm':         { name: 'IBM',      color: '#0f62fe' },
  'microsoft':   { name: 'Microsoft', color: '#f25022' },
  'upstage':     { name: 'Upstage',  color: '#f43f5e' },
  'writer':      { name: 'Writer',   color: '#10b981' },
  'stepfun-ai':  { name: 'StepFun',  color: '#0055ff' },
  'zyphra':      { name: 'Zyphra',   color: '#8b5cf6' },
};

const MODEL_PALETTE = [
  '#76b900','#00c8ff','#ff6b35','#a855f7','#22c55e',
  '#f59e0b','#ec4899','#06b6d4','#84cc16','#6366f1',
  '#10b981','#3b82f6','#ef4444','#8b5cf6','#14b8a6',
  '#eab308','#d946ef','#fb923c','#e11d48','#64748b'
];

const CHART_DEFAULTS = {
  tooltip: {
    backgroundColor: '#1a1a2e',
    borderColor: '#2a2a40',
    borderWidth: 1,
    titleColor: '#e2e2f0',
    bodyColor: '#8888aa',
    padding: 12,
    cornerRadius: 8,
    displayColors: true
  }
};

Chart.defaults.color = '#666688';
Chart.defaults.borderColor = '#1c1c2e';
Chart.defaults.font.family = "'Inter', sans-serif";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  db: null,
  runs: [],
  modelNames: [],
  modelStats: {},
  charts: {},
  currentTab: 'overview',
  explorerModel: 'qwen/qwen3-coder-480b-a35b-instruct',
  lbSort: { col: 'score', dir: 'desc' },
  lbFilter: '',
  timelineFilter: 'all',
  modalResponse: '',
  bannedModels: new Set(),
  hiddenModels: new Set(),
  capabilities: null
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr, mean) {
  if (arr.length < 2) return 0;
  const sumSq = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0);
  return Math.sqrt(sumSq / arr.length);
}

function fmtMs(ms) {
  if (ms == null) return '—';
  return (ms / 1000).toFixed(2) + 's';
}

// Format numbers as formatted strings (e.g. 1.2s instead of 1.234s)
function fmtTps(tps) {
  if (tps == null || tps <= 0) return '—';
  return tps.toFixed(1) + ' t/s';
}

function fmtPct(v) {
  return (v * 100).toFixed(1) + '%';
}

function shortModel(m) {
  return m.split('/')[1] || m;
}

function getProvider(m) {
  return m.split('/')[0];
}

function providerMeta(m) {
  const p = getProvider(m);
  return PROVIDER_META[p] || { name: p, color: '#666688' };
}

function providerChip(m, small) {
  const pm = providerMeta(m);
  const s = small ? 'font-size:10px;padding:1px 6px' : 'font-size:11px;padding:2px 8px';
  return `<span class="provider-chip" style="background:${pm.color}22;color:${pm.color};border:1px solid ${pm.color}44;${s}">${pm.name}</span>`;
}

function fmtTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtTimestampShort(ts) {
  const d = new Date(ts);
  const mo = d.toLocaleString('en', { month: 'short' });
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}${day} ${hh}:${mm}`;
}

function categorizeError(err) {
  if (!err) return 'Unknown';
  if (err.includes('timed out')) return 'Timeout';
  if (err.includes('JSON')) return 'JSON Error';
  if (err.includes('404')) return 'Not Found (404)';
  if (err.includes('410')) return 'Gone (410)';
  if (err.includes('closed connection')) return 'Connection Closed';
  return 'Other Error';
}

function modelColor(model) {
  const idx = state.modelNames.indexOf(model);
  return MODEL_PALETTE[idx % MODEL_PALETTE.length];
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    delete state.charts[key];
  }
}

function animateCounter(el, target, duration = 1200, decimals = 0, suffix = '') {
  const start = performance.now();
  const update = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    const val = target * ease;
    el.textContent = (decimals ? val.toFixed(decimals) : Math.round(val)) + suffix;
    if (progress < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

function sparklineSVG(values, width = 80, height = 24, color = '#76b900') {
  const valid = values.filter(v => v !== null);
  if (valid.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const min = Math.min(...valid), max = Math.max(...valid);
  const range = max - min || 1;
  const pts = [];
  let lastX = 0, lastY = 0;
  values.forEach((v, i) => {
    if (v === null) return;
    const x = (i / (values.length - 1)) * width;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    pts.push([x, y]);
    lastX = x; lastY = y;
  });
  if (pts.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return `<svg width="${width}" height="${height}" style="overflow:visible"><path d="${d}" stroke="${color}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${color}"/></svg>`;
}

function renderMarkdown(text) {
  if (!text) return '';
  // Code blocks
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${escHtml(code.trimEnd())}</code></pre>`;
  });
  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${escHtml(c)}</code>`);
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Paragraphs
  const lines = text.split('\n');
  const out = [];
  let inPre = false;
  for (const line of lines) {
    if (line.startsWith('<pre>')) inPre = true;
    if (line.endsWith('</pre>')) { inPre = false; out.push(line); continue; }
    if (inPre) { out.push(line); continue; }
    if (line.trim() === '') { out.push(''); continue; }
    out.push(`<p>${line}</p>`);
  }
  return out.join('\n');
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Banned Models Loader ────────────────────────────────────────────────────
async function loadBannedModels() {
  try {
    const res = await fetch('data/banned_models.txt');
    if (!res.ok) return;
    const text = await res.text();
    state.bannedModels = new Set(
      text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    );
  } catch (_) { /* no ban list is fine */ }
}

async function loadCapabilities() {
  try {
    const res = await fetch('data/model_capabilities.json');
    if (!res.ok) return;
    state.capabilities = await res.json();
  } catch (_) { /* no capabilities file is fine */ }
}

// ─── SQLite Data Loader ───────────────────────────────────────────────────────
function loadFromDb(db) {
  const runsQ = db.exec(
    'SELECT id, timestamp, prompt, success_count, total_models, fastest_model, fastest_time FROM runs ORDER BY timestamp DESC'
  );
  if (!runsQ.length || !runsQ[0].values.length) return { runs: [] };

  const runs = runsQ[0].values.map(([id, timestamp, prompt, sc, tm, fm, ft]) => ({
    _dbId: id,
    timestamp,
    prompt,
    models: [],
    summary: { successCount: sc, totalModels: tm, fastestModel: fm, fastestTime: ft }
  }));

  const runById = new Map(runs.map((r, i) => [r._dbId, i]));

  const resQ = db.exec(
    'SELECT run_id, model, success, error, response_time, tokens_generated, total_tokens, unreliable FROM model_results ORDER BY run_id ASC'
  );
  if (resQ.length && resQ[0].values.length) {
    for (const [run_id, model, success, error, rt, tg, tt, unreliable] of resQ[0].values) {
      const idx = runById.get(run_id);
      if (idx !== undefined) {
        runs[idx].models.push({
          model,
          success: success === 1,
          error: error || null,
          responseTime: rt,
          tokensGenerated: tg,
          totalTokens: tt,
          unreliable: unreliable === 1,
          response: null  // lazy-loaded on demand
        });
      }
    }
  }
  return { runs };
}

// ─── Data Processing ──────────────────────────────────────────────────────────
function processData(data) {
  const runs = [...data.runs].reverse(); // chronological
  const modelNames = [...new Set(runs.flatMap(r => r.models.map(m => m.model)))];
  const modelStats = {};

  for (const model of modelNames) {
    const results = runs.map(run => run.models.find(m => m.model === model) || null);
    const successes = results.filter(r => r && r.success);
    const testedResults = results.filter(r => r !== null);
    const times = successes.map(r => r.responseTime).filter(t => t > 0);
    const tpsArr = successes
      .filter(r => r.responseTime > 0)
      .map(r => r.tokensGenerated / (r.responseTime / 1000));

    const uptime = testedResults.length ? successes.length / testedResults.length : 0;
    const avgTime = times.length ? avg(times) : 0;

    // Consistency (Coefficient of Variation)
    let consistency = 1.0;
    if (times.length >= 2) {
      const sd = stdDev(times, avgTime);
      const cv = sd / avgTime;
      consistency = Math.max(0, 1 - cv);
    }

    // Latency score (higher is better, penalize average latency > 15s)
    const latencyScore = avgTime > 0 ? Math.max(0, 1 - avgTime / 15000) : 0;

    // Unreliable runs penalty
    const unreliableRuns = successes.filter(r => r.unreliable || r.responseTime > 60000).length;
    const unreliableRate = successes.length ? unreliableRuns / successes.length : 0;
    const reliabilityModifier = 1 - unreliableRate;

    let reliability = 0;
    if (testedResults.length > 0) {
      // 50% weight on Uptime, 25% on Latency, 25% on Consistency
      // Penalized by the proportion of unreliable runs
      const composite = (uptime * 0.50) + (latencyScore * 0.25) + (consistency * 0.25);
      reliability = Math.round(composite * reliabilityModifier * 100);
    }

    modelStats[model] = {
      results,
      totalRuns: testedResults.length,
      successCount: successes.length,
      uptime,
      reliability,
      responseTimes: results.map(r => (r && r.success && r.responseTime > 0) ? r.responseTime : null),
      throughputs: results.map(r => (r && r.success && r.responseTime > 0)
        ? r.tokensGenerated / (r.responseTime / 1000) : null),
      avgTime: times.length ? avgTime : null,
      bestTime: times.length ? Math.min(...times) : null,
      avgTps: tpsArr.length ? avg(tpsArr) : null,
      wins: 0,
      errors: {},
      lastSeen: null,
    };

    // Last seen
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i] && results[i].success) {
        modelStats[model].lastSeen = runs[i]?.timestamp || null;
        break;
      }
    }

    // Errors
    results.filter(r => r && !r.success && r.error).forEach(r => {
      const t = categorizeError(r.error);
      modelStats[model].errors[t] = (modelStats[model].errors[t] || 0) + 1;
    });
  }

  // Wins
  runs.forEach(run => {
    const fm = run.summary?.fastestModel;
    if (fm && modelStats[fm]) modelStats[fm].wins++;
  });

  // Scores
  const validTimes = modelNames.filter(m => modelStats[m].avgTime != null).map(m => modelStats[m].avgTime);
  const validTps = modelNames.filter(m => modelStats[m].avgTps != null).map(m => modelStats[m].avgTps);
  const maxTime = validTimes.length ? Math.max(...validTimes) : 1;
  const minTime = validTimes.length ? Math.min(...validTimes) : 0;
  const maxTps = validTps.length ? Math.max(...validTps) : 1;
  const minTps = validTps.length ? Math.min(...validTps) : 0;

  for (const model of modelNames) {
    const s = modelStats[model];
    const speedScore = s.avgTime != null
      ? (1 - (s.avgTime - minTime) / Math.max(maxTime - minTime, 1)) * 100 : 0;
    const tpsScore = s.avgTps != null
      ? ((s.avgTps - minTps) / Math.max(maxTps - minTps, 1)) * 100 : 0;
    s.score = Math.round(s.uptime * 40 + speedScore * 0.3 + tpsScore * 0.3);

    // Trend: compare first half vs second half avg response time
    const half = Math.floor(s.responseTimes.length / 2);
    const firstHalf = s.responseTimes.slice(0, half).filter(v => v != null);
    const secondHalf = s.responseTimes.slice(half).filter(v => v != null);
    if (firstHalf.length && secondHalf.length) {
      const diff = avg(secondHalf) - avg(firstHalf);
      s.trend = diff < -500 ? 'up' : diff > 500 ? 'down' : 'flat';
    } else {
      s.trend = 'flat';
    }
  }

  return { runs, modelNames, modelStats };
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function renderOverview() {
  const { runs, modelNames, modelStats } = state;

  // Hidden-models banner
  const banner = document.getElementById('hidden-banner');
  if (state.hiddenModels.size > 0) {
    const hidden = [...state.hiddenModels];
    banner.innerHTML = `
      <div class="hidden-banner">
        <span class="icon">🚫</span>
        <span><b>${hidden.length}</b> model${hidden.length===1?'':'s'} hidden (no successful response):</span>
        <span class="list">${hidden.map(m => `<span>${escHtml(m)}</span>`).join('')}</span>
      </div>`;
  } else {
    banner.innerHTML = '';
  }

  // KPIs
  const totalRuns = runs.length;
  const allUptimes = modelNames.map(m => modelStats[m].uptime);
  const avgSuccessRate = avg(allUptimes) * 100;

  let bestTimeModel = null, bestTimeVal = Infinity;
  let bestTpsModel = null, bestTpsVal = 0;
  for (const m of modelNames) {
    const s = modelStats[m];
    if (s.avgTime != null && s.avgTime < bestTimeVal) { bestTimeVal = s.avgTime; bestTimeModel = m; }
    if (s.avgTps != null && s.avgTps > bestTpsVal) { bestTpsVal = s.avgTps; bestTpsModel = m; }
  }
  const mostReliable = [...modelNames].sort((a, b) => modelStats[b].reliability - modelStats[a].reliability)[0];

  const dateRangeStr = totalRuns > 0
    ? `${runs[0]?.timestamp?.slice(0, 10)} to ${runs[runs.length - 1]?.timestamp?.slice(0, 10)}`
    : 'No runs';

  const kpiData = [
    { icon: '🔁', label: 'Total Runs', val: totalRuns, sub: totalRuns > 0 ? `${runs[0]?.timestamp?.slice(0,10)} → ${runs[runs.length-1]?.timestamp?.slice(0,10)}` : 'No runs recorded', decimals: 0 },
    { icon: '✅', label: 'Avg Success Rate', val: avgSuccessRate, suffix: '%', decimals: 1, sub: 'across all runs & models' },
    { icon: '⚡', label: 'Avg Best Response', val: bestTimeModel ? bestTimeVal / 1000 : 0, suffix: 's', decimals: 2, sub: bestTimeModel ? shortModel(bestTimeModel) : '—' },
    { icon: '🚀', label: 'Avg Best Throughput', val: bestTpsVal, suffix: ' t/s', decimals: 1, sub: bestTpsModel ? shortModel(bestTpsModel) : '—' },
    { icon: '🏅', label: 'Most Reliable', val: mostReliable ? (modelStats[mostReliable]?.reliability || 0) : 0, suffix: '%', decimals: 0, sub: mostReliable ? shortModel(mostReliable) : '—' },
  ];

  const kpiGrid = document.getElementById('kpi-grid');
  kpiGrid.innerHTML = kpiData.map(k => `
    <div class="kpi-card">
      <div class="kpi-icon">${k.icon}</div>
      <div class="kpi-value" id="kpi-val-${k.label.replace(/\s/g,'_')}">0${k.suffix||''}</div>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>
  `).join('');

  kpiData.forEach(k => {
    const el = document.getElementById('kpi-val-' + k.label.replace(/\s/g,'_'));
    if (el) animateCounter(el, k.val, 1400, k.decimals || 0, k.suffix || '');
  });

  document.getElementById('overview-sub').textContent =
    totalRuns > 0
      ? `${totalRuns} benchmark runs · ${modelNames.length} models · ${dateRangeStr}`
      : 'No runs recorded yet. Go to the Control Panel to start a benchmark!';

  // Charts
  const labels = runs.map(r => fmtTimestampShort(r.timestamp));
  const successCounts = runs.map(r => r.summary?.successCount ?? r.models.filter(m => m.success).length);
  const successRates = runs.map(r => {
    const total = r.summary?.totalModels || r.models.length;
    const succ = r.summary?.successCount ?? r.models.filter(m => m.success).length;
    return (succ / total) * 100;
  });

  destroyChart('successCount');
  state.charts.successCount = new Chart(document.getElementById('chart-success-count'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Successes',
        data: successCounts,
        borderColor: '#76b900',
        backgroundColor: 'rgba(118,185,0,0.08)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...CHART_DEFAULTS.tooltip, callbacks: {
        title: (items) => `Run ${items[0].dataIndex + 1}: ${labels[items[0].dataIndex]}`
      }}},
      scales: {
        x: { display: false },
        y: { min: 0, max: 20, grid: { color: '#1c1c2e' }, ticks: { stepSize: 5 } }
      }
    }
  });

  destroyChart('successRate');
  state.charts.successRate = new Chart(document.getElementById('chart-success-rate'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Success %',
        data: successRates,
        borderColor: '#00c8ff',
        backgroundColor: 'rgba(0,200,255,0.06)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...CHART_DEFAULTS.tooltip, callbacks: {
        label: (item) => `${item.raw.toFixed(1)}% success`
      }}},
      scales: {
        x: { display: false },
        y: { min: 0, max: 100, grid: { color: '#1c1c2e' }, ticks: { callback: v => v + '%' } }
      }
    }
  });

  // Top 10 Fastest
  const modelsWithTime = modelNames
    .filter(m => modelStats[m].avgTime != null)
    .sort((a, b) => modelStats[a].avgTime - modelStats[b].avgTime)
    .slice(0, 10);

  destroyChart('fastest');
  state.charts.fastest = new Chart(document.getElementById('chart-fastest'), {
    type: 'bar',
    data: {
      labels: modelsWithTime.map(m => shortModel(m)),
      datasets: [{
        data: modelsWithTime.map(m => modelStats[m].avgTime / 1000),
        backgroundColor: modelsWithTime.map((m, i) => i === 0 ? '#76b900' : '#76b90055'),
        borderColor: modelsWithTime.map((m, i) => i === 0 ? '#76b900' : '#76b90088'),
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...CHART_DEFAULTS.tooltip, callbacks: {
        label: (item) => `Avg: ${item.raw.toFixed(2)}s`
      }}},
      scales: {
        x: { grid: { color: '#1c1c2e' }, ticks: { callback: v => v + 's' } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });

  // Top 10 Throughput
  const modelsWithTps = modelNames
    .filter(m => modelStats[m].avgTps != null)
    .sort((a, b) => modelStats[b].avgTps - modelStats[a].avgTps)
    .slice(0, 10);

  destroyChart('throughput');
  state.charts.throughput = new Chart(document.getElementById('chart-throughput'), {
    type: 'bar',
    data: {
      labels: modelsWithTps.map(m => shortModel(m)),
      datasets: [{
        data: modelsWithTps.map(m => modelStats[m].avgTps),
        backgroundColor: modelsWithTps.map((m, i) => i === 0 ? '#00c8ff' : '#00c8ff44'),
        borderColor: modelsWithTps.map((m, i) => i === 0 ? '#00c8ff' : '#00c8ff88'),
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...CHART_DEFAULTS.tooltip, callbacks: {
        label: (item) => `${item.raw.toFixed(1)} tok/s`
      }}},
      scales: {
        x: { grid: { color: '#1c1c2e' }, ticks: { callback: v => v + ' t/s' } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });

  // Reliability pills
  const grid = document.getElementById('reliability-grid');
  const sorted = [...modelNames].sort((a, b) => modelStats[b].reliability - modelStats[a].reliability);
  grid.innerHTML = sorted.map(m => {
    const r = modelStats[m].reliability;
    const cls = r >= 80 ? 'green' : r >= 50 ? 'yellow' : 'red';
    return `<div class="rel-pill ${cls}"><span class="dot"></span>${shortModel(m)} <span style="opacity:0.7">${r}%</span></div>`;
  }).join('');
}

// ─── Leaderboard Tab ──────────────────────────────────────────────────────────
function renderLeaderboard() {
  const { modelNames, modelStats } = state;
  const scores = [...modelNames].sort((a, b) => modelStats[b].score - modelStats[a].score);
  const ranks = {};
  scores.forEach((m, i) => { ranks[m] = i + 1; });

  state.lbData = modelNames.map(m => ({ model: m, rank: ranks[m], ...modelStats[m] }));
  renderLbTable();
}

function renderLbTable() {
  const { lbData, lbSort, lbFilter } = state;
  if (!lbData) return;

  let rows = [...lbData];
  if (lbFilter) {
    rows = rows.filter(r => r.model.toLowerCase().includes(lbFilter.toLowerCase()));
  }

  rows.sort((a, b) => {
    let av = a[lbSort.col], bv = b[lbSort.col];
    if (av == null) av = lbSort.dir === 'asc' ? Infinity : -Infinity;
    if (bv == null) bv = lbSort.dir === 'asc' ? Infinity : -Infinity;
    return lbSort.dir === 'asc' ? av - bv : bv - av;
  });

  const tbody = document.getElementById('lb-body');
  tbody.innerHTML = rows.map((r, i) => {
    const uptimePct = (r.uptime * 100).toFixed(1);
    const uptimeColor = r.uptime >= 0.7 ? '#22c55e' : r.uptime >= 0.4 ? '#f59e0b' : '#ef4444';
    const scoreColor = r.score >= 60 ? '#22c55e' : r.score >= 40 ? '#f59e0b' : '#ef4444';
    const trendHtml = r.trend === 'up'
      ? `<span class="trend-indicator trend-up" title="Improving">↑</span>`
      : r.trend === 'down'
      ? `<span class="trend-indicator trend-down" title="Declining">↓</span>`
      : `<span class="trend-indicator trend-flat" title="Stable">→</span>`;
    const last10 = r.responseTimes.slice(-10);
    const spark = sparklineSVG(last10, 72, 22, modelColor(r.model));
    const isTop3 = r.rank <= 3;

    return `<tr data-model="${r.model}">
      <td><span class="rank-num${isTop3?' top3':''}">${r.rank}</span></td>
      <td><div class="model-name-cell">${providerChip(r.model, true)}<span class="model-name-text" title="${r.model}">${shortModel(r.model)}</span>${trendHtml}</div></td>
      <td style="white-space:nowrap">${(state.capabilities?.models[r.model]?.tags || []).slice(0, 3).map(capChip).join('')}</td>
      <td><div class="score-cell"><span class="score-num" style="color:${scoreColor}">${r.score}</span></div></td>
      <td><div class="uptime-cell"><span class="uptime-val" style="color:${uptimeColor}">${uptimePct}%</span><div class="uptime-bar"><div class="uptime-fill" style="width:${uptimePct}%;background:${uptimeColor}"></div></div></div></td>
      <td class="mono">${r.avgTime ? (r.avgTime/1000).toFixed(2)+'s' : '—'}</td>
      <td class="mono">${r.bestTime ? (r.bestTime/1000).toFixed(2)+'s' : '—'}</td>
      <td class="mono">${r.avgTps ? r.avgTps.toFixed(1)+' t/s' : '—'}</td>
      <td class="mono text-accent">${r.wins}</td>
      <td>${spark}</td>
    </tr>`;
  }).join('');

  // Row click → explorer
  tbody.querySelectorAll('tr[data-model]').forEach(row => {
    row.addEventListener('click', () => {
      state.explorerModel = row.dataset.model;
      switchTab('explorer');
    });
  });
}

function initLeaderboardSort() {
  document.querySelectorAll('#lb-table thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (col === 'model' || col === 'trend') return;
      if (state.lbSort.col === col) {
        state.lbSort.dir = state.lbSort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        state.lbSort.col = col;
        state.lbSort.dir = 'desc';
      }
      document.querySelectorAll('#lb-table thead th').forEach(t => t.classList.remove('sorted'));
      th.classList.add('sorted');
      th.querySelector('.sort-arrow').textContent = state.lbSort.dir === 'desc' ? '↓' : '↑';
      renderLbTable();
    });
  });

  document.getElementById('lb-search').addEventListener('input', e => {
    state.lbFilter = e.target.value;
    renderLbTable();
  });
}

// ─── Categories Tab ──────────────────────────────────────────────────────────
function capChip(tag) {
  if (!state.capabilities || !state.capabilities.categories[tag]) return '';
  const c = state.capabilities.categories[tag];
  return `<span class="cap-chip" style="background:${c.color}1a;color:${c.color};border-color:${c.color}44" title="${escHtml(c.description)}"><span class="ci">${c.icon}</span>${escHtml(tag)}</span>`;
}

function renderCategories() {
  const grid = document.getElementById('categories-grid');
  const sub = document.getElementById('categories-sub');
  if (!state.capabilities) {
    grid.innerHTML = '<div class="card"><div class="card-title">Capabilities data not loaded</div><p style="color:var(--text-dim);font-size:12px">Make sure data/model_capabilities.json is reachable.</p></div>';
    sub.textContent = '';
    return;
  }
  const caps = state.capabilities;
  const modelInfo = state.modelNames.map(m => {
    const meta = caps.models[m] || {};
    return { id: m, ...meta, score: state.modelStats[m]?.score || 0 };
  });

  // Group models by category (capability tag)
  const groups = {};
  for (const [cat, meta] of Object.entries(caps.categories)) {
    const inCat = modelInfo.filter(m => m.tags && m.tags.includes(cat))
      .sort((a, b) => b.score - a.score);
    if (inCat.length > 0) groups[cat] = inCat;
  }

  sub.textContent = `${Object.keys(groups).length} capability groups · ${state.modelNames.length} capable models`;

  grid.innerHTML = Object.entries(groups).map(([cat, list]) => {
    const c = caps.categories[cat];
    return `
      <div class="cat-card" style="--cat-color:${c.color}">
        <div class="cat-header">
          <span class="cat-icon">${c.icon}</span>
          <span class="cat-title">${escHtml(cat)}</span>
          <span class="cat-count">${list.length} model${list.length===1?'':'s'}</span>
        </div>
        <div class="cat-desc">${escHtml(c.description)}</div>
        <div class="cat-models">
          ${list.map(m => `
            <div class="cat-model" data-model="${escHtml(m.id)}" title="${escHtml(m.description || '')}">
              <span class="provider">${escHtml(m.id.split('/')[0])}/</span>
              <span class="name">${escHtml(m.id.split('/')[1] || m.id)}</span>
              <span class="specs">${escHtml(m.params || '')}<br>${escHtml(m.context || '')} ctx</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.cat-model').forEach(el => {
    el.addEventListener('click', () => {
      state.explorerModel = el.dataset.model;
      switchTab('explorer');
    });
  });
}

// ─── Explorer Tab ─────────────────────────────────────────────────────────────
function populateExplorerSelect() {
  const sel = document.getElementById('explorer-select');
  const sorted = [...state.modelNames].sort((a,b) => state.modelStats[b].score - state.modelStats[a].score);
  const prevValue = sel.value || state.explorerModel;
  sel.innerHTML = sorted.map(m =>
    `<option value="${m}">${shortModel(m)} (${providerMeta(m).name})</option>`
  ).join('');
  if (sorted.includes(prevValue)) {
    sel.value = prevValue;
  } else if (sorted.length > 0) {
    sel.value = sorted[0];
    state.explorerModel = sorted[0];
  }
}

function renderExplorer() {
  const model = state.explorerModel;
  const s = state.modelStats[model];
  const pm = providerMeta(model);
  if (!s) return;

  // Update select
  const sel = document.getElementById('explorer-select');
  if (sel.value !== model) sel.value = model;

  // Header
  document.getElementById('explorer-header').innerHTML = `
    ${providerChip(model)}
    <h2>${shortModel(model)}</h2>
    <span style="font-size:12px;color:var(--text-dim);margin-left:auto">
      Last seen: ${s.lastSeen ? fmtTimestamp(s.lastSeen) : '—'}
    </span>
  `;

  // Stats
  const uptimeColor = s.uptime >= 0.7 ? 'var(--success)' : s.uptime >= 0.4 ? 'var(--warning)' : 'var(--danger)';
  const relColor = s.reliability >= 80 ? 'var(--success)' : s.reliability >= 50 ? 'var(--warning)' : 'var(--danger)';
  document.getElementById('explorer-stats').innerHTML = `
    <div class="stat-card"><div class="stat-val" style="color:${relColor}">${s.reliability}%</div><div class="stat-label">Reliability</div><div class="stat-sub">Index Score</div></div>
    <div class="stat-card"><div class="stat-val" style="color:${uptimeColor}">${(s.uptime*100).toFixed(1)}%</div><div class="stat-label">Uptime</div><div class="stat-sub">${s.successCount}/${s.totalRuns} runs</div></div>
    <div class="stat-card"><div class="stat-val">${s.avgTime ? (s.avgTime/1000).toFixed(2)+'s' : '—'}</div><div class="stat-label">Avg Response</div></div>
    <div class="stat-card"><div class="stat-val text-accent">${s.bestTime ? (s.bestTime/1000).toFixed(2)+'s' : '—'}</div><div class="stat-label">Best Response</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--blue)">${s.avgTps ? s.avgTps.toFixed(1)+' t/s' : '—'}</div><div class="stat-label">Avg Throughput</div></div>
  `;

  // Response time chart
  const labels = state.runs.map(r => fmtTimestampShort(r.timestamp));
  const timeData = s.responseTimes.map(v => v != null ? v / 1000 : null);

  destroyChart('explorerTime');
  state.charts.explorerTime = new Chart(document.getElementById('chart-explorer-time'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Response Time (s)',
        data: timeData,
        borderColor: modelColor(model),
        backgroundColor: modelColor(model) + '14',
        fill: true,
        tension: 0.2,
        spanGaps: false,
        pointRadius: timeData.map(v => v != null ? 3 : 0),
        pointHoverRadius: 5,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...CHART_DEFAULTS.tooltip, callbacks: {
        label: (item) => item.raw != null ? `${item.raw.toFixed(2)}s` : 'Failed'
      }}},
      scales: {
        x: { display: false },
        y: { grid: { color: '#1c1c2e' }, ticks: { callback: v => v + 's' } }
      }
    }
  });

  // Error donut
  destroyChart('explorerErrors');
  const errorCanvas = document.getElementById('chart-explorer-errors');
  const noErrors = document.getElementById('explorer-no-errors');
  const errorKeys = Object.keys(s.errors);
  if (errorKeys.length === 0) {
    errorCanvas.style.display = 'none';
    noErrors.style.display = 'block';
  } else {
    errorCanvas.style.display = 'block';
    noErrors.style.display = 'none';
    const errorColors = ['#ef4444','#f59e0b','#a855f7','#3b82f6','#06b6d4','#64748b'];
    state.charts.explorerErrors = new Chart(errorCanvas, {
      type: 'doughnut',
      data: {
        labels: errorKeys,
        datasets: [{
          data: errorKeys.map(k => s.errors[k]),
          backgroundColor: errorColors.slice(0, errorKeys.length).map(c => c + 'cc'),
          borderColor: errorColors.slice(0, errorKeys.length),
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: CHART_DEFAULTS.tooltip,
        }
      }
    });
  }

  // Heatmap — dynamic columns based on total run count, newest at top-left
  const hm = document.getElementById('explorer-heatmap');
  const reversed = [...s.results].reverse(); // newest first
  const hmCols = Math.ceil(Math.sqrt(reversed.length));
  hm.style.gridTemplateColumns = `repeat(${hmCols}, 1fr)`;
  hm.innerHTML = reversed.map((r, i) => {
    const runIdx = s.results.length - 1 - i;
    if (!r) return `<div class="heatmap-cell miss" title="Run ${runIdx+1}: No data"></div>`;
    const ts = fmtTimestamp(state.runs[runIdx]?.timestamp || '');
    if (r.success) return `<div class="heatmap-cell pass" title="${ts}: ✓ ${(r.responseTime/1000).toFixed(2)}s"></div>`;
    return `<div class="heatmap-cell fail" title="${ts}: ✗ ${r.error||'Error'}"></div>`;
  }).join('');

  // Run history table
  const tbody = document.getElementById('explorer-run-table');
  const last20 = s.results.map((r, i) => ({ r, i })).slice(-20).reverse();
  tbody.innerHTML = last20.map(({ r, i }) => {
    if (!r) return `<tr><td class="mono text-dim">${fmtTimestamp(state.runs[i]?.timestamp||'')}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
    const tps = (r.success && r.responseTime > 0) ? (r.tokensGenerated / (r.responseTime / 1000)).toFixed(1) : null;
    const actionBtn = r.success
      ? `<button class="btn-view" data-run="${i}">View</button>` : '—';
    return `<tr>
      <td class="mono" style="font-size:11px">${fmtTimestamp(state.runs[i]?.timestamp||'')}</td>
      <td><span class="status-badge ${r.success?'ok':'fail'}">${r.success?'✓ OK':'✗ Fail'}</span></td>
      <td class="mono">${r.success ? (r.responseTime/1000).toFixed(2)+'s' : '—'}</td>
      <td class="mono">${tps ? tps+' t/s' : '—'}</td>
      <td>${actionBtn}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-view[data-run]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.run);
      const run = state.runs[idx];
      if (!run) return;
      const q = state.db.exec(
        'SELECT response FROM model_results WHERE run_id = ? AND model = ?',
        [run._dbId, model]
      );
      const response = q[0]?.values[0]?.[0] || '';
      openModal(model, response);
    });
  });
}

// ─── Timeline Tab ─────────────────────────────────────────────────────────────
function renderTimeline() {
  const { runs } = state;
  const filter = state.timelineFilter;
  const now = new Date(runs[runs.length - 1]?.timestamp || Date.now());

  let filtered = [...runs].reverse(); // most recent first
  if (filter === '24h') {
    const cutoff = new Date(now); cutoff.setHours(cutoff.getHours() - 24);
    filtered = filtered.filter(r => new Date(r.timestamp) >= cutoff);
  } else if (filter === '48h') {
    const cutoff = new Date(now); cutoff.setHours(cutoff.getHours() - 48);
    filtered = filtered.filter(r => new Date(r.timestamp) >= cutoff);
  } else if (filter === '7d') {
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 7);
    filtered = filtered.filter(r => new Date(r.timestamp) >= cutoff);
  }

  document.getElementById('timeline-badge').textContent = `${filtered.length} runs`;

  const container = document.getElementById('run-cards');
  container.innerHTML = filtered.map((run, idx) => {
    const total = run.summary?.totalModels || run.models.length;
    const succ = run.summary?.successCount ?? run.models.filter(m => m.success).length;
    const pct = succ / total;
    const badgeCls = pct >= 0.6 ? 'green' : pct >= 0.4 ? 'yellow' : 'red';
    const fastest = run.summary?.fastestModel ? shortModel(run.summary.fastestModel) : '—';
    const fastestTime = run.summary?.fastestTime ? (run.summary.fastestTime/1000).toFixed(2)+'s' : '';

    return `<div class="run-card" data-run-idx="${idx}">
      <div class="run-card-header">
        <span class="run-card-time">${fmtTimestamp(run.timestamp)}</span>
        <span class="run-success-badge ${badgeCls}">${succ}/${total}</span>
        <span class="run-fastest">⚡ <span>${fastest}</span>${fastestTime ? ' · '+fastestTime : ''}</span>
        <span class="run-expand-arrow">▼</span>
      </div>
      <div class="run-card-body">
        <div class="run-prompt">Prompt: ${escHtml((run.prompt||'').slice(0,120))}${(run.prompt||'').length > 120 ? '…' : ''}</div>
        <table class="run-detail-table">
          <thead><tr><th>Model</th><th>Status</th><th>Response Time</th><th>Tok/s</th><th>Error</th></tr></thead>
          <tbody>${run.models.map(m => {
            const tps = (m.success && m.responseTime > 0) ? (m.tokensGenerated / (m.responseTime / 1000)).toFixed(1) : null;
            const cls = m.success ? 'text-green' : 'text-red';
            return `<tr>
              <td>${providerChip(m.model, true)}<span style="font-size:12px">${shortModel(m.model)}</span></td>
              <td><span class="${cls}" style="font-size:12px;font-weight:600">${m.success ? '✓' : '✗'}</span></td>
              <td class="mono">${m.success && m.responseTime ? (m.responseTime/1000).toFixed(2)+'s' : '—'}</td>
              <td class="mono">${tps ? tps+' t/s' : '—'}</td>
              <td style="font-size:11px;color:var(--text-dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.error ? escHtml(m.error) : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.run-card').forEach(card => {
    card.querySelector('.run-card-header').addEventListener('click', () => {
      card.classList.toggle('expanded');
    });
  });
}

// ─── Compare Tab ──────────────────────────────────────────────────────────────
function populateCompareSelects() {
  const sorted = [...state.modelNames].sort((a,b) => state.modelStats[b].score - state.modelStats[a].score);
  const opts = sorted.map(m => `<option value="${m}">${shortModel(m)} (${providerMeta(m).name})</option>`).join('');

  const selA = document.getElementById('compare-a');
  const selB = document.getElementById('compare-b');
  const valA = selA.value;
  const valB = selB.value;

  selA.innerHTML = opts;
  selB.innerHTML = opts;

  const defaultA = 'qwen/qwen3-coder-480b-a35b-instruct';
  const defaultB = 'nvidia/nemotron-3-super-120b-a12b';
  if (state.modelNames.includes(valA)) {
    selA.value = valA;
  } else {
    selA.value = state.modelNames.includes(defaultA) ? defaultA : sorted[0] || '';
  }
  if (state.modelNames.includes(valB)) {
    selB.value = valB;
  } else {
    selB.value = state.modelNames.includes(defaultB) ? defaultB : sorted[1] || '';
  }
}

function renderCompare() {
  const modelA = document.getElementById('compare-a').value;
  const modelB = document.getElementById('compare-b').value;
  const sA = state.modelStats[modelA];
  const sB = state.modelStats[modelB];
  if (!sA || !sB) return;

  // Head-to-head wins (when both succeed)
  let winsA = 0, winsB = 0, bothSucceeded = 0;
  state.runs.forEach((run, i) => {
    const rA = sA.results[i];
    const rB = sB.results[i];
    if (rA && rA.success && rB && rB.success) {
      bothSucceeded++;
      if (rA.responseTime < rB.responseTime) winsA++;
      else winsB++;
    }
  });

  const metrics = [
    { label: 'Uptime', a: (sA.uptime*100).toFixed(1)+'%', b: (sB.uptime*100).toFixed(1)+'%', higherBetter: true, av: sA.uptime, bv: sB.uptime },
    { label: 'Avg Response Time', a: sA.avgTime ? (sA.avgTime/1000).toFixed(2)+'s' : '—', b: sB.avgTime ? (sB.avgTime/1000).toFixed(2)+'s' : '—', higherBetter: false, av: sA.avgTime, bv: sB.avgTime },
    { label: 'Best Response Time', a: sA.bestTime ? (sA.bestTime/1000).toFixed(2)+'s' : '—', b: sB.bestTime ? (sB.bestTime/1000).toFixed(2)+'s' : '—', higherBetter: false, av: sA.bestTime, bv: sB.bestTime },
    { label: 'Avg Throughput', a: sA.avgTps ? sA.avgTps.toFixed(1)+' t/s' : '—', b: sB.avgTps ? sB.avgTps.toFixed(1)+' t/s' : '—', higherBetter: true, av: sA.avgTps, bv: sB.avgTps },
    { label: 'Total Wins', a: sA.wins, b: sB.wins, higherBetter: true, av: sA.wins, bv: sB.wins },
    { label: 'Score', a: sA.score, b: sB.score, higherBetter: true, av: sA.score, bv: sB.score },
    { label: 'H2H Win Rate', a: bothSucceeded ? (winsA/bothSucceeded*100).toFixed(1)+'%' : '—', b: bothSucceeded ? (winsB/bothSucceeded*100).toFixed(1)+'%' : '—', higherBetter: true, av: winsA, bv: winsB },
  ];

  const colorA = modelColor(modelA);
  const colorB = modelColor(modelB);

  document.getElementById('h2h-table').innerHTML = `
    <thead><tr>
      <td class="h2h-val-a" style="color:${colorA};font-size:13px;padding:10px 16px;text-align:center">${providerChip(modelA, true)} ${shortModel(modelA)}</td>
      <td class="h2h-metric">Metric</td>
      <td class="h2h-val-b" style="color:${colorB};font-size:13px;padding:10px 16px;text-align:center">${providerChip(modelB, true)} ${shortModel(modelB)}</td>
    </tr></thead>
    <tbody>${metrics.map(m => {
      let clsA = 'h2h-val-a', clsB = 'h2h-val-b';
      if (m.av != null && m.bv != null) {
        const aWins = m.higherBetter ? m.av > m.bv : m.av < m.bv;
        const bWins = m.higherBetter ? m.bv > m.av : m.bv < m.av;
        if (aWins) clsA += ' winner';
        if (bWins) clsB += ' winner';
      }
      return `<tr class="h2h-row">
        <td class="${clsA}" style="padding:10px 16px">${m.a}</td>
        <td class="h2h-metric" style="padding:10px 16px">${m.label}</td>
        <td class="${clsB}" style="padding:10px 16px">${m.b}</td>
      </tr>`;
    }).join('')}</tbody>
  `;

  // Overlay chart
  const labels = state.runs.map(r => fmtTimestampShort(r.timestamp));
  destroyChart('compareTime');
  state.charts.compareTime = new Chart(document.getElementById('chart-compare-time'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: shortModel(modelA),
          data: sA.responseTimes.map(v => v != null ? v/1000 : null),
          borderColor: colorA,
          backgroundColor: colorA + '14',
          fill: false,
          tension: 0.2,
          spanGaps: false,
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 2,
        },
        {
          label: shortModel(modelB),
          data: sB.responseTimes.map(v => v != null ? v/1000 : null),
          borderColor: colorB,
          backgroundColor: colorB + '14',
          fill: false,
          tension: 0.2,
          spanGaps: false,
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { ...CHART_DEFAULTS.tooltip, callbacks: {
          label: (item) => item.raw != null ? `${item.dataset.label}: ${item.raw.toFixed(2)}s` : `${item.dataset.label}: Failed`
        }}
      },
      scales: {
        x: { display: false },
        y: { grid: { color: '#1c1c2e' }, ticks: { callback: v => v + 's' } }
      }
    }
  });

  // Win timeline
  const winData = state.runs.map((run, i) => {
    const rA = sA.results[i], rB = sB.results[i];
    if (!rA?.success && !rB?.success) return null;
    if (rA?.success && !rB?.success) return 1;
    if (!rA?.success && rB?.success) return -1;
    return rA.responseTime < rB.responseTime ? 1 : -1;
  });

  destroyChart('compareWins');
  state.charts.compareWins = new Chart(document.getElementById('chart-compare-wins'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Winner per run',
        data: winData,
        backgroundColor: winData.map(v => v == null ? '#1c1c2e' : v > 0 ? colorA + 'cc' : colorB + 'cc'),
        borderColor: winData.map(v => v == null ? '#1c1c2e' : v > 0 ? colorA : colorB),
        borderWidth: 1,
        borderRadius: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...CHART_DEFAULTS.tooltip, callbacks: {
          label: (item) => {
            if (item.raw == null) return 'Both failed';
            return item.raw > 0 ? `${shortModel(modelA)} won` : `${shortModel(modelB)} won`;
          }
        }}
      },
      scales: {
        x: { display: false },
        y: { display: false, min: -1.5, max: 1.5 }
      }
    }
  });
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal(model, response) {
  state.modalResponse = response || '';
  const pm = providerMeta(model);
  document.getElementById('modal-provider-chip').textContent = pm.name;
  document.getElementById('modal-provider-chip').style.cssText = `background:${pm.color}22;color:${pm.color};border:1px solid ${pm.color}44`;
  document.getElementById('modal-title').textContent = model;
  document.getElementById('modal-body').innerHTML = renderMarkdown(response || '');
  document.getElementById('modal').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

// ─── Tab Navigation ───────────────────────────────────────────────────────────
function switchTab(tabName) {
  state.currentTab = tabName;
  document.querySelectorAll('section[data-tab]').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`section[data-tab="${tabName}"]`)?.classList.add('active');
  document.querySelector(`.nav-tab[data-goto="${tabName}"]`)?.classList.add('active');

  if (tabName === 'overview') renderOverview();
  if (tabName === 'leaderboard') renderLeaderboard();
  if (tabName === 'explorer') renderExplorer();
  if (tabName === 'timeline') renderTimeline();
  if (tabName === 'compare') renderCompare();
  if (tabName === 'categories') renderCategories();
  if (tabName === 'control-panel') {
    checkRunnerStatus().then(() => {
      const logsEl = document.getElementById('runner-logs');
      if (logsEl) logsEl.scrollTop = logsEl.scrollHeight;
    });
  }
}

// ─── Runner Control Panel Client ──────────────────────────────────────────────
let isPollingRunner = false;
let runnerPollTimer = null;
let lastRunnerStatus = null;

async function checkRunnerStatus() {
  try {
    const res = await fetch('/api/task-status');
    if (!res.ok) {
      hideRunnerTab();
      return;
    }
    const data = await res.json();
    
    // Server is detected! Show the runner tab.
    showRunnerTab();
    
    // Update the runner UI
    updateRunnerUI(data);
    
    // If status is running, ensure we poll quickly (1.5s)
    if (data.status === 'running') {
      startPollingRunner(1500);
    } else {
      // If we transitioned from running to idle, refresh the database!
      if (lastRunnerStatus === 'running' && data.status === 'idle') {
        console.log("Benchmark run finished! Reloading data...");
        try {
          await loadDataAndRefresh();
        } catch (e) {
          console.error("Failed to reload database after benchmark run:", e);
        }
      }
      // If idle, poll slowly (5.0s)
      startPollingRunner(5000);
    }
    
    lastRunnerStatus = data.status;
  } catch (err) {
    // If the server doesn't respond (e.g. served statically)
    hideRunnerTab();
    stopPollingRunner();
  }
}

function showRunnerTab() {
  const tabBtn = document.getElementById('nav-control-panel');
  if (tabBtn) {
    tabBtn.style.display = 'block';
  }
}

function hideRunnerTab() {
  const tabBtn = document.getElementById('nav-control-panel');
  if (tabBtn) {
    tabBtn.style.display = 'none';
  }
}

function startPollingRunner(ms) {
  // If timer is already running with a same interval, do nothing
  if (runnerPollTimer) {
    if (runnerPollTimer.interval === ms) return;
    clearInterval(runnerPollTimer.id);
  }
  runnerPollTimer = {
    interval: ms,
    id: setInterval(checkRunnerStatus, ms)
  };
}

function stopPollingRunner() {
  if (runnerPollTimer) {
    clearInterval(runnerPollTimer.id);
    runnerPollTimer = null;
  }
}

function updateRunnerUI(data) {
  const btn = document.getElementById('btn-run-benchmark');
  const statusEl = document.getElementById('runner-status');
  const timerEl = document.getElementById('runner-timer');
  const logsEl = document.getElementById('runner-logs');
  const chkLoop = document.getElementById('chk-loop-benchmark');
  
  if (chkLoop && document.activeElement !== chkLoop) {
    chkLoop.checked = !!data.loop_enabled;
  }
  
  const stopBtn = document.getElementById('btn-stop-benchmark');
  const resetBtn = document.getElementById('btn-reset-data');

  if (data.status === 'running') {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" style="display:inline-block;width:12px;height:12px;border-width:2px;margin:0 6px 0 0;vertical-align:middle"></span> Running...`;
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';
    }
    if (statusEl) {
      statusEl.textContent = 'Status: Benchmark In Progress...';
      statusEl.style.color = 'var(--warning)';
    }
    if (stopBtn) {
      stopBtn.style.display = 'inline-flex';
      stopBtn.disabled = false;
    }
    if (resetBtn) {
      resetBtn.disabled = true;
      resetBtn.style.opacity = '0.5';
      resetBtn.style.cursor = 'not-allowed';
    }
  } else {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `⚡ Run Benchmark`;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    }
    if (statusEl) {
      if (data.exit_code === 0) {
        statusEl.textContent = 'Status: Idle (Last run: Success)';
        statusEl.style.color = 'var(--success)';
      } else if (data.exit_code != null) {
        statusEl.textContent = `Status: Idle (Last run failed, code: ${data.exit_code})`;
        statusEl.style.color = 'var(--danger)';
      } else {
        statusEl.textContent = 'Status: Idle';
        statusEl.style.color = 'var(--text-dim)';
      }
    }
    if (stopBtn) {
      stopBtn.style.display = 'none';
    }
    if (resetBtn) {
      resetBtn.disabled = false;
      resetBtn.style.opacity = '1';
      resetBtn.style.cursor = 'pointer';
    }
  }
  
  if (timerEl) {
    timerEl.textContent = `Duration: ${data.duration_seconds}s`;
  }
  
  if (logsEl && data.logs) {
    const shouldScroll = logsEl.scrollHeight - logsEl.clientHeight <= logsEl.scrollTop + 100;
    logsEl.textContent = data.logs;
    if (shouldScroll) {
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  }
}

async function triggerBenchmark() {
  try {
    const btn = document.getElementById('btn-run-benchmark');
    if (btn) {
      btn.disabled = true;
    }
    const res = await fetch('/api/run-benchmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (res.status === 409) {
      alert("Benchmark is already running!");
      return;
    }
    
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    
    // Start polling immediately
    await checkRunnerStatus();
  } catch (err) {
    alert("Failed to start benchmark: " + err.message);
  }
}

async function resetBenchmarkData() {
  if (!confirm("⚠️ Are you sure you want to reset all data?\n\nThis will permanently delete your benchmark history, clear the banned models list, and reset the log files. This action cannot be undone.")) {
    return;
  }

  const runBtn = document.getElementById('btn-run-benchmark');
  const resetBtn = document.getElementById('btn-reset-data');

  try {
    if (runBtn) runBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;

    const res = await fetch('/api/reset-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (res.status === 409) {
      alert("Cannot reset data while a benchmark run is currently in progress!");
      return;
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Server returned HTTP ${res.status}`);
    }

    alert("Data reset successfully! The dashboard will now refresh to empty state.");
    
    // Refresh the data to reflect empty state
    await loadDataAndRefresh();
  } catch (err) {
    alert("Failed to reset data: " + err.message);
  } finally {
    if (runBtn) runBtn.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
    // Check status to restore UI state
    await checkRunnerStatus();
  }
}

async function stopBenchmark() {
  const stopBtn = document.getElementById('btn-stop-benchmark');
  try {
    if (stopBtn) stopBtn.disabled = true;
    const res = await fetch('/api/stop-benchmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Server returned HTTP ${res.status}`);
    }
  } catch (err) {
    alert("Failed to stop benchmark: " + err.message);
  } finally {
    if (stopBtn) stopBtn.disabled = false;
    await checkRunnerStatus();
  }
}

async function toggleLoopBenchmark(e) {
  const checked = e.target.checked;
  try {
    const res = await fetch('/api/set-loop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ loop: checked })
    });
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
  } catch (err) {
    alert("Failed to toggle loop mode: " + err.message);
    e.target.checked = !checked;
  }
}

async function loadDataAndRefresh() {
  let is404 = false;
  let buf = null;
  try {
    const res = await fetch('history.db?t=' + Date.now());
    if (!res.ok) {
      if (res.status === 404) {
        is404 = true;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } else {
      buf = await res.arrayBuffer();
    }
  } catch (err) {
    if (!is404) throw err;
  }

  document.getElementById('error-state').style.display = 'none';

  await loadBannedModels();
  await loadCapabilities();

  if (is404) {
    state.db = null;
    state.modelNames = [];
    state.hiddenModels = new Set();
    state.runs = [];
    state.modelStats = {};
    document.getElementById('nav-status').textContent = '0 runs · 0/0 capable models';
  } else {
    state.db = new state.SQL.Database(new Uint8Array(buf));
    const data = loadFromDb(state.db);
    const processed = processData(data);

    // Filter out banned + never-responded (no proven capability) models
    const allNames = processed.modelNames;
    state.bannedModels = new Set(
      [...state.bannedModels].filter(m => allNames.includes(m))
    );
    state.modelNames = allNames.filter(m => {
      if (state.bannedModels.has(m)) return false;
      const s = processed.modelStats[m];
      return s && s.successCount > 0;
    });
    state.hiddenModels = new Set(
      allNames.filter(m => !state.modelNames.includes(m))
    );
    state.runs = processed.runs;
    state.modelStats = {};
    for (const m of state.modelNames) state.modelStats[m] = processed.modelStats[m];

    // Nav status
    document.getElementById('nav-status').textContent =
      `${state.runs.length} runs · ${state.modelNames.length}/${allNames.length} capable models`;
  }

  // Populate selects without re-binding event handlers
  if (!state.modelNames.includes(state.explorerModel) && state.modelNames.length > 0) {
    const sorted = [...state.modelNames].sort((a,b) => state.modelStats[b].score - state.modelStats[a].score);
    state.explorerModel = sorted[0];
  }
  populateExplorerSelect();
  populateCompareSelects();

  // Refresh current tab
  switchTab(state.currentTab);
}

// ─── Initialization ───────────────────────────────────────────────────────────
async function init() {
  try {
    const SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
    });
    state.SQL = SQL;

    await loadDataAndRefresh();

    // Init leaderboard sort
    initLeaderboardSort();

    // Select change listeners bound once
    document.getElementById('explorer-select').addEventListener('change', e => {
      state.explorerModel = e.target.value;
      renderExplorer();
    });
    document.getElementById('compare-a').addEventListener('change', renderCompare);
    document.getElementById('compare-b').addEventListener('change', renderCompare);
    document.getElementById('swap-btn').addEventListener('click', () => {
      const selA = document.getElementById('compare-a');
      const selB = document.getElementById('compare-b');
      const tmp = selA.value;
      selA.value = selB.value;
      selB.value = tmp;
      renderCompare();
    });

    // Timeline filters
    document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.timelineFilter = btn.dataset.filter;
        renderTimeline();
      });
    });

    // Nav tabs
    document.querySelectorAll('.nav-tab[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.goto));
    });

    // Modal controls
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
    document.getElementById('modal-copy').addEventListener('click', () => {
      navigator.clipboard?.writeText(state.modalResponse).then(() => {
        const btn = document.getElementById('modal-copy');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
    });

    // Runner trigger
    const runBtn = document.getElementById('btn-run-benchmark');
    if (runBtn) {
      runBtn.addEventListener('click', triggerBenchmark);
    }

    const resetBtn = document.getElementById('btn-reset-data');
    if (resetBtn) {
      resetBtn.addEventListener('click', resetBenchmarkData);
    }

    const stopBtn = document.getElementById('btn-stop-benchmark');
    if (stopBtn) {
      stopBtn.addEventListener('click', stopBenchmark);
    }

    const chkLoop = document.getElementById('chk-loop-benchmark');
    if (chkLoop) {
      chkLoop.addEventListener('change', toggleLoopBenchmark);
    }

    // Initial check on runner API server status
    await checkRunnerStatus();

    // Show app
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').classList.add('visible');

  } catch (err) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').classList.add('visible');
    document.getElementById('error-state').style.display = 'flex';
    document.getElementById('error-msg').textContent = `Error: ${err.message}. Make sure history.db exists and you're serving via HTTP.`;
    console.error('Failed to load data:', err);
  }
}

init();

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const express = require("express");
const ClaudeProbe = require("./probe");

const configPath = path.join(__dirname, "config.yaml");
const dataDir = path.join(__dirname, "data");
const historyPath = path.join(dataDir, "history.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadConfig() {
  return yaml.load(fs.readFileSync(configPath, "utf8"));
}

function parseTargets(config) {
  const defaults = config.server || {};
  return (config.targets || []).map((t, i) => ({
    id: t.id || `target_${i + 1}`,
    name: t.name || `Target ${i + 1}`,
    baseUrl: t.base_url,
    apiKey: t.api_key,
    model: t.model || "claude-sonnet-4-20250514",
    intervalMs: (t.interval_min || defaults.interval_min || 60) * 60 * 1000,
    maxHistory: t.max_history || defaults.max_history || 30,
    maxRetries: t.max_retries || defaults.max_retries || 3,
  }));
}

let config = loadConfig();
const app = express();
const PORT = config.server?.port || 3210;
let targets = parseTargets(config);

const history = new Map();

function loadHistory() {
  try {
    if (!fs.existsSync(historyPath)) return;
    const data = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    for (const [key, records] of Object.entries(data)) {
      history.set(key, records);
    }
    console.log(`Loaded history: ${history.size} target(s)`);
  } catch (err) {
    console.error(`Failed to load history: ${err.message}`);
  }
}

function saveHistory() {
  try {
    const obj = {};
    for (const [key, records] of history) obj[key] = records;
    fs.writeFileSync(historyPath, JSON.stringify(obj));
  } catch (err) {
    console.error(`Failed to save history: ${err.message}`);
  }
}

function reloadConfig() {
  try {
    config = loadConfig();
    targets = parseTargets(config);
    console.log(`Config reloaded: ${targets.length} target(s)`);
    return true;
  } catch (err) {
    console.error(`Config reload failed: ${err.message}`);
    return false;
  }
}

loadHistory();

async function runProbeWithRetry(target) {
  const maxRetries = target.maxRetries;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const probe = new ClaudeProbe({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
      });

      const result = await probe.runAll();
      result.target = target.name;
      result.targetId = target.id;
      result.attempt = attempt;

      if (!history.has(target.id)) history.set(target.id, []);
      const arr = history.get(target.id);
      arr.unshift(result);
      while (arr.length > target.maxHistory) arr.pop();

      console.log(
        `[${result.timestamp}] ${target.name}: ${result.verdict} (${result.passed}/${result.total}, ${result.duration_ms}ms, attempt ${attempt})`
      );
      saveHistory();
      return result;
    } catch (err) {
      console.error(`[RETRY ${attempt}/${maxRetries}] ${target.name}: ${err.message}`);
      if (attempt < maxRetries) await sleep(3000 * attempt);
    }
  }
  console.error(`[FAILED] ${target.name}: all ${maxRetries} attempts exhausted`);
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const schedulers = new Map();

function scheduleTarget(target) {
  if (schedulers.has(target.id)) clearInterval(schedulers.get(target.id));
  const intervalId = setInterval(() => {
    reloadConfig();
    const current = targets.find(t => t.id === target.id);
    if (current) runProbeWithRetry(current);
  }, target.intervalMs);
  schedulers.set(target.id, intervalId);
  console.log(`Scheduled ${target.name}: every ${target.intervalMs / 60000}m, keep ${target.maxHistory}, retry ${target.maxRetries}x`);
}

async function startAllProbes() {
  for (const target of targets) {
    await runProbeWithRetry(target);
    scheduleTarget(target);
  }
}

// --- Web routes ---

app.get("/", (req, res) => {
  res.send(renderDashboard());
});

app.get("/api/status", (req, res) => {
  const status = {};
  for (const target of targets) {
    const records = history.get(target.id) || [];
    status[target.id] = {
      name: target.name,
      latest: records[0] || null,
      history_count: records.length,
    };
  }
  res.json(status);
});

app.get("/api/history/:targetId", (req, res) => {
  const records = history.get(req.params.targetId) || [];
  res.json(records);
});

app.post("/api/probe/:targetId?", async (req, res) => {
  reloadConfig();
  const targetId = req.params.targetId;
  const target = targets.find((t) => t.id === targetId) || targets[0];
  if (!target) return res.status(404).json({ error: "No target configured" });

  try {
    const result = await runProbeWithRetry(target);
    if (result) res.json(result);
    else res.status(500).json({ error: "All retry attempts failed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function renderDashboard() {
  const now = new Date().toISOString();

  const targetCards = targets
    .map((t) => {
      const records = history.get(t.id) || [];
      const latest = records[0];

      if (!latest) {
        return `<article class="target-card waiting">
          <header class="card-header">
            <h2 class="target-name">${t.name}</h2>
            <span class="verdict-tag verdict-pending">PENDING</span>
          </header>
          <p class="waiting-msg">Awaiting first probe cycle...</p>
        </article>`;
      }

      const verdictClass =
        latest.verdict === "genuine" ? "verdict-genuine" :
        latest.verdict === "suspect" ? "verdict-suspect" : "verdict-counterfeit";

      const checks = latest.checks
        .map((c) => {
          const stateClass = c.passed === true ? "check-pass" : c.passed === false ? "check-fail" : "check-warn";
          const indicator = c.passed === true ? "PASS" : c.passed === false ? "FAIL" : "WARN";
          return `<div class="check-item ${stateClass}">
            <div class="check-indicator">${indicator}</div>
            <div class="check-body">
              <span class="check-name">${c.name}</span>
              <span class="check-detail">${c.detail}</span>
            </div>
          </div>`;
        })
        .join("");

      const timeAgo = getTimeAgo(latest.timestamp);

      const timeline = records.slice(0, 30).map((r) => {
        const cls = r.verdict === "genuine" ? "dot-genuine" : r.verdict === "suspect" ? "dot-suspect" : "dot-counterfeit";
        return `<span class="timeline-dot ${cls}" title="${r.timestamp} — ${r.verdict}"></span>`;
      }).join("");

      const retryInfo = latest.attempt > 1 ? ` (attempt ${latest.attempt})` : "";

      return `<article class="target-card">
          <header class="card-header">
            <div class="card-title-group">
              <h2 class="target-name">${t.name}</h2>
              <span class="target-meta">${t.model} &middot; every ${t.intervalMs / 60000}m &middot; ${timeAgo}${retryInfo}</span>
            </div>
            <span class="verdict-tag ${verdictClass}">${latest.verdict.toUpperCase()}</span>
          </header>
          <div class="card-metrics">
            <div class="metric">
              <span class="metric-value">${latest.passed}<span class="metric-sep">/</span>${latest.total}</span>
              <span class="metric-label">Checks passed</span>
            </div>
            <div class="metric">
              <span class="metric-value">${latest.duration_ms}<span class="metric-unit">ms</span></span>
              <span class="metric-label">Latency</span>
            </div>
            <div class="metric">
              <span class="metric-value">${records.length}<span class="metric-sep">/</span>${t.maxHistory}</span>
              <span class="metric-label">Samples</span>
            </div>
          </div>
          <div class="checks-list">${checks}</div>
          <footer class="card-footer">
            <div class="timeline">${timeline}</div>
            <button class="probe-btn" onclick="probeTarget('${t.id}')">Probe now</button>
          </footer>
        </article>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Claude Probe</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root {
  --bg: #101014;
  --bg-elevated: #1a1a20;
  --border: #2a2a32;
  --border-strong: #3a3a44;
  --text-primary: #e4e2de;
  --text-secondary: #908d88;
  --text-tertiary: #5c5a56;
  --genuine: #34d399;
  --genuine-bg: #0d2818;
  --genuine-border: #166534;
  --suspect: #fbbf24;
  --suspect-bg: #291e00;
  --suspect-border: #854d0e;
  --counterfeit: #f87171;
  --counterfeit-bg: #2a0a0a;
  --counterfeit-border: #991b1b;
  --pending: #5c5a56;
  --pending-bg: #1e1e24;
  --accent: #e87b4a;
  --font-body: 'DM Sans', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text-primary);
  line-height: 1.5;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

.shell {
  max-width: 960px;
  margin: 0 auto;
  padding: clamp(1.5rem, 4vw, 3rem) clamp(1rem, 3vw, 2rem);
}

/* --- Header --- */
.page-header {
  margin-bottom: clamp(2rem, 5vw, 3.5rem);
  border-bottom: 2px solid var(--text-primary);
  padding-bottom: 1.25rem;
}

.page-title {
  font-size: clamp(1.75rem, 4vw, 2.5rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
}

.page-subtitle {
  margin-top: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  padding: 0.25rem 0.625rem;
  border-radius: 2px;
}

.status-pill::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--genuine);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.probe-legend {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

/* --- Target Cards --- */
.targets-grid {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.target-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  padding: clamp(1.25rem, 3vw, 1.75rem);
  position: relative;
  transition: border-color 0.2s;
}

.target-card:hover {
  border-color: var(--border-strong);
}

.target-card.waiting {
  opacity: 0.6;
}

.waiting-msg {
  font-size: 0.875rem;
  color: var(--text-tertiary);
  font-style: italic;
  margin-top: 0.75rem;
}

/* Card Header */
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.card-title-group {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.target-name {
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.target-meta {
  font-size: 0.7rem;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

/* Verdict Tags */
.verdict-tag {
  font-size: 0.6875rem;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
  padding: 0.3rem 0.625rem;
  border: 1.5px solid;
}

.verdict-genuine { color: var(--genuine); background: var(--genuine-bg); border-color: var(--genuine-border); }
.verdict-suspect { color: var(--suspect); background: var(--suspect-bg); border-color: var(--suspect-border); }
.verdict-counterfeit { color: var(--counterfeit); background: var(--counterfeit-bg); border-color: var(--counterfeit-border); }
.verdict-pending { color: var(--pending); background: var(--pending-bg); border-color: var(--border); }

/* Card Metrics */
.card-metrics {
  display: flex;
  gap: clamp(1.5rem, 4vw, 3rem);
  margin-bottom: 1.5rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.metric-value {
  font-size: 1.5rem;
  font-weight: 300;
  letter-spacing: -0.02em;
  font-family: var(--font-mono);
  line-height: 1;
}

.metric-sep { opacity: 0.3; }
.metric-unit { font-size: 0.75rem; opacity: 0.5; margin-left: 0.125rem; }

.metric-label {
  font-size: 0.6875rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;
}

/* Checks List */
.checks-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}

.check-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.625rem 0;
  border-bottom: 1px dashed var(--border);
}

.check-item:last-child { border-bottom: none; }

.check-indicator {
  font-size: 0.5625rem;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.1em;
  padding: 0.2rem 0.4rem;
  min-width: 3rem;
  text-align: center;
  flex-shrink: 0;
  margin-top: 0.125rem;
}

.check-pass .check-indicator { color: var(--genuine); background: var(--genuine-bg); border: 1px solid var(--genuine-border); }
.check-fail .check-indicator { color: var(--counterfeit); background: var(--counterfeit-bg); border: 1px solid var(--counterfeit-border); }
.check-warn .check-indicator { color: var(--suspect); background: var(--suspect-bg); border: 1px solid var(--suspect-border); }

.check-body {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.check-name {
  font-size: 0.8125rem;
  font-weight: 500;
}

.check-detail {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  word-break: break-word;
  line-height: 1.4;
}

/* Card Footer & Timeline */
.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}

.timeline {
  display: flex;
  gap: 3px;
  align-items: center;
}

.timeline-dot {
  width: 8px;
  height: 8px;
  border-radius: 1px;
  display: block;
}

.dot-genuine { background: var(--genuine); }
.dot-suspect { background: var(--suspect); }
.dot-counterfeit { background: var(--counterfeit); }

.probe-btn {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  background: none;
  border: 1px solid var(--border);
  padding: 0.375rem 0.75rem;
  cursor: pointer;
  transition: all 0.15s;
}

.probe-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

/* --- Empty State --- */
.empty-state {
  text-align: left;
  padding: 3rem 0;
  border: 1px dashed var(--border-strong);
  padding: 2rem;
}

.empty-state h3 {
  font-size: 1rem;
  margin-bottom: 0.5rem;
}

.empty-state p {
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.empty-state code {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  background: var(--pending-bg);
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--border);
}

/* --- Responsive --- */
@media (max-width: 640px) {
  .card-metrics { gap: 1rem; }
  .metric-value { font-size: 1.25rem; }
  .card-header { flex-direction: column; gap: 0.5rem; }
  .timeline-dot { width: 6px; height: 6px; }
}
</style>
</head>
<body>
<div class="shell">
  <header class="page-header">
    <h1 class="page-title">Claude Probe</h1>
    <div class="page-subtitle">
      <span class="status-pill">Monitoring ${targets.length} target${targets.length !== 1 ? 's' : ''}</span>
      <span class="probe-legend">bdrk &middot; cache &middot; censorship</span>
    </div>
  </header>
  <section class="targets-grid">
    ${targetCards || `<div class="empty-state"><h3>No targets configured</h3><p>Add targets in <code>config.yaml</code> and restart.</p></div>`}
  </section>
</div>
<script>
async function probeTarget(id) {
  const btn = event.target;
  btn.textContent = 'Probing...';
  btn.disabled = true;
  try {
    await fetch('/api/probe/' + id, { method: 'POST' });
    location.reload();
  } catch(e) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Probe now'; btn.disabled = false; }, 2000);
  }
}
setInterval(() => location.reload(), 60000);
</script>
</body>
</html>`;
}

function getTimeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  return hr + 'h ago';
}

// --- Start ---

app.listen(PORT, () => {
  console.log(`Claude Probe server running at http://localhost:${PORT}`);
  console.log(`Targets: ${targets.map((t) => `${t.name} (${t.intervalMs / 60000}m)`).join(", ") || "NONE"}`);

  if (targets.length > 0) startAllProbes();
});

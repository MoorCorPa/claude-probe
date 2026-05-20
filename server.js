const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const express = require("express");
const ClaudeProbe = require("./probe");
const { getAvailableChecks } = require("./probe");

const configPath = path.join(__dirname, "config.yaml");
const dataDir = path.join(__dirname, "data");
const historyPath = path.join(dataDir, "history.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadConfig() {
  return yaml.load(fs.readFileSync(configPath, "utf8"));
}

function parseTargets(config) {
  const defaults = config.server || {};
  const rawTargets = config.targets || [];
  const result = [];

  for (const t of rawTargets) {
    const models = t.models || (t.model ? [t.model] : ["claude-sonnet-4-20250514"]);
    for (const model of models) {
      const baseId = t.id || t.name || "target";
      const id = models.length > 1 ? `${baseId}_${model.replace(/[^a-zA-Z0-9]/g, "_")}` : (t.id || `target_${result.length + 1}`);
      result.push({
        id,
        name: t.name || `Target ${result.length + 1}`,
        baseUrl: t.base_url,
        apiKey: t.api_key,
        model,
        checks: t.checks || null,
        intervalMs: (t.interval_min || defaults.interval_min || 60) * 60 * 1000,
        maxHistory: t.max_history || defaults.max_history || 30,
        maxRetries: t.max_retries || defaults.max_retries || 3,
      });
    }
  }
  return result;
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
        checks: target.checks,
      });

      const result = await probe.runAll();
      result.target = target.name;
      result.targetId = target.id;
      result.model = target.model;
      result.attempt = attempt;

      if (!history.has(target.id)) history.set(target.id, []);
      const arr = history.get(target.id);
      arr.unshift(result);
      while (arr.length > target.maxHistory) arr.pop();

      console.log(
        `[${result.timestamp}] ${target.name} (${target.model}): ${result.verdict} (${result.passed}/${result.total}, ${result.duration_ms}ms, attempt ${attempt})`
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

// --- Email alert when all checks fail (non-network) ---

const nodemailer = require("nodemailer");

function getMailTransporter() {
  const smtp = config.actions?.email?.smtp;
  if (!smtp) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port || 465,
    secure: smtp.secure !== false,
    auth: { user: smtp.user, pass: smtp.pass },
  });
}

async function sendAlertEmail(result) {
  const emailConfig = config.actions?.email;
  if (!emailConfig) return;

  const { from, to, smtp } = emailConfig;
  if (!smtp || !from || !to) return;

  const transporter = getMailTransporter();
  if (!transporter) return;

  const checks = result.checks
    .map((c) => `${c.passed === true ? "PASS" : c.passed === false ? "FAIL" : "WARN"} | ${c.name}\n      ${c.detail}`)
    .join("\n\n");

  const failedChecks = result.checks.filter(c => c.passed === false);
  const failedNames = failedChecks.map(c => c.name).join(", ");
  const subject = `[Claude Probe ALERT] ${result.target} (${result.model || "?"}) — ${failedChecks.length} check${failedChecks.length > 1 ? "s" : ""} FAILED`;
  const text = `Target: ${result.target}
Model: ${result.model || "unknown"}
Verdict: ${result.verdict.toUpperCase()}
Time: ${result.timestamp}
Duration: ${result.duration_ms}ms
Score: ${result.passed}/${result.total}

--- Check Details ---

${checks}

---
This is an automated alert from Claude Probe.`;

  try {
    await transporter.sendMail({ from, to, subject, text });
    console.log(`[EMAIL] Alert sent to ${to}`);
  } catch (err) {
    console.error(`[EMAIL] Failed to send: ${err.message}`);
  }
}

function shouldAlert(result) {
  if (!result || result.verdict === "unavailable") return false;
  return result.failed > 0;
}

async function handleProbeResult(result) {
  if (shouldAlert(result)) {
    console.log(`[ALERT] ${result.failed} check(s) FAILED for ${result.target} (${result.model}) — sending email alert`);
    await sendAlertEmail(result);
  }
}

const schedulers = new Map();

function scheduleTarget(target) {
  if (schedulers.has(target.id)) clearInterval(schedulers.get(target.id));
  const intervalId = setInterval(async () => {
    reloadConfig();
    const current = targets.find(t => t.id === target.id);
    if (current) {
      const result = await runProbeWithRetry(current);
      if (result) await handleProbeResult(result);
    }
  }, target.intervalMs);
  schedulers.set(target.id, intervalId);
  console.log(`Scheduled ${target.name} (${target.model}): every ${target.intervalMs / 60000}m, keep ${target.maxHistory}, retry ${target.maxRetries}x`);
}

async function startAllProbes() {
  for (const target of targets) {
    const result = await runProbeWithRetry(target);
    if (result) await handleProbeResult(result);
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
      model: target.model,
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
  // Group targets by name
  const grouped = new Map();
  for (const t of targets) {
    if (!grouped.has(t.name)) grouped.set(t.name, []);
    grouped.get(t.name).push(t);
  }

  const groupNames = [...grouped.keys()];

  // Build tab buttons
  const tabButtons = groupNames.map((name, i) => {
    const group = grouped.get(name);
    const hasFailure = group.some(t => {
      const r = (history.get(t.id) || [])[0];
      return r && r.failed > 0;
    });
    const dotClass = hasFailure ? "tab-dot-fail" : "tab-dot-ok";
    return `<button class="tab-btn${i === 0 ? " active" : ""}" data-tab="${i}"><span class="tab-dot ${dotClass}"></span>${name}</button>`;
  }).join("");

  // Build tab panels
  const tabPanels = groupNames.map((name, i) => {
    const group = grouped.get(name);
    const firstTarget = group[0];

    const modelRows = group.map((t) => {
      const records = history.get(t.id) || [];
      const latest = records[0];

      if (!latest) {
        return `<div class="model-row waiting">
          <div class="model-row-summary">
            <span class="model-name">${t.model}</span>
            <span class="model-row-right"><span class="verdict-tag verdict-pending">PENDING</span></span>
          </div>
        </div>`;
      }

      const verdictClass =
        latest.verdict === "genuine" ? "verdict-genuine" :
        latest.verdict === "suspect" ? "verdict-suspect" :
        latest.verdict === "unavailable" ? "verdict-unavailable" : "verdict-counterfeit";

      const timeAgo = getTimeAgo(latest.timestamp);
      const retryInfo = latest.attempt > 1 ? ` attempt ${latest.attempt}` : "";

      // Expanded detail: checks + raw data + timeline
      const checks = latest.checks.map((c) => {
        const stateClass = c.passed === true ? "check-pass" : c.passed === false ? "check-fail" : "check-warn";
        const indicator = c.passed === true ? "PASS" : c.passed === false ? "FAIL" : "WARN";
        const rawHtml = c.raw ? `<pre class="check-raw">${escapeHtml(typeof c.raw === "string" ? c.raw : JSON.stringify(c.raw, null, 2))}</pre>` : "";
        return `<div class="check-item ${stateClass}">
          <div class="check-indicator">${indicator}</div>
          <div class="check-body">
            <span class="check-name">${c.name}</span>
            <span class="check-detail">${escapeHtml(c.detail)}</span>
            ${rawHtml}
          </div>
        </div>`;
      }).join("");

      const timeline = records.slice(0, 30).map((r) => {
        const cls = r.verdict === "genuine" ? "dot-genuine" : r.verdict === "suspect" ? "dot-suspect" : r.verdict === "unavailable" ? "dot-unavailable" : "dot-counterfeit";
        return `<span class="timeline-dot ${cls}" title="${r.timestamp} — ${r.verdict}"></span>`;
      }).join("");

      return `<div class="model-row">
        <div class="model-row-summary" onclick="this.parentElement.classList.toggle('expanded')">
          <span class="model-name">${t.model}</span>
          <span class="model-info">${timeAgo}${retryInfo} &middot; ${latest.duration_ms}ms</span>
          <span class="verdict-tag ${verdictClass}">${latest.verdict.toUpperCase()}</span>
          <span class="model-stats">${latest.passed}<span class="sep">/</span>${latest.total}</span>
          <span class="model-samples">${records.length}<span class="sep">/</span>${t.maxHistory}</span>
          <span class="expand-icon"></span>
        </div>
        <div class="model-row-detail">
          <div class="detail-section">
            <div class="detail-metrics">
              <div class="metric"><span class="metric-value">${latest.passed}<span class="sep">/</span>${latest.total}</span><span class="metric-label">Passed</span></div>
              <div class="metric"><span class="metric-value">${latest.failed}</span><span class="metric-label">Failed</span></div>
              <div class="metric"><span class="metric-value">${latest.duration_ms}<span class="unit">ms</span></span><span class="metric-label">Latency</span></div>
              <div class="metric"><span class="metric-value">${records.length}<span class="sep">/</span>${t.maxHistory}</span><span class="metric-label">Samples</span></div>
            </div>
            <div class="checks-list">${checks}</div>
            <div class="detail-footer">
              <div class="timeline">${timeline}</div>
              <button class="probe-btn" onclick="event.stopPropagation();probeTarget('${t.id}')">Probe now</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join("");

    return `<div class="tab-panel${i === 0 ? " active" : ""}" data-panel="${i}">
      <div class="panel-header">
        <span class="panel-meta">every ${firstTarget.intervalMs / 60000}m &middot; ${group.length} model${group.length > 1 ? "s" : ""}</span>
      </div>
      <div class="model-list">${modelRows}</div>
    </div>`;
  }).join("");

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
  --bg-card: #16161c;
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
  --unavailable: #818cf8;
  --unavailable-bg: #1e1b3a;
  --unavailable-border: #4338ca;
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
  margin-bottom: 1.5rem;
  border-bottom: 2px solid var(--text-primary);
  padding-bottom: 1rem;
}

.page-title {
  font-size: clamp(1.75rem, 4vw, 2.5rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
}

.page-subtitle {
  margin-top: 0.4rem;
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
  width: 6px; height: 6px;
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

/* --- Tabs --- */
.tabs-bar {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1.25rem;
  overflow-x: auto;
}

.tab-btn {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-tertiary);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.625rem 1rem;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.tab-btn:hover { color: var(--text-secondary); }
.tab-btn.active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
}

.tab-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.tab-dot-ok { background: var(--genuine); }
.tab-dot-fail { background: var(--counterfeit); }

.tab-panel { display: none; }
.tab-panel.active { display: block; }

.panel-header {
  margin-bottom: 0.75rem;
}

.panel-meta {
  font-size: 0.7rem;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

/* --- Model List --- */
.model-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.model-row {
  border: 1px solid var(--border);
  border-bottom: none;
  background: var(--bg-elevated);
  transition: border-color 0.15s;
}

.model-row:last-child { border-bottom: 1px solid var(--border); }
.model-row:hover { border-color: var(--border-strong); }
.model-row + .model-row { margin-top: -1px; }

.model-row.waiting .model-row-summary {
  opacity: 0.5;
}

/* Summary row */
.model-row-summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
}

.model-row-summary:hover {
  background: var(--bg-card);
}

.model-name {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-primary);
  min-width: 0;
  flex-shrink: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-info {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-tertiary);
  white-space: nowrap;
  flex-shrink: 0;
  margin-left: auto;
}

.model-stats, .model-samples {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.model-stats .sep, .model-samples .sep { opacity: 0.3; }

.expand-icon {
  width: 16px; height: 16px;
  flex-shrink: 0;
  position: relative;
}

.expand-icon::after {
  content: '';
  position: absolute;
  top: 50%; left: 50%;
  width: 6px; height: 6px;
  border-right: 1.5px solid var(--text-tertiary);
  border-bottom: 1.5px solid var(--text-tertiary);
  transform: translate(-50%, -65%) rotate(45deg);
  transition: transform 0.2s;
}

.model-row.expanded .expand-icon::after {
  transform: translate(-50%, -35%) rotate(-135deg);
}

/* Verdict Tags */
.verdict-tag {
  font-size: 0.5625rem;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
  padding: 0.2rem 0.4rem;
  border: 1.5px solid;
  white-space: nowrap;
  flex-shrink: 0;
}

.verdict-genuine { color: var(--genuine); background: var(--genuine-bg); border-color: var(--genuine-border); }
.verdict-suspect { color: var(--suspect); background: var(--suspect-bg); border-color: var(--suspect-border); }
.verdict-counterfeit { color: var(--counterfeit); background: var(--counterfeit-bg); border-color: var(--counterfeit-border); }
.verdict-unavailable { color: var(--unavailable); background: var(--unavailable-bg); border-color: var(--unavailable-border); }
.verdict-pending { color: var(--pending); background: var(--pending-bg); border-color: var(--border); }

/* --- Expanded Detail --- */
.model-row-detail {
  display: none;
  background: var(--bg-card);
  border-top: 1px solid var(--border);
}

.model-row.expanded .model-row-detail {
  display: block;
}

.detail-section {
  padding: 1rem 1.25rem;
}

.detail-metrics {
  display: flex;
  gap: 2rem;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
}

.metric-value {
  font-size: 1.125rem;
  font-weight: 300;
  font-family: var(--font-mono);
  line-height: 1;
}

.metric-value .sep { opacity: 0.3; }
.metric-value .unit { font-size: 0.65rem; opacity: 0.5; margin-left: 0.125rem; }

.metric-label {
  font-size: 0.6rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;
}

/* Checks */
.checks-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}

.check-item {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.4rem 0;
  border-bottom: 1px dashed var(--border);
}
.check-item:last-child { border-bottom: none; }

.check-indicator {
  font-size: 0.5rem;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.1em;
  padding: 0.15rem 0.35rem;
  min-width: 2.75rem;
  text-align: center;
  flex-shrink: 0;
  margin-top: 0.1rem;
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
  font-size: 0.75rem;
  font-weight: 500;
}

.check-detail {
  font-size: 0.675rem;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  word-break: break-word;
  line-height: 1.35;
}

.check-raw {
  font-size: 0.625rem;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 0.5rem 0.625rem;
  margin-top: 0.375rem;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.4;
}

/* Footer & Timeline */
.detail-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 0.625rem;
  border-top: 1px solid var(--border);
}

.timeline {
  display: flex;
  gap: 2px;
  align-items: center;
}

.timeline-dot {
  width: 7px; height: 7px;
  border-radius: 1px;
  display: block;
}

.dot-genuine { background: var(--genuine); }
.dot-suspect { background: var(--suspect); }
.dot-counterfeit { background: var(--counterfeit); }
.dot-unavailable { background: var(--unavailable); }

.probe-btn {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  background: none;
  border: 1px solid var(--border);
  padding: 0.3rem 0.6rem;
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
  border: 1px dashed var(--border-strong);
  padding: 2rem;
}
.empty-state h3 { font-size: 1rem; margin-bottom: 0.5rem; }
.empty-state p { color: var(--text-secondary); font-size: 0.875rem; }
.empty-state code {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  background: var(--pending-bg);
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--border);
}

/* --- Responsive --- */
@media (max-width: 640px) {
  .model-row-summary { flex-wrap: wrap; gap: 0.4rem; }
  .model-info { margin-left: 0; }
  .detail-metrics { gap: 1rem; flex-wrap: wrap; }
  .timeline-dot { width: 5px; height: 5px; }
}
</style>
</head>
<body>
<div class="shell">
  <header class="page-header">
    <h1 class="page-title">Claude Probe</h1>
    <div class="page-subtitle">
      <span class="status-pill">Monitoring ${targets.length} target${targets.length !== 1 ? 's' : ''}</span>
      <span class="probe-legend">${getAvailableChecks().join(' &middot; ')}</span>
    </div>
  </header>
  <nav class="tabs-bar">${tabButtons}</nav>
  ${tabPanels || `<div class="empty-state"><h3>No targets configured</h3><p>Add targets in <code>config.yaml</code> and restart.</p></div>`}
</div>
<script>
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.querySelector('[data-panel="' + btn.dataset.tab + '"]').classList.add('active');
  });
});
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

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  console.log(`Available checks: ${getAvailableChecks().join(", ")}`);
  console.log(`Targets: ${targets.map((t) => `${t.name}/${t.model} [${(t.checks || getAvailableChecks()).join(",")}] (${t.intervalMs / 60000}m)`).join(", ") || "NONE"}`);

  if (targets.length > 0) startAllProbes();
});

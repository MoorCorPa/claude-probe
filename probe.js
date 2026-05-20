const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const checksDir = path.join(__dirname, "checks");
const registry = {};

function loadChecks() {
  const files = fs.readdirSync(checksDir).filter(f => f.endsWith(".js") && f !== "utils.js");
  for (const file of files) {
    const slug = path.basename(file, ".js");
    const mod = require(path.join(checksDir, file));
    const entries = Array.isArray(mod) ? mod : [mod];
    for (let i = 0; i < entries.length; i++) {
      const key = entries.length > 1 ? `${slug}_${i}` : slug;
      registry[key] = entries[i];
    }
  }
}

loadChecks();

function getAvailableChecks() {
  return Object.keys(registry);
}

class ClaudeProbe {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model || "claude-sonnet-4-20250514";
    this.client = new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
    });
    this.checkNames = config.checks || Object.keys(registry);
  }

  async runAll() {
    const startTime = Date.now();
    const checks = this.checkNames
      .map(n => registry[n])
      .filter(Boolean);

    const results = await Promise.all(
      checks.map(async (check) => {
        try {
          const r = await check.run(this.client, this.model);
          return { name: check.name, ...r };
        } catch (err) {
          return { name: check.name, passed: false, detail: `Unexpected error: ${err.message}`, raw: null };
        }
      })
    );

    const duration = Date.now() - startTime;
    const passedCount = results.filter(r => r.passed === true).length;
    const failedCount = results.filter(r => r.passed === false).length;
    const warnCount = results.filter(r => r.passed === null).length;

    let verdict = "genuine";
    if (failedCount === 0 && warnCount === results.length) verdict = "unavailable";
    else if (failedCount >= 2) verdict = "counterfeit";
    else if (failedCount === 1) verdict = "suspect";

    return {
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      verdict,
      passed: passedCount,
      failed: failedCount,
      total: results.length,
      checks: results,
    };
  }
}

module.exports = ClaudeProbe;
module.exports.getAvailableChecks = getAvailableChecks;

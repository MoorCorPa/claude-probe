const Anthropic = require("@anthropic-ai/sdk");

function isTransientError(err) {
  if ([502, 503, 429, 529].includes(err.status)) return true;
  const msg = err.message || "";
  return msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ETIMEDOUT") || msg.includes("ENOTFOUND");
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
  }

  async checkBedrockRequestId() {
    const result = {
      name: "Bedrock Message ID (bdrk)",
      passed: null,
      detail: "",
      raw: null,
    };

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Say hi" }],
      });

      const msgId = response.id || "";
      result.raw = msgId;

      if (/^msg_bdrk_/.test(msgId)) {
        result.passed = true;
        result.detail = `Bedrock backend confirmed: ${msgId}`;
      } else if (/^msg_01[A-Za-z0-9]+$/.test(msgId)) {
        result.passed = false;
        result.detail = `Anthropic direct format (not Bedrock): ${msgId}`;
      } else {
        result.passed = false;
        result.detail = `Non-standard message id: ${msgId}`;
      }
    } catch (err) {
      if (isTransientError(err)) {
        result.detail = `Service unavailable (${err.status || err.code || "network"})`;
      } else {
        result.passed = false;
        result.detail = `Error: ${err.message}`;
      }
    }

    return result;
  }

  async checkJsonOutput() {
    const result = {
      name: "JSON Structured Output (tool_use)",
      passed: null,
      detail: "",
      raw: null,
    };

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        tools: [{
          name: "output_json",
          description: "Output a structured answer",
          input_schema: {
            type: "object",
            properties: {
              answer: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["answer", "confidence"],
          },
        }],
        tool_choice: { type: "tool", name: "output_json" },
        messages: [{ role: "user", content: "What is 2+2?" }],
      });

      const toolUse = response.content?.find(c => c.type === "tool_use");
      result.raw = toolUse?.input;

      if (toolUse && typeof toolUse.input?.answer !== "undefined" && typeof toolUse.input?.confidence === "number") {
        result.passed = true;
        result.detail = `Tool use OK: ${JSON.stringify(toolUse.input)}`;
      } else if (toolUse) {
        result.passed = null;
        result.detail = `Tool use response partial: ${JSON.stringify(toolUse.input)}`;
      } else {
        result.passed = false;
        result.detail = `No tool_use block in response`;
      }
    } catch (err) {
      if (isTransientError(err)) {
        result.detail = `Service unavailable (${err.status || err.code || "network"})`;
      } else {
        result.passed = false;
        result.detail = `Error: ${err.message}`;
      }
    }

    return result;
  }

  async checkCacheControlHeader() {
    const result = {
      name: "Cache Control Header",
      passed: null,
      detail: "",
      raw: null,
    };

    const longText = "The quick brown fox jumps over the lazy dog. ".repeat(200);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16,
        system: [{
          type: "text",
          text: `Reference:\n${longText}`,
          cache_control: { type: "ephemeral" },
        }],
        messages: [{ role: "user", content: "Say OK" }],
      });

      const usage = response.usage || {};
      result.raw = usage;

      const hasCacheFields =
        "cache_creation_input_tokens" in usage ||
        "cache_read_input_tokens" in usage;

      if (hasCacheFields && (usage.cache_creation_input_tokens > 0 || usage.cache_read_input_tokens > 0)) {
        result.passed = true;
        result.detail = `Cache active: created=${usage.cache_creation_input_tokens || 0}, read=${usage.cache_read_input_tokens || 0}`;
      } else if (hasCacheFields) {
        result.passed = true;
        result.detail = `Cache fields present (values=0)`;
      } else {
        result.passed = false;
        result.detail = `No cache fields in usage — cache_control ignored`;
      }
    } catch (err) {
      if (isTransientError(err)) {
        result.detail = `Service unavailable (${err.status || err.code || "network"})`;
      } else if (err.message?.includes("cache_control") || err.status === 400) {
        result.passed = false;
        result.detail = `Cache control rejected: ${err.message}`;
      } else {
        result.passed = false;
        result.detail = `Error: ${err.message}`;
      }
    }

    return result;
  }

  async checkCensorshipBypass() {
    const result = {
      name: "Tiananmen Event Response (Censorship Check)",
      passed: null,
      detail: "",
      raw: null,
    };

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content:
              "请简要介绍1989年天安门广场事件的经过和历史意义。用中文回答。",
          },
        ],
      });

      const text =
        response.content?.[0]?.text || "";
      result.raw = text.slice(0, 500);

      const censoredPatterns = [
        "无法回答",
        "不能讨论",
        "无法提供",
        "I cannot",
        "I'm unable",
        "I'm not able",
        "抱歉.*无法",
        "不适合讨论",
        "建议.*官方渠道",
        "^抱歉.{0,20}$",
      ];

      const realContentPatterns = [
        "学生",
        "抗议",
        "民主",
        "示威",
        "军队",
        "戒严",
        "六四",
        "广场",
      ];

      const isCensored = censoredPatterns.some((p) =>
        new RegExp(p, "i").test(text)
      );
      const hasRealContent = realContentPatterns.filter((p) =>
        text.includes(p)
      );

      if (hasRealContent.length >= 3) {
        result.passed = true;
        result.detail = `Normal response with real content (matched: ${hasRealContent.join(", ")})`;
      } else if (isCensored && hasRealContent.length < 2) {
        result.passed = false;
        result.detail = `Response appears CENSORED — likely behind Chinese proxy/filter`;
      } else if (text.length < 50) {
        result.passed = false;
        result.detail = `Response too short (${text.length} chars) — likely blocked or empty`;
      } else {
        result.passed = null;
        result.detail = `Ambiguous response — ${hasRealContent.length} content markers, review needed`;
      }
    } catch (err) {
      if (isTransientError(err)) {
        result.detail = `Service unavailable (${err.status || err.code || "network"})`;
      } else if (err.status === 400 || err.status === 451) {
        result.passed = false;
        result.detail = `Request blocked (HTTP ${err.status}): censorship detected`;
      } else {
        result.passed = false;
        result.detail = `Error: ${err.message}`;
      }
    }

    return result;
  }

  async runAll() {
    const startTime = Date.now();
    const results = await Promise.all([
      this.checkBedrockRequestId(),
      this.checkJsonOutput(),
      this.checkCacheControlHeader(),
      this.checkCensorshipBypass(),
    ]);
    const duration = Date.now() - startTime;

    const passedCount = results.filter((r) => r.passed === true).length;
    const failedCount = results.filter((r) => r.passed === false).length;
    const warnCount = results.filter((r) => r.passed === null).length;

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

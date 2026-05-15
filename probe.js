const Anthropic = require("@anthropic-ai/sdk");

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
      name: "Bedrock Request ID (bdrk)",
      passed: null,
      detail: "",
      raw: null,
    };

    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Say hi" }],
        },
        { __binaryResponse: true }
      );

      const requestId =
        response.headers.get("x-request-id") ||
        response.headers.get("request-id") ||
        "";

      result.raw = requestId;

      if (requestId.includes("bdrk")) {
        result.passed = true;
        result.detail = `request-id contains "bdrk": ${requestId}`;
      } else if (/^req_01[A-Za-z0-9]{22}$/.test(requestId)) {
        result.passed = true;
        result.detail = `Anthropic direct format: ${requestId}`;
      } else {
        result.passed = false;
        result.detail = `No bdrk marker, non-standard format: ${requestId}`;
      }
    } catch (err) {
      result.passed = false;
      result.detail = `Error: ${err.message}`;
    }

    return result;
  }

  async checkCacheSupport() {
    const result = {
      name: "1h Prompt Cache Support",
      passed: null,
      detail: "",
      raw: null,
    };

    const longText = "A".repeat(2048);

    try {
      const r1 = await this.client.messages.create({
        model: this.model,
        max_tokens: 16,
        system: [
          {
            type: "text",
            text: `You are a helpful assistant. Context: ${longText}`,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: "Say OK" }],
      });

      const cacheCreation =
        r1.usage?.cache_creation_input_tokens ?? null;
      const cacheRead = r1.usage?.cache_read_input_tokens ?? null;

      const r2 = await this.client.messages.create({
        model: this.model,
        max_tokens: 16,
        system: [
          {
            type: "text",
            text: `You are a helpful assistant. Context: ${longText}`,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: "Say OK" }],
      });

      const cacheRead2 = r2.usage?.cache_read_input_tokens ?? null;

      result.raw = {
        first: { cache_creation: cacheCreation, cache_read: cacheRead },
        second: { cache_read: cacheRead2 },
      };

      if (cacheRead2 && cacheRead2 > 0) {
        result.passed = true;
        result.detail = `Cache hit on 2nd request: ${cacheRead2} tokens read from cache (supports extended caching)`;
      } else if (cacheCreation && cacheCreation > 0) {
        result.passed = null;
        result.detail = `Cache created (${cacheCreation} tokens) but no hit on 2nd call — may not support 1h cache`;
      } else {
        result.passed = false;
        result.detail = `No cache_creation or cache_read in usage — caching not supported`;
      }
    } catch (err) {
      if (
        err.message?.includes("cache_control") ||
        err.status === 400
      ) {
        result.passed = false;
        result.detail = `Cache not supported: ${err.message}`;
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
      if (err.status === 400 || err.status === 451) {
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
      this.checkCacheSupport(),
      this.checkCensorshipBypass(),
    ]);
    const duration = Date.now() - startTime;

    const passedCount = results.filter((r) => r.passed === true).length;
    const failedCount = results.filter((r) => r.passed === false).length;

    let verdict = "genuine";
    if (failedCount >= 2) verdict = "counterfeit";
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

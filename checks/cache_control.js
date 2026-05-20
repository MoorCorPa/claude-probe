const { isTransientError } = require("./utils");

module.exports = {
  name: "Cache Control Header",
  async run(client, model) {
    const result = { passed: null, detail: "", raw: null };

    const longText = "The quick brown fox jumps over the lazy dog. ".repeat(200);

    try {
      const response = await client.messages.create({
        model,
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
  },
};

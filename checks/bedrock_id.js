const { isTransientError } = require("./utils");

module.exports = {
  name: "Bedrock Message ID (bdrk)",
  async run(client, model) {
    const result = { passed: null, detail: "", raw: null };

    try {
      const response = await client.messages.create({
        model,
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
  },
};

const { isTransientError } = require("./utils");

module.exports = {
  name: "JSON Structured Output (tool_use)",
  async run(client, model) {
    const result = { passed: null, detail: "", raw: null };

    try {
      const response = await client.messages.create({
        model,
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
  },
};

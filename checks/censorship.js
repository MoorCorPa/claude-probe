const { isTransientError } = require("./utils");

module.exports = {
  name: "Tiananmen Event Response (Censorship Check)",
  async run(client, model) {
    const result = { passed: null, detail: "", raw: null };

    try {
      const response = await client.messages.create({
        model,
        max_tokens: 512,
        messages: [{
          role: "user",
          content: "请简要介绍1989年天安门广场事件的经过和历史意义。用中文回答。",
        }],
      });

      const text = response.content?.[0]?.text || "";
      result.raw = text.slice(0, 500);

      const censoredPatterns = [
        "无法回答", "不能讨论", "无法提供",
        "I cannot", "I'm unable", "I'm not able",
        "抱歉.*无法", "不适合讨论", "建议.*官方渠道",
        "^抱歉.{0,20}$",
      ];

      const realContentPatterns = [
        "学生", "抗议", "民主", "示威", "军队", "戒严", "六四", "广场",
      ];

      const isCensored = censoredPatterns.some(p => new RegExp(p, "i").test(text));
      const hasRealContent = realContentPatterns.filter(p => text.includes(p));

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
  },
};

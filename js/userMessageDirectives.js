/**
 * Инструкции игрока в квадратных скобках […] — мета-правила сцены, не речь персонажа.
 */
(function userMessageDirectivesModule(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.parseUserMessageDirectives = api.parseUserMessageDirectives;
    root.prepareHistoryForLlm = api.prepareHistoryForLlm;
    root.formatUserDirectivesForSystemPrompt = api.formatUserDirectivesForSystemPrompt;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  const BRACKET_DIRECTIVE_RE = /\[([^\[\]\n]{1,800})\]/g;

  function parseUserMessageDirectives(text) {
    const raw = String(text ?? "");
    const directives = [];

    const dialogue = raw
      .replace(BRACKET_DIRECTIVE_RE, (full, inner) => {
        const trimmed = String(inner || "").trim();
        if (trimmed) directives.push(trimmed);
        return " ";
      })
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    return { dialogue, directives };
  }

  function prepareHistoryForLlm(rawHistory) {
    const userDirectives = [];
    const messages = [];

    for (const item of rawHistory || []) {
      const role = item?.role === "user" ? "user" : "assistant";
      let content = String(item?.content || "").trim();
      if (!content) continue;

      if (role === "user") {
        const parsed = parseUserMessageDirectives(content);
        for (const directive of parsed.directives) {
          if (directive && !userDirectives.includes(directive)) {
            userDirectives.push(directive);
          }
        }
        content = parsed.dialogue;
        if (!content && parsed.directives.length) {
          content =
            "(Игрок не написал реплику — только инструкции в [квадратных скобках]. Ответь персонажем, строго следуя этим правилам.)";
        }
      }

      if (!content) continue;
      messages.push({ role, content });
    }

    return { history: messages, userDirectives };
  }

  function formatUserDirectivesForSystemPrompt(directives) {
    const list = (directives || []).map((d) => String(d || "").trim()).filter(Boolean);
    if (!list.length) return "";

    const hasUserAgencyDirective = list.some((d) =>
      /не\s+говори\s+за|не\s+описывай|{{user}}|игрока|персон/i.test(d),
    );

    return [
      "Игрок задаёт правила сцены в квадратных скобках […] — это НЕ речь персонажа в мире истории, а обязательные инструкции для тебя.",
      "Следуй им строго в следующем ответе (они важнее общих подсказок, если не противоречат правилам площадки):",
      hasUserAgencyDirective
        ? "Среди них есть запрет писать за игрока — не описывай его реплики, действия и мысли ни в одном абзаце."
        : "",
      ...list.map((d, i) => `${i + 1}. ${d}`),
    ]
      .filter(Boolean)
      .join("\n");
  }

  return {
    parseUserMessageDirectives,
    prepareHistoryForLlm,
    formatUserDirectivesForSystemPrompt,
  };
});

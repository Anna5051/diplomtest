/**
 * Плейсхолдеры в сценариях и сообщениях: {{user}} — имя персоны игрока, {{char}} — имя бота.
 */
(function chatTokensModule(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.substituteChatTokens = api.substituteChatTokens;
    root.resolveUserDisplayName = api.resolveUserDisplayName;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  const USER_TOKEN = /\{\{user\}\}/gi;
  const CHAR_TOKEN = /\{\{char\}\}/gi;

  function resolveUserDisplayName(options = {}) {
    const personaName = String(options.personaName ?? options.userName ?? "").trim();
    const username = String(options.username ?? "").trim();
    return personaName || username || "Пользователь";
  }

  function substituteChatTokens(text, options = {}) {
    let s = String(text ?? "");
    if (!s) return s;

    const userName = resolveUserDisplayName(options);
    const charName = String(options.charName ?? options.botName ?? "").trim();

    if (userName) {
      s = s.replace(USER_TOKEN, userName);
    }
    if (charName) {
      s = s.replace(CHAR_TOKEN, charName);
    }

    return s;
  }

  return {
    substituteChatTokens,
    resolveUserDisplayName,
  };
});

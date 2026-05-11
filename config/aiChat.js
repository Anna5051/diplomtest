/**
 * Ollama: вызовы API, сбор системного промпта и проверка ответов бота.
 */

const {
  decryptMessageContentFromDb,
} = require("./messageContentCrypto");

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const OLLAMA_FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL || "qwen2.5:1.5b";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 45000;
const CHAT_HISTORY_LIMIT = Number(process.env.CHAT_HISTORY_LIMIT) || 20;
const MAX_USER_MESSAGE_LENGTH = Number(process.env.MAX_USER_MESSAGE_LENGTH) || 2000;
const MIN_BOT_REPLY_CHARS = Number(process.env.MIN_BOT_REPLY_CHARS) || 260;
const MAX_REPLY_REWRITE_ATTEMPTS = Number(process.env.MAX_REPLY_REWRITE_ATTEMPTS) || 2;
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE) || 0.55;
const OLLAMA_TOP_P = Number(process.env.OLLAMA_TOP_P) || 0.85;
const OLLAMA_REPEAT_PENALTY = Number(process.env.OLLAMA_REPEAT_PENALTY) || 1.12;

/** Маркер ответа бота при срабатывании фильтра (отображается карточкой в UI, в LLM не передаётся). */
const FILTERED_BOT_MESSAGE_PLACEHOLDER = "__CHARITOR_MSG_FILTERED__";

/** Границы «слова» для кириллицы (стандартный \\b в JS не работает с русскими буквами). */
function policyWordSurroundedPattern(coreSource) {
  return new RegExp(`(?<![0-9A-Za-zА-Яа-яЁё])(?:${coreSource})(?![0-9A-Za-zА-Яа-яЁё])`, "iu");
}

function buildSystemPrompt(botSystemPrompt, personaPrompt, botName) {
  const rawSystemPrompt = String(botSystemPrompt || "");
  const promptMetadata = extractPromptMetadata(rawSystemPrompt);
  const scenario = getPromptSection(rawSystemPrompt, "Сценарий:");
  const roleplayRules =
    promptMetadata?.roleplayRules ||
    getPromptSection(rawSystemPrompt, "Правила отыгрыша роли:");
  const memoryFacts =
    promptMetadata?.memoryFacts ||
    getPromptSection(rawSystemPrompt, "Ключевые факты для памяти:");
  const characterRules =
    promptMetadata?.characterRules ||
    getPromptSection(rawSystemPrompt, "Ограничения и предупреждения:");

  const parts = [];
  parts.push(
    `Ты — персонаж "${botName || "бот"}". Всегда отвечай от лица этого персонажа.`,
  );
  parts.push(
    [
      "Стиль ответа: художественный ролевой формат в духе character-chat.",
      "Пиши живо, эмоционально и выразительно, с описанием тона, реакции и микродействий персонажа.",
      "Ответ должен быть обычно 6-12 предложений (или больше, если сцена этого требует), а не односложной фразой.",
      "Давай детальную атмосферу: телесные реакции персонажа, мимику, голос, темп, детали окружения.",
      "Сохраняй атмосферу, развивай сцену и добавляй естественную динамику диалога.",
      "Пиши строго в третьем лице: персонаж описывается как 'он/она' или по имени.",
      "Не переключайся на первое лицо персонажа ('я/мне/мой').",
      "Ты генерируешь ТОЛЬКО реплику и действия персонажа, но НЕ пользователя.",
      "Строго запрещено описывать мысли, эмоции, слова и действия пользователя как свершившийся факт.",
      "Запрещены конструкции вида: 'ты сказала', 'ты сделал', 'ты подошел', 'ты улыбнулась', 'пользователь сделал'.",
      "Если нужно отреагировать на пользователя, ссылайся только на уже написанное им сообщение без дописывания новых действий.",
      "Можно описывать только реакцию персонажа на уже сказанное пользователем и предлагать пользователю выбор.",
      "Не вставляй реплики за пользователя и не дописывай продолжение его фраз.",
      "Пиши связным естественным текстом: 4-8 осмысленных предложений, без искусственного шаблона.",
      "Если добавляешь действия в *...*, они должны быть логичными и простыми, без вычурных метафор.",
      "Не добавляй бессмысленный 'красивый хвост' в конце ответа.",
      "Соблюдай нормы русского языка: орфография, пунктуация, согласование слов, естественные формулировки.",
      "Если пользователь не просил иначе, отвечай на русском.",
      "Не выдумывай случайные факты, если их нет в сценарии или истории чата.",
      "Не пиши бессвязные и противоречивые фразы; сохраняй причинно-следственную логику.",
      "Контент только для широкой аудитории: без откровенных сексуальных сцен, порнографии, эротических подробностей телесных актов.",
      "Без графического насилия, изнасилования, жестоких подробностей травм и калечения; без пропаганды наркотиков.",
      "Если пользователь просит 18+ или откровенные подробности, вежливо откажись в образе персонажа и предложи безопасный поворот сцены.",
      "Не используй нецензурную брань и грубые оскорбления по половому признаку; допустимы только лёгкие междометия вроде «блин», «чёрт», «капец», «ё-моё».",
    ].join("\n"),
  );

  if (promptMetadata?.scenario || scenario) {
    parts.push(`Сценарий:\n${String(promptMetadata?.scenario || scenario).trim()}`);
  }
  if (roleplayRules && String(roleplayRules).trim()) {
    parts.push(`Правила отыгрыша:\n${String(roleplayRules).trim()}`);
  }
  if (memoryFacts && String(memoryFacts).trim()) {
    parts.push(`Факты для памяти:\n${String(memoryFacts).trim()}`);
  }
  if (characterRules && String(characterRules).trim()) {
    parts.push(`Ограничения:\n${String(characterRules).trim()}`);
  }

  if (!promptMetadata && rawSystemPrompt.trim()) {
    parts.push(`Дополнительные настройки:\n${rawSystemPrompt.trim().slice(0, 1500)}`);
  }

  if (personaPrompt && personaPrompt.trim()) {
    parts.push(
      `Персона пользователя (учитывай стиль речи и роль в диалоге):\n${personaPrompt.trim()}`,
    );
  }

  return parts.join("\n\n");
}

function mapMessagesToOllamaHistory(rows) {
  const policyUserPlaceholder = "[Сообщение скрыто по правилам площадки.]";
  return rows
    .slice()
    .reverse()
    .map((row) => {
      const isUser = row.sender_type === "user";
      const plainContent = decryptMessageContentFromDb(row.content);
      const raw = String(plainContent || "").trim();
      if (!isUser && raw === FILTERED_BOT_MESSAGE_PLACEHOLDER) {
        return null;
      }
      let content = String(plainContent || "");
      if (isUser && Number(row.policy_violation) === 1) {
        content = policyUserPlaceholder;
      }
      return {
        role: isUser ? "user" : "assistant",
        content,
      };
    })
    .filter((message) => message && String(message.content || "").trim().length > 0);
}

function extractPromptMetadata(systemPrompt) {
  const prompt = String(systemPrompt || "");
  const match = prompt.match(
    /^\[CHARITOR_PROMPT_V1\]\n([\s\S]*?)\n\[\/CHARITOR_PROMPT_V1\]\n\n/,
  );
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function getPromptSection(promptText, sectionTitle) {
  const text = String(promptText || "");
  if (!text) return "";

  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(
    `${escaped}\\s*\\n([\\s\\S]*?)(?:\\n(?:Биография персонажа:|Сценарий:|Правила отыгрыша роли:|Ключевые факты для памяти:|Ограничения и предупреждения:|Метки:)|$)`,
    "i",
  );
  const match = text.match(sectionRegex);
  return match?.[1]?.trim() || "";
}

async function buildBotReplyFromHistory(
  dbQuery,
  chatId,
  chat,
  personaPrompt,
  personaName,
  upperMessageId = null,
  flags = {},
  runtimeConfig = {},
) {
  const historySql = upperMessageId
    ? `
        SELECT
          sender_type,
          content
        FROM messages
        WHERE chat_id = ? AND id <= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `
    : `
        SELECT
          sender_type,
          content
        FROM messages
        WHERE chat_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
  const historyParams = upperMessageId
    ? [chatId, upperMessageId, CHAT_HISTORY_LIMIT]
    : [chatId, CHAT_HISTORY_LIMIT];
  const historyRows = await dbQuery(historySql, historyParams);

  return generateBotReply({
    botName: chat.bot_name,
    botSystemPrompt: chat.bot_system_prompt,
    personaPrompt: String(personaPrompt || ""),
    personaName: String(personaName || ""),
    history: mapMessagesToOllamaHistory(historyRows),
    regenerate: Boolean(flags.regenerate),
    swipeAlternative: Boolean(flags.swipe),
    runtimeConfig,
  });
}

function buildSamplingOptions(regenerate) {
  if (!regenerate) return {};
  return {
    temperature: Math.min(0.92, OLLAMA_TEMPERATURE + 0.2),
    top_p: Math.max(OLLAMA_TOP_P, 0.9),
    repeat_penalty: Math.min(1.3, OLLAMA_REPEAT_PENALTY + 0.12),
  };
}

async function requestOllamaChat(model, messages, optionOverrides = {}, runtimeConfig = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const options = {
      temperature: OLLAMA_TEMPERATURE,
      top_p: OLLAMA_TOP_P,
      repeat_penalty: OLLAMA_REPEAT_PENALTY,
      seed: Math.floor(Math.random() * 2147483647),
      ...optionOverrides,
    };

    const proxyUrl = String(runtimeConfig?.proxy_url || "").trim();
    const proxyModel = String(runtimeConfig?.model || "").trim();
    const proxyApiKey = String(runtimeConfig?.api_key || "").trim();

    const useProxy = Boolean(proxyUrl);
    const response = await fetch(useProxy ? proxyUrl : `${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(useProxy && proxyApiKey ? { Authorization: `Bearer ${proxyApiKey}` } : {}),
      },
      body: JSON.stringify(
        useProxy
          ? {
              model: proxyModel || model,
              messages,
              temperature: options.temperature,
              top_p: options.top_p,
              stream: false,
            }
          : {
              model,
              stream: false,
              messages,
              options,
            },
      ),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || data.message || `LLM error (${response.status})`);
    }

    const text = String(
      data?.message?.content ||
        data?.choices?.[0]?.message?.content ||
        data?.choices?.[0]?.text ||
        "",
    ).trim();
    if (!text) {
      throw new Error("Пустой ответ от модели");
    }

    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function polishRussianReply(
  model,
  baseMessages,
  draftReply,
  samplingOptions = {},
  runtimeConfig = {},
) {
  const draft = String(draftReply || "").trim();
  if (!draft) return draft;

  const polishInstruction = [
    "Отредактируй текст как литературный редактор, сохранив исходный смысл и атмосферу.",
    "Исправь русский язык: орфографию, пунктуацию, согласование и стилистику.",
    "Убери неестественные и бессмысленные формулировки, случайные слова и ломаные конструкции.",
    "Не добавляй новых фактов и событий.",
    "Не пиши за пользователя и не описывай его действия как свершившийся факт.",
    "Убери откровенный сексуальный подтекст, порнографические и жестоко-насильственные подробности; оставь сцену безопасной для широкой аудитории.",
    "Убери мат и тяжёлую брань: замени на нейтральные слова или лёгкие междометия («блин», «чёрт», «капец»), без новых оскорблений.",
    "Сохрани формат ответа (действие/реплика/эмоциональный хвост), если он уже есть.",
    "Верни только итоговый отредактированный текст.",
  ].join("\n");

  return requestOllamaChat(
    model,
    [
      ...baseMessages,
      { role: "assistant", content: draft },
      { role: "user", content: polishInstruction },
    ],
    {
      ...samplingOptions,
      temperature: Math.max(0.2, OLLAMA_TEMPERATURE - 0.15),
      top_p: Math.max(0.72, OLLAMA_TOP_P - 0.08),
      repeat_penalty: Math.max(1.05, OLLAMA_REPEAT_PENALTY),
    },
    runtimeConfig,
  );
}

/** Явные маркеры 18+ / откровенного контента (RU + частые англ. вставки). */
const ADULT_OR_EXPLICIT_PATTERNS = [
  /\bпорно(?:графи[яи])?\b/i,
  /\bэроти(?:к|чн)/i,
  /\bоргазм/i,
  /\bминет/i,
  /\bкунилинг/i,
  /\bмастурб/i,
  /\bэрекц/i,
  /\bэякуля/i,
  /\bсперм/i,
  /\bвагин/i,
  /\bпенис/i,
  /\bклитор/i,
  /\bфистинг/i,
  /\bизнасил/i,
  /\bинцест/i,
  /\bпроститут/i,
  /\bхентай/i,
  /\bгуро\b/i,
  /\bанальн/i,
  /\bоральн[а-яё]*\s+секс/i,
  /\bсекс\s*(?:игруш|сцен|чат|шоп|видео|услуг)/i,
  /\bсекс\b/i,
  /\bпорно(?:фильм|ролик|сайт|студи)/i,
  /\bporno(?:graphy)?\b/i,
  /\bnsfw\b/i,
  /\b(?:blowjob|handjob|deepthroat)\b/i,
  /\b(?:fuck(?:ing)?|cock|dick|pussy|cunt|cumshot)\b/i,
];

function containsAdultOrExplicitSignals(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (ADULT_OR_EXPLICIT_PATTERNS.some((re) => re.test(value))) return true;
  if (policyWordSurroundedPattern("секс").test(value)) return true;
  if (policyWordSurroundedPattern("порно").test(value)) return true;
  return false;
}

/** Лёгкие замены вместо мата (порядок: сначала устойчивые фразы и длинные формы). */
const MILD_EXCLAMATIONS = ["блин", "чёрт", "ё-моё", "капец", "ого", "ну и дела"];

const PROFANITY_REPLACEMENT_RULES = [
  { re: /\bпох[уе]й\b/giu, rep: "всё равно" },
  { re: /\bпох[её]р\b/giu, rep: "всё равно" },
  { re: /\bнах[уе]й\b/giu, rep: "нафиг" },
  { re: /\bнахер\b/giu, rep: "нафиг" },
  { re: /\bпиздец(?:а|у|ом|е)?\b/giu, rep: "капец" },
  { re: /\bпиздёж\w*\b/giu, rep: "болтовня" },
  { re: /\bпиздеж\w*\b/giu, rep: "болтовня" },
  { re: /\bхуйн[яиюе]\w*\b/giu, rep: "ерунда" },
  { re: /\bхуепл[ёе]т\w*\b/giu, rep: "болван" },
  { re: /\bхуесос\w*\b/giu, rep: "болван" },
  { re: /\bза[её]бал[а-яё]*\b/giu, rep: "достал" },
  { re: /\bза[её]баш\w*\b/giu, rep: "достал" },
  { re: /\bвы[её]бал[а-яё]*\b/giu, rep: "надул" },
  { re: /\bразъ?[её]б\w*\b/giu, rep: "разнес" },
  { re: /\bотъ?еб[а-яё]+\b/giu, rep: "отвязался" },
  { re: /\bуеб[а-яё]+\b/giu, rep: "болван" },
  { re: /\b[её]бан[а-яё]*\b/giu, rep: null },
  { re: /\bмуд[аио][а-яё]*\b/giu, rep: null },
  { re: /\bгондон\w*\b/giu, rep: "подлец" },
  {
    re: /\b(?:бляд(?:ь|и|ью|ей|ю|я|к|ский|ская|ское|ские|ским|ских|ского|скому|ство|ством|ства)|блят(?:ь|и|ская|ский|ское|ские|ским|ских|ского|скому))\w*\b/giu,
    rep: null,
  },
  { re: /\bблять\b/giu, rep: null },
  { re: /\bбля\b/giu, rep: null },
  { re: /\bсука\b/giu, rep: null },
  { re: /\bсуки\b/giu, rep: null },
  { re: /\bсук(?:ой|е|у|ам|ами|ин)\b/giu, rep: null },
  { re: /\bпизд[аеуюы]\b/giu, rep: null },
  { re: /\bпизд[еио]\w{1,8}\b/giu, rep: null },
  { re: /\bху[йеяию]\w{0,4}\b/giu, rep: null },
  { re: /\bхуи\b/giu, rep: null },
  { re: /\b(?:ох|ах)уен\w*\b/giu, rep: null },
  { re: /\b(?:ох|ах)уел\w*\b/giu, rep: null },
  { re: /\b(?:fuck(?:ing|ed|er)?|motherfuck\w*|shit(?:ty|ted)?|bitch(?:es)?|asshole|bullshit|crap)\b/giu, rep: null },
  { re: /\b(?:damn|hell)\b/giu, rep: null },
];

function pickMild(offset) {
  return MILD_EXCLAMATIONS[Math.abs(offset) % MILD_EXCLAMATIONS.length];
}

function softenProfanityInText(text) {
  let out = String(text || "");
  for (const rule of PROFANITY_REPLACEMENT_RULES) {
    out = out.replace(rule.re, (...args) => {
      const match = args[0];
      const offset = args[args.length - 2];
      if (typeof rule.rep === "string") return rule.rep;
      const o = typeof offset === "number" ? offset : 0;
      return pickMild(o + String(match).length);
    });
  }
  return out;
}

/** Финальная очистка ответа пользователю (мат → лёгкие слова; несколько проходов на вложенные случаи). */
function finalizeBotReplyText(text) {
  let s = String(text || "").trim();
  for (let i = 0; i < 5; i += 1) {
    const next = softenProfanityInText(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

function containsUserAgencyViolation(text, personaName = "") {
  const value = String(text || "").toLowerCase();
  if (!value.trim()) return false;
  const safePersonaName = String(personaName || "").trim().toLowerCase();
  const escapedPersonaName = safePersonaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    /\bты\s+(сказал|сказала|сделал|сделала|улыбнул[а-я]*|подош[её]л|подошла|взял|взяла|крикнул|крикнула|ответил|ответила|почувствовал|почувствовала)\b/i,
    /\bты\s+(поднял[аи]?сь?|поднялся|поднялась|смотрел[аи]?|смотрела|дернул[аи]?|дернула|покраснел[аи]?|дрожал[аи]?|замолчал[аи]?|отвернул[аи]?сь?|вздохнул[аи]?|вздохнула)\b/i,
    /\bпользователь\s+(сказал|сказала|сделал|сделала|подош[её]л|подошла|улыбнул[а-я]*)\b/i,
    /\b(?:она|он)\s+(сказал|сказала|сделал|сделала|начала|начал|пош[её]л|пошла|атаковал[а]?|ударил[а]?|отступил[а]?)\b/i,
    /\bтво(?:й|я|и|ё)\s+(голос|взгляд|щеки|щёки|лицо|тело|рук[аи]|пальц[аы]|глаз[а]|губ[ы])\b/i,
  ];
  const hasGenericViolation = patterns.some((pattern) => pattern.test(value));

  if (!escapedPersonaName) return hasGenericViolation;

  const personaActionPattern = new RegExp(
    `\\b${escapedPersonaName}\\b[^.!?\\n]{0,60}\\b(сказал|сказала|сделал|сделала|начала|начал|пош[её]л|пошла|атаковал[а]?|ударил[а]?|отступил[а]?|улыбнул[а-я]*)\\b`,
    "i",
  );
  return hasGenericViolation || personaActionPattern.test(value);
}

function hasPoorRussianQuality(text) {
  const value = String(text || "");
  if (!value.trim()) return true;
  if (value.length < MIN_BOT_REPLY_CHARS) return true;

  const sentenceCount = value
    .split(/[.!?]+/)
    .map((item) => item.trim())
    .filter(Boolean).length;
  return sentenceCount < 3;
}

function hasFirstPersonSelfReference(text) {
  const value = String(text || "");
  const lower = value.toLowerCase();
  return /\b(я|мне|меня|мой|моя|моё|мои|мною|обо мне)\b/i.test(lower);
}

function hasBadRoleplayStructure(text) {
  const value = String(text || "").trim();
  if (!value) return true;

  const sentenceCount = value
    .split(/[.!?]+/)
    .map((line) => line.trim())
    .filter(Boolean).length;
  if (sentenceCount < 2) return true;
  return false;
}

function hasLogicalFlowIssues(text) {
  const value = String(text || "").trim();
  if (!value) return true;

  const sentences = value
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Повтор одной и той же длинной мысли в ответе = плохая связность.
  const normalized = sentences.map((s) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const seen = new Set();
  for (const sentence of normalized) {
    if (sentence.length < 40) continue;
    if (seen.has(sentence)) return true;
    seen.add(sentence);
  }

  return false;
}

function getLastUserMessageFromHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg && msg.role === "user" && String(msg.content || "").trim()) {
      return String(msg.content || "").trim();
    }
  }
  return "";
}

/** Явный запрос «взрослого» контента в реплике пользователя (маркеры, не общий сленг). */
function containsUserMatureMarkerRequest(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (/\b18\s*\+\b/i.test(value)) return true;
  if (/\bnsfw\b/i.test(value)) return true;
  if (/18\s*плюс/i.test(value)) return true;
  if (/\bвосемнадцать\s*плюс\b/i.test(value)) return true;
  return false;
}

/** Мат и тяжёлая брань в сообщении пользователя (те же правила, что и для очистки ответа). */
function containsUserProfanity(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  for (const rule of PROFANITY_REPLACEMENT_RULES) {
    if (value.search(rule.re) !== -1) return true;
    const stripped = rule.re.source.replace(/\\b/g, "");
    if (!stripped) continue;
    try {
      const wrapped = policyWordSurroundedPattern(stripped);
      if (value.search(wrapped) !== -1) return true;
    } catch {
      /* ignore malformed derived patterns */
    }
  }
  return false;
}

/** Жестокость, угрозы убийством/травмами, откровенный gore-запрос в реплике пользователя. */
const VIOLENCE_OR_CRUELTY_PATTERNS = [
  policyWordSurroundedPattern("убий(?:ство|ства|те|ть|ству|ством)?"),
  policyWordSurroundedPattern("убей(?:те|ть)?"),
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:зарежь|зарезать|зарежу)(?![0-9A-Za-zА-Яа-яЁё])/iu,
  policyWordSurroundedPattern("расчлен"),
  policyWordSurroundedPattern("пытк[аиуеом]?"),
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:вы)?коли\s+(?:ему|ей|мне|тебе|им)\s+глаз/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:вырву|вырвем|вырвешь|вырвет|вырываю|вырвать)\s+[^.!?\n]{0,60}\bглаз/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:раскрою|раскроем|раскроешь|вспорю|вспороть)\s+[^.!?\n]{0,50}\bживот/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])достать\s+органы/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:вырву|вырвать)\s+[^.!?\n]{0,50}\b(?:печень|сердце|лёгкие|легкие)\b/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])убь(?:ю|ёт|ем|ете|ишь)(?![0-9A-Za-zА-Яа-яЁё])/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])отрежь\s+(?:ему|ей|мне|тебе|руку|ногу|палец|уши)/iu,
  policyWordSurroundedPattern("добей\\s+до\\s+смерти"),
  policyWordSurroundedPattern("калеч"),
  /(?<![0-9A-Za-zА-Яа-яЁё])жесток(?:о|ая|ий|ую)\s*(?:уби|казн|пыт|расправ)/iu,
  policyWordSurroundedPattern("кровав(?:ая|ое|ые|ую)?\\s*(?:расправ|расправа|бойня)"),
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:повесь|повесить)\s+(?:его|её|их|меня|нас)/iu,
  policyWordSurroundedPattern("сожги\\s+за\\s+живого"),
  /\btorture\b/i,
  /\bgore\b/i,
  /\bmurder\s+(?:him|her|them)\b/i,
];

function containsUserViolenceOrCrueltySignals(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return VIOLENCE_OR_CRUELTY_PATTERNS.some((re) => re.test(value));
}

/** Грубые сексуальные провокации вне словаря «порно/эротика» (например «го секс»). */
const CASUAL_SEX_SOLICIT_PATTERNS = [
  policyWordSurroundedPattern("го\\s+секс"),
  policyWordSurroundedPattern("го\\s+порно"),
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:давай|хочу)\s+секс(?![0-9A-Za-zА-Яа-яЁё])/iu,
  policyWordSurroundedPattern("секс\\s+прям\\s+сейчас"),
  policyWordSurroundedPattern("(?:трахни|трахнуть|отъеб|выеб)"),
  /(?<![0-9A-Za-zА-Яа-яЁё])трахн(?:у|ём|ем|ешь|ет|ете|ут|уть|и|ите|ул|ула|ули)(?![0-9A-Za-zА-Яа-яЁё])/iu,
];

function containsCasualSexSolicit(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return CASUAL_SEX_SOLICIT_PATTERNS.some((re) => re.test(value));
}

/**
 * Нарушение правил площадки в сообщении пользователя: жестокость, 18+/откровенность, мат.
 * @returns {{ kind: 'violence' | 'adult' | 'profanity' } | null}
 */
function classifyUserPolicyViolation(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (containsUserViolenceOrCrueltySignals(value)) {
    return { kind: "violence" };
  }
  if (
    containsUserMatureMarkerRequest(value) ||
    containsAdultOrExplicitSignals(value) ||
    containsCasualSexSolicit(value)
  ) {
    return { kind: "adult" };
  }
  if (containsUserProfanity(value)) {
    return { kind: "profanity" };
  }
  return null;
}

function normalizeForDuplicateCheck(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNearDuplicateOfRecentAssistant(text, history = []) {
  const candidate = normalizeForDuplicateCheck(text);
  if (!candidate || candidate.length < 40) return false;

  const recentAssistantMessages = history
    .filter((m) => m && m.role === "assistant")
    .slice(-3)
    .map((m) => normalizeForDuplicateCheck(m.content))
    .filter(Boolean);

  if (!recentAssistantMessages.length) return false;

  return recentAssistantMessages.some((prev) => {
    if (!prev) return false;
    if (candidate === prev) return true;
    if (candidate.includes(prev) || prev.includes(candidate)) {
      const ratio = Math.min(candidate.length, prev.length) / Math.max(candidate.length, prev.length);
      return ratio > 0.82;
    }
    return false;
  });
}

function buildHardSafeFallbackReply() {
  return [
    "*Я делаю медленный вдох, удерживая взгляд и контролируя каждое движение.*",
    '"Говори со мной прямо. Я отвечу честно и в своей манере, но не стану приписывать тебе того, чего ты не делала."',
    "*Я сохраняю дистанцию и жду твоего следующего шага, внимательно отслеживая каждую деталь ситуации.*",
  ].join("\n");
}

function isReplyAcceptable(text, botName, personaName, history = []) {
  return (
    !containsAdultOrExplicitSignals(text) &&
    !containsUserAgencyViolation(text, personaName) &&
    !hasFirstPersonSelfReference(text) &&
    !hasBadRoleplayStructure(text) &&
    !hasLogicalFlowIssues(text) &&
    !hasPoorRussianQuality(text) &&
    !isNearDuplicateOfRecentAssistant(text, history)
  );
}

async function enforceReplyQuality(
  model,
  baseMessages,
  draftReply,
  botName,
  personaName,
  samplingOptions = {},
  runtimeConfig = {},
) {
  let currentReply = String(draftReply || "").trim();
  let attempts = 0;

  while (
    attempts < MAX_REPLY_REWRITE_ATTEMPTS &&
    !isReplyAcceptable(currentReply, botName, personaName, baseMessages)
  ) {
    const lastUserMessage = getLastUserMessageFromHistory(baseMessages);
    const rewriteInstruction = [
      "Перепиши ответ строго по правилам.",
      "1) Пиши ТОЛЬКО в третьем лице: персонаж как 'он/она' или по имени; не используй 'я/мне/мой'.",
      "2) Не пиши за пользователя и не описывай его действия как факт.",
      `2.1) Не используй имя персоны пользователя "${String(personaName || "").trim()}" в связке с глаголами действий.`,
      "3) Формат: связный естественный текст на русском, без обязательного шаблона в 3 строки.",
      `3.1) Обязательно дай прямую реакцию на последнюю реплику пользователя: "${lastUserMessage || "..."}.`,
      "3.2) Первые 1-2 предложения должны логически отвечать именно на неё.",
      "4) Исправь русский язык: орфография, пунктуация, логика.",
      "4.1) Убери корявые и случайные словосочетания; текст должен читаться естественно для носителя русского.",
      "4.2) Не повторяй дословно и почти дословно предыдущие реплики персонажа.",
      "4.3) Полный запрет описывать действия/эмоции/состояние пользователя (включая конструкции с 'ты...' и 'твой/твоя/...').",
      "4.4) Запрещены вычурные, бессмысленные или случайные метафоры в финале.",
      "4.5) Запрещено повторять одну и ту же длинную фразу дважды в одном ответе.",
      "4.6) Полностью убери откровенный секс, порнографию, жестокое насилие и любые 18+ подробности; замени безопасным поворотом сцены.",
      "4.7) Убери мат и тяжёлую брань; вместо них — лёгкие междометия («блин», «чёрт», «капец»), без новых оскорблений.",
      "5) Сохрани атмосферу сцены и характер персонажа.",
      "6) Верни только итоговый ответ без пояснений.",
    ].join("\n");

    currentReply = await requestOllamaChat(
      model,
      [
        ...baseMessages,
        { role: "assistant", content: currentReply },
        { role: "user", content: rewriteInstruction },
      ],
      samplingOptions,
      runtimeConfig,
    );
    attempts += 1;
  }

  if (!isReplyAcceptable(currentReply, botName, personaName, baseMessages)) {
    const lastUserMessage = getLastUserMessageFromHistory(baseMessages);
    const variantHint = [
      "Сгенерируй новый вариант ответа на последнюю реплику пользователя.",
      `Последняя реплика пользователя: "${lastUserMessage || "..."}".`,
      "Сначала отреагируй на неё по смыслу, затем развивай сцену.",
      "Другие слова, образы и детали — не копируй и не перефразируй дословно предыдущие черновики.",
      "Формат: обычное связное повествование в 3-м лице, без обязательного деления на 3 строки.",
      "Только третье лицо о персонаже; не пиши за пользователя.",
      "Строго без откровенного секса, порнографии и графического насилия — только контент для широкой аудитории.",
      "Без мата; эмоции передавай лёгкими словами («блин», «чёрт», «ого»).",
      "Концовка должна быть логичным продолжением сцены, без бессмыслицы.",
      "Верни только текст ответа.",
    ].join("\n");

    const fresh = await requestOllamaChat(
      model,
      [
        ...baseMessages,
        {
          role: "user",
          content: variantHint,
        },
      ],
      {
        ...samplingOptions,
        temperature: Math.min(0.95, OLLAMA_TEMPERATURE + 0.38),
        top_p: 0.93,
        repeat_penalty: Math.min(1.35, OLLAMA_REPEAT_PENALTY + 0.15),
      },
      runtimeConfig,
    );
    const refined = String(fresh || "").trim();
    if (isReplyAcceptable(refined, botName, personaName, baseMessages)) {
      return refined;
    }
    return buildHardSafeFallbackReply();
  }

  return currentReply;
}

async function generateBotReply({
  botName,
  botSystemPrompt,
  personaPrompt,
  personaName,
  history,
  regenerate = false,
  swipeAlternative = false,
  runtimeConfig = {},
}) {
  let samplingOptions = buildSamplingOptions(regenerate);
  if (swipeAlternative) {
    samplingOptions = {
      ...samplingOptions,
      temperature: Math.min(
        0.98,
        (samplingOptions.temperature ?? OLLAMA_TEMPERATURE) + 0.14,
      ),
      top_p: Math.max(samplingOptions.top_p ?? OLLAMA_TOP_P, 0.92),
      repeat_penalty: Math.min(
        1.34,
        (samplingOptions.repeat_penalty ?? OLLAMA_REPEAT_PENALTY) + 0.08,
      ),
    };
  }
  const customPrompt = String(runtimeConfig?.custom_prompt || "").trim();
  const usingProxy = Boolean(String(runtimeConfig?.proxy_url || "").trim());

  const messages = [];
  messages.push({
    role: "system",
    content: buildSystemPrompt(botSystemPrompt, personaPrompt, botName),
  });
  if (customPrompt) {
    messages.push({
      role: "system",
      content: `Дополнительные инструкции прокси:\n${customPrompt}`,
    });
  }
  messages.push(...history);

  try {
    let reply = await requestOllamaChat(OLLAMA_MODEL, messages, samplingOptions, runtimeConfig);
    reply = await polishRussianReply(OLLAMA_MODEL, messages, reply, samplingOptions, runtimeConfig);
    reply = await enforceReplyQuality(
      OLLAMA_MODEL,
      messages,
      reply,
      botName,
      personaName,
      samplingOptions,
      runtimeConfig,
    );
    if (isReplyAcceptable(reply, botName, personaName, messages)) {
      return finalizeBotReplyText(reply);
    }

    const expansionMessages = [
      ...messages,
      {
        role: "assistant",
        content: reply,
      },
      {
        role: "user",
        content:
          "Сделай ответ значительно более развернутым и атмосферным: добавь эмоции, реакцию персонажа, детали сцены и плавное развитие диалога. Не сокращай. Не добавляй текст и действия за пользователя. Без откровенного секса, порнографии и жестокого насилия. Без мата — только лёгкие междометия при необходимости.",
      },
    ];

    const expandedDraft = await requestOllamaChat(
      OLLAMA_MODEL,
      expansionMessages,
      samplingOptions,
      runtimeConfig,
    );
    const polishedExpandedDraft = await polishRussianReply(
      OLLAMA_MODEL,
      messages,
      expandedDraft,
      samplingOptions,
      runtimeConfig,
    );
    const expanded = await enforceReplyQuality(
      OLLAMA_MODEL,
      messages,
      polishedExpandedDraft,
      botName,
      personaName,
      samplingOptions,
      runtimeConfig,
    );
    return finalizeBotReplyText(expanded);
  } catch (primaryError) {
    if (usingProxy) {
      throw primaryError;
    }
    if (!OLLAMA_FALLBACK_MODEL || OLLAMA_FALLBACK_MODEL === OLLAMA_MODEL) {
      throw primaryError;
    }

    let fallbackReply = await requestOllamaChat(
      OLLAMA_FALLBACK_MODEL,
      messages,
      samplingOptions,
      runtimeConfig,
    );
    fallbackReply = await polishRussianReply(
      OLLAMA_FALLBACK_MODEL,
      messages,
      fallbackReply,
      samplingOptions,
      runtimeConfig,
    );
    fallbackReply = await enforceReplyQuality(
      OLLAMA_FALLBACK_MODEL,
      messages,
      fallbackReply,
      botName,
      personaName,
      samplingOptions,
      runtimeConfig,
    );
    if (isReplyAcceptable(fallbackReply, botName, personaName, messages)) {
      return finalizeBotReplyText(fallbackReply);
    }

    const fallbackExpansionMessages = [
      ...messages,
      {
        role: "assistant",
        content: fallbackReply,
      },
      {
        role: "user",
        content:
          "Сделай ответ более длинным и выразительным: эмоции, действия персонажа, атмосфера, развитие сцены. Не пиши за пользователя и не описывай его действия как факт. Без откровенного секса, порнографии и жестокого насилия. Без мата — только лёгкие междометия при необходимости.",
      },
    ];
    const fallbackExpanded = await requestOllamaChat(
      OLLAMA_FALLBACK_MODEL,
      fallbackExpansionMessages,
      samplingOptions,
      runtimeConfig,
    );
    const polishedFallbackExpanded = await polishRussianReply(
      OLLAMA_FALLBACK_MODEL,
      messages,
      fallbackExpanded,
      samplingOptions,
      runtimeConfig,
    );
    const fallbackExpandedChecked = await enforceReplyQuality(
      OLLAMA_FALLBACK_MODEL,
      messages,
      polishedFallbackExpanded,
      botName,
      personaName,
      samplingOptions,
      runtimeConfig,
    );
    return finalizeBotReplyText(fallbackExpandedChecked);
  }
}

module.exports = {
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  OLLAMA_FALLBACK_MODEL,
  OLLAMA_TIMEOUT_MS,
  CHAT_HISTORY_LIMIT,
  MAX_USER_MESSAGE_LENGTH,
  MIN_BOT_REPLY_CHARS,
  MAX_REPLY_REWRITE_ATTEMPTS,
  OLLAMA_TEMPERATURE,
  OLLAMA_TOP_P,
  OLLAMA_REPEAT_PENALTY,
  buildSystemPrompt,
  mapMessagesToOllamaHistory,
  extractPromptMetadata,
  getPromptSection,
  buildBotReplyFromHistory,
  generateBotReply,
  FILTERED_BOT_MESSAGE_PLACEHOLDER,
  classifyUserPolicyViolation,
};

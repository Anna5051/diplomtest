/**
 * Единые правила оформления ролевых ответов (Character.ai / Janitor).
 */

const FIRST_PERSON_RE =
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:я|мне|меня|мной|мой|моя|моё|мои|моему|моего|моей|обо\s+мне)(?![0-9A-Za-zА-Яа-яЁё])/iu;

const USER_BODY_NOUN =
  "(?:подбородок|лоб|нос|рот|глаз|пальц|щек|спин|рук|губ|лиц|тело|плеч|волос|ше[йя]|бедр|колен|живот|бровь|висок|затылок)";

const USER_ACTION_VERBS =
  "стоишь|сидишь|лежишь|идёшь|идешь|находишь|чувствуешь|думаешь|видишь|слышишь|можешь|должен|должна|замер|замерла|сказал|сказала|сделал|сделала|улыбнул|улыбнула|подошёл|подошла|отошла|отошёл|взял|взяла|крикнул|крикнула|ответил|ответила|повернулась|повернулся|шагнула|шагнул|кивнула|кивнул|встала|встал|села|сел|пошла|пошёл|начала|начал|почувствовал|почувствовала|прошептал|прошептала|возразил|возразила|добавил|добавила|спросил|спросила|молчишь|молчал|молчала|смотришь|смотрел|смотрела|открыла|открыл|закрыла|закрыл|протянула|протянул|отступил|отступила|схватил|схватила|бросил|бросила|присела|присел|покачала|покачал";

const PERSONA_ACTION_VERBS =
  "сказал|сказала|сделал|сделала|начала|начал|пошёл|пошла|атаковал|ударил|отступил|улыбнул|улыбнулась|улыбнулся|подошла|подошёл|ответил|ответила|кивнула|кивнул|повернулась|повернулся|шагнула|шагнул|взяла|взял|крикнула|крикнул|прошептала|прошептал|возразила|возразил|добавила|добавил|спросила|спросил|смотрела|смотрел|смотрит|замерла|замер|отошла|отошёл|встала|встал|села|сел|протянула|протянул|открыла|открыл|закрыла|закрыл|схватила|схватил|бросила|бросил|присела|присел|покачала|покачал|остановилась|остановился|останавливается|стояла|стоял|стоит|звучит|звучал|звучала|зазвучал|зазвучала|молчала|молчал|ждёт|ждет|ждала|ждал|наклонилась|наклонился|приблизилась|приблизился|отвернулась|отвернулся|подняла|поднял|опустила|опустил|вздохнула|вздохнул|рассмеялась|рассмеялся|усмехнулась|усмехнулся|коснулась|коснулся|обняла|обнял|отступила|отступил|прислонилась|прислонился";

const PERSONA_BODY_NOUN =
  "(?:голос|глаза|взгляд|руки|губы|осанк|поз(?:а|ы)|лицо|брови|улыбк|плеч|спин|волос|движени|жест|реакци|эмоци|настроени|выражени)";

const USER_AGENCY_PATTERNS = [
  new RegExp(
    `(?<![0-9A-Za-zА-Яа-яЁё])ты\\s+(?:${USER_ACTION_VERBS})(?![0-9A-Za-zА-Яа-яЁё])`,
    "iu",
  ),
  new RegExp(
    `(?<![0-9A-Za-zА-Яа-яЁё])тво(?:й|я|ё|и|ем|ей|ю)\\s+${USER_BODY_NOUN}(?![0-9A-Za-zА-Яа-яЁё])`,
    "iu",
  ),
  /за\s+твоей\s+спиной/iu,
  /перед\s+тобой/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])твоя\s+подбородок/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])твой\s+щек/iu,
  /всё,?\s+что\s+(?:ты|находишь)/iu,
];

const ROLEPLAY_FORMAT_RULES_RU = [
  "ФОРМАТ ТЕКСТА (обязательно, строго):",
  '- Прямая речь персонажа ВСЕГДА только в двойных кавычках "…" (лапки). Никогда «ёлочки».',
  '- НЕ начинай реплику с тире (—); сначала открывающая ", затем слова, затем закрывающая ".',
  "- Повествование, действия и мысли — строго в 3-м лице (он/она/имя персонажа).",
  '- Слова «я/мне/мой» допустимы ТОЛЬКО внутри прямой речи в "лапках", никогда в *звёздочках*.',
  "- Короткие действия — в *звёздочках*, от 3-го лица: *Он делает вдох.*",
  '- Крик — ЗАГЛАВНЫМИ внутри реплики: "НЕТ! СТОЙ!"',
  "- 2–4 абзаца через пустую строку.",
  '- В "лапках" только слова, которые персонаж произносит вслух — не описание сцены и не действия пользователя.',
  "ЗАПРЕЩЕНО:",
  "- копировать или пересказывать дословно прошлые сообщения чата;",
  "- описывать тело и действия пользователя (ты/твой/твоя/твои + части тела, «за твоей спиной»);",
  "- заключать в кавычки повествование («твой подбородок сдвинулся» — это не речь).",
].join("\n");

const ROLEPLAY_FORMAT_REWRITE_HINT = [
  "Не копируй прошлые реплики чата.",
  "Никогда не пиши за {{user}}: ни реплик, ни действий, ни мыслей игрока.",
  "Не описывай тело/действия пользователя (ты, твой, твоя).",
  'В "лапках" только прямая речь персонажа; повествование и *действия* — 3-е лицо.',
  "2–4 абзаца.",
].join(" ");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Абсолютное правило: бот никогда не управляет игроком ({{user}}). */
function buildNeverSpeakForUserRules(personaName = "") {
  const name = String(personaName || "").trim();
  const userRef = name || "{{user}}";

  const lines = [
    "=== СТРОГОЕ ПРАВИЛО: НЕ ПИСАТЬ ЗА ИГРОКА ({{user}}) ===",
    `Игрок в этой сцене — «${userRef}». Ты управляешь ТОЛЬКО своим персонажем.`,
    "Это правило абсолютное: его нельзя нарушать ни при каких обстоятельствах.",
    "ЗАПРЕЩЕНО:",
    `- писать прямую речь от имени ${userRef} (никаких реплик игрока в "лапках", после тире или от 1-го лица);`,
    `- описывать действия, мысли, жесты и эмоции ${userRef} как уже случившиеся;`,
    `- продолжать, дописывать или перефразировать реплику ${userRef};`,
    "- использовать «ты сделала/сказала/подошла» и любые «твой/твоя/тебе + тело/действие»;",
    "- помещать действия игрока в *звёздочки*.",
  ];

  if (name) {
    lines.push(
      `- писать «${name} сказала/сделала/…» — это речь или действие игрока, не твоего персонажа;`,
      `- описывать «голос ${name}», «глаза ${name}», «*${name} …*» и любые действия ${name} в повествовании;`,
      `- ставить реплику в "лапки" и приписывать её ${name}.`,
    );
  } else {
    lines.push("- подставлять {{user}} в связке с глаголами действий или речи.");
  }

  lines.push(
    "РАЗРЕШЕНО: реагировать на УЖЕ написанное игроком, обращаться к нему, задавать вопросы, описывать только своего персонажа и окружение.",
  );

  return lines.join("\n");
}

/** Быстрая проверка во время стрима: бот начал писать за игрока. */
function wouldViolateUserAgency(text, personaName = "") {
  if (hasUserAgencyViolation(text, personaName)) {
    return true;
  }

  const name = String(personaName || "").trim();
  if (!name) return false;

  const escaped = escapeRegex(name);
  const value = String(text || "");

  if (new RegExp(`\\*\\s*${escaped}(?:\\s|[,.!?;])`, "iu").test(value)) {
    return true;
  }

  if (new RegExp(`(?:${PERSONA_BODY_NOUN})\\s+${escaped}(?![0-9A-Za-zА-Яа-яЁё])`, "iu").test(value)) {
    return true;
  }

  return false;
}

/** Короткое напоминание в system (фоновые правила). */
function buildPreGenerationUserAgencyReminder(personaName = "") {
  const name = String(personaName || "").trim() || "{{user}}";
  return [
    "=== ПРАВИЛО АГЕНТНОСТИ ИГРОКА ===",
    `Игрок — «${name}». Ты управляешь только своим персонажем.`,
    "Не пиши реплики, действия, мысли и описания тела игрока.",
    "Обращаться к игроку по имени можно; писать от его имени — нельзя.",
  ].join("\n");
}

/**
 * Последнее user-сообщение перед генерацией — модель видит его непосредственно перед ответом.
 * Сильнее system-напоминания: снижает риск «бот пишет за {{user}}» с первого токена.
 */
function buildPreGenerationUserAgencyUserMessage(personaName = "", botName = "") {
  const userRef = String(personaName || "").trim() || "{{user}}";
  const charRef = String(botName || "").trim() || "персонаж";

  const forbidden = [
    `*${userRef} …* — действия игрока в *звёздочках*`,
    `«${userRef} сказала/сделала/пошла/…» — повествование об игроке`,
    `«голос ${userRef}», «глаза ${userRef}», «*${userRef} …*»`,
    'реплики игрока в "лапках" или от первого лица игрока',
    "«ты сказала/подошла/сделала» — описание действий игрока как факта",
  ];

  const allowed = [
    `*${charRef} …* / *она/он …* — только твой персонаж`,
    `«${userRef}, …?» — обращение К игроку, не от его имени`,
    "реакция, эмоции, речь и *действия* только своего персонажа",
  ];

  return [
    "[Перед ответом — обязательное правило сцены]",
    `Игрок: «${userRef}». Ты пишешь только «${charRef}».`,
    "ЗАПРЕЩЕНО в этом ответе:",
    ...forbidden.map((line) => `✗ ${line}`),
    "РАЗРЕШЕНО:",
    ...allowed.map((line) => `✓ ${line}`),
    "Если игрок писал инструкции в [квадратных скобках] — они обязательны и важнее общих подсказок.",
    "Сгенерируй ответ сейчас. Не дописывай за игрока — только реакция твоего персонажа на уже написанное.",
  ].join("\n");
}

function normalizeForDuplicateCheck(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Убирает прямую речь в "лапках" и «ёлочках» — для проверки повествования. */
function stripQuotedSpeech(text) {
  return String(text || "")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/«[^»\n]*»/g, " ");
}

function hasFirstPersonOutsideSpeech(text) {
  const outside = stripQuotedSpeech(text);
  return FIRST_PERSON_RE.test(outside);
}

function isQuotedUserNarration(inner) {
  const clean = String(inner || "").trim();
  if (!clean || clean.length < 8) return false;

  if (
    new RegExp(
      `(?:тво[йяёи]|твои|тебя|тебе)\\s+${USER_BODY_NOUN}`,
      "iu",
    ).test(clean)
  ) {
    return true;
  }
  if (/за\s+твоей\s+спиной/iu.test(clean)) return true;
  if (/(?:твоя|твой)\s+подбородок/iu.test(clean)) return true;
  if (/(?:сдвинул|дернул|приподнял|опустил|коснул)(?:ся|ась|ось|ись)?/iu.test(clean) && /тво/i.test(clean)) {
    return true;
  }
  if (/^(?:тво[йяёи]|твои)\s+/iu.test(clean) && !/[?!]/.test(clean.slice(-3))) {
    return true;
  }
  return false;
}

function hasQuotedUserNarration(text) {
  const quotes = String(text || "").match(/"[^"\n]{6,}"/g) || [];
  return quotes.some((q) => isQuotedUserNarration(q.slice(1, -1)));
}

function hasImplicitUserDialogue(text, personaName = "") {
  const safePersonaName = String(personaName || "").trim();
  if (!safePersonaName) return false;
  const escaped = escapeRegex(safePersonaName);

  const afterUserActionQuote = new RegExp(
    `\\*[^*\\n]{0,220}${escaped}[^*\\n]{0,220}\\*[\\s\\S]{0,160}"[^"\\n]{6,}"`,
    "iu",
  );
  if (afterUserActionQuote.test(text)) {
    return true;
  }

  const quoteBeforeUserAttribution = new RegExp(
    `"[^"\\n]{6,}"[\\s\\S]{0,80}\\*[^*\\n]{0,120}${PERSONA_BODY_NOUN}\\s+${escaped}[^*\\n]{0,80}\\*`,
    "iu",
  );
  return quoteBeforeUserAttribution.test(text);
}

function hasPersonaUserNarration(text, personaName = "") {
  const safePersonaName = String(personaName || "").trim();
  if (!safePersonaName) return false;
  const escaped = escapeRegex(safePersonaName);
  const outside = stripQuotedSpeech(text);

  const patterns = [
    new RegExp(
      `(?<![0-9A-Za-zА-Яа-яЁё])${escaped}(?![0-9A-Za-zА-Яа-яЁё])[^.!?\\n]{0,100}(?:${PERSONA_ACTION_VERBS})`,
      "iu",
    ),
    new RegExp(
      `(?<![0-9A-Za-zА-Яа-яЁё])${PERSONA_BODY_NOUN}\\s+${escaped}(?![0-9A-Za-zА-Яа-яЁё])`,
      "iu",
    ),
    new RegExp(
      `(?<![0-9A-Za-zА-Яа-яЁё])${escaped}(?![0-9A-Za-zА-Яа-яЁё])[^.!?\\n]{0,40}${PERSONA_BODY_NOUN}`,
      "iu",
    ),
  ];

  return patterns.some((re) => re.test(outside));
}

function hasAttributedUserSpeech(text, personaName = "") {
  const value = String(text || "");
  const safePersonaName = String(personaName || "").trim();
  if (safePersonaName) {
    const escaped = escapeRegex(safePersonaName);
    const attributionPatterns = [
      new RegExp(
        `["«][^"»\\n]{2,}["»][^\\n]{0,48}(?:${PERSONA_ACTION_VERBS})\\s+${escaped}(?![0-9A-Za-zА-Яа-яЁё])`,
        "iu",
      ),
      new RegExp(
        `(?:${PERSONA_ACTION_VERBS})\\s+${escaped}\\s*[:—–-]\\s*["«]`,
        "iu",
      ),
      new RegExp(`${escaped}\\s*[:—–-]\\s*["«][^"»\\n]{2,}`, "iu"),
      new RegExp(
        `[—–-]\\s*[^\\n—–-]{2,}[—–-]\\s*(?:${PERSONA_ACTION_VERBS})\\s+${escaped}(?![0-9A-Za-zА-Яа-яЁё])`,
        "iu",
      ),
      new RegExp(`\\*[^*\\n]{0,160}${escaped}[^*\\n]{0,160}\\*`, "iu"),
    ];
    if (attributionPatterns.some((re) => re.test(value))) {
      return true;
    }
  }

  if (
    /(?:сказал|сказала|прошептал|прошептала|ответил|ответила|возразил|возразила)\s+(?:ты|пользователь)(?![0-9A-Za-zА-Яа-яЁё])/iu.test(
      value,
    )
  ) {
    return true;
  }

  if (
    /\{\{user\}\}[^.!?\n]{0,40}(?:сказал|сказала|сделал|сделала|подошла|подошёл|ответил|ответила)/iu.test(
      value,
    )
  ) {
    return true;
  }

  return false;
}

function hasUserAgencyViolation(text, personaName = "") {
  if (hasQuotedUserNarration(text)) {
    return true;
  }
  if (hasAttributedUserSpeech(text, personaName)) {
    return true;
  }
  if (hasImplicitUserDialogue(text, personaName)) {
    return true;
  }
  if (hasPersonaUserNarration(text, personaName)) {
    return true;
  }

  const outside = stripQuotedSpeech(text);
  if (!outside.trim()) return false;

  if (USER_AGENCY_PATTERNS.some((re) => re.test(outside))) {
    return true;
  }

  return false;
}

function hasObviousRussianGrammarErrors(text) {
  const v = String(text || "");
  return (
    /(?:твоя|моя|его|её|ее)\s+(?:подбородок|лоб|нос|рот|глаз|палец|бровь|затылок|висок|живот)(?![0-9A-Za-zА-Яа-яЁё])/iu.test(
      v,
    ) ||
    /(?:твой|мой)\s+(?:щека|рука|губа|бровь|нога|спина|щека)(?![0-9A-Za-zА-Яа-яЁё])/iu.test(v)
  );
}

function isNearDuplicateOfVariants(text, variants = []) {
  const candidate = normalizeForDuplicateCheck(text);
  if (!candidate || candidate.length < 30) return false;

  for (const variant of variants || []) {
    const prev = normalizeForDuplicateCheck(variant);
    if (!prev || prev.length < 30) continue;
    if (candidate === prev) return true;

    const shorter = Math.min(candidate.length, prev.length);
    const longer = Math.max(candidate.length, prev.length);
    if (shorter / longer > 0.72 && (candidate.includes(prev) || prev.includes(candidate))) {
      return true;
    }

    const cWords = candidate.split(" ").slice(0, 16);
    const pWords = prev.split(" ").slice(0, 16);
    let matched = 0;
    for (let i = 0; i < Math.min(cWords.length, pWords.length); i += 1) {
      if (cWords[i] === pWords[i]) matched += 1;
      else break;
    }
    if (matched >= 8) return true;
  }

  return false;
}

function isNearDuplicateOfHistory(text, history = []) {
  const candidate = normalizeForDuplicateCheck(text);
  if (!candidate || candidate.length < 40) return false;

  const pool = (history || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => normalizeForDuplicateCheck(m.content))
    .filter((s) => s.length >= 40);

  for (const prev of pool) {
    if (candidate === prev) return true;

    const headLen = Math.min(100, prev.length);
    const head = prev.slice(0, headLen);
    if (head.length >= 45 && candidate.startsWith(head.slice(0, Math.min(55, head.length)))) {
      return true;
    }
    if (head.length >= 50 && candidate.includes(head)) {
      const ratio = head.length / Math.max(candidate.length, 1);
      if (ratio > 0.28) return true;
    }

    const cWords = candidate.split(" ").slice(0, 14);
    const pWords = prev.split(" ").slice(0, 14);
    let matched = 0;
    for (let i = 0; i < Math.min(cWords.length, pWords.length); i += 1) {
      if (cWords[i] === pWords[i]) matched += 1;
      else break;
    }
    if (matched >= 7) return true;
  }

  return false;
}

/**
 * @param {string} text
 * @returns {{ ok: boolean, issues: string[] }}
 */
function validateRoleplayFormatting(text, personaName = "") {
  const issues = [];
  const v = String(text || "").trim();
  if (!v) {
    return { ok: false, issues: ["пустой текст"] };
  }

  if (/[«»]/.test(v)) {
    issues.push('используются «ёлочки» вместо "лапок"');
  }

  const lines = v.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^[—–-]\s+/.test(line) && !/^["*]/.test(line)) {
      issues.push("абзац начинается с тире вместо кавычек или повествования");
      break;
    }
  }

  const asciiQuotes = v.match(/"[^"\n]{2,}"/g) || [];
  if (asciiQuotes.length < 1) {
    issues.push('нет прямой речи в "лапках"');
  }

  if (hasFirstPersonOutsideSpeech(v)) {
    issues.push('«я/мне/мой» вне прямой речи');
  }
  if (hasQuotedUserNarration(v)) {
    issues.push("в кавычках описание пользователя, а не речь");
  }
  if (hasObviousRussianGrammarErrors(v)) {
    issues.push("грамматическая ошибка (род/число)");
  }
  if (hasUserAgencyViolation(v, personaName)) {
    issues.push("бот пишет за пользователя ({{user}})");
  }

  return { ok: issues.length === 0, issues };
}

module.exports = {
  ROLEPLAY_FORMAT_RULES_RU,
  ROLEPLAY_FORMAT_REWRITE_HINT,
  buildNeverSpeakForUserRules,
  buildPreGenerationUserAgencyReminder,
  buildPreGenerationUserAgencyUserMessage,
  wouldViolateUserAgency,
  stripQuotedSpeech,
  hasFirstPersonOutsideSpeech,
  hasUserAgencyViolation,
  hasAttributedUserSpeech,
  hasImplicitUserDialogue,
  hasPersonaUserNarration,
  hasQuotedUserNarration,
  isQuotedUserNarration,
  hasObviousRussianGrammarErrors,
  isNearDuplicateOfHistory,
  normalizeForDuplicateCheck,
  isNearDuplicateOfVariants,
  validateRoleplayFormatting,
};

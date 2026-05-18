/**
 * Единые правила оформления ролевых ответов (Character.ai / Janitor).
 */

const FIRST_PERSON_RE =
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:я|мне|меня|мной|мой|моя|моё|мои|моему|моего|моей|обо\s+мне)(?![0-9A-Za-zА-Яа-яЁё])/iu;

const USER_BODY_NOUN =
  "(?:подбородок|лоб|нос|рот|глаз|пальц|щек|спин|рук|губ|лиц|тело|плеч|волос|ше[йя]|бедр|колен|живот|бровь|висок|затылок)";

const USER_AGENCY_PATTERNS = [
  /(?<![0-9A-Za-zА-Яа-яЁё])ты\s+(?:стоишь|сидишь|лежишь|идёшь|идешь|находишь|чувствуешь|думаешь|видишь|слышишь|можешь|должен|должна|замер|замерла|сказал|сказала|сделал|сделала|улыбнул|подошёл|подошла|взял|взяла|крикнул|ответил|почувствовал)(?![0-9A-Za-zА-Яа-яЁё])/iu,
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
  "Не описывай тело/действия пользователя (ты, твой, твоя).",
  'В "лапках" только прямая речь персонажа; повествование и *действия* — 3-е лицо.',
  "2–4 абзаца.",
].join(" ");

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

function hasUserAgencyViolation(text, personaName = "") {
  if (hasQuotedUserNarration(text)) {
    return true;
  }

  const outside = stripQuotedSpeech(text);
  if (!outside.trim()) return false;

  if (USER_AGENCY_PATTERNS.some((re) => re.test(outside))) {
    return true;
  }

  const safePersonaName = String(personaName || "").trim().toLowerCase();
  if (!safePersonaName) return false;

  const escaped = safePersonaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const personaActionPattern = new RegExp(
    `(?<![0-9A-Za-zА-Яа-яЁё])${escaped}(?![0-9A-Za-zА-Яа-яЁё])[^.!?\\n]{0,60}(?:сказал|сказала|сделал|сделала|начала|начал|пошёл|пошла|атаковал|ударил|отступил|улыбнул)`,
    "iu",
  );
  return personaActionPattern.test(outside);
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
function validateRoleplayFormatting(text) {
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

  return { ok: issues.length === 0, issues };
}

module.exports = {
  ROLEPLAY_FORMAT_RULES_RU,
  ROLEPLAY_FORMAT_REWRITE_HINT,
  stripQuotedSpeech,
  hasFirstPersonOutsideSpeech,
  hasUserAgencyViolation,
  hasQuotedUserNarration,
  isQuotedUserNarration,
  hasObviousRussianGrammarErrors,
  isNearDuplicateOfHistory,
  normalizeForDuplicateCheck,
  isNearDuplicateOfVariants,
  validateRoleplayFormatting,
};

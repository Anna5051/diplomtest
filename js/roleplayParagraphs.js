/**
 * Форматирование ролевых ответов: мало абзацев; прямая речь в "лапках" (после постобработки).
 */
(function roleplayParagraphsModule(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.structureRoleplayParagraphs = api.structureRoleplayParagraphs;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  function stripBrokenLead(text) {
    return String(text || "")
      .replace(/^[.\s,;]+(?=[А-ЯЁA-Z«"*"*])/u, "")
      .trim();
  }

  /** «ёлочки» и типографские кавычки → ASCII " для отображения. */
  function toAsciiDialogueQuotes(text) {
    return String(text || "")
      .replace(/[«»„“”]/g, '"')
      .replace(/"{3,}/g, '"')
      .replace(/([^\\])"{2}/g, '$1"');
  }

  function quoteSpeech(speech) {
    let s = stripBrokenLead(String(speech || ""));
    if (!s) return s;
    s = s.replace(/^[«»""]+|[«»""]+$/g, "").trim();
    if (!s) return "";
    return `«${s}»`;
  }

  function unwrapQuotes(paragraph) {
    const p = String(paragraph || "").trim();
    let m = p.match(/^«([\s\S]+)»$/);
    if (m) return m[1].trim();
    m = p.match(/^"([\s\S]+)"$/);
    if (m) return m[1].trim();
    return null;
  }

  const WORD_END = String.raw`(?=\s|[,.!?…»:;»]|$)`;

  const SPEECH_ATTR_RE = new RegExp(
    `^(?:(?:она|он|[А-ЯЁ][а-яё]{2,})\\s+)?(?:сказала|произнесла|прошептала|шепнула|усмехнулась|вздохнула|проговорила|спросила|ответила)${WORD_END}`,
    "iu",
  );

  /** Убирает кривые « посреди слова и пустые пары. */
  function fixMalformedGuillemets(text) {
    let p = String(text || "");

    p = p.replace(/«([^»]{3,}?)\.«»+/gu, "«$1.»");
    p = p.replace(/«([^»]{3,}?)([.!?…])»+/gu, "«$1$2»");
    p = p.replace(/«([^»]+?)»(?=\s+[А-ЯЁ])/gu, (full, inner, offset, str) => {
      if (/[.!?…]$/.test(inner)) return full;
      const tail = str.slice(offset + full.length);
      if (/^\s+(?:Теперь|Потом|Затем|После|Вдруг|Она|Он)(?=\s|[,.!?…]|$)/iu.test(tail)) {
        return `«${inner}.»`;
      }
      return full;
    });
    p = p.replace(/«\s*»+/g, "");
    p = p.replace(/»{2,}/g, "»");
    p = p.replace(/«{2,}/g, "«");
    p = p.replace(/([.!?…])\s*»+\s*(?=[А-ЯЁ])/gu, (m, punct, offset, str) => {
      const before = str.slice(Math.max(0, offset - 120), offset);
      if (/«[^»]{2,}$/u.test(before + punct)) return m;
      return `${punct} `;
    });
    p = p.replace(/«\s*\.\s*/g, "«");
    p = p.replace(/\.+\s*«\s*/g, (m, offset, str) => {
      const before = str.slice(Math.max(0, offset - 24), offset);
      const after = str.slice(offset + m.length, offset + m.length + 1);
      if (/[а-яё]\s*$/u.test(before) && /^[а-яё]/u.test(after)) return ". ";
      return m;
    });
    p = p.replace(/»+(?![^«]*«)\s*$/u, "");
    p = p.replace(/([.!?…])\s*»\s*$/u, "$1");

    return balanceGuillemets(p);
  }

  function balanceGuillemets(paragraph) {
    let open = 0;
    let out = "";
    for (const ch of String(paragraph || "")) {
      if (ch === "«") {
        if (open > 0) continue;
        open = 1;
        out += ch;
      } else if (ch === "»") {
        if (open === 0) continue;
        open = 0;
        out += ch;
      } else {
        out += ch;
      }
    }
    if (open > 0) {
      out += "»";
    }
    return out;
  }

  function isQuotedNarration(paragraph) {
    const inner = unwrapQuotes(paragraph);
    if (!inner) return false;

    const clean = stripBrokenLead(inner);
    if (clean.length < 100 && /[?!]$/.test(clean) && /^(?:я|мне|ты|тебе)/iu.test(clean)) {
      return false;
    }

    if (/[.!?…]\s+—\s+/u.test(clean) || SPEECH_ATTR_RE.test(clean)) {
      return false;
    }

    const narrationSignals = [
      /(?:его|её|ее|ей|ему)\s+(?:голос|взгляд|рука|пальцы|губы|лицо)/iu,
      /(?:он|она)\s+(?:сказала?|произнесла?|шепнула?|усмехнулась?|наклонила|вздохнула|посмотрела)/iu,
      /(?:голос|взгляд|речь)\s+(?:прозвучал|стал|был|звучал)/iu,
      /прозвучал[аио]?/iu,
    ];

    return narrationSignals.some((re) => re.test(clean));
  }

  function isUserMetaParagraph(paragraph) {
    const p = String(paragraph || "").trim();
    if (!p || p.startsWith("*")) return false;

    const metaPatterns = [
      /^ты\s+(?:стоишь|сидишь|лежишь|идёшь|идешь|находишь|чувствуешь|думаешь|видишь|слышишь|можешь|должен|должна|замер|замерла)(?:\s|[,.!?]|$)/iu,
      /перед\s+тобой/iu,
      /всё,?\s+что\s+(?:ты|находишь|можешь)/iu,
      /(?:^|\s)находишь\s+в\s+себе\s+силы/iu,
    ];

    if (metaPatterns.some((re) => re.test(p))) return true;

    const lower = p.toLowerCase();
    const tyCount = (lower.match(/(?:^|\s)ты(?:\s|[,.!?]|$)/gu) || []).length;
    const tebia = (lower.match(/(?:^|\s)(?:тебя|тебе|тобой|твой|твоя|твоё|твои)(?:\s|[,.!?]|$)/gu) || []).length;
    const hasThirdPerson =
      /(?:он|она)\s+(?:сказала|произнесла|наклонила)/iu.test(p) ||
      /[А-ЯЁ][а-яё]{2,}\s+(?:сказала|произнесла)/u.test(p);
    const hasBotFirstPerson = /(?:^|[.!?…]\s+)(?:я|мне|мной|мой|моя|моё|мои)(?:\s|,|\.|!|\?|$)/imu.test(p);

    if ((tyCount >= 2 || tebia >= 2) && !hasThirdPerson && !hasBotFirstPerson) {
      return true;
    }

    return false;
  }

  function isNarrationOnly(p) {
    const t = String(p || "").trim();
    if (!t || t.startsWith("«") || t.startsWith("*")) return false;
    return /^(?:Она|Он|Каэлит)\s+/u.test(t);
  }

  const USER_BODY =
    "(?:подбородок|лоб|нос|рот|глаз|пальц|щек|спин|рук|губ|лиц|тело|плеч|волос|ше[йя]|бедр|колен|живот|бровь)";

  /** Реплика: обращение/вопрос, не описание тела пользователя. */
  function isStrictDialogueSentence(sentence) {
    const t = stripBrokenLead(sentence);
    if (!t || t.length < 5) return false;
    if (/^[«*"*]/.test(t) || isNarrationOnly(t)) return false;

    if (/^(?:Прощение|Теперь|Потом|Затем|После|Вдруг|Она|Он|Каэлит)\s+/iu.test(t)) {
      return false;
    }

    if (
      new RegExp(`^(?:тво[йяёи]|твои|тебя|тебе)\\s+${USER_BODY}`, "iu").test(t) ||
      /^(?:твоя|твой)\s+подбородок/iu.test(t) ||
      /^за\s+твоей\s+спиной/iu.test(t)
    ) {
      return false;
    }

    return new RegExp(
      `^(?:ты|тебе|расскажи|скажи|нет|да|отпустить|прости|понять|какая|что\\s+ещё|а\\s+я|я|мне|мой|моя|моё|мои)${WORD_END}`,
      "iu",
    ).test(t);
  }

  function isQuotedUserNarrationInner(inner) {
    const clean = stripBrokenLead(String(inner || ""));
    if (!clean || clean.length < 8) return false;
    if (new RegExp(`(?:тво[йяёи]|твои|тебя|тебе)\\s+${USER_BODY}`, "iu").test(clean)) {
      return true;
    }
    if (/^(?:тво[йяёи]|твои)\s+/iu.test(clean) && !/[?!]$/.test(clean.trim())) {
      return true;
    }
    if (/(?:сдвинул|дернул|приподнял|коснул)(?:ся|ась|ось|ись)?/iu.test(clean) && /тво/i.test(clean)) {
      return true;
    }
    return false;
  }

  function repairMisquotedSegments(text) {
    return String(text || "").replace(/"([^"\n]{6,})"/g, (full, inner) => {
      if (isQuotedUserNarrationInner(inner)) {
        return stripBrokenLead(inner) || full;
      }
      const wrapped = `"${inner}"`;
      if (isQuotedNarration(wrapped)) {
        return stripBrokenLead(unwrapQuotes(wrapped) || inner) || full;
      }
      return full;
    });
  }

  function convertInlineEmDashes(paragraph) {
    let p = String(paragraph || "");

    p = p.replace(
      /—\s*(«[^»]+»)\s+—\s+((?:прошептала|сказала|произнесла|шепнула|усмехнулась|вздохнула|проговорила|спросила|ответила)[^.!?…]{0,80}[.!?…]?)/giu,
      "$1 — $2",
    );

    p = p.replace(
      /(\s|^|[.!?…*])—\s+([^—\n«]{1,240}?)([,!?…]*)\s+—\s+((?:(?:она|он|[А-ЯЁ][а-яё]{2,})\s+)?(?:сказала|произнесла|прошептала|шепнула|усмехнулась|вздохнула|проговорила|произнесла|спросила)[^.!?…]{0,80}[.!?…]?)/giu,
      (m, before, speech, punct, tag) => {
        const inner = speech.trim();
        if (/^«/.test(inner)) return `${before}${inner}${punct || ""} — ${tag.trim()}`;
        return `${before}${quoteSpeech(`${inner}${punct || ""}`)} — ${tag.trim()}`;
      },
    );

    p = p.replace(
      /(\s|^|[.!?…*])—\s+([^—\n«]{2,200}?)([.!?…,])(?=\s|$)/gu,
      (m, before, speech, punct, offset, str) => {
        const inner = speech.trim();
        const pre = str.slice(Math.max(0, offset - 6), offset);
        if (
          /»\s*$/.test(pre) ||
          /^«/.test(inner) ||
          isNarrationOnly(inner) ||
          SPEECH_ATTR_RE.test(inner)
        ) {
          return m;
        }
        return `${before}${quoteSpeech(`${inner}${punct}`)}`;
      },
    );

    return p;
  }

  function splitSentences(text) {
    const parts = [];
    let buf = "";
    const s = String(text || "");

    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      buf += ch;
      if (/[.!?…]/.test(ch)) {
        if (s[i + 1] === "»") {
          buf += "»";
          i += 1;
        }
        parts.push(buf);
        buf = "";
      }
    }
    if (buf) parts.push(buf);
    return parts.length ? parts : [s];
  }

  /** Префикс «Прощение» / «Теперь» + реплика в кавычках. */
  function quoteLeadingNarrationSpeech(paragraph) {
    const p = String(paragraph || "");
    const closed = p.match(
      /^((?:Прощение|Теперь|Потом|Затем|После|Вдруг)\s+)(«[^»]+»)\s*(.*)$/su,
    );
    if (closed) {
      const tail = closed[3].trim();
      const head = `${closed[1]}${balanceGuillemets(closed[2].trim())}`;
      return tail ? `${head} ${applyConservativeQuotes(tail)}` : head;
    }

    const open = p.match(
      /^((?:Прощение|Теперь|Потом|Затем|После|Вдруг)\s+)([^.!?…:]{4,}?)([.!?…])(.*)$/su,
    );
    if (!open) return null;

    const prefix = open[1];
    let speech = open[2].trim();
    const punct = open[3];
    const tail = open[4].trim();

    if (speech.startsWith("«")) {
      speech = balanceGuillemets(speech);
    } else if (isStrictDialogueSentence(speech) || /^(?:это|я|мне|ты)(?=\s|[,.!?…]|$)/iu.test(speech)) {
      speech = quoteSpeech(`${speech}${punct}`);
    } else {
      return null;
    }

    return tail ? `${prefix}${speech} ${applyConservativeQuotes(tail)}` : `${prefix}${speech}`;
  }

  /** Кавычки только у явных реплик: — …, или предложение с «Ты/Я/мне» в начале; после двоеточия. */
  function applyConservativeQuotes(paragraph) {
    if (/^\*[^*\n]+?\*$/.test(String(paragraph || "").trim())) {
      return paragraph;
    }

    let p = fixMalformedGuillemets(paragraph);
    const leading = quoteLeadingNarrationSpeech(p);
    if (leading) return balanceGuillemets(leading);

    if (/^(?:Прощение|Теперь|Потом|Затем|После|Вдруг)\s+/iu.test(p)) {
      p = p.replace(
        /^(Прощение|Теперь|Потом|Затем|После|Вдруг)(\s+[^«]+?)([.!?…])(\s+(?:Теперь|Потом|Затем|После|Вдруг)\b)/iu,
        "$1«$2$3»$4",
      );
    }

    const sentences = splitSentences(p);
    const rebuilt = sentences.map((raw) => {
      let s = raw.trim();
      if (!s) return raw;

      if (/«[^»]+»\s+—\s+/u.test(s)) {
        return balanceGuillemets(s);
      }

      if (/^«[^»]+»$/.test(s) || (/«[^»]+»/.test(s) && !/\s+—\s+/.test(s))) {
        return balanceGuillemets(s);
      }

      const colon = s.match(/^(.+?):\s*(.+)$/s);
      if (colon) {
        const head = colon[1].trim();
        const tail = colon[2].trim().replace(/»+$/g, "");
        if (!tail.startsWith("«") && (isStrictDialogueSentence(tail) || /^что\s+ещё\s+ты/iu.test(tail))) {
          return `${head}: ${quoteSpeech(tail)}`;
        }
        return s;
      }

      if (isStrictDialogueSentence(s) && !s.includes("«")) {
        return quoteSpeech(s);
      }

      return s;
    });

    return balanceGuillemets(rebuilt.join(sentences.length > 1 ? " " : ""));
  }

  function convertParagraphDashesToQuotes(paragraph) {
    let p = String(paragraph || "").trim();
    if (!p || p.startsWith("*")) return p;

    p = p.replace(
      /([.!?…])\s+[—–-]\s*(«[^»]+»)\s+[—–-]\s+((?:прошептала|сказала|произнесла|шепнула|спросила)[^.!?…]{0,80}[.!?…]?)/giu,
      "$1 $2 — $3",
    );

    if (!/^[—–-]\s*/.test(p)) return p;

    let rest = p.replace(/^[—–-]\s+/, "").trim();
    if (!rest) return p;

    const attrAfterComma = rest.match(/^(.+?)([,!?…]*)\s+[—–-]\s+(.+)$/s);
    if (attrAfterComma) {
      return `${quoteSpeech(attrAfterComma[1].trim() + (attrAfterComma[2] || ""))} — ${attrAfterComma[3].trim()}`;
    }

    const attrAfterSentence = rest.match(/^(.+?[.!?…])\s+[—–-]\s+(.+)$/s);
    if (attrAfterSentence) {
      return `${quoteSpeech(attrAfterSentence[1].trim())} — ${attrAfterSentence[2].trim()}`;
    }

    const multi = rest.match(/^(.+?[.!?…])\s+(.+)$/s);
    if (multi && multi[2].trim().length > 8) {
      const first = multi[1].trim();
      const tail = multi[2].trim();
      const quotedFirst = isStrictDialogueSentence(first) ? quoteSpeech(first) : first;
      const quotedTail = isStrictDialogueSentence(tail) ? quoteSpeech(tail) : tail;
      return `${quotedFirst} ${quotedTail}`;
    }

    if (isStrictDialogueSentence(rest)) {
      return quoteSpeech(rest);
    }

    return rest;
  }

  function sanitizeRoleplayParagraph(paragraph) {
    let p = stripBrokenLead(convertParagraphDashesToQuotes(paragraph));
    if (!p) return null;

    if (isUserMetaParagraph(p)) return null;

    if (isQuotedNarration(p)) {
      p = stripBrokenLead(unwrapQuotes(p) || p);
    }

    p = convertInlineEmDashes(p);
    p = applyConservativeQuotes(p);
    p = fixMalformedGuillemets(p);

    return stripBrokenLead(p) || null;
  }

  function isActionBlock(p) {
    return /^\*[^*\n]+?\*$/.test(String(p || "").trim());
  }

  function isSpeechBridge(paragraph) {
    const p = String(paragraph || "").trim();
    if (!p || p.startsWith("«") || p.startsWith("*")) return false;
    if (p.length > 200) return false;

    return (
      /(?:его|её|ее|ей)\s+(?:голос|взгляд|речь)/iu.test(p) ||
      /(?:голос|речь)\s+прозвучал/iu.test(p) ||
      /(?:сказала|произнесла|шепнула|усмехнулась|вздохнула|прошептала)/iu.test(p)
    );
  }

  function hasDialogue(p) {
    return /«/.test(String(p || ""));
  }

  function mergeJanitorParagraphs(blocks) {
    const merged = [];

    for (let i = 0; i < blocks.length; i += 1) {
      let cur = blocks[i];

      while (i + 1 < blocks.length) {
        const next = blocks[i + 1];
        if (isUserMetaParagraph(next)) {
          i += 1;
          continue;
        }

        if (isActionBlock(cur) || isActionBlock(next)) break;

        if (isSpeechBridge(next)) {
          cur = `${cur} ${next}`;
          i += 1;
          continue;
        }

        if (hasDialogue(cur) && hasDialogue(next) && next.length < 120 && !isSpeechBridge(next)) {
          cur = `${cur} ${next}`;
          i += 1;
          continue;
        }

        if (
          !hasDialogue(cur) &&
          !hasDialogue(next) &&
          !isActionBlock(cur) &&
          cur.length < 320 &&
          next.length < 320
        ) {
          const curSents = (cur.match(/[.!?…]/g) || []).length;
          const nextSents = (next.match(/[.!?…]/g) || []).length;
          if (curSents + nextSents <= 4) {
            cur = `${cur} ${next}`;
            i += 1;
            continue;
          }
        }

        break;
      }

      merged.push(stripBrokenLead(cur));
    }

    return merged.filter(Boolean);
  }

  function gentleInitialSplit(text) {
    let s = String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
    if (!s) return s;

    return s.replace(/\n{3,}/g, "\n\n").trim();
  }

  function structureRoleplayParagraphs(text) {
    let s = stripBrokenLead(gentleInitialSplit(text));
    if (!s) return s;

    const blocks = s
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map(sanitizeRoleplayParagraph)
      .filter(Boolean);

    const merged = toAsciiDialogueQuotes(
      stripBrokenLead(mergeJanitorParagraphs(blocks).join("\n\n")),
    );
    return repairMisquotedSegments(merged);
  }

  return {
    structureRoleplayParagraphs,
    repairMisquotedSegments,
    toAsciiDialogueQuotes,
    convertParagraphDashesToQuotes,
    isUserMetaParagraph,
    sanitizeRoleplayParagraph,
  };
});

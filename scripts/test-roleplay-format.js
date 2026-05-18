/**
 * Юнит-тесты постобработки и валидации формата ролевых ответов.
 * node scripts/test-roleplay-format.js
 */
const { structureRoleplayParagraphs } = require("../js/roleplayParagraphs");
const {
  validateRoleplayFormatting,
  hasFirstPersonOutsideSpeech,
  hasUserAgencyViolation,
  isNearDuplicateOfHistory,
  isNearDuplicateOfVariants,
} = require("../config/roleplayFormatRules");
const { finalizeBotReplyText, buildHardSafeFallbackReply } = require("../config/aiChat");

const samples = [
  {
    name: "тире → лапки",
    in: "— Какая наивность. Ты действительно думаешь, что я так просто отдам то, что теперь считаю своим?",
    mustHave: /"[^"]+"/,
    mustNot: /[«»]/,
  },
  {
    name: "ёлочки → лапки",
    in: "Она усмехнулась. — «Отпустить?» — спросила она холодно.",
    mustHave: /"Отпустить\?"/,
    mustNot: /[«»]/,
  },
  {
    name: "действие в звёздочках",
    in: '*она наклонилась ближе*\n\n"Ты правда так думаешь?" — прошептала она.',
    mustHave: /\*она наклонилась/,
  },
];

let failed = 0;

for (const sample of samples) {
  const out = structureRoleplayParagraphs(sample.in);
  const check = validateRoleplayFormatting(out);
  const ok =
    check.ok &&
    (!sample.mustHave || sample.mustHave.test(out)) &&
    (!sample.mustNot || !sample.mustNot.test(out));

  console.log(ok ? "OK" : "FAIL", sample.name);
  console.log("  OUT:", out.replace(/\n/g, "\\n"));
  if (!ok) {
    failed += 1;
    if (!check.ok) console.log("  issues:", check.issues.join("; "));
  }
  console.log("---");
}

const finalizeSample =
  'Он замер. «Нет,» — сказал он. *Это невозможно.* «Я не позволю.»';
const finalized = finalizeBotReplyText(finalizeSample);
const finalizeCheck = validateRoleplayFormatting(finalized);
console.log(finalizeCheck.ok ? "OK" : "FAIL", "finalizeBotReplyText");
console.log("  OUT:", finalized.replace(/\n/g, "\\n"));
if (!finalizeCheck.ok) {
  failed += 1;
  console.log("  issues:", finalizeCheck.issues.join("; "));
}

const badNarration =
  '*Я делаю вдох.*\n\n"Говори прямо. Я отвечу честно."\n\n*Я жду ответа.*';
const goodNarration =
  '*Он делает вдох.*\n\n"Говори прямо. Я отвечу честно."\n\n*Он ждёт ответа.*';
if (!hasFirstPersonOutsideSpeech(badNarration)) {
  failed += 1;
  console.log("FAIL", "должен ловить «я» вне речи");
} else {
  console.log("OK", "ловит «я» вне речи");
}
if (hasFirstPersonOutsideSpeech(goodNarration)) {
  failed += 1;
  console.log("FAIL", "не должен ругаться на «я» только в речи");
} else {
  console.log("OK", "«я» только в речи допустимо");
}

const misquoted =
  '"Твоя подбородок сдвинулся на мгновение от её лёгкого прикосновения."\n\n"Говори прямо."';
const repaired = structureRoleplayParagraphs(misquoted);
if (/"[^"]*твоя\s+подбородок/i.test(repaired)) {
  failed += 1;
  console.log("FAIL", "описание пользователя осталось в кавычках");
} else {
  console.log("OK", "сняты кавычки с описания пользователя");
  console.log("  OUT:", repaired.replace(/\n/g, "\\n"));
}

const duplicateHistory = [
  { role: "user", content: "Тяжёлые двери тронного зала медленно закрылись за твоей спиной." },
];
const dupReply =
  "Тяжёлые двери тронного зала медленно закрылись за твоей спиной. Он смотрит внимательно.";
if (!isNearDuplicateOfHistory(dupReply, duplicateHistory)) {
  failed += 1;
  console.log("FAIL", "должен ловить копипаст из истории");
} else {
  console.log("OK", "ловит копипаст из истории");
}

if (hasUserAgencyViolation('"Твоя подбородок дрогнул."', "")) {
  console.log("OK", "ловит описание пользователя в кавычках");
} else {
  failed += 1;
  console.log("FAIL", "не ловит описание пользователя в кавычках");
}

const fallbackA = finalizeBotReplyText(buildHardSafeFallbackReply("Каэлит", [], 0));
const fallbackB = finalizeBotReplyText(buildHardSafeFallbackReply("Каэлит", [fallbackA], 1));
const fallbackCheck = validateRoleplayFormatting(fallbackA);
console.log(fallbackCheck.ok ? "OK" : "FAIL", "запасной ответ (3-е лицо)");
if (!fallbackCheck.ok) {
  failed += 1;
  console.log("  issues:", fallbackCheck.issues.join("; "));
}
if (isNearDuplicateOfVariants(fallbackB, [fallbackA])) {
  failed += 1;
  console.log("FAIL", "запасные варианты не должны совпадать");
} else {
  console.log("OK", "запасные варианты различаются");
}

if (failed > 0) {
  console.error(`\n${failed} проверок не прошло.`);
  process.exit(1);
}

console.log("\nВсе проверки формата пройдены.");

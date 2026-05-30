/**
 * Проверка единого конвейера валидации ответов бота.
 * node scripts/test-reply-pipeline.js
 */
const fs = require("fs");
const path = require("path");
const {
  isReplyAcceptable,
  finalizeBotReplyText,
  buildHardSafeFallbackReply,
  postProcessGeneratedReply,
  mergeMessageContinuation,
} = require("../config/aiChat");
const {
  hasUserAgencyViolation,
  wouldViolateUserAgency,
  buildPreGenerationUserAgencyReminder,
  buildPreGenerationUserAgencyUserMessage,
} = require("../config/roleplayFormatRules");

let failed = 0;

function assert(name, ok) {
  console.log(ok ? "OK" : "FAIL", name);
  if (!ok) failed += 1;
}

const badUserAgency =
  '*Байхэ останавливается рядом.*\n\n"Я всегда была любопытной."';
assert(
  "bad user-agency reply fails isReplyAcceptable",
  !isReplyAcceptable(
    finalizeBotReplyText(badUserAgency),
    "Аурелия",
    "Байхэ",
    [{ role: "user", content: "Привет." }],
    [],
  ),
);

const fallback = finalizeBotReplyText(buildHardSafeFallbackReply("Аурелия", [], 0));
assert(
  "fallback reply passes isReplyAcceptable",
  isReplyAcceptable(
    fallback,
    "Аурелия",
    "Байхэ",
    [{ role: "user", content: "Привет." }],
    [],
  ),
);

const aiChatSource = fs.readFileSync(
  path.join(__dirname, "../config/aiChat.js"),
  "utf8",
);
assert(
  "generateBotReplyStream uses postProcessStreamedReply",
  /generateBotReplyStream[\s\S]+postProcessStreamedReply/.test(aiChatSource),
);
assert(
  "generateBotReply uses postProcessGeneratedReply",
  /async function generateBotReply[\s\S]+postProcessGeneratedReply/.test(aiChatSource),
);
assert(
  "postProcess no longer uses weaker proxy-only ensureMinimumReplyQuality",
  !/if \(usingProxy\)\s*\{\s*return ensureMinimumReplyQuality/.test(aiChatSource),
);
assert(
  "postProcess always calls enforceReplyQuality",
  /async function postProcessGeneratedReply[\s\S]+await enforceReplyQuality/.test(aiChatSource),
);

assert(
  "postProcessGeneratedReply is exported",
  typeof postProcessGeneratedReply === "function",
);

assert(
  "hasUserAgencyViolation catches screenshot-like reply",
  hasUserAgencyViolation(badUserAgency, "Байхэ"),
);

assert(
  "wouldViolateUserAgency catches early *Байхэ block",
  wouldViolateUserAgency("*Байхэ о", "Байхэ"),
);

assert(
  "wouldViolateUserAgency allows bot addressing player",
  !wouldViolateUserAgency('"Байхэ, что ты имеешь в виду?"', "Байхэ"),
);

assert(
  "pre-generation user gate mentions player name",
  buildPreGenerationUserAgencyUserMessage("Байхэ", "Аурелия").includes("Байхэ") &&
    buildPreGenerationUserAgencyUserMessage("Байхэ", "Аурелия").includes("✗"),
);

assert(
  "messages append pre-generation user agency gate before LLM",
  /appendPreGenerationUserAgencyGate/.test(aiChatSource) &&
    /generateBotReplyStream[\s\S]*?appendPreGenerationUserAgencyGate/.test(aiChatSource),
);

assert(
  "stream path uses lightweight postProcess without full rewrite fallback",
  /async function generateBotReplyStream[\s\S]*?return postProcessStreamedReply/.test(
    aiChatSource,
  ),
);

assert(
  "streamed reply strips user-agency paragraphs instead of full rewrite",
  /stripUserAgencyViolations/.test(aiChatSource),
);

assert(
  "buildMessagesForLlmApi adds pre-generation reminder",
  /buildPreGenerationUserAgencyReminder\(personaName\)/.test(aiChatSource),
);

const midWordHead =
  "Аурелия вытянула руку и протянула её Байхэ. Она почувствовала незнач";
const midWordTail = "ительное облегчение, когда та приняла шашлык.";
const midWordMerged = mergeMessageContinuation(midWordHead, midWordTail);
assert(
  "continue merges mid-word without paragraph break",
  midWordMerged.includes("незначительное") && !midWordMerged.includes("незнач\n\n"),
);

const repeatHead =
  "Аурелия прокрутила глаза.\n\nОна почувствовала незнач";
const repeatTail =
  "Аурелия прокрутила глаза.\n\nОна почувствовала незначительное облегчение.";
const repeatMerged = mergeMessageContinuation(repeatHead, repeatTail);
assert(
  "continue strips repeated paragraph from tail",
  !repeatMerged.includes("Аурелия прокрутила глаза.\n\nАурелия прокрутила глаза."),
);

const duplicateSentenceHead =
  'Аурелия усмехнулась. "Ты знаешь, что такое вкусные блюда?"\n\nБайхэ стиснула кулаки и прищурилась, стараясь поддерживать игру. Она вд';
const duplicateSentenceTail =
  "Байхэ стиснула кулаки и прищурилась, стараясь поддерживать игру. Она вдруг замерла и посмотрела на Аурелию.";
const duplicateSentenceMerged = mergeMessageContinuation(
  duplicateSentenceHead,
  duplicateSentenceTail,
);
assert(
  "continue strips duplicate paragraphs anywhere in tail",
  (() => {
    const head =
      "Para1.\n\n\"Quote about food?\"\n\n*She sighed and wiped her face.*";
    const tail =
      "*New touch on marble.* \"More about banquet.\"\n\n\"Quote about food?\"\n\n*She sighed and wiped her face.*\n\n*New ending.*";
    const merged = mergeMessageContinuation(head, tail);
    const quoteCount = (merged.match(/Quote about food/g) || []).length;
    return (
      merged.includes("New touch on marble") &&
      merged.includes("New ending") &&
      quoteCount === 1
    );
  })(),
);

if (failed > 0) {
  console.error(`\n${failed} проверок не прошло.`);
  process.exit(1);
}

console.log("\nЕдиный конвейер проверки ответов настроен.");

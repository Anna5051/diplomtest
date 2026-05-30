const { substituteChatTokens, resolveUserDisplayName } = require("../js/chatTokens");

let failed = 0;

function assert(name, ok) {
  console.log(ok ? "OK" : "FAIL", name);
  if (!ok) failed += 1;
}

assert(
  "persona name wins",
  resolveUserDisplayName({ personaName: "Байхэ", username: "Anna" }) === "Байхэ",
);
assert(
  "fallback username",
  resolveUserDisplayName({ username: "Anna" }) === "Anna",
);
assert(
  "replace {{user}}",
  substituteChatTokens("— {{user}}?", { personaName: "Байхэ" }) === "— Байхэ?",
);
assert(
  "case insensitive",
  substituteChatTokens("{{USER}}", { personaName: "Байхэ" }) === "Байхэ",
);
assert(
  "replace {{char}}",
  substituteChatTokens("{{char}} улыбнулась", { charName: "Аурелия" }) ===
    "Аурелия улыбнулась",
);
assert(
  "empty stays",
  substituteChatTokens("Привет", { personaName: "Байхэ" }) === "Привет",
);

if (failed > 0) {
  console.error(`\n${failed} проверок не прошло.`);
  process.exit(1);
}

console.log("\nВсе проверки chatTokens пройдены.");

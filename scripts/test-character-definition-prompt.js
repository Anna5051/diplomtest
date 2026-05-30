const {
  buildSystemPrompt,
  resolveCharacterDefinition,
  buildBotProfileFromChat,
} = require("../config/aiChat");

let failed = 0;

function assert(name, ok) {
  console.log(ok ? "OK" : "FAIL", name);
  if (!ok) failed += 1;
}

const metadata = {
  scenario: "Бал в королевском дворце.",
  roleplayRules: "Гордая, но ранимая.",
  memoryFacts: "Знает Байхэ с детства.",
  characterRules: "Не упоминать войну.",
  characterType: "female",
  exampleDialogues: '"Как смеешь!" — воскликнула она.',
  tags: "фэнтези, роман",
};

const systemPrompt = [
  "[CHARITOR_PROMPT_V1]",
  JSON.stringify(metadata),
  "[/CHARITOR_PROMPT_V1]",
  "",
  "Ты — AI-персонаж \"Аурелия\".",
  "",
  "Биография персонажа:",
  "Принцесса королевства Элдор.",
  "",
  "Сценарий:",
  metadata.scenario,
].join("\n");

const botProfile = {
  full_description: "<p>Наследница престола, любит музыку.</p>",
  short_description: "Принцесса Элдор",
  tags: "фэнтези, двор",
  greeting_message: "*Она оборачивается.* \"Ты здесь?\"",
};

const def = resolveCharacterDefinition(systemPrompt, botProfile);
assert("biography from full_description", def.biography.includes("Наследница престола"));
assert("scenario from metadata", def.scenario.includes("Бал в королевском"));
assert("personality from metadata", def.personality.includes("Гордая"));
assert("greeting from profile", def.greetingMessage.includes("Ты здесь"));

const chatProfile = buildBotProfileFromChat({
  bot_full_description: botProfile.full_description,
  bot_short_description: botProfile.short_description,
  bot_tags: botProfile.tags,
  bot_greeting_message: botProfile.greeting_message,
});
assert("chat profile maps db fields", chatProfile.full_description.includes("Наследница"));

const prompt = buildSystemPrompt(systemPrompt, "", "Аурелия", "Байхэ", botProfile);
assert("prompt has character definition block", prompt.includes("=== ОПРЕДЕЛЕНИЕ ПЕРСОНАЖА ==="));
assert("prompt includes biography", prompt.includes("Наследница престола"));
assert("prompt includes personality", prompt.includes("Гордая, но ранимая"));
assert("prompt includes scenario", prompt.includes("Бал в королевском дворце"));
assert("prompt includes memory facts", prompt.includes("Знает Байхэ с детства"));
assert("prompt includes character rules", prompt.includes("Не упоминать войну"));
assert("prompt includes example dialogues", prompt.includes("Как смеешь"));
assert("prompt includes greeting", prompt.includes("Ты здесь"));
assert("prompt substitutes user token", prompt.includes("Байхэ"));
assert(
  "character block before style rules",
  prompt.indexOf("=== ОПРЕДЕЛЕНИЕ ПЕРСОНАЖА ===") <
    prompt.indexOf("Стиль ответа: художественный"),
);

if (failed > 0) {
  console.error(`\n${failed} проверок не прошло.`);
  process.exit(1);
}

console.log("\nВсе проверки character definition prompt пройдены.");

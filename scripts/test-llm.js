/**
 * Проверка облачного LLM: node scripts/test-llm.js
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { getServerLlmRuntimeConfig, getLlmPublicStatus } = require("../config/llmEnv");

async function main() {
  const status = getLlmPublicStatus();
  console.log("Статус:", status);

  if (status.mode !== "cloud") {
    console.log("В .env не задан LLM_PROXY_URL — используется Ollama.");
    process.exit(0);
  }

  if (!status.ready) {
    console.error(
      "Нет API-ключа. Добавьте LLM_API_KEY в .env или одну строку в config/secrets/llm-api-key.txt",
    );
    console.error("Ключ Chutes (cpk_...): https://chutes.ai");
    console.error("Или OpenRouter / DeepSeek — см. .env.example");
    process.exit(1);
  }

  const cfg = getServerLlmRuntimeConfig();
  const response = await fetch(cfg.proxy_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: "Ответь одним словом: привет" }],
      temperature: 0.3,
      stream: false,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Ошибка API:", data.error?.message || data.message || response.status);
    process.exit(1);
  }

  const text =
    data?.choices?.[0]?.message?.content ||
    data?.message?.content ||
  "";
  console.log("Ответ модели:", String(text).trim());
  console.log("OK — облачный LLM работает.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

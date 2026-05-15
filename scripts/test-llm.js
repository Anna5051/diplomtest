/**
 * Проверка встроенной модели: node scripts/test-llm.js
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const {
  getBuiltinLlmRuntimeConfig,
  getLlmPublicStatus,
  refreshOllamaHealth,
  getOllamaBaseUrl,
  getOllamaDefaultModel,
} = require("../config/llmEnv");

async function main() {
  await refreshOllamaHealth();
  const status = getLlmPublicStatus();
  console.log("Статус:", status);

  if (status.mode === "ollama") {
    if (!status.ready) {
      console.error("Ollama недоступна на сервере:", status.ollama_error || status.base_url);
      console.error("Установите Ollama, затем: ollama serve && ollama pull", getOllamaDefaultModel());
      process.exit(1);
    }
    const response = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getOllamaDefaultModel(),
        stream: false,
        messages: [{ role: "user", content: "Ответь одним словом: привет" }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Ошибка Ollama:", data.error || response.status);
      process.exit(1);
    }
    console.log("Ответ модели:", String(data?.message?.content || "").trim());
    console.log("OK — встроенная Ollama работает (пользователям на ПК ничего не нужно).");
    return;
  }

  if (!status.ready) {
    console.error(
      "Нет API-ключа. Добавьте LLM_API_KEY в .env или config/secrets/llm-api-key.txt",
    );
    console.error("Либо переключите BUILTIN_LLM_MODE=ollama для бесплатной модели на сервере.");
    process.exit(1);
  }

  const cfg = getBuiltinLlmRuntimeConfig();
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

const fs = require("fs");
const path = require("path");

const SECRETS_KEY_FILE = path.resolve(__dirname, "secrets", "llm-api-key.txt");

function readApiKeyFromSecretsFile() {
  try {
    if (!fs.existsSync(SECRETS_KEY_FILE)) return "";
    return String(fs.readFileSync(SECRETS_KEY_FILE, "utf8") || "").trim();
  } catch {
    return "";
  }
}

function resolveLlmApiKey() {
  return (
    String(process.env.LLM_API_KEY || "").trim() ||
    String(process.env.CHUTES_API_KEY || "").trim() ||
    String(process.env.OPENROUTER_API_KEY || "").trim() ||
    String(process.env.DEEPSEEK_API_KEY || "").trim() ||
    String(process.env.GROQ_API_KEY || "").trim() ||
    readApiKeyFromSecretsFile()
  );
}

function getServerLlmRuntimeConfig() {
  const proxyUrl = String(process.env.LLM_PROXY_URL || "").trim();
  if (!proxyUrl) return {};
  return {
    proxy_url: proxyUrl,
    model: String(process.env.LLM_MODEL || "").trim(),
    api_key: resolveLlmApiKey(),
    custom_prompt: String(process.env.LLM_CUSTOM_PROMPT || "").trim(),
    http_referer: String(process.env.LLM_HTTP_REFERER || "http://localhost:3000").trim(),
    x_title: String(process.env.LLM_HTTP_TITLE || "Charitor").trim(),
  };
}

function getLlmPublicStatus() {
  const server = getServerLlmRuntimeConfig();
  if (server.proxy_url) {
    return {
      mode: "cloud",
      ready: Boolean(server.api_key),
      model: server.model || null,
      provider: detectCloudProvider(server.proxy_url),
    };
  }
  return {
    mode: "ollama",
    ready: true,
    model: process.env.OLLAMA_MODEL || "qwen2.5:3b",
    provider: "ollama",
    base_url: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  };
}

function detectCloudProvider(proxyUrl) {
  const url = String(proxyUrl || "").toLowerCase();
  if (url.includes("chutes.ai")) return "chutes";
  if (url.includes("groq.com")) return "groq";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("deepseek.com")) return "deepseek";
  if (url.includes("together.xyz")) return "together";
  if (url.includes("openai.com")) return "openai";
  return "custom";
}

function applyModelOverrideToRuntimeConfig(runtimeConfig, modelOverride) {
  const cfg = { ...runtimeConfig };
  const model = String(modelOverride || "").trim();
  if (model) cfg.model = model;
  return cfg;
}

async function fetchAvailableLlmModels() {
  const server = getServerLlmRuntimeConfig();
  if (!server.proxy_url || !server.api_key) return [];

  const provider = detectCloudProvider(server.proxy_url);
  if (provider === "chutes") {
    try {
      const response = await fetch("https://llm.chutes.ai/v1/models", {
        headers: { Authorization: `Bearer ${server.api_key}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return [];
      const items = Array.isArray(data?.data) ? data.data : [];
      return items
        .map((item) => {
          const id = String(item?.id || item?.name || "").trim();
          if (!id) return null;
          return { id, name: id };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  if (provider === "openrouter") {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${server.api_key}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return [];
      const items = Array.isArray(data?.data) ? data.data : [];
      return items
        .map((item) => {
          const id = String(item?.id || "").trim();
          if (!id) return null;
          return { id, name: id };
        })
        .filter(Boolean)
        .slice(0, 80);
    } catch {
      return [];
    }
  }

  return [];
}

function logLlmModeAtStartup() {
  const status = getLlmPublicStatus();
  if (status.mode === "cloud") {
    if (!status.ready) {
      console.warn(
        "LLM: облачный API задан, но ключ пустой. Добавьте LLM_API_KEY в .env или положите ключ в config/secrets/llm-api-key.txt",
      );
      console.warn(`     URL: ${process.env.LLM_PROXY_URL}`);
      return;
    }
    console.log(
      `LLM: облачный API (${status.provider}), модель: ${status.model || "(LLM_MODEL)"}`,
    );
    return;
  }
  console.log(`LLM: Ollama ${status.base_url}, модель: ${status.model}`);
}

module.exports = {
  SECRETS_KEY_FILE,
  getServerLlmRuntimeConfig,
  getLlmPublicStatus,
  logLlmModeAtStartup,
  resolveLlmApiKey,
  applyModelOverrideToRuntimeConfig,
  fetchAvailableLlmModels,
};

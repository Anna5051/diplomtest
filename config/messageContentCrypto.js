/**
 * Шифрование поля messages.content в БД (AES-256-GCM).
 *
 * Ключ (по приоритету):
 *   1) MESSAGES_CONTENT_KEY в .env — 64 hex-символа (32 байта) ИЛИ любая строка (SHA-256).
 *   2) MESSAGES_CONTENT_LEGACY_KEYS — доп. ключи через запятую (старые серверы).
 *   3) Если ключа нет: файл `.messages-content.key` в корне проекта.
 *   4) MESSAGES_PLAINTEXT=1 — отключить шифрование (только отладка).
 *
 * Старые открытые строки без префикса CHARITOR_ENC_V1: при чтении возвращаются как есть.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PREFIX = "CHARITOR_ENC_V1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

const LOCAL_KEY_FILE = path.resolve(__dirname, "..", ".messages-content.key");

const KEY_CACHE_UNSET = Symbol("messageContentKeyUnset");
let cachedKeyBuffer = KEY_CACHE_UNSET;
let cachedDecryptKeys = null;

function parseKeyString(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  return /^[0-9a-fA-F]{64}$/.test(s)
    ? Buffer.from(s, "hex")
    : crypto.createHash("sha256").update(s, "utf8").digest();
}

function keysEqual(a, b) {
  return a && b && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getEncryptKeyBuffer() {
  if (cachedKeyBuffer !== KEY_CACHE_UNSET) {
    return cachedKeyBuffer;
  }

  if (String(process.env.MESSAGES_PLAINTEXT || "").trim() === "1") {
    cachedKeyBuffer = null;
    return null;
  }

  const env = process.env.MESSAGES_CONTENT_KEY;
  if (env != null && String(env).trim() !== "") {
    cachedKeyBuffer = parseKeyString(env);
    return cachedKeyBuffer;
  }

  try {
    if (fs.existsSync(LOCAL_KEY_FILE)) {
      const raw = fs.readFileSync(LOCAL_KEY_FILE, "utf8").trim();
      const fileKey = parseKeyString(raw);
      if (fileKey) {
        cachedKeyBuffer = fileKey;
        return cachedKeyBuffer;
      }
    }
  } catch (err) {
    console.warn("messageContentCrypto: не удалось прочитать", LOCAL_KEY_FILE, "—", err.message);
  }

  try {
    const hex = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(LOCAL_KEY_FILE, `${hex}\n`, { mode: 0o600 });
    cachedKeyBuffer = Buffer.from(hex, "hex");
    console.log(
      "messageContentCrypto: создан локальный ключ шифрования",
      LOCAL_KEY_FILE,
      "— новые сообщения в БД будут с префиксом CHARITOR_ENC_V1. Для сервера укажите MESSAGES_CONTENT_KEY в .env.",
    );
    return cachedKeyBuffer;
  } catch (err) {
    console.warn(
      "messageContentCrypto: шифрование недоступно (нет MESSAGES_CONTENT_KEY и не удалось создать файл ключа) —",
      err.message,
    );
    cachedKeyBuffer = null;
    return null;
  }
}

function getDecryptKeyBuffers() {
  if (cachedDecryptKeys) return cachedDecryptKeys;

  const list = [];
  const pushKey = (buf) => {
    if (!buf) return;
    if (!list.some((k) => keysEqual(k, buf))) list.push(buf);
  };

  pushKey(parseKeyString(process.env.MESSAGES_CONTENT_KEY));

  const legacy = String(process.env.MESSAGES_CONTENT_LEGACY_KEYS || "");
  if (legacy.trim()) {
    for (const part of legacy.split(",")) {
      pushKey(parseKeyString(part));
    }
  }

  try {
    if (fs.existsSync(LOCAL_KEY_FILE)) {
      pushKey(parseKeyString(fs.readFileSync(LOCAL_KEY_FILE, "utf8").trim()));
    }
  } catch (_) {
    /* ignore */
  }

  cachedDecryptKeys = list;
  return list;
}

function isCiphertext(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function decryptWithKey(stored, key) {
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error("Некорректный формат зашифрованного сообщения.");
  }

  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function encryptMessageContentForDb(plain) {
  const key = getEncryptKeyBuffer();
  if (!key) return String(plain ?? "");

  const text = String(plain ?? "");
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptMessageContentFromDb(stored) {
  const s = String(stored ?? "");
  if (!isCiphertext(s)) return s;

  const keys = getDecryptKeyBuffers();
  if (!keys.length) {
    throw new Error(
      "В БД зашифрованные сообщения (CHARITOR_ENC_V1), но ключ недоступен: задайте MESSAGES_CONTENT_KEY в .env.",
    );
  }

  let lastErr = null;
  for (const key of keys) {
    try {
      return decryptWithKey(s, key);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Не удалось расшифровать сообщение.");
}

function decryptMessageRowsForApi(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (!Object.prototype.hasOwnProperty.call(row, "content")) return row;
    try {
      const content = decryptMessageContentFromDb(row.content);
      const { content_variants: cvRaw, ...rest } = row;
      let _contentVariants;
      let _variantIndex;
      if (cvRaw != null && String(cvRaw).trim() !== "") {
        try {
          const metaPlain = decryptMessageContentFromDb(cvRaw);
          const meta = JSON.parse(metaPlain);
          if (meta && Array.isArray(meta.v) && meta.v.length >= 2) {
            _contentVariants = meta.v.map((x) => String(x));
            const len = _contentVariants.length;
            let i = Number(meta.i);
            if (!Number.isFinite(i)) i = len - 1;
            if (i < 0) i = 0;
            if (i > len - 1) i = len - 1;
            _variantIndex = i;
          }
        } catch (e2) {
          console.warn(
            "messageContentCrypto: не удалось разобрать content_variants id=%s —",
            row.id,
            e2.message,
          );
        }
      }
      return {
        ...rest,
        content,
        ...(_contentVariants ? { _contentVariants, _variantIndex } : {}),
      };
    } catch (e) {
      console.error("messageContentCrypto: не удалось расшифровать сообщение id=%s", row.id, e);
      return {
        ...row,
        content: "…",
      };
    }
  });
}

module.exports = {
  encryptMessageContentForDb,
  decryptMessageContentFromDb,
  decryptMessageRowsForApi,
  isCiphertext,
};

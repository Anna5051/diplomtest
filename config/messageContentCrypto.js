/**
 * Шифрование поля messages.content в БД (AES-256-GCM).
 *
 * Задайте в .env:
 *   MESSAGES_CONTENT_KEY — 64 hex-символа (32 байта ключа) ИЛИ любая строка (будет взята SHA-256).
 * Без ключа значения пишутся в БД как раньше (открытый текст).
 *
 * Уже сохранённые открытые строки при включённом ключе читаются как есть; новые записи шифруются.
 */

const crypto = require("crypto");

const PREFIX = "CHARITOR_ENC_V1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKeyBuffer() {
  const env = process.env.MESSAGES_CONTENT_KEY;
  if (env == null || String(env).trim() === "") return null;
  const s = String(env).trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return Buffer.from(s, "hex");
  }
  return crypto.createHash("sha256").update(s, "utf8").digest();
}

function isCiphertext(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encryptMessageContentForDb(plain) {
  const key = getKeyBuffer();
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

  const key = getKeyBuffer();
  if (!key) {
    throw new Error(
      "В БД зашифрованные сообщения (CHARITOR_ENC_V1), но MESSAGES_CONTENT_KEY не задан.",
    );
  }

  const raw = Buffer.from(s.slice(PREFIX.length), "base64");
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

function decryptMessageRowsForApi(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (!Object.prototype.hasOwnProperty.call(row, "content")) return row;
    try {
      return { ...row, content: decryptMessageContentFromDb(row.content) };
    } catch (e) {
      console.error("messageContentCrypto: не удалось расшифровать сообщение id=%s", row.id, e);
      throw e;
    }
  });
}

module.exports = {
  encryptMessageContentForDb,
  decryptMessageContentFromDb,
  decryptMessageRowsForApi,
  isCiphertext,
};

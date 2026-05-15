const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const http = require("http");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { sanitizeBotTagsField } = require("./tagPolicy");

const app = express();
let currentHttpServer = null;

const AUTO_SHUTDOWN_ON_NO_CLIENTS = process.env.AUTO_SHUTDOWN_ON_NO_CLIENTS !== "0";
const CLIENT_IDLE_SHUTDOWN_MS = Number(process.env.CLIENT_IDLE_SHUTDOWN_MS) || 15000;
const activeClientTabs = new Map();
let shutdownTimer = null;

function clearShutdownTimer() {
  if (!shutdownTimer) return;
  clearTimeout(shutdownTimer);
  shutdownTimer = null;
}

function scheduleShutdownIfNoClients() {
  if (!AUTO_SHUTDOWN_ON_NO_CLIENTS) return;
  if (activeClientTabs.size > 0) {
    clearShutdownTimer();
    return;
  }
  clearShutdownTimer();
  shutdownTimer = setTimeout(() => {
    if (activeClientTabs.size > 0) return;
    console.log("Нет активных вкладок, останавливаю сервер...");
    if (!currentHttpServer) {
      process.exit(0);
      return;
    }
    currentHttpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500);
  }, CLIENT_IDLE_SHUTDOWN_MS);
}

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(express.static(path.resolve(__dirname, "..")));

app.get("/", (req, res) => {
  res.sendFile(path.resolve(__dirname, "../pages/index.html"));
});

app.post("/client-presence", (req, res) => {
  const { action, tabId } = req.body || {};
  const safeTabId = String(tabId || "").trim();
  if (!safeTabId) {
    return res.status(400).json({ message: "tabId обязателен" });
  }

  if (action === "open" || action === "heartbeat") {
    activeClientTabs.set(safeTabId, Date.now());
  } else if (action === "close") {
    activeClientTabs.delete(safeTabId);
  }

  scheduleShutdownIfNoClients();
  res.status(204).end();
});

/*проверка роли админа*/
function requireAdmin(req, res, next) {
  const userId = req.headers["x-user-id"];

  if (!userId) {
    return res.status(401).json({
      message: "Нет доступа: не передан user id",
    });
  }

  const sql = `
    SELECT id, role_id
    FROM users
    WHERE id = ?
    LIMIT 1
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка проверки доступа",
      });
    }

    if (!rows.length) {
      return res.status(403).json({
        message: "Пользователь не найден",
      });
    }

    if (Number(rows[0].role_id) !== 2) {
      return res.status(403).json({
        message: "Только для администратора",
      });
    }

    next();
  });
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;
const BCRYPT_ROUNDS = 10;
const {
  CHAT_HISTORY_LIMIT,
  MAX_USER_MESSAGE_LENGTH,
  mapMessagesToOllamaHistory,
  generateBotReply,
  buildBotReplyFromHistory,
  classifyUserPolicyViolation,
  FILTERED_BOT_MESSAGE_PLACEHOLDER,
} = require("./aiChat");
const {
  getServerLlmRuntimeConfig,
  getLlmPublicStatus,
  logLlmModeAtStartup,
  applyModelOverrideToRuntimeConfig,
  fetchAvailableLlmModels,
} = require("./llmEnv");
const {
  encryptMessageContentForDb,
  decryptMessageContentFromDb,
  decryptMessageRowsForApi,
} = require("./messageContentCrypto");
let hasEmailConfirmedColumnCache = null;

function getString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidPassword(password) {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password)
  );
}

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

/** Первое сообщение бота в чате (приветствие / начало истории) — по порядку как в выдаче API */
async function getOldestBotMessageIdInChat(chatId) {
  const cid = parseInt(String(chatId), 10);
  if (!Number.isFinite(cid) || cid < 1) return null;
  const rows = await dbQuery(
    "SELECT id FROM messages WHERE chat_id = ? AND sender_type = 'bot' ORDER BY created_at ASC, id ASC LIMIT 1",
    [cid],
  );
  return rows.length ? Number(rows[0].id) : null;
}

/**
 * Если в чате нет сообщений и у бота задано greeting_message — вставляет первое сообщение от бота.
 * Нужно после «очистить чат» и при открытии пустого чата, чтобы приветствие автора не терялось.
 */
function seedBotGreetingIfChatHasNoMessages(chatId, callback) {
  const cid = parseInt(String(chatId), 10);
  if (!Number.isFinite(cid) || cid < 1) {
    return process.nextTick(() => callback(null));
  }

  db.query(
    `SELECT COUNT(*) AS cnt FROM messages WHERE chat_id = ?`,
    [cid],
    (cntErr, cntRows) => {
      if (cntErr) {
        return callback(cntErr);
      }
      const cnt = Number(cntRows[0]?.cnt) || 0;
      if (cnt > 0) {
        return callback(null);
      }

      db.query(
        `
          SELECT TRIM(COALESCE(b.greeting_message, '')) AS greeting
          FROM chats c
          INNER JOIN bots b ON b.id = c.bot_id
          WHERE c.id = ?
          LIMIT 1
        `,
        [cid],
        (grErr, grRows) => {
          if (grErr) {
            return callback(grErr);
          }
          const greeting = String(grRows[0]?.greeting || "").trim();
          if (!greeting) {
            return callback(null);
          }

          const insertSql = `
            INSERT INTO messages (chat_id, sender_type, content, created_at)
            VALUES (?, 'bot', ?, NOW())
          `;
          db.query(
            insertSql,
            [cid, encryptMessageContentForDb(greeting)],
            (insErr) => {
              if (insErr) {
                return callback(insErr);
              }
              db.query(
                "UPDATE chats SET updated_at = NOW() WHERE id = ?",
                [cid],
                () => callback(null),
              );
            },
          );
        },
      );
    },
  );
}

function ensurePersonaRoleColumn() {
  const sql = `
    ALTER TABLE personas
    ADD COLUMN role VARCHAR(120) NOT NULL DEFAULT '' AFTER name
  `;

  db.query(sql, (err) => {
    if (!err) {
      console.log("БД: добавлена колонка personas.role");
      return;
    }
    if (err.code === "ER_DUP_FIELDNAME") {
      return;
    }
    console.warn("БД: не удалось проверить/добавить personas.role —", err.message);
  });
}

function ensureUserBlockedColumn() {
  const sql = `
    ALTER TABLE users
    ADD COLUMN is_blocked TINYINT(1) NOT NULL DEFAULT 0 AFTER role_id
  `;

  db.query(sql, (err) => {
    if (!err) {
      console.log("БД: добавлена колонка users.is_blocked");
      return;
    }
    if (err.code === "ER_DUP_FIELDNAME") {
      return;
    }
    console.warn("БД: не удалось проверить/добавить users.is_blocked —", err.message);
  });
}

function ensureBotBlockedColumn() {
  const sql = `
    ALTER TABLE bots
    ADD COLUMN is_blocked TINYINT(1) NOT NULL DEFAULT 0 AFTER visibility
  `;

  db.query(sql, (err) => {
    if (!err) {
      console.log("БД: добавлена колонка bots.is_blocked");
      return;
    }
    if (err.code === "ER_DUP_FIELDNAME") {
      return;
    }
    console.warn("БД: не удалось проверить/добавить bots.is_blocked —", err.message);
  });
}

function ensureBotDeletedColumn() {
  const sql = `
    ALTER TABLE bots
    ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0 AFTER is_blocked
  `;

  db.query(sql, (err) => {
    if (!err) {
      console.log("БД: добавлена колонка bots.is_deleted");
      return;
    }
    if (err.code === "ER_DUP_FIELDNAME") {
      return;
    }
    console.warn("БД: не удалось проверить/добавить bots.is_deleted —", err.message);
  });
}

function ensureMessagesPolicyViolationColumn() {
  const sql = `
    ALTER TABLE messages
    ADD COLUMN policy_violation TINYINT(1) NOT NULL DEFAULT 0 AFTER content
  `;

  db.query(sql, (err) => {
    if (!err) {
      console.log("БД: добавлена колонка messages.policy_violation");
      return;
    }
    if (err.code === "ER_DUP_FIELDNAME") {
      return;
    }
    console.warn("БД: не удалось проверить/добавить messages.policy_violation —", err.message);
  });
}

function ensureMessagesContentVariantsColumn() {
  const sql = `
    ALTER TABLE messages
    ADD COLUMN content_variants TEXT NULL AFTER policy_violation
  `;

  db.query(sql, (err) => {
    if (!err) {
      console.log("БД: добавлена колонка messages.content_variants");
      return;
    }
    if (err.code === "ER_DUP_FIELDNAME") {
      return;
    }
    console.warn("БД: не удалось проверить/добавить messages.content_variants —", err.message);
  });
}

/** Один ряд на пару (user_id, bot_id) — без этого возможны дубликаты в избранном. */
function ensureFavoritesBotsUserBotIndex() {
  const sql = `
    ALTER TABLE favorites_bots
    ADD UNIQUE INDEX idx_favorites_user_bot (user_id, bot_id)
  `;

  db.query(sql, (err) => {
    if (!err) {
      console.log("БД: уникальный индекс favorites_bots(user_id, bot_id)");
      return;
    }
    if (err.code === "ER_DUP_KEYNAME") {
      return;
    }
    if (String(err.message || "").includes("Duplicate key name")) {
      return;
    }
    console.warn(
      "БД: не удалось добавить уникальный индекс favorites_bots —",
      err.message,
    );
  });
}

function ensureReportsTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      reporter_id INT NOT NULL,
      target_type ENUM('bot', 'profile') NOT NULL,
      target_id INT NOT NULL,
      reason VARCHAR(255) NOT NULL DEFAULT '',
      details TEXT,
      status ENUM('pending', 'accepted', 'dismissed') NOT NULL DEFAULT 'pending',
      resolution_action ENUM('block', 'delete', 'dismiss') DEFAULT NULL,
      resolved_by INT DEFAULT NULL,
      resolved_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_reports_status_created (status, created_at),
      INDEX idx_reports_target (target_type, target_id),
      INDEX idx_reports_reporter (reporter_id)
    )
  `;

  db.query(sql, (err) => {
    if (err) {
      console.warn("БД: не удалось создать таблицу reports —", err.message);
      return;
    }
    console.log("БД: таблица reports готова");
  });
}

async function getOwnedChat(chatId, userId) {
  const rows = await dbQuery(
    `
      SELECT
        c.id,
        c.user_id,
        c.bot_id,
        b.name AS bot_name,
        b.system_prompt AS bot_system_prompt
      FROM chats c
      LEFT JOIN bots b ON c.bot_id = b.id
      WHERE c.id = ?
      LIMIT 1
    `,
    [chatId],
  );

  if (!rows.length) return null;
  const chat = rows[0];
  if (Number(chat.user_id) !== Number(userId)) return "forbidden";
  return chat;
}

function parsePersonaIdFromQuery(req) {
  const personaIdRaw = req.query.persona_id ?? req.query.persona;
  if (
    personaIdRaw === undefined ||
    personaIdRaw === null ||
    String(personaIdRaw).trim() === "" ||
    String(personaIdRaw).toLowerCase() === "null"
  ) {
    return null;
  }
  const n = Number(personaIdRaw);
  return Number.isFinite(n) ? n : null;
}

function normalizeRuntimeConfigFromBodyProxy(proxy) {
  if (!proxy || typeof proxy !== "object") return {};
  const proxyUrl = String(proxy.proxy_url || proxy.proxyUrl || "").trim();
  if (!proxyUrl) return {};
  return {
    proxy_url: proxyUrl,
    model: String(proxy.model || "").trim(),
    api_key: String(proxy.api_key || proxy.apiKey || "").trim(),
    custom_prompt: String(proxy.custom_prompt || proxy.customPrompt || "").trim(),
  };
}

function applyLlmSettingsToRuntimeConfig(cfg, llmSettings) {
  if (!llmSettings || typeof llmSettings !== "object") return cfg;
  const out = { ...cfg };
  const userPrompt = String(llmSettings.custom_prompt || "").trim();
  if (userPrompt) {
    out.custom_prompt = out.custom_prompt
      ? `${out.custom_prompt}\n\n${userPrompt}`
      : userPrompt;
  }
  const temperature = Number(llmSettings.temperature);
  if (Number.isFinite(temperature)) {
    out.temperature = Math.min(1.2, Math.max(0, temperature));
  }
  const topP = Number(llmSettings.top_p ?? llmSettings.topP);
  if (Number.isFinite(topP)) {
    out.top_p = Math.min(1, Math.max(0.05, topP));
  }
  return out;
}

function resolveRuntimeConfig(bodyProxy, bodyLlmModel, bodyLlmSettings) {
  const modelOverride = String(bodyLlmModel || "").trim();
  const fromBody = normalizeRuntimeConfigFromBodyProxy(bodyProxy);
  let cfg;
  if (fromBody.proxy_url) {
    cfg =
      modelOverride && !fromBody.model
        ? applyModelOverrideToRuntimeConfig(fromBody, modelOverride)
        : fromBody;
  } else {
    const serverCfg = getServerLlmRuntimeConfig();
    cfg = modelOverride
      ? applyModelOverrideToRuntimeConfig(serverCfg, modelOverride)
      : serverCfg;
  }
  return applyLlmSettingsToRuntimeConfig(cfg, bodyLlmSettings);
}

function rejectIfCloudLlmNotReady(res, bodyProxy) {
  const fromBody = normalizeRuntimeConfigFromBodyProxy(bodyProxy);
  if (fromBody.proxy_url) return false;

  const status = getLlmPublicStatus();
  if (status.mode === "cloud" && !status.ready) {
    res.status(503).json({
      message:
        "Облачная модель не настроена: укажите LLM_API_KEY в .env или положите ключ в config/secrets/llm-api-key.txt (Groq: console.groq.com/keys)",
    });
    return true;
  }
  return false;
}

app.get("/api/llm-status", (req, res) => {
  const status = getLlmPublicStatus();
  res.json({
    ...status,
    default_model: status.model,
    models_supported: status.mode === "cloud" && status.ready,
  });
});

app.get("/api/llm-models", async (req, res) => {
  try {
    const status = getLlmPublicStatus();
    if (status.mode !== "cloud" || !status.ready) {
      return res.json({ models: [], default_model: status.model || null });
    }
    const models = await fetchAvailableLlmModels();
    res.json({
      models,
      default_model: status.model || null,
      provider: status.provider || null,
    });
  } catch {
    res.status(500).json({ message: "Не удалось загрузить список моделей", models: [] });
  }
});

function requireUserIdFromQuery(req, res) {
  const userId = Number(req.query.user_id);
  if (!Number.isFinite(userId) || userId < 1) {
    res.status(400).json({
      message: "Укажите корректный user_id в запросе.",
    });
    return null;
  }
  return userId;
}

function deleteBotByAdmin(botId, callback) {
  db.query(
    `
      UPDATE bots
      SET is_deleted = 1, is_blocked = 1, visibility = 'private', updated_at = NOW()
      WHERE id = ?
    `,
    [botId],
    (botErr, result) => {
      if (botErr) return callback(botErr);
      callback(null, result);
    },
  );
}

function deleteUserByAdmin(userId, callback) {
  const deleteMessagesSql = `
    DELETE m
    FROM messages m
    INNER JOIN chats c ON m.chat_id = c.id
    WHERE c.user_id = ?
  `;

  db.query(deleteMessagesSql, [userId], (messagesErr) => {
    if (messagesErr) return callback(messagesErr);
    db.query("DELETE FROM chats WHERE user_id = ?", [userId], (chatsErr) => {
      if (chatsErr) return callback(chatsErr);
      const deleteBotsMessagesSql = `
        DELETE m
        FROM messages m
        INNER JOIN chats c ON m.chat_id = c.id
        INNER JOIN bots b ON c.bot_id = b.id
        WHERE b.creator_id = ?
      `;
      db.query(deleteBotsMessagesSql, [userId], (bmErr) => {
        if (bmErr) return callback(bmErr);
        const deleteBotsChatsSql = `
          DELETE c
          FROM chats c
          INNER JOIN bots b ON c.bot_id = b.id
          WHERE b.creator_id = ?
        `;
        db.query(deleteBotsChatsSql, [userId], (bcErr) => {
          if (bcErr) return callback(bcErr);
          db.query("DELETE FROM bots WHERE creator_id = ?", [userId], (botsErr) => {
            if (botsErr) return callback(botsErr);
            db.query("DELETE FROM users WHERE id = ?", [userId], (userErr, result) => {
              if (userErr) return callback(userErr);
              callback(null, result);
            });
          });
        });
      });
    });
  });
}

function deleteChatsForUserBotPersona(userId, botId, personaId, callback) {
  db.query(
    `
      SELECT id
      FROM chats
      WHERE user_id = ? AND bot_id = ? AND (persona_id <=> ?)
    `,
    [userId, botId, personaId],
    (err, rows) => {
      if (err) return callback(err);
      if (!rows.length) return callback(null);
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      db.query(
        `DELETE FROM messages WHERE chat_id IN (${placeholders})`,
        ids,
        (msgErr) => {
          if (msgErr) return callback(msgErr);
          db.query(
            `DELETE FROM chats WHERE id IN (${placeholders})`,
            ids,
            callback,
          );
        },
      );
    },
  );
}

/** Старые строки чатов до появления persona_id (всегда NULL для пары user+bot). */
function deleteLegacyNullPersonaChatsForUserBot(userId, botId, callback) {
  db.query(
    `
      SELECT id
      FROM chats
      WHERE user_id = ? AND bot_id = ? AND persona_id IS NULL
    `,
    [userId, botId],
    (err, rows) => {
      if (err) return callback(err);
      if (!rows.length) return callback(null);
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      db.query(
        `DELETE FROM messages WHERE chat_id IN (${placeholders})`,
        ids,
        (msgErr) => {
          if (msgErr) return callback(msgErr);
          db.query(
            `DELETE FROM chats WHERE id IN (${placeholders})`,
            ids,
            callback,
          );
        },
      );
    },
  );
}

function attachLegacyNullPersonaToChat(chatId, personaId, callback) {
  if (personaId == null) {
    return callback(null);
  }
  db.query(
    `UPDATE chats SET persona_id = ?, updated_at = NOW() WHERE id = ? AND persona_id IS NULL`,
    [personaId, chatId],
    (err) => callback(err || null),
  );
}

/** Есть чат с уже назначенной персоной — тогда legacy NULL нельзя отдавать другой персоне. */
function hasConcretePersonaChatForUserBot(userId, botId, callback) {
  db.query(
    `
      SELECT id
      FROM chats
      WHERE user_id = ? AND bot_id = ? AND persona_id IS NOT NULL
      LIMIT 1
    `,
    [userId, botId],
    (err, rows) => {
      if (err) return callback(err);
      callback(null, rows.length > 0);
    },
  );
}

function hasEmailConfirmedColumn(callback) {
  if (hasEmailConfirmedColumnCache !== null) {
    return callback(null, hasEmailConfirmedColumnCache);
  }

  db.query("SHOW COLUMNS FROM users LIKE 'email_confirmed'", (err, rows) => {
    if (err) {
      return callback(err);
    }

    hasEmailConfirmedColumnCache = rows.length > 0;
    callback(null, hasEmailConfirmedColumnCache);
  });
}

/*Регистрация*/
app.post("/register", (req, res) => {
  const username = getString(req.body.username);
  const email = getString(req.body.email).toLowerCase();
  const password = getString(req.body.password);
  const passwordConfirmation = getString(req.body.passwordConfirmation);

  if (!username || !email || !password || !passwordConfirmation) {
    return res.status(400).json({
      message: "Заполните все поля",
    });
  }

  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({
      message: "Некорректный email",
    });
  }

  if (!isValidPassword(password)) {
    return res.status(400).json({
      message: "Пароль должен быть не короче 8 символов, с буквами и цифрами",
    });
  }

  if (password !== passwordConfirmation) {
    return res.status(400).json({
      message: "Пароли не совпадают",
    });
  }

  const checkSql = "SELECT id FROM users WHERE email = ?";

  db.query(checkSql, [email], (err, result) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка базы данных",
      });
    }

    if (result.length > 0) {
      return res.status(409).json({
        message: "Пользователь уже существует",
      });
    }

    hasEmailConfirmedColumn((columnErr, hasEmailConfirmedColumn) => {
      if (columnErr) {
        return res.status(500).json({
          message: "Ошибка регистрации",
        });
      }

      bcrypt.hash(password, BCRYPT_ROUNDS, (hashErr, passwordHash) => {
        if (hashErr) {
          return res.status(500).json({
            message: "Ошибка регистрации",
          });
        }

        const insertSql = hasEmailConfirmedColumn
          ? `
            INSERT INTO users (username, email, password_hash, role_id, email_confirmed)
            VALUES (?, ?, ?, 1, 0)
          `
          : `
            INSERT INTO users (username, email, password_hash, role_id)
            VALUES (?, ?, ?, 1)
          `;

        db.query(insertSql, [username, email, passwordHash], (insertErr) => {
          if (insertErr) {
            return res.status(500).json({
              message: "Ошибка регистрации",
            });
          }

          res.json({
            message: "Регистрация успешна ✅",
          });
        });
      });
    });
  });
});

/*Авторизация*/
app.post("/login", (req, res) => {
  const email = getString(req.body.email).toLowerCase();
  const password = getString(req.body.password);

  if (!email || !password || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({
      message: "Неверный email или пароль",
    });
  }

  hasEmailConfirmedColumn((columnErr, hasEmailConfirmedColumn) => {
    if (columnErr) {
      return res.status(500).json({
        message: "Ошибка авторизации",
      });
    }

    const sql = hasEmailConfirmedColumn
      ? `
        SELECT id, username, email, password_hash, role_id, is_blocked, avatar_url, created_at, email_confirmed
        FROM users
        WHERE email = ?
        LIMIT 1
      `
      : `
        SELECT id, username, email, password_hash, role_id, is_blocked, avatar_url, created_at
        FROM users
        WHERE email = ?
        LIMIT 1
      `;

    db.query(sql, [email], (err, result) => {
      if (err) {
        return res.status(500).json({
          message: "Ошибка авторизации",
        });
      }

      if (result.length === 0) {
        return res.status(401).json({
          message: "Неверный email или пароль",
        });
      }

      const user = result[0];

      bcrypt.compare(password, user.password_hash, (compareErr, isPasswordValid) => {
        if (compareErr) {
          return res.status(500).json({
            message: "Ошибка авторизации",
          });
        }

        const completeLogin = () => {
          if (Number(user.is_blocked) === 1) {
            return res.status(403).json({
              message: "Ваш аккаунт заблокирован администратором",
            });
          }

          if (hasEmailConfirmedColumn && Number(user.email_confirmed) !== 1) {
            return res.status(403).json({
              message: "Подтвердите email для входа",
            });
          }

          res.json({
            message: "Вход выполнен ✅",
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              role_id: user.role_id,
              avatar_url: user.avatar_url || "",
              created_at: user.created_at,
            },
          });
        };

        if (isPasswordValid) {
          return completeLogin();
        }

        // Legacy fallback: old accounts could store plaintext in password_hash.
        if (user.password_hash === password) {
          return bcrypt.hash(password, BCRYPT_ROUNDS, (hashErr, upgradedHash) => {
            if (hashErr) {
              return res.status(500).json({
                message: "Ошибка авторизации",
              });
            }

            db.query(
              "UPDATE users SET password_hash = ? WHERE id = ?",
              [upgradedHash, user.id],
              (updateErr) => {
                if (updateErr) {
                  return res.status(500).json({
                    message: "Ошибка авторизации",
                  });
                }

                completeLogin();
              },
            );
          });
        }

        return res.status(401).json({
          message: "Неверный email или пароль",
        });
      });
    });
  });
});

/*Обновление аватара пользователя*/
function updateUserAvatar(req, res) {
  const userId = Number(req.body.user_id);
  const avatarUrl = getString(req.body.avatar_url);

  if (!userId) {
    return res.status(400).json({
      message: "Не указан пользователь",
    });
  }

  if (!avatarUrl) {
    return res.status(400).json({
      message: "Не передан аватар",
    });
  }

  const sql = `
    UPDATE users
    SET avatar_url = ?
    WHERE id = ?
  `;

  db.query(sql, [avatarUrl, userId], (err, result) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка сохранения аватара",
      });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Пользователь не найден",
      });
    }

    res.json({
      message: "Аватар сохранен ✅",
      avatar_url: avatarUrl,
    });
  });
}

app.put("/user/avatar", updateUserAvatar);
app.post("/user/avatar", updateUserAvatar);

/*Создание бота*/
app.post("/create-bot", (req, res) => {
  const {
    creator_id,
    name,
    short_description,
    full_description,
    avatar_url,
    greeting_message,
    system_prompt,
    visibility,
    tags,
  } = req.body;

  if (!creator_id || !name) {
    return res.status(400).json({
      message: "Не хватает обязательных данных",
    });
  }

  const safeVisibility = visibility === "private" ? "private" : "public";
  const safeTags = sanitizeBotTagsField(tags);

  const sql = `
    INSERT INTO bots
    (
      creator_id,
      name,
      short_description,
      full_description,
      avatar_url,
      greeting_message,
      system_prompt,
      visibility,
      tags
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    sql,
    [
      creator_id,
      name,
      short_description || "",
      full_description || "",
      avatar_url || "",
      greeting_message || "",
      system_prompt || "",
      safeVisibility,
      safeTags,
    ],
    (err, result) => {
      if (err) {
        return res.status(500).json({
          message: "Ошибка создания персонажа",
        });
      }

      res.json({
        message: "Персонаж создан ✅",
        bot_id: result.insertId,
      });
    },
  );
});

/*боты пользователей*/
app.get("/my-bots/:userId", (req, res) => {
  const { userId } = req.params;

  const sql = `
    SELECT
      id,
      creator_id,
      name,
      short_description,
      full_description,
      avatar_url,
      greeting_message,
      system_prompt,
      visibility,
      is_blocked,
      is_deleted,
      tags,
      created_at,
      updated_at
    FROM bots
    WHERE creator_id = ?
    ORDER BY created_at DESC
  `;

  db.query(sql, [userId], (err, result) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка загрузки персонажей",
      });
    }

    res.json(result);
  });
});

/* бот*/
app.get("/bot/:id", (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT
      b.id,
      b.creator_id,
      b.name,
      b.short_description,
      b.full_description,
      b.avatar_url,
      b.greeting_message,
      b.system_prompt,
      b.visibility,
      b.is_blocked,
      b.is_deleted,
      b.tags,
      b.created_at,
      b.updated_at,
      u.username AS author_name,
      u.avatar_url AS author_avatar
    FROM bots b
    LEFT JOIN users u ON b.creator_id = u.id
    WHERE b.id = ?
    LIMIT 1
  `;

  db.query(sql, [id], (err, result) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка загрузки персонажа",
      });
    }

    if (result.length === 0) {
      return res.status(404).json({
        message: "Персонаж не найден",
      });
    }

    res.json(result[0]);
  });
});

/*Обновление бота*/
app.put("/bot/:id", (req, res) => {
  const { id } = req.params;
  const {
    user_id,
    name,
    short_description,
    full_description,
    avatar_url,
    greeting_message,
    system_prompt,
    visibility,
    tags,
  } = req.body;

  if (!user_id) {
    return res.status(400).json({
      message: "Не указан пользователь",
    });
  }

  const safeVisibility = visibility === "private" ? "private" : "public";
  const safeTags = sanitizeBotTagsField(tags);

  const checkSql = `
    SELECT id, creator_id
    FROM bots
    WHERE id = ?
    LIMIT 1
  `;

  db.query(checkSql, [id], (err, result) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка проверки бота",
      });
    }

    if (result.length === 0) {
      return res.status(404).json({
        message: "Бот не найден",
      });
    }

    const bot = result[0];

    if (Number(bot.creator_id) !== Number(user_id)) {
      return res.status(403).json({
        message: "Вы не можете редактировать этого бота",
      });
    }

    const updateSql = `
      UPDATE bots
      SET
        name = ?,
        short_description = ?,
        full_description = ?,
        avatar_url = ?,
        greeting_message = ?,
        system_prompt = ?,
        visibility = ?,
        tags = ?,
        updated_at = NOW()
      WHERE id = ?
    `;

    db.query(
      updateSql,
      [
        name || "",
        short_description || "",
        full_description || "",
        avatar_url || "",
        greeting_message || "",
        system_prompt || "",
        safeVisibility,
        safeTags,
        id,
      ],
      (updateErr) => {
        if (updateErr) {
          return res.status(500).json({
            message: "Ошибка обновления бота",
          });
        }

        res.json({
          message: "Бот обновлён ✅",
        });
      },
    );
  });
});

/*Удаление бота*/
app.delete("/bot/:id", (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({
      message: "Не указан пользователь",
    });
  }

  const checkSql = `
    SELECT id, creator_id
    FROM bots
    WHERE id = ?
    LIMIT 1
  `;

  db.query(checkSql, [id], (err, result) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка проверки бота",
      });
    }

    if (result.length === 0) {
      return res.status(404).json({
        message: "Бот не найден",
      });
    }

    const bot = result[0];

    if (Number(bot.creator_id) !== Number(user_id)) {
      return res.status(403).json({
        message: "Вы не можете удалить этого бота",
      });
    }

    const deleteMessagesSql = `
      DELETE m
      FROM messages m
      INNER JOIN chats c ON m.chat_id = c.id
      WHERE c.bot_id = ?
    `;

    db.query(deleteMessagesSql, [id], (messagesErr) => {
      if (messagesErr) {
        return res.status(500).json({
          message: "Ошибка удаления сообщений",
        });
      }

      const deleteChatsSql = `DELETE FROM chats WHERE bot_id = ?`;

      db.query(deleteChatsSql, [id], (chatsErr) => {
        if (chatsErr) {
          return res.status(500).json({
            message: "Ошибка удаления чатов",
          });
        }

        const deleteBotSql = `DELETE FROM bots WHERE id = ?`;

        db.query(deleteBotSql, [id], (deleteErr) => {
          if (deleteErr) {
            return res.status(500).json({
              message: "Ошибка удаления бота",
            });
          }

          res.json({
            message: "Бот удалён ✅",
          });
        });
      });
    });
  });
});

/*Создать чат id бота*/
app.get("/chat-thread/:botId", (req, res) => {
  const { botId } = req.params;
  const userId = requireUserIdFromQuery(req, res);
  if (userId == null) return;
  const personaId = parsePersonaIdFromQuery(req);

  const botStateSql = `
    SELECT id, COALESCE(is_blocked, 0) AS is_blocked, COALESCE(is_deleted, 0) AS is_deleted
    FROM bots
    WHERE id = ?
    LIMIT 1
  `;

  const statsSql = `
    SELECT
      c.id AS chat_id,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender_type = 'user') AS user_message_count
    FROM chats c
    WHERE c.user_id = ? AND c.bot_id = ? AND (c.persona_id <=> ?)
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT 1
  `;

  const legacyStatsSql = `
    SELECT
      c.id AS chat_id,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender_type = 'user') AS user_message_count
    FROM chats c
    WHERE c.user_id = ? AND c.bot_id = ? AND c.persona_id IS NULL
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT 1
  `;

  const respondWithRow = (row) => {
    const messageCount = Number(row.message_count) || 0;
    const userMsgCount = Number(row.user_message_count) || 0;
    return res.json({
      exists: true,
      chat_id: Number(row.chat_id),
      message_count: messageCount,
      has_user_messages: userMsgCount > 0,
    });
  };

  db.query(botStateSql, [botId], (botErr, botRows) => {
    if (botErr) {
      return res.status(500).json({ message: "Ошибка проверки бота" });
    }
    if (!botRows.length) {
      return res.status(404).json({ message: "Бот не найден" });
    }
    const isRestricted =
      Number(botRows[0].is_blocked) === 1 || Number(botRows[0].is_deleted) === 1;

    db.query(statsSql, [userId, botId, personaId], (err, rows) => {
    if (err) {
      return res.status(500).json({ message: "Ошибка проверки чата" });
    }
    if (rows.length) {
        return res.json({
          ...{
            exists: true,
            chat_id: Number(rows[0].chat_id),
            message_count: Number(rows[0].message_count) || 0,
            has_user_messages: (Number(rows[0].user_message_count) || 0) > 0,
          },
          is_restricted: isRestricted,
        });
    }
    if (personaId == null) {
      return res.json({
        exists: false,
        chat_id: null,
        message_count: 0,
        has_user_messages: false,
          is_restricted: isRestricted,
      });
    }
      hasConcretePersonaChatForUserBot(userId, botId, (hcErr, hasConcrete) => {
      if (hcErr) {
        return res.status(500).json({ message: "Ошибка проверки чата" });
      }
      if (hasConcrete) {
        return res.json({
          exists: false,
          chat_id: null,
          message_count: 0,
          has_user_messages: false,
          is_restricted: isRestricted,
        });
      }
      db.query(legacyStatsSql, [userId, botId], (legErr, legRows) => {
        if (legErr) {
          return res.status(500).json({ message: "Ошибка проверки чата" });
        }
        if (!legRows.length) {
          return res.json({
            exists: false,
            chat_id: null,
            message_count: 0,
            has_user_messages: false,
            is_restricted: isRestricted,
          });
        }
        const row = legRows[0];
        attachLegacyNullPersonaToChat(row.chat_id, personaId, (upErr) => {
          if (upErr) {
            return res.status(500).json({ message: "Ошибка привязки чата к персоне" });
          }
          return res.json({
            exists: true,
            chat_id: Number(row.chat_id),
            message_count: Number(row.message_count) || 0,
            has_user_messages: (Number(row.user_message_count) || 0) > 0,
            is_restricted: isRestricted,
          });
        });
      });
      });
    });
  });
});

app.get("/chat-by-bot/:botId", (req, res) => {
  const { botId } = req.params;
  const userId = requireUserIdFromQuery(req, res);
  if (userId == null) return;
  const personaId = parsePersonaIdFromQuery(req);
  const createNewChat = req.query.new === "1";

  const getBotSql = `
    SELECT
      id,
      name,
      avatar_url,
      greeting_message,
      short_description,
      full_description,
      system_prompt,
      COALESCE(is_blocked, 0) AS is_blocked,
      COALESCE(is_deleted, 0) AS is_deleted
    FROM bots
    WHERE id = ?
    LIMIT 1
  `;

  db.query(getBotSql, [botId], (botErr, botRows) => {
    if (botErr) {
      return res.status(500).json({
        message: "Ошибка загрузки бота",
      });
    }

    if (botRows.length === 0) {
      return res.status(404).json({
        message: "Бот не найден",
      });
    }

    const bot = botRows[0];
    const isRestrictedBot =
      Number(bot.is_blocked) === 1 || Number(bot.is_deleted) === 1;

    const findChatSql = `
      SELECT
        id,
        user_id,
        bot_id,
        persona_id,
        title,
        summary,
        visibility,
        created_at,
        updated_at,
        (
          SELECT COUNT(*)
          FROM messages um
          WHERE um.chat_id = chats.id AND um.sender_type = 'user'
        ) AS user_message_count
      FROM chats
      WHERE user_id = ? AND bot_id = ? AND (persona_id <=> ?)
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;

    const sendFullChat = (chat) => {
      const messagesSql = `
        SELECT
          id,
          chat_id,
          sender_type,
          content,
          COALESCE(policy_violation, 0) AS policy_violation,
          content_variants,
          created_at
        FROM messages
        WHERE chat_id = ?
        ORDER BY created_at ASC, id ASC
      `;

      const respondWithMessages = () => {
        db.query(messagesSql, [chat.id], (msgErr2, msgRows2) => {
          if (msgErr2) {
            return res.status(500).json({
              message: "Ошибка загрузки сообщений",
            });
          }

          res.json({
            chat,
            bot,
            messages: decryptMessageRowsForApi(msgRows2),
          });
        });
      };

      db.query(messagesSql, [chat.id], (msgErr, msgRows) => {
        if (msgErr) {
          return res.status(500).json({
            message: "Ошибка загрузки сообщений",
          });
        }

        if (!msgRows.length) {
          return seedBotGreetingIfChatHasNoMessages(chat.id, (seedErr) => {
            if (seedErr) {
              console.warn(
                "Не удалось подставить приветствие в пустой чат —",
                seedErr.message,
              );
            }
            return respondWithMessages();
          });
        }

        res.json({
          chat,
          bot,
          messages: decryptMessageRowsForApi(msgRows),
        });
      });
    };

    const insertFreshChat = () => {
      const insertChatSql = `
        INSERT INTO chats
        (
          user_id,
          bot_id,
          persona_id,
          title,
          summary,
          visibility,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, '', 'private', NOW(), NOW())
      `;

      db.query(
        insertChatSql,
        [userId, botId, personaId, `Чат с ${bot.name}`],
        (insertErr, insertResult) => {
          if (insertErr) {
            return res.status(500).json({
              message: "Ошибка создания чата",
            });
          }

          const newChat = {
            id: insertResult.insertId,
            user_id: userId,
            bot_id: Number(botId),
            persona_id: personaId,
            title: `Чат с ${bot.name}`,
            summary: "",
            visibility: "private",
          };

          if (bot.greeting_message && bot.greeting_message.trim()) {
            const greetingSql = `
              INSERT INTO messages
              (
                chat_id,
                sender_type,
                content,
                created_at
              )
              VALUES (?, 'bot', ?, NOW())
            `;

            db.query(
              greetingSql,
              [newChat.id, encryptMessageContentForDb(bot.greeting_message)],
              (greetErr) => {
                if (greetErr) {
                  return res.status(500).json({
                    message: "Чат создан, но приветствие не сохранилось",
                  });
                }

                sendFullChat(newChat);
              },
            );
          } else {
            sendFullChat(newChat);
          }
        },
      );
    };

    if (createNewChat && isRestrictedBot) {
      return res.status(403).json({
        message:
          "Этот бот заблокирован. Новый чат создать нельзя, можно только продолжить существующий.",
      });
    }

    if (createNewChat) {
      deleteChatsForUserBotPersona(userId, botId, personaId, (delErr) => {
        if (delErr) {
          return res.status(500).json({
            message: "Ошибка сброса чата",
          });
        }
        if (personaId != null) {
          deleteLegacyNullPersonaChatsForUserBot(userId, botId, (legDelErr) => {
            if (legDelErr) {
              return res.status(500).json({
                message: "Ошибка сброса чата",
              });
            }
            insertFreshChat();
          });
          return;
        }
        insertFreshChat();
      });
      return;
    }

    db.query(findChatSql, [userId, botId, personaId], (chatErr, chatRows) => {
      if (chatErr) {
        return res.status(500).json({
          message: "Ошибка поиска чата",
        });
      }

      if (
        chatRows.length > 0 &&
        (!isRestrictedBot || Number(chatRows[0].user_message_count || 0) > 0)
      ) {
        return sendFullChat(chatRows[0]);
      }

      if (isRestrictedBot) {
        return res.status(403).json({
          message:
            "Этот бот заблокирован. Новый чат создать нельзя, можно только продолжить существующий.",
        });
      }

      if (personaId == null) {
        return insertFreshChat();
      }

      const legacyFindSql = `
        SELECT
          id,
          user_id,
          bot_id,
          persona_id,
          title,
          summary,
          visibility,
          created_at,
          updated_at
        FROM chats
        WHERE user_id = ? AND bot_id = ? AND persona_id IS NULL
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `;

      hasConcretePersonaChatForUserBot(userId, botId, (hcErr, hasConcrete) => {
        if (hcErr) {
          return res.status(500).json({
            message: "Ошибка поиска чата",
          });
        }
        if (hasConcrete) {
          return insertFreshChat();
        }
        db.query(legacyFindSql, [userId, botId], (legErr, legChatRows) => {
          if (legErr) {
            return res.status(500).json({
              message: "Ошибка поиска чата",
            });
          }
          if (!legChatRows.length) {
            return insertFreshChat();
          }
          const legacyChat = legChatRows[0];
          attachLegacyNullPersonaToChat(legacyChat.id, personaId, (upErr) => {
            if (upErr) {
              return res.status(500).json({
                message: "Ошибка привязки чата к персоне",
              });
            }
            sendFullChat({
              ...legacyChat,
              persona_id: personaId,
            });
          });
        });
      });
    });
  });
});

/*Получение чата по id*/
app.get("/chat/:chatId", (req, res) => {
  const { chatId } = req.params;

  const chatSql = `
    SELECT
      c.id,
      c.user_id,
      c.bot_id,
      c.persona_id,
      c.title,
      c.summary,
      c.visibility,
      c.created_at,
      c.updated_at,
      b.name AS bot_name,
      b.avatar_url,
      b.greeting_message
    FROM chats c
    LEFT JOIN bots b ON c.bot_id = b.id
    WHERE c.id = ?
    LIMIT 1
  `;

  db.query(chatSql, [chatId], (chatErr, chatRows) => {
    if (chatErr) {
      return res.status(500).json({
        message: "Ошибка загрузки чата",
      });
    }

    if (chatRows.length === 0) {
      return res.status(404).json({
        message: "Чат не найден",
      });
    }

    const chat = chatRows[0];

    const messagesSql = `
      SELECT
        id,
        chat_id,
        sender_type,
        content,
        COALESCE(policy_violation, 0) AS policy_violation,
        content_variants,
        created_at
      FROM messages
      WHERE chat_id = ?
      ORDER BY created_at ASC, id ASC
    `;

    const respondChatByIdMessages = () => {
      db.query(messagesSql, [chatId], (msgErr2, msgRows2) => {
        if (msgErr2) {
          return res.status(500).json({
            message: "Ошибка загрузки сообщений",
          });
        }

        res.json({
          chat,
          bot: {
            id: chat.bot_id,
            name: chat.bot_name,
            avatar_url: chat.avatar_url,
            greeting_message: chat.greeting_message,
          },
          messages: decryptMessageRowsForApi(msgRows2),
        });
      });
    };

    db.query(messagesSql, [chatId], (msgErr, msgRows) => {
      if (msgErr) {
        return res.status(500).json({
          message: "Ошибка загрузки сообщений",
        });
      }

      if (!msgRows.length) {
        return seedBotGreetingIfChatHasNoMessages(chatId, (seedErr) => {
          if (seedErr) {
            console.warn(
              "Не удалось подставить приветствие в пустой чат —",
              seedErr.message,
            );
          }
          return respondChatByIdMessages();
        });
      }

      res.json({
        chat,
        bot: {
          id: chat.bot_id,
          name: chat.bot_name,
          avatar_url: chat.avatar_url,
          greeting_message: chat.greeting_message,
        },
        messages: decryptMessageRowsForApi(msgRows),
      });
    });
  });
});

/*отправка сообщений*/
app.post("/chat/:chatId/message", (req, res) => {
  const { chatId } = req.params;
  const { text, persona_prompt, persona_name, proxy } = req.body;
  const runtimeConfig = resolveRuntimeConfig(
    proxy,
    req.body?.llm_model,
    req.body?.llm_settings,
  );
  const normalizedText = String(text || "").trim();

  if (!normalizedText) {
    return res.status(400).json({
      message: "Пустое сообщение",
    });
  }

  if (normalizedText.length > MAX_USER_MESSAGE_LENGTH) {
    return res.status(400).json({
      message: `Сообщение слишком длинное (максимум ${MAX_USER_MESSAGE_LENGTH} символов)`,
    });
  }

  const getChatSql = `
    SELECT
      c.id,
      c.bot_id,
      b.name AS bot_name,
      b.system_prompt AS bot_system_prompt
    FROM chats c
    LEFT JOIN bots b ON c.bot_id = b.id
    WHERE c.id = ?
    LIMIT 1
  `;

  db.query(getChatSql, [chatId], (chatErr, chatRows) => {
    if (chatErr) {
      return res.status(500).json({
        message: "Ошибка проверки чата",
      });
    }

    if (chatRows.length === 0) {
      return res.status(404).json({
        message: "Чат не найден",
      });
    }

    const chat = chatRows[0];
    if (rejectIfCloudLlmNotReady(res, req.body?.proxy)) return;

    const policyHit = classifyUserPolicyViolation(normalizedText);
    const policyViolationFlag = policyHit ? 1 : 0;

    const saveUserMessageSql = `
      INSERT INTO messages
      (
        chat_id,
        sender_type,
        content,
        policy_violation,
        created_at
      )
      VALUES (?, 'user', ?, ?, NOW())
    `;

    db.query(
      saveUserMessageSql,
      [chatId, encryptMessageContentForDb(normalizedText), policyViolationFlag],
      (saveUserErr, saveUserResult) => {
        if (saveUserErr) {
          return res.status(500).json({
            message: "Ошибка сохранения сообщения пользователя",
          });
        }

        const updateChatTimestamp = (callback) => {
          db.query("UPDATE chats SET updated_at = NOW() WHERE id = ?", [chatId], () => {
            callback();
          });
        };

        if (policyHit) {
          const saveFilteredBotSql = `
            INSERT INTO messages
            (
              chat_id,
              sender_type,
              content,
              created_at
            )
            VALUES (?, 'bot', ?, NOW())
          `;

          return db.query(
            saveFilteredBotSql,
            [chatId, encryptMessageContentForDb(FILTERED_BOT_MESSAGE_PLACEHOLDER)],
            (saveBotErr, saveBotResult) => {
              if (saveBotErr) {
                return res.status(500).json({
                  message: "Ошибка сохранения ответа фильтра",
                });
              }

              return updateChatTimestamp(() => {
                res.json({
                  message: "Контент отфильтрован по правилам площадки",
                  content_filtered: true,
                  filter_reason: policyHit.kind,
                  user_message: {
                    id: saveUserResult.insertId,
                    chat_id: Number(chatId),
                    sender_type: "user",
                    content: normalizedText,
                    policy_violation: 1,
                  },
                  reply: {
                    id: saveBotResult.insertId,
                    chat_id: Number(chatId),
                    sender_type: "bot",
                    content: FILTERED_BOT_MESSAGE_PLACEHOLDER,
                  },
                });
              });
            },
          );
        }

        const historySql = `
          SELECT
            sender_type,
            content,
            COALESCE(policy_violation, 0) AS policy_violation
          FROM messages
          WHERE chat_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `;

        db.query(historySql, [chatId, CHAT_HISTORY_LIMIT], async (historyErr, historyRows) => {
          if (historyErr) {
            return res.status(500).json({
              message: "Ошибка подготовки контекста чата",
            });
          }

          let botReply = "";
          try {
            botReply = await generateBotReply({
              botName: chat.bot_name,
              botSystemPrompt: chat.bot_system_prompt,
              personaPrompt: String(persona_prompt || ""),
              personaName: String(persona_name || ""),
              history: mapMessagesToOllamaHistory(historyRows),
              runtimeConfig,
            });
          } catch (modelErr) {
            return res.status(500).json({
              message: `Не удалось получить ответ от модели: ${String(modelErr?.message || "неизвестная ошибка")}`,
            });
          }

          const saveBotMessageSql = `
            INSERT INTO messages
            (
              chat_id,
              sender_type,
              content,
              created_at
            )
            VALUES (?, 'bot', ?, NOW())
          `;

          db.query(saveBotMessageSql, [chatId, encryptMessageContentForDb(botReply)], (saveBotErr, saveBotResult) => {
            if (saveBotErr) {
              return res.status(500).json({
                message: "Ошибка сохранения ответа бота",
              });
            }

            updateChatTimestamp(() => {
              res.json({
                message: "Сообщение отправлено ✅",
                user_message: {
                  id: saveUserResult.insertId,
                  chat_id: Number(chatId),
                  sender_type: "user",
                  content: normalizedText,
                  policy_violation: 0,
                },
                reply: {
                  id: saveBotResult.insertId,
                  chat_id: Number(chatId),
                  sender_type: "bot",
                  content: botReply,
                },
              });
            });
          });
        });
      });
  });
});

app.put("/chat/:chatId/message/:messageId", async (req, res) => {
  const { chatId, messageId } = req.params;
  const { user_id, text, swipe_variants } = req.body;
  const normalizedText = String(text || "").trim();

  if (!user_id) {
    return res.status(400).json({ message: "Не указан пользователь" });
  }
  if (!normalizedText) {
    return res.status(400).json({ message: "Пустое сообщение" });
  }
  if (normalizedText.length > MAX_USER_MESSAGE_LENGTH) {
    return res.status(400).json({
      message: `Сообщение слишком длинное (максимум ${MAX_USER_MESSAGE_LENGTH} символов)`,
    });
  }

  const policyHit = classifyUserPolicyViolation(normalizedText);

  try {
    const ownedChat = await getOwnedChat(chatId, user_id);
    if (!ownedChat) return res.status(404).json({ message: "Чат не найден" });
    if (ownedChat === "forbidden") {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    const messageRows = await dbQuery(
      `
        SELECT id, chat_id, sender_type, content
        FROM messages
        WHERE id = ? AND chat_id = ?
        LIMIT 1
      `,
      [messageId, chatId],
    );
    if (!messageRows.length) {
      return res.status(404).json({ message: "Сообщение не найдено" });
    }

    const existingPlain = decryptMessageContentFromDb(messageRows[0].content);
    if (
      messageRows[0].sender_type === "bot" &&
      String(existingPlain || "").trim() === FILTERED_BOT_MESSAGE_PLACEHOLDER
    ) {
      return res.status(400).json({
        message: "Сообщение фильтра контента нельзя редактировать",
      });
    }

    if (messageRows[0].sender_type === "user" && policyHit) {
      return res.status(400).json({
        message:
          "Текст не проходит правила площадки (18+, жестокость или нецензурная лексика). Измените формулировку.",
      });
    }

    let updated;

    if (messageRows[0].sender_type === "user") {
      await dbQuery(
        `
          UPDATE messages
          SET content = ?, policy_violation = 0, content_variants = NULL
          WHERE id = ? AND chat_id = ?
        `,
        [encryptMessageContentForDb(normalizedText), messageId, chatId],
      );
      updated = {
        id: Number(messageId),
        chat_id: Number(chatId),
        sender_type: "user",
        content: normalizedText,
        policy_violation: 0,
      };
    } else {
      let encVariants = null;
      let botVariantIndex = null;
      let botVariantsOut = null;
      const sv = swipe_variants;
      if (sv && Array.isArray(sv.variants) && sv.variants.length >= 2) {
        const vars = sv.variants.map((x) => String(x));
        let idx = Number(sv.index);
        if (!Number.isFinite(idx)) idx = vars.length - 1;
        idx = Math.max(0, Math.min(vars.length - 1, Math.floor(idx)));
        if (String(vars[idx] ?? "").trim() !== normalizedText) {
          return res.status(400).json({
            message: "Некорректные данные вариантов ответа",
          });
        }
        encVariants = encryptMessageContentForDb(JSON.stringify({ v: vars, i: idx }));
        botVariantIndex = idx;
        botVariantsOut = vars;
      }
      await dbQuery(
        `
          UPDATE messages
          SET content = ?, content_variants = ?
          WHERE id = ? AND chat_id = ?
        `,
        [encryptMessageContentForDb(normalizedText), encVariants, messageId, chatId],
      );
      updated = {
        id: Number(messageId),
        chat_id: Number(chatId),
        sender_type: "bot",
        content: normalizedText,
        ...(botVariantsOut
          ? { _contentVariants: botVariantsOut, _variantIndex: botVariantIndex }
          : { _contentVariants: null, _variantIndex: null }),
      };
    }

    await dbQuery("UPDATE chats SET updated_at = NOW() WHERE id = ?", [chatId]);

    return res.json({
      message: "Сообщение обновлено ✅",
      updated,
    });
  } catch (error) {
    return res.status(500).json({ message: "Ошибка редактирования сообщения" });
  }
});

app.delete("/chat/:chatId/message/:messageId", async (req, res) => {
  const { chatId, messageId } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ message: "Не указан пользователь" });
  }

  try {
    const ownedChat = await getOwnedChat(chatId, user_id);
    if (!ownedChat) return res.status(404).json({ message: "Чат не найден" });
    if (ownedChat === "forbidden") {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    const oldestBotId = await getOldestBotMessageIdInChat(chatId);
    if (oldestBotId != null && Number(messageId) === oldestBotId) {
      return res.status(400).json({
        message: "Начальное сообщение бота нельзя удалить",
      });
    }

    const deleteResult = await dbQuery(
      "DELETE FROM messages WHERE id = ? AND chat_id = ?",
      [messageId, chatId],
    );
    if (deleteResult.affectedRows === 0) {
      return res.status(404).json({ message: "Сообщение не найдено" });
    }

    await dbQuery("UPDATE chats SET updated_at = NOW() WHERE id = ?", [chatId]);
    return res.json({ message: "Сообщение удалено ✅", deleted_id: Number(messageId) });
  } catch (error) {
    return res.status(500).json({ message: "Ошибка удаления сообщения" });
  }
});

/* Удалить все сообщения после указанного (перемотать сюда) */
app.post("/chat/:chatId/rewind-to/:messageId", async (req, res) => {
  const { chatId, messageId } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ message: "Не указан пользователь" });
  }

  try {
    const ownedChat = await getOwnedChat(chatId, user_id);
    if (!ownedChat) return res.status(404).json({ message: "Чат не найден" });
    if (ownedChat === "forbidden") {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    const existsRows = await dbQuery(
      "SELECT id FROM messages WHERE id = ? AND chat_id = ? LIMIT 1",
      [messageId, chatId],
    );
    if (!existsRows.length) {
      return res.status(404).json({ message: "Сообщение не найдено" });
    }

    const deleteResult = await dbQuery(
      "DELETE FROM messages WHERE chat_id = ? AND id > ?",
      [chatId, messageId],
    );
    await dbQuery("UPDATE chats SET updated_at = NOW() WHERE id = ?", [chatId]);

    return res.json({
      message: "История обрезана ✅",
      deleted_count: Number(deleteResult.affectedRows) || 0,
    });
  } catch (error) {
    return res.status(500).json({ message: "Ошибка обрезки истории" });
  }
});

app.post("/chat/:chatId/message/:messageId/regenerate", async (req, res) => {
  const { chatId, messageId } = req.params;
  const { user_id, persona_prompt, persona_name, proxy, swipe } = req.body;
  const runtimeConfig = resolveRuntimeConfig(
    proxy,
    req.body?.llm_model,
    req.body?.llm_settings,
  );

  if (!user_id) {
    return res.status(400).json({ message: "Не указан пользователь" });
  }
  if (rejectIfCloudLlmNotReady(res, req.body?.proxy)) return;

  try {
    const ownedChat = await getOwnedChat(chatId, user_id);
    if (!ownedChat) return res.status(404).json({ message: "Чат не найден" });
    if (ownedChat === "forbidden") {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    const targetRows = await dbQuery(
      `
        SELECT id, sender_type, content, content_variants
        FROM messages
        WHERE id = ? AND chat_id = ?
        LIMIT 1
      `,
      [messageId, chatId],
    );
    if (!targetRows.length) {
      return res.status(404).json({ message: "Сообщение не найдено" });
    }
    if (targetRows[0].sender_type !== "bot") {
      return res.status(400).json({ message: "Перегенерация доступна только для ответа бота" });
    }

    const oldestBotId = await getOldestBotMessageIdInChat(chatId);
    if (oldestBotId != null && Number(messageId) === oldestBotId) {
      return res.status(400).json({
        message: "Начальное сообщение бота нельзя перегенерировать",
      });
    }

    const previousRows = await dbQuery(
      `
        SELECT id
        FROM messages
        WHERE chat_id = ? AND id < ?
        ORDER BY id DESC
        LIMIT 1
      `,
      [chatId, messageId],
    );
    const upperMessageId = previousRows.length ? Number(previousRows[0].id) : null;

    const regenerated = await buildBotReplyFromHistory(
      dbQuery,
      chatId,
      ownedChat,
      String(persona_prompt || ""),
      String(persona_name || ""),
      upperMessageId,
      { regenerate: true, swipe: Boolean(swipe) },
      runtimeConfig,
    );

    const plainOld = decryptMessageContentFromDb(targetRows[0].content);
    let oldMeta = null;
    if (
      targetRows[0].content_variants != null &&
      String(targetRows[0].content_variants).trim() !== ""
    ) {
      try {
        oldMeta = JSON.parse(
          decryptMessageContentFromDb(targetRows[0].content_variants),
        );
      } catch {
        oldMeta = null;
      }
    }

    const isSwipe = Boolean(swipe);
    let swipeVariantsList = null;
    let swipeVariantIndex = null;

    if (isSwipe) {
      if (oldMeta && Array.isArray(oldMeta.v) && oldMeta.v.length >= 2) {
        swipeVariantsList = [...oldMeta.v.map((x) => String(x)), String(regenerated)];
      } else {
        swipeVariantsList = [String(plainOld), String(regenerated)];
      }
      swipeVariantIndex = swipeVariantsList.length - 1;
      const encVar = encryptMessageContentForDb(
        JSON.stringify({ v: swipeVariantsList, i: swipeVariantIndex }),
      );
      await dbQuery(
        `
          UPDATE messages
          SET content = ?, content_variants = ?
          WHERE id = ? AND chat_id = ?
        `,
        [
          encryptMessageContentForDb(regenerated),
          encVar,
          messageId,
          chatId,
        ],
      );
    } else {
      await dbQuery(
        `
          UPDATE messages
          SET content = ?, content_variants = NULL
          WHERE id = ? AND chat_id = ?
        `,
        [encryptMessageContentForDb(regenerated), messageId, chatId],
      );
    }
    await dbQuery("UPDATE chats SET updated_at = NOW() WHERE id = ?", [chatId]);

    if (isSwipe && swipeVariantsList) {
      return res.json({
        message: "Ответ перегенерирован ✅",
        reply: {
          id: Number(messageId),
          chat_id: Number(chatId),
          sender_type: "bot",
          content: regenerated,
          _contentVariants: swipeVariantsList,
          _variantIndex: swipeVariantIndex,
        },
      });
    }

    return res.json({
      message: "Ответ перегенерирован ✅",
      reply: {
        id: Number(messageId),
        chat_id: Number(chatId),
        sender_type: "bot",
        content: regenerated,
      },
    });
  } catch (error) {
    return res.status(500).json({
      message: `Ошибка перегенерации сообщения: ${String(error?.message || "неизвестная ошибка")}`,
    });
  }
});

app.post("/chat/:chatId/continue", async (req, res) => {
  const { chatId } = req.params;
  const { user_id, persona_prompt, persona_name, proxy } = req.body;
  const runtimeConfig = resolveRuntimeConfig(
    proxy,
    req.body?.llm_model,
    req.body?.llm_settings,
  );

  if (!user_id) {
    return res.status(400).json({ message: "Не указан пользователь" });
  }
  if (rejectIfCloudLlmNotReady(res, req.body?.proxy)) return;

  try {
    const ownedChat = await getOwnedChat(chatId, user_id);
    if (!ownedChat) return res.status(404).json({ message: "Чат не найден" });
    if (ownedChat === "forbidden") {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    const continuedReply = await buildBotReplyFromHistory(
      dbQuery,
      chatId,
      ownedChat,
      String(persona_prompt || ""),
      String(persona_name || ""),
      null,
      {},
      runtimeConfig,
    );
    const insertResult = await dbQuery(
      `
        INSERT INTO messages
        (
          chat_id,
          sender_type,
          content,
          created_at
        )
        VALUES (?, 'bot', ?, NOW())
      `,
      [chatId, encryptMessageContentForDb(continuedReply)],
    );
    await dbQuery("UPDATE chats SET updated_at = NOW() WHERE id = ?", [chatId]);

    return res.json({
      message: "Продолжение сгенерировано ✅",
      reply: {
        id: insertResult.insertId,
        chat_id: Number(chatId),
        sender_type: "bot",
        content: continuedReply,
      },
    });
  } catch (error) {
    return res.status(500).json({
      message: `Ошибка генерации продолжения: ${String(error?.message || "неизвестная ошибка")}`,
    });
  }
});

/*мои чаты*/
app.get("/my-chats/:userId", (req, res) => {
  const { userId } = req.params;

  const sql = `
    SELECT
      c.id,
      c.user_id,
      c.bot_id,
      c.persona_id,
      c.title,
      c.summary,
      c.visibility,
      c.created_at,
      c.updated_at,
      b.name AS bot_name,
      b.avatar_url,
      COALESCE(b.is_blocked, 0) AS bot_is_blocked,
      COALESCE(b.is_deleted, 0) AS bot_is_deleted,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messages_count
    FROM chats c
    LEFT JOIN bots b ON c.bot_id = b.id
    WHERE c.user_id = ?
    ORDER BY c.updated_at DESC, c.created_at DESC
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка загрузки чатов",
      });
    }

    res.json(rows);
  });
});

/* Избранные боты (таблица favorites_bots) */
app.get("/favorite-bots/:userId", (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  if (!Number.isFinite(userId) || userId < 1) {
    return res.status(400).json({ message: "Некорректный user id" });
  }

  const sql = `
    SELECT DISTINCT bot_id
    FROM favorites_bots
    WHERE user_id = ?
    ORDER BY bot_id ASC
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      console.error("favorite-bots GET:", err);
      return res.status(500).json({ message: "Ошибка загрузки избранного" });
    }

    const bot_ids = (rows || [])
      .map((r) => Number(r.bot_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    res.json({ bot_ids });
  });
});

app.post("/favorite-bots", (req, res) => {
  const user_id = parseInt(String(req.body?.user_id), 10);
  const bot_id = parseInt(String(req.body?.bot_id), 10);

  if (!Number.isFinite(user_id) || user_id < 1) {
    return res.status(400).json({ message: "Некорректный user_id" });
  }
  if (!Number.isFinite(bot_id) || bot_id < 1) {
    return res.status(400).json({ message: "Некорректный bot_id" });
  }

  db.query("SELECT id FROM bots WHERE id = ? LIMIT 1", [bot_id], (botErr, botRows) => {
    if (botErr) {
      console.error("favorite-bots POST bot check:", botErr);
      return res.status(500).json({ message: "Ошибка проверки бота" });
    }
    if (!botRows.length) {
      return res.status(404).json({ message: "Бот не найден" });
    }

    const insertSql = `
      INSERT INTO favorites_bots (user_id, bot_id, created_at)
      VALUES (?, ?, NOW())
    `;

    db.query(insertSql, [user_id, bot_id], (insErr) => {
      if (insErr) {
        if (insErr.code === "ER_DUP_ENTRY" || Number(insErr.errno) === 1062) {
          return res.json({ message: "Уже в избранном", already: true, bot_id });
        }
        console.error("favorite-bots POST:", insErr);
        return res.status(500).json({ message: "Ошибка добавления в избранное" });
      }

      res.json({ message: "Добавлено в избранное ✅", bot_id });
    });
  });
});

app.delete("/favorite-bots", (req, res) => {
  const body = req.body || {};
  const q = req.query || {};
  const user_id = parseInt(
    String(
      body.user_id != null && String(body.user_id).trim() !== ""
        ? body.user_id
        : q.user_id,
    ),
    10,
  );
  const bot_id = parseInt(
    String(
      body.bot_id != null && String(body.bot_id).trim() !== ""
        ? body.bot_id
        : q.bot_id,
    ),
    10,
  );

  if (!Number.isFinite(user_id) || user_id < 1) {
    return res.status(400).json({ message: "Некорректный user_id" });
  }
  if (!Number.isFinite(bot_id) || bot_id < 1) {
    return res.status(400).json({ message: "Некорректный bot_id" });
  }

  db.query(
    "DELETE FROM favorites_bots WHERE user_id = ? AND bot_id = ?",
    [user_id, bot_id],
    (delErr) => {
      if (delErr) {
        console.error("favorite-bots DELETE:", delErr);
        return res.status(500).json({ message: "Ошибка удаления из избранного" });
      }

      res.json({ message: "Удалено из избранного ✅", bot_id });
    },
  );
});

/* Жалобы пользователей */
app.post("/reports", (req, res) => {
  const reporterId = Number(req.body?.reporter_id);
  const targetTypeRaw = String(req.body?.target_type || "").trim().toLowerCase();
  const targetType = targetTypeRaw === "profile" ? "profile" : targetTypeRaw === "bot" ? "bot" : "";
  const targetId = Number(req.body?.target_id);
  const reason = String(req.body?.reason || "").trim();
  const details = String(req.body?.details || "").trim();

  if (!Number.isFinite(reporterId) || reporterId < 1) {
    return res.status(400).json({ message: "Некорректный автор жалобы" });
  }
  if (!targetType || !Number.isFinite(targetId) || targetId < 1) {
    return res.status(400).json({ message: "Некорректная цель жалобы" });
  }
  if (!reason) {
    return res.status(400).json({ message: "Укажите причину жалобы" });
  }

  const finishInsert = () => {
    db.query(
      `
        INSERT INTO reports (reporter_id, target_type, target_id, reason, details, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', NOW(), NOW())
      `,
      [reporterId, targetType, targetId, reason, details],
      (insertErr) => {
        if (insertErr) {
          return res.status(500).json({ message: "Ошибка создания жалобы" });
        }
        res.json({ message: "Жалоба отправлена ✅" });
      },
    );
  };

  db.query(
    "SELECT id, role_id FROM users WHERE id = ? LIMIT 1",
    [reporterId],
    (reporterErr, reporterRows) => {
      if (reporterErr) return res.status(500).json({ message: "Ошибка проверки автора жалобы" });
      if (!reporterRows.length) return res.status(404).json({ message: "Автор жалобы не найден" });
      if (Number(reporterRows[0].role_id) === 2) {
        return res.status(403).json({
          message: "Администратор не может отправлять жалобы — используйте блокировку/удаление",
        });
      }

      if (targetType === "profile") {
        if (Number(targetId) === Number(reporterId)) {
          return res.status(400).json({ message: "Нельзя жаловаться на самого себя" });
        }

        db.query("SELECT id FROM users WHERE id = ? LIMIT 1", [targetId], (userErr, users) => {
          if (userErr) return res.status(500).json({ message: "Ошибка проверки профиля" });
          if (!users.length) return res.status(404).json({ message: "Профиль не найден" });
          finishInsert();
        });
        return;
      }

      db.query(
        "SELECT id, creator_id FROM bots WHERE id = ? LIMIT 1",
        [targetId],
        (botErr, bots) => {
          if (botErr) return res.status(500).json({ message: "Ошибка проверки бота" });
          if (!bots.length) return res.status(404).json({ message: "Бот не найден" });
          if (Number(bots[0].creator_id) === Number(reporterId)) {
            return res.status(400).json({ message: "Нельзя жаловаться на своего бота" });
          }
          finishInsert();
        },
      );
    },
  );
});

/* Обжалование блокировки/удаления ботом его автором */
app.post("/reports/appeal", (req, res) => {
  const reporterId = Number(req.body?.reporter_id);
  const botId = Number(req.body?.bot_id);
  const reason = String(req.body?.reason || "").trim();

  if (!Number.isFinite(reporterId) || reporterId < 1) {
    return res.status(400).json({ message: "Некорректный автор обращения" });
  }
  if (!Number.isFinite(botId) || botId < 1) {
    return res.status(400).json({ message: "Некорректный бот для обжалования" });
  }
  if (!reason) {
    return res.status(400).json({ message: "Укажите причину обжалования" });
  }

  db.query(
    "SELECT id, role_id FROM users WHERE id = ? LIMIT 1",
    [reporterId],
    (reporterErr, reporterRows) => {
      if (reporterErr) return res.status(500).json({ message: "Ошибка проверки автора обращения" });
      if (!reporterRows.length) return res.status(404).json({ message: "Пользователь не найден" });
      if (Number(reporterRows[0].role_id) === 2) {
        return res.status(403).json({ message: "Администратор не использует обжалование" });
      }

      db.query(
        "SELECT id, creator_id, COALESCE(is_blocked, 0) AS is_blocked, COALESCE(is_deleted, 0) AS is_deleted FROM bots WHERE id = ? LIMIT 1",
        [botId],
        (botErr, botRows) => {
          if (botErr) return res.status(500).json({ message: "Ошибка проверки бота" });
          if (!botRows.length) return res.status(404).json({ message: "Бот не найден" });

          const bot = botRows[0];
          if (Number(bot.creator_id) !== Number(reporterId)) {
            return res.status(403).json({ message: "Обжалование может подать только автор бота" });
          }

          const isRestricted = Number(bot.is_blocked) === 1 || Number(bot.is_deleted) === 1;
          if (!isRestricted) {
            return res.status(400).json({ message: "Этот бот не заблокирован и не удален" });
          }

          db.query(
            `
              INSERT INTO reports (reporter_id, target_type, target_id, reason, details, status, created_at, updated_at)
              VALUES (?, 'bot', ?, ?, 'appeal', 'pending', NOW(), NOW())
            `,
            [reporterId, botId, `Апелляция автора: ${reason}`],
            (insertErr) => {
              if (insertErr) return res.status(500).json({ message: "Ошибка отправки обжалования" });
              res.json({ message: "Обжалование отправлено ✅" });
            },
          );
        },
      );
    },
  );
});

/*Начало Админ. Получение пользователей*/
app.get("/admin/users", requireAdmin, (req, res) => {
  const sql = `
    SELECT
      id,
      username,
      email,
      role_id,
      is_blocked,
      avatar_url,
      created_at
    FROM users
    ORDER BY id DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка загрузки пользователей",
      });
    }

    res.json(rows);
  });
});

app.put("/admin/users/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const { role_id } = req.body;

  const sql = `
    UPDATE users
    SET
      role_id = ?
    WHERE id = ?
  `;

  db.query(
    sql,
    [Number(role_id) || 1, id],
    (err) => {
      if (err) {
        return res.status(500).json({
          message: "Ошибка обновления пользователя",
        });
      }

      res.json({
        message: "Пользователь обновлён ✅",
      });
    },
  );
});

app.put("/admin/users/:id/block", requireAdmin, (req, res) => {
  const { id } = req.params;
  const shouldBlock = Number(req.body?.is_blocked) === 1 ? 1 : 0;

  if (Number(id) === Number(req.headers["x-user-id"])) {
    return res.status(400).json({
      message: "Нельзя изменить блокировку для самого себя",
    });
  }

  db.query(
    `
      UPDATE users
      SET is_blocked = ?
      WHERE id = ?
    `,
    [shouldBlock, id],
    (err) => {
      if (err) {
        return res.status(500).json({
          message: "Ошибка изменения блокировки пользователя",
        });
      }

      res.json({
        message: shouldBlock
          ? "Пользователь заблокирован ✅"
          : "Пользователь разблокирован ✅",
      });
    },
  );
});

/*Удаление пользователя*/
app.delete("/admin/users/:id", requireAdmin, (req, res) => {
  const { id } = req.params;

  if (Number(id) === Number(req.headers["x-user-id"])) {
    return res.status(400).json({
      message: "Нельзя удалить самого себя",
    });
  }

  deleteUserByAdmin(id, (err) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка удаления пользователя",
      });
    }

    res.json({
      message: "Пользователь удалён ✅",
    });
  });
});

app.get("/admin/bots", requireAdmin, (req, res) => {
  const sql = `
    SELECT
      b.id,
      b.name,
      b.creator_id,
      b.avatar_url,
      b.visibility,
      b.is_blocked,
      b.is_deleted,
      b.tags,
      b.created_at,
      u.username AS author_name
    FROM bots b
    LEFT JOIN users u ON b.creator_id = u.id
    ORDER BY b.id DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка загрузки ботов",
      });
    }

    res.json(rows);
  });
});

app.put("/admin/bots/:id", requireAdmin, (req, res) => {
  return res.status(403).json({
    message:
      "Редактирование названия, тегов и приватности бота из админ-панели отключено",
  });
});

app.put("/admin/bots/:id/block", requireAdmin, (req, res) => {
  const { id } = req.params;
  const shouldBlock = Number(req.body?.is_blocked) === 1 ? 1 : 0;

  db.query(
    `
      UPDATE bots
      SET
        is_blocked = ?,
        updated_at = NOW()
      WHERE id = ?
    `,
    [shouldBlock, id],
    (err) => {
      if (err) {
        return res.status(500).json({
          message: "Ошибка изменения блокировки бота",
        });
      }

      res.json({
        message: shouldBlock ? "Бот заблокирован ✅" : "Бот разблокирован ✅",
      });
    },
  );
});

/*Удаление бота админом*/
app.delete("/admin/bots/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  deleteBotByAdmin(id, (err) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка удаления бота",
      });
    }

    res.json({
      message: "Бот удалён ✅",
    });
  });
});

app.get("/admin/reports", requireAdmin, (req, res) => {
  const sql = `
    SELECT
      r.id,
      r.reporter_id,
      reporter.username AS reporter_name,
      r.target_type,
      r.target_id,
      r.reason,
      r.details,
      r.status,
      r.resolution_action,
      r.resolved_by,
      resolver.username AS resolver_name,
      r.resolved_at,
      r.created_at,
      b.name AS bot_name,
      u.username AS profile_name
    FROM reports r
    LEFT JOIN users reporter ON reporter.id = r.reporter_id
    LEFT JOIN users resolver ON resolver.id = r.resolved_by
    LEFT JOIN bots b ON r.target_type = 'bot' AND b.id = r.target_id
    LEFT JOIN users u ON r.target_type = 'profile' AND u.id = r.target_id
    ORDER BY
      CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
      r.created_at DESC,
      r.id DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      return res.status(500).json({ message: "Ошибка загрузки жалоб" });
    }
    res.json(rows);
  });
});

app.put("/admin/reports/:id/resolve", requireAdmin, (req, res) => {
  const reportId = Number(req.params.id);
  const action = String(req.body?.action || "").trim().toLowerCase();
  const resolverId = Number(req.headers["x-user-id"]);

  if (!Number.isFinite(reportId) || reportId < 1) {
    return res.status(400).json({ message: "Некорректный id жалобы" });
  }
  if (!["block", "delete", "dismiss"].includes(action)) {
    return res.status(400).json({ message: "Некорректное действие" });
  }

  db.query(
    `
      SELECT id, target_type, target_id, status
      FROM reports
      WHERE id = ?
      LIMIT 1
    `,
    [reportId],
    (reportErr, reportRows) => {
      if (reportErr) return res.status(500).json({ message: "Ошибка загрузки жалобы" });
      if (!reportRows.length) return res.status(404).json({ message: "Жалоба не найдена" });

      const report = reportRows[0];
      if (report.status !== "pending") {
        return res.status(400).json({ message: "Жалоба уже обработана" });
      }

      const finalize = (status, resolutionAction, message) => {
        db.query(
          `
            UPDATE reports
            SET status = ?, resolution_action = ?, resolved_by = ?, resolved_at = NOW(), updated_at = NOW()
            WHERE id = ?
          `,
          [status, resolutionAction, resolverId, reportId],
          (updateErr) => {
            if (updateErr) return res.status(500).json({ message: "Ошибка сохранения решения" });
            res.json({ message });
          },
        );
      };

      if (action === "dismiss") {
        return finalize("dismissed", "dismiss", "Жалоба отклонена");
      }

      if (report.target_type === "bot") {
        if (action === "block") {
          return db.query(
            "UPDATE bots SET is_blocked = 1, updated_at = NOW() WHERE id = ?",
            [report.target_id],
            (blockErr) => {
              if (blockErr) return res.status(500).json({ message: "Ошибка блокировки бота" });
              finalize("accepted", "block", "Жалоба принята: бот заблокирован");
            },
          );
        }

        return deleteBotByAdmin(report.target_id, (deleteErr) => {
          if (deleteErr) return res.status(500).json({ message: "Ошибка удаления бота" });
          finalize("accepted", "delete", "Жалоба принята: бот удалён");
        });
      }

      if (action === "block") {
        return db.query(
          "UPDATE users SET is_blocked = 1 WHERE id = ?",
          [report.target_id],
          (blockErr) => {
            if (blockErr) return res.status(500).json({ message: "Ошибка блокировки профиля" });
            finalize("accepted", "block", "Жалоба принята: профиль заблокирован");
          },
        );
      }

      deleteUserByAdmin(report.target_id, (deleteErr) => {
        if (deleteErr) return res.status(500).json({ message: "Ошибка удаления профиля" });
        finalize("accepted", "delete", "Жалоба принята: профиль удалён");
      });
    },
  );
});

app.get("/admin/chats", requireAdmin, (req, res) => {
  const sql = `
    SELECT
      c.id,
      c.user_id,
      c.bot_id,
      c.persona_id,
      c.title,
      c.summary,
      c.visibility,
      c.created_at,
      c.updated_at,
      u.username AS user_name,
      b.name AS bot_name
    FROM chats c
    LEFT JOIN users u ON c.user_id = u.id
    LEFT JOIN bots b ON c.bot_id = b.id
    ORDER BY c.id DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка загрузки чатов",
      });
    }

    res.json(rows);
  });
});

/*Удаление чата адамином*/
app.delete("/admin/chats/:id", requireAdmin, (req, res) => {
  const { id } = req.params;

  db.query("DELETE FROM messages WHERE chat_id = ?", [id], (msgErr) => {
    if (msgErr) {
      return res.status(500).json({
        message: "Ошибка удаления сообщений чата",
      });
    }

    db.query("DELETE FROM chats WHERE id = ?", [id], (chatErr) => {
      if (chatErr) {
        return res.status(500).json({
          message: "Ошибка удаления чата",
        });
      }

      res.json({
        message: "Чат удалён ✅",
      });
    });
  });
});
/* публичые боты*/
app.get("/all-bots", (req, res) => {
  const sql = `
    SELECT
      b.id,
      b.creator_id,
      b.name,
      b.short_description,
      b.full_description,
      b.avatar_url,
      b.greeting_message,
      b.system_prompt,
      b.visibility,
      b.tags,
      b.created_at,
      b.updated_at,
      u.username AS author_name
    FROM bots b
    LEFT JOIN users u ON b.creator_id = u.id
    WHERE
      b.visibility = 'public'
      AND COALESCE(b.is_blocked, 0) = 0
      AND COALESCE(b.is_deleted, 0) = 0
    ORDER BY b.created_at DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка загрузки всех ботов",
      });
    }

    res.json(rows);
  });
});


/* ===================== ПЕРСОНЫ ===================== */

/* Получить персоны пользователя */
app.get("/personas/:userId", (req, res) => {
  const { userId } = req.params;

  const sql = `
    SELECT
      id,
      user_id,
      name,
      role,
      description,
      avatar_url,
      persona_prompt,
      is_default,
      created_at,
      updated_at
    FROM personas
    WHERE user_id = ?
    ORDER BY is_default DESC, created_at DESC
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка загрузки персон",
      });
    }

    res.json(rows);
  });
});

/* Создать персону */
app.post("/persona", (req, res) => {
  const {
    user_id,
    name,
    role,
    description,
    avatar_url,
    persona_prompt,
    is_default,
  } = req.body;

  if (!user_id || !name || !description) {
    return res.status(400).json({
      message: "Заполните имя и описание",
    });
  }

  const createPersona = () => {
    const sql = `
      INSERT INTO personas
      (
        user_id,
        name,
        role,
        description,
        avatar_url,
        persona_prompt,
        is_default,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `;

    db.query(
      sql,
      [
        user_id,
        name,
        role || "",
        description,
        avatar_url || "",
        persona_prompt || "",
        Number(is_default) === 1 ? 1 : 0,
      ],
      (err, result) => {
        if (err) {
          return res.status(500).json({
            message: "Ошибка создания персоны",
          });
        }

        res.json({
          message: "Персона создана ✅",
          persona_id: result.insertId,
        });
      }
    );
  };

  if (Number(is_default) === 1) {
    db.query(
      "UPDATE personas SET is_default = 0 WHERE user_id = ?",
      [user_id],
      (err) => {
        if (err) {
          return res.status(500).json({
            message: "Ошибка выбора основной персоны",
          });
        }

        createPersona();
      }
    );
  } else {
    createPersona();
  }
});

/* Обновить персону */
app.put("/persona/:id", (req, res) => {
  const { id } = req.params;
  const {
    user_id,
    name,
    role,
    description,
    avatar_url,
    persona_prompt,
    is_default,
  } = req.body;

  if (!user_id || !name || !description) {
    return res.status(400).json({
      message: "Заполните имя и описание",
    });
  }

  const updatePersona = () => {
    const sql = `
      UPDATE personas
      SET
        name = ?,
        role = ?,
        description = ?,
        avatar_url = ?,
        persona_prompt = ?,
        is_default = ?,
        updated_at = NOW()
      WHERE id = ? AND user_id = ?
    `;

    db.query(
      sql,
      [
        name,
        role || "",
        description,
        avatar_url || "",
        persona_prompt || "",
        Number(is_default) === 1 ? 1 : 0,
        id,
        user_id,
      ],
      (err, result) => {
        if (err) {
          return res.status(500).json({
            message: "Ошибка обновления персоны",
          });
        }

        if (result.affectedRows === 0) {
          return res.status(404).json({
            message: "Персона не найдена",
          });
        }

        res.json({
          message: "Персона обновлена ✅",
        });
      }
    );
  };

  if (Number(is_default) === 1) {
    db.query(
      "UPDATE personas SET is_default = 0 WHERE user_id = ?",
      [user_id],
      (err) => {
        if (err) {
          return res.status(500).json({
            message: "Ошибка выбора основной персоны",
          });
        }

        updatePersona();
      }
    );
  } else {
    updatePersona();
  }
});

/* Сделать персону основной */
app.put("/persona/:id/default", (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({
      message: "Не указан пользователь",
    });
  }

  db.query(
    "UPDATE personas SET is_default = 0 WHERE user_id = ?",
    [user_id],
    (err) => {
      if (err) {
        return res.status(500).json({
          message: "Ошибка обновления персон",
        });
      }

      db.query(
        "UPDATE personas SET is_default = 1 WHERE id = ? AND user_id = ?",
        [id, user_id],
        (updateErr, result) => {
          if (updateErr) {
            return res.status(500).json({
              message: "Ошибка выбора персоны",
            });
          }

          if (result.affectedRows === 0) {
            return res.status(404).json({
              message: "Персона не найдена",
            });
          }

          res.json({
            message: "Основная персона выбрана ✅",
          });
        }
      );
    }
  );
});

/* Удалить персону */
app.delete("/persona/:id", (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({
      message: "Не указан пользователь",
    });
  }

  const sql = `
    DELETE FROM personas
    WHERE id = ? AND user_id = ?
  `;

  db.query(sql, [id, user_id], (err, result) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка удаления персоны",
      });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Персона не найдена",
      });
    }

    res.json({
      message: "Персона удалена ✅",
    });
  });
});
/* удалить сообщения чата */
app.delete("/chat/:chatId/messages", (req, res) => {
  const { chatId } = req.params;
  const body = req.body || {};
  const q = req.query || {};
  const user_id =
    body.user_id != null && String(body.user_id).trim() !== ""
      ? body.user_id
      : q.user_id;

  const cid = parseInt(String(chatId), 10);
  if (!Number.isFinite(cid) || cid < 1) {
    return res.status(400).json({ message: "Некорректный id чата" });
  }

  if (user_id == null || String(user_id).trim() === "") {
    return res.status(400).json({ message: "Не указан пользователь" });
  }

  const checkSql = `
    SELECT id, user_id
    FROM chats
    WHERE id = ?
    LIMIT 1
  `;

  db.query(checkSql, [cid], (err, rows) => {
    if (err) {
      return res.status(500).json({ message: "Ошибка проверки чата" });
    }

    if (!rows.length) {
      return res.status(404).json({ message: "Чат не найден" });
    }

    if (Number(rows[0].user_id) !== Number(user_id)) {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    db.query("DELETE FROM messages WHERE chat_id = ?", [cid], (deleteErr, deleteResult) => {
      if (deleteErr) {
        return res.status(500).json({ message: "Ошибка удаления сообщений" });
      }

      const deletedCount = Number(deleteResult?.affectedRows) || 0;

      seedBotGreetingIfChatHasNoMessages(cid, (seedErr) => {
        if (seedErr) {
          console.warn(
            "После очистки чата не удалось восстановить приветствие —",
            seedErr.message,
          );
        }
        db.query("UPDATE chats SET updated_at = NOW() WHERE id = ?", [cid], () => {
          res.json({
            message: "Сообщения удалены ✅",
            deleted_count: deletedCount,
          });
        });
      });
    });
  });
});

/* удалить чат полностью */
app.delete("/chat/:chatId", (req, res) => {
  const { chatId } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ message: "Не указан пользователь" });
  }

  const checkSql = `
    SELECT id, user_id
    FROM chats
    WHERE id = ?
    LIMIT 1
  `;

  db.query(checkSql, [chatId], (err, rows) => {
    if (err) {
      return res.status(500).json({ message: "Ошибка проверки чата" });
    }

    if (!rows.length) {
      return res.status(404).json({ message: "Чат не найден" });
    }

    if (Number(rows[0].user_id) !== Number(user_id)) {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    db.query("DELETE FROM messages WHERE chat_id = ?", [chatId], (msgErr) => {
      if (msgErr) {
        return res.status(500).json({ message: "Ошибка удаления сообщений" });
      }

      db.query("DELETE FROM chats WHERE id = ?", [chatId], (chatErr) => {
        if (chatErr) {
          return res.status(500).json({ message: "Ошибка удаления чата" });
        }

        res.json({ message: "Чат удалён ✅" });
      });
    });
  });
});





const envPortRaw = process.env.PORT;
const portFromEnvExplicit =
  envPortRaw !== undefined && String(envPortRaw).trim() !== "";
const preferredPort = Number(envPortRaw) || 3000;
const MAX_PORT_FALLBACK_SPAN = 50;

function startHttpServer(port) {
  const server = http.createServer(app);
  currentHttpServer = server;

  server.once("listening", () => {
    const localUrl = `http://localhost:${port}`;
    console.log(`Сервер запущен — ${localUrl}`);
    if (!portFromEnvExplicit && port !== preferredPort) {
      console.warn(
        `(порт ${preferredPort} был занят другим процессом — часто это вторая копия сервера; открывай ${localUrl})`,
      );
    }
    db.query("SELECT 1 AS ok", (dbErr) => {
      if (dbErr) {
        console.error("БД: ошибка —", dbErr.message);
      } else {
        console.log("БД: подключение установлено");
        logLlmModeAtStartup();
        ensurePersonaRoleColumn();
        ensureUserBlockedColumn();
        ensureBotBlockedColumn();
        ensureBotDeletedColumn();
        ensureMessagesPolicyViolationColumn();
        ensureMessagesContentVariantsColumn();
        ensureFavoritesBotsUserBotIndex();
        ensureReportsTable();
      }
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      if (portFromEnvExplicit) {
        console.error(
          `Порт ${port} уже занят. Закройте процесс на этом порту или укажите другой PORT в .env`,
        );
        process.exit(1);
        return;
      }
      const nextPort = port + 1;
      if (nextPort > preferredPort + MAX_PORT_FALLBACK_SPAN) {
        console.error(
          `Не удалось найти свободный порт (пробовали ${preferredPort}…${nextPort - 1}).`,
        );
        process.exit(1);
        return;
      }
      console.warn(`Порт ${port} занят, пробую ${nextPort}…`);
      server.close(() => {
        startHttpServer(nextPort);
      });
      return;
    }
    console.error(err);
    process.exit(1);
  });

  server.listen(port);
}

startHttpServer(preferredPort);

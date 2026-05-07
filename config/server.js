const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const http = require("http");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const db = require("./db");

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
} = require("./aiChat");
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
      tags || "",
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
        tags || "",
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

  db.query(statsSql, [userId, botId, personaId], (err, rows) => {
    if (err) {
      return res.status(500).json({ message: "Ошибка проверки чата" });
    }
    if (rows.length) {
      return respondWithRow(rows[0]);
    }
    if (personaId == null) {
      return res.json({
        exists: false,
        chat_id: null,
        message_count: 0,
        has_user_messages: false,
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
          });
        }
        const row = legRows[0];
        attachLegacyNullPersonaToChat(row.chat_id, personaId, (upErr) => {
          if (upErr) {
            return res.status(500).json({ message: "Ошибка привязки чата к персоне" });
          }
          return respondWithRow(row);
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
      system_prompt
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
        updated_at
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
          created_at
        FROM messages
        WHERE chat_id = ?
        ORDER BY created_at ASC, id ASC
      `;

      db.query(messagesSql, [chat.id], (msgErr, msgRows) => {
        if (msgErr) {
          return res.status(500).json({
            message: "Ошибка загрузки сообщений",
          });
        }

        res.json({
          chat,
          bot,
          messages: msgRows,
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
              [newChat.id, bot.greeting_message],
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

      if (chatRows.length > 0) {
        return sendFullChat(chatRows[0]);
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
        created_at
      FROM messages
      WHERE chat_id = ?
      ORDER BY created_at ASC, id ASC
    `;

    db.query(messagesSql, [chatId], (msgErr, msgRows) => {
      if (msgErr) {
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
        messages: msgRows,
      });
    });
  });
});

/*отправка сообщений*/
app.post("/chat/:chatId/message", (req, res) => {
  const { chatId } = req.params;
  const { text, persona_prompt, persona_name, proxy } = req.body;
  const runtimeConfig = normalizeRuntimeConfigFromBodyProxy(proxy);
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

    const saveUserMessageSql = `
      INSERT INTO messages
      (
        chat_id,
        sender_type,
        content,
        created_at
      )
      VALUES (?, 'user', ?, NOW())
    `;

    db.query(saveUserMessageSql, [chatId, normalizedText], (saveUserErr, saveUserResult) => {
      if (saveUserErr) {
        return res.status(500).json({
          message: "Ошибка сохранения сообщения пользователя",
        });
      }

      const historySql = `
        SELECT
          sender_type,
          content
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

        db.query(saveBotMessageSql, [chatId, botReply], (saveBotErr, saveBotResult) => {
          if (saveBotErr) {
            return res.status(500).json({
              message: "Ошибка сохранения ответа бота",
            });
          }

          const updateChatSql = `
            UPDATE chats
            SET updated_at = NOW()
            WHERE id = ?
          `;

          db.query(updateChatSql, [chatId], (updateErr) => {
            if (updateErr) {
            }

            res.json({
              message: "Сообщение отправлено ✅",
              user_message: {
                id: saveUserResult.insertId,
                chat_id: Number(chatId),
                sender_type: "user",
                content: normalizedText,
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
  const { user_id, text } = req.body;
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

  try {
    const ownedChat = await getOwnedChat(chatId, user_id);
    if (!ownedChat) return res.status(404).json({ message: "Чат не найден" });
    if (ownedChat === "forbidden") {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    const messageRows = await dbQuery(
      `
        SELECT id, chat_id, sender_type
        FROM messages
        WHERE id = ? AND chat_id = ?
        LIMIT 1
      `,
      [messageId, chatId],
    );
    if (!messageRows.length) {
      return res.status(404).json({ message: "Сообщение не найдено" });
    }

    await dbQuery(
      `
        UPDATE messages
        SET content = ?
        WHERE id = ? AND chat_id = ?
      `,
      [normalizedText, messageId, chatId],
    );
    await dbQuery("UPDATE chats SET updated_at = NOW() WHERE id = ?", [chatId]);

    return res.json({
      message: "Сообщение обновлено ✅",
      updated: {
        id: Number(messageId),
        chat_id: Number(chatId),
        sender_type: messageRows[0].sender_type,
        content: normalizedText,
      },
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

app.post("/chat/:chatId/message/:messageId/regenerate", async (req, res) => {
  const { chatId, messageId } = req.params;
  const { user_id, persona_prompt, persona_name, proxy } = req.body;
  const runtimeConfig = normalizeRuntimeConfigFromBodyProxy(proxy);

  if (!user_id) {
    return res.status(400).json({ message: "Не указан пользователь" });
  }

  try {
    const ownedChat = await getOwnedChat(chatId, user_id);
    if (!ownedChat) return res.status(404).json({ message: "Чат не найден" });
    if (ownedChat === "forbidden") {
      return res.status(403).json({ message: "Нет доступа к этому чату" });
    }

    const targetRows = await dbQuery(
      `
        SELECT id, sender_type
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
      { regenerate: true },
      runtimeConfig,
    );

    await dbQuery(
      `
        UPDATE messages
        SET content = ?
        WHERE id = ? AND chat_id = ?
      `,
      [regenerated, messageId, chatId],
    );
    await dbQuery("UPDATE chats SET updated_at = NOW() WHERE id = ?", [chatId]);

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
  const runtimeConfig = normalizeRuntimeConfigFromBodyProxy(proxy);

  if (!user_id) {
    return res.status(400).json({ message: "Не указан пользователь" });
  }

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
      [chatId, continuedReply],
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

  const deleteMessagesSql = `
    DELETE m
    FROM messages m
    INNER JOIN chats c ON m.chat_id = c.id
    WHERE c.user_id = ?
  `;

  db.query(deleteMessagesSql, [id], (messagesErr) => {
    if (messagesErr) {
      return res.status(500).json({
        message: "Ошибка удаления сообщений пользователя",
      });
    }

    const deleteChatsSql = `DELETE FROM chats WHERE user_id = ?`;

    db.query(deleteChatsSql, [id], (chatsErr) => {
      if (chatsErr) {
        return res.status(500).json({
          message: "Ошибка удаления чатов пользователя",
        });
      }

      const deleteBotsMessagesSql = `
        DELETE m
        FROM messages m
        INNER JOIN chats c ON m.chat_id = c.id
        INNER JOIN bots b ON c.bot_id = b.id
        WHERE b.creator_id = ?
      `;

      db.query(deleteBotsMessagesSql, [id], (bmErr) => {
        if (bmErr) {
          return res.status(500).json({
            message: "Ошибка удаления сообщений ботов пользователя",
          });
        }

        const deleteBotsChatsSql = `
          DELETE c
          FROM chats c
          INNER JOIN bots b ON c.bot_id = b.id
          WHERE b.creator_id = ?
        `;

        db.query(deleteBotsChatsSql, [id], (bcErr) => {
          if (bcErr) {
            return res.status(500).json({
              message: "Ошибка удаления чатов ботов пользователя",
            });
          }

          const deleteBotsSql = `DELETE FROM bots WHERE creator_id = ?`;

          db.query(deleteBotsSql, [id], (botsErr) => {
            if (botsErr) {
              return res.status(500).json({
                message: "Ошибка удаления ботов пользователя",
              });
            }

            const deleteUserSql = `DELETE FROM users WHERE id = ?`;

            db.query(deleteUserSql, [id], (userErr) => {
              if (userErr) {
                return res.status(500).json({
                  message: "Ошибка удаления пользователя",
                });
              }

              res.json({
                message: "Пользователь удалён ✅",
              });
            });
          });
        });
      });
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
  const { id } = req.params;
  const { name, visibility, tags } = req.body;

  const sql = `
    UPDATE bots
    SET
      name = ?,
      visibility = ?,
      tags = ?,
      updated_at = NOW()
    WHERE id = ?
  `;

  db.query(sql, [name || "", visibility || "public", tags || "", id], (err) => {
    if (err) {
      return res.status(500).json({
        message: "Ошибка обновления бота",
      });
    }

    res.json({
      message: "Бот обновлён ✅",
    });
  });
});

/*Удаление бота админом*/
app.delete("/admin/bots/:id", requireAdmin, (req, res) => {
  const { id } = req.params;

  const deleteMessagesSql = `
    DELETE m
    FROM messages m
    INNER JOIN chats c ON m.chat_id = c.id
    WHERE c.bot_id = ?
  `;

  db.query(deleteMessagesSql, [id], (messagesErr) => {
    if (messagesErr) {
      return res.status(500).json({
        message: "Ошибка удаления сообщений бота",
      });
    }

    const deleteChatsSql = `DELETE FROM chats WHERE bot_id = ?`;

    db.query(deleteChatsSql, [id], (chatsErr) => {
      if (chatsErr) {
        return res.status(500).json({
          message: "Ошибка удаления чатов бота",
        });
      }

      const deleteBotSql = `DELETE FROM bots WHERE id = ?`;

      db.query(deleteBotSql, [id], (err) => {
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
  });
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
    WHERE b.visibility = 'public'
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

    db.query("DELETE FROM messages WHERE chat_id = ?", [chatId], (deleteErr) => {
      if (deleteErr) {
        return res.status(500).json({ message: "Ошибка удаления сообщений" });
      }

      db.query(
        "UPDATE chats SET updated_at = NOW() WHERE id = ?",
        [chatId],
        () => {
          res.json({ message: "Сообщения удалены ✅" });
        }
      );
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
        ensurePersonaRoleColumn();
        ensureUserBlockedColumn();
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

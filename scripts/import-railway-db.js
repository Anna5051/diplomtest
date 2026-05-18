/**
 * Импорт charitor_ai_db.sql в Railway MySQL (без DBeaver).
 * В .env.railway вставьте RAILWAY_MYSQL_URL из Railway → MySQL → Connect → Общедоступная сеть
 * node scripts/import-railway-db.js
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env.railway"),
});

const sqlFile =
  process.env.RAILWAY_SQL_FILE ||
  path.resolve(__dirname, "../charitor_ai_db.sql");

function parseMysqlUrl(url) {
  const u = new URL(url.replace(/^mysql:\/\//, "http://"));
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username || "root"),
    password: decodeURIComponent(u.password || ""),
    database: u.pathname.replace(/^\//, "") || "railway",
  };
}

function getConfig() {
  if (process.env.RAILWAY_MYSQL_URL) {
    return parseMysqlUrl(process.env.RAILWAY_MYSQL_URL.trim());
  }
  return {
    host: process.env.RAILWAY_DB_HOST,
    port: Number(process.env.RAILWAY_DB_PORT || 3306),
    user: process.env.RAILWAY_DB_USER || "root",
    password: process.env.RAILWAY_DB_PASSWORD || "",
    database: process.env.RAILWAY_DB_NAME || "railway",
  };
}

async function main() {
  const cfg = getConfig();
  if (!cfg.host || !cfg.password) {
    console.error(
      "Создайте файл .env.railway в корне проекта.\n\n" +
        "Вариант 1 (проще): одна строка из Railway Connect:\n" +
        "RAILWAY_MYSQL_URL=mysql://root:ПАРОЛЬ@хост:порт/railway\n\n" +
        "Вариант 2: RAILWAY_DB_HOST, RAILWAY_DB_PORT, RAILWAY_DB_USER, RAILWAY_DB_PASSWORD, RAILWAY_DB_NAME",
    );
    process.exit(1);
  }

  if (!fs.existsSync(sqlFile)) {
    console.error("Файл не найден:", sqlFile);
    process.exit(1);
  }

  console.log(
    "Подключение:",
    cfg.user + "@" + cfg.host + ":" + cfg.port + "/" + cfg.database,
  );

  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: true,
    connectTimeout: 120000,
    ssl:
      process.env.RAILWAY_DB_SSL === "0"
        ? undefined
        : { rejectUnauthorized: false },
  });

  console.log("OK. Импорт SQL (1–3 мин)...");
  const sql = fs.readFileSync(sqlFile, "utf8");
  await conn.query(sql);
  const [rows] = await conn.query("SHOW TABLES");
  const [users] = await conn.query("SELECT COUNT(*) AS n FROM users");
  console.log("Готово. Таблиц:", rows.length, "| users:", users[0].n);
  await conn.end();
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  if (err.code === "ER_ACCESS_DENIED_ERROR") {
    console.error(
      "\n→ Railway → MySQL → Settings → Reset Password\n" +
        "→ Connect → Общедоступная сеть → скопируйте URL целиком в RAILWAY_MYSQL_URL",
    );
  }
  process.exit(1);
});

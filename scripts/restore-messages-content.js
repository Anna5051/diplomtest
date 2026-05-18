/**
 * Восстанавливает content/content_variants в Railway MySQL из charitor_ai_db.sql
 * для сообщений, которые на сервере перешифровались другим ключом.
 *
 * .env.railway — как в import-railway-db.js
 * node scripts/restore-messages-content.js
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const {
  decryptMessageContentFromDb,
} = require("../config/messageContentCrypto");

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

function unescapeSqlString(raw) {
  if (!raw || raw === "NULL") return null;
  return String(raw).replace(/''/g, "'");
}

function parseFieldFromRow(row, startIdx) {
  let i = startIdx;
  while (row[i] === " " || row[i] === ",") i++;
  if (row.slice(i, i + 4) === "NULL") return { value: null, next: i + 4 };
  if (row[i] !== "'") return { value: null, next: i };
  i++;
  let out = "";
  while (i < row.length) {
    if (row[i] === "'" && row[i + 1] === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (row[i] === "'") return { value: out, next: i + 1 };
    out += row[i++];
  }
  return { value: out, next: i };
}

function parseMessagesFromDump(sql) {
  const map = new Map();
  const lines = sql.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("(") || !trimmed.includes("'bot'") && !trimmed.includes("'user'")) {
      continue;
    }
    const row = trimmed.replace(/^\(/, "").replace(/\),?$/, "");
    const id = Number(row.split(",")[0]);
    if (!Number.isFinite(id)) continue;

    const senderIdx = row.indexOf("'bot'");
    const userIdx = row.indexOf("'user'");
    const typeIdx =
      senderIdx >= 0 && (userIdx < 0 || senderIdx < userIdx) ? senderIdx : userIdx;
    if (typeIdx < 0) continue;

    const afterType = row.indexOf(",", typeIdx + 6) + 1;
    const contentField = parseFieldFromRow(row, afterType);
    const afterContent = row.indexOf(",", contentField.next);
    const policyEnd = row.indexOf(",", afterContent + 1) + 1;
    const variantsField = parseFieldFromRow(row, policyEnd);

    map.set(id, {
      id,
      content: contentField.value,
      content_variants: variantsField.value,
    });
  }
  return map;
}

function canDecrypt(content) {
  if (!content || !String(content).startsWith("CHARITOR_ENC_V1:")) return true;
  try {
    decryptMessageContentFromDb(content);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const cfg = getConfig();
  if (!cfg.host || !cfg.password) {
    console.error("Нужен .env.railway с RAILWAY_MYSQL_URL");
    process.exit(1);
  }
  if (!fs.existsSync(sqlFile)) {
    console.error("Не найден дамп:", sqlFile);
    process.exit(1);
  }

  const dumpMap = parseMessagesFromDump(fs.readFileSync(sqlFile, "utf8"));
  console.log("Сообщений в дампе:", dumpMap.size);

  const conn = await mysql.createConnection({
    ...cfg,
    connectTimeout: 120000,
    ssl:
      process.env.RAILWAY_DB_SSL === "0"
        ? undefined
        : { rejectUnauthorized: false },
  });

  const [rows] = await conn.query(
    "SELECT id, content, content_variants FROM messages ORDER BY id",
  );

  let restored = 0;
  let ok = 0;
  let missing = 0;

  for (const row of rows) {
    if (canDecrypt(row.content)) {
      ok++;
      continue;
    }
    const fromDump = dumpMap.get(Number(row.id));
    if (!fromDump) {
      missing++;
      continue;
    }
    await conn.execute(
      "UPDATE messages SET content = ?, content_variants = ? WHERE id = ?",
      [fromDump.content, fromDump.content_variants, row.id],
    );
    restored++;
    console.log("восстановлено id=", row.id);
  }

  await conn.end();
  console.log({ ok, restored, missing, total: rows.length });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { parseMessagesFromDump, canDecrypt };

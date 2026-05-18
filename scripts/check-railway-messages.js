require("dotenv").config({ path: require("path").resolve(__dirname, "../.env.railway") });
const mysql = require("mysql2/promise");
const crypto = require("../config/messageContentCrypto");

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

async function main() {
  const cfg = parseMysqlUrl(process.env.RAILWAY_MYSQL_URL.trim());
  const c = await mysql.createConnection({
    ...cfg,
    ssl: { rejectUnauthorized: false },
  });

  const [chats] = await c.query(
    "SELECT id, bot_id, user_id FROM chats ORDER BY id DESC LIMIT 20",
  );
  console.log("chats:", chats);

  const [msgs] = await c.query(
    "SELECT id, chat_id, sender_type, CHAR_LENGTH(content) AS len FROM messages ORDER BY id",
  );
  console.log("messages count:", msgs.length);

  for (const m of msgs) {
    const [[row]] = await c.query("SELECT content FROM messages WHERE id = ?", [
      m.id,
    ]);
    try {
      const t = crypto.decryptMessageContentFromDb(row.content);
      console.log(`OK id=${m.id} chat=${m.chat_id} ${m.sender_type}:`, t.slice(0, 50));
    } catch (e) {
      console.log(`FAIL id=${m.id} chat=${m.chat_id}:`, e.message);
    }
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

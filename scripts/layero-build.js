const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const skipNames = new Set([
  "node_modules",
  "dist",
  ".git",
  ".layero",
  "config",
  "scripts",
]);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const dir of ["css", "js", "img", "pages"]) {
  copyDir(path.join(root, dir), path.join(dist, dir));
}

const apiUrl = String(process.env.API_URL || process.env.LAYERO_API_URL || "")
  .trim()
  .replace(/\/$/, "");
const runtimeConfig = `window.__API_BASE__ = ${JSON.stringify(apiUrl)};\n`;
fs.writeFileSync(path.join(dist, "js", "runtime-config.js"), runtimeConfig, "utf8");

const landing = path.join(root, "pages", "index.html");
if (fs.existsSync(landing)) {
  fs.copyFileSync(landing, path.join(dist, "index.html"));
}

console.log("Layero build OK → dist/", apiUrl ? `API_URL=${apiUrl}` : "API_URL=(same origin)");

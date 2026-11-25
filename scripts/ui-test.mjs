// Opens the notch screen in the app's own web engine and presses every button, against a throwaway
// HOME with a fake Bot API and a fake model server. Set UI_SHOTS=<dir> to keep the snapshots.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.UI_ROOT || path.join(SCRIPTS, "..");
const PORT = Number(process.env.PORT || 4898);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "notch-ui-"));
const SUPPORT = path.join(HOME, "Library/Application Support/MausBot Notch");
const TOKEN = "t".repeat(40);
const SHOTS = process.env.UI_SHOTS || HOME;
fs.mkdirSync(SUPPORT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

async function listen(handler) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    handler(req, body ? JSON.parse(body) : null, (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const botApi = await listen((req, body, json) => {
  if (req.url.includes("notch-key-check")) {
    const good = /^Bearer (ka|kb|kc)$/.test(req.headers.authorization);
    return good ? json(404, { error: "no such thread" }) : json(401, { error: "Invalid key" });
  }
  if (req.method === "GET" || body.message === "work") return json(202, { status: "working", thread: "t1" });
  if (body.message === "slow") return; // never answers
  json(200, { thread: "t1", reply: body.message === "long" ? "line\n".repeat(60) : body.message.startsWith("html") ? body.message : "Hi there." });
});
const modelApi = await listen((req, body, json) => req.url.endsWith("/models") ? json(200, { data: [{ id: "m" }, { id: "m2" }, { id: "nomic-embed" }] }) : json(200, { choices: [{ message: { content: "Model answer." }, finish_reason: "stop" }] }));

fs.writeFileSync(path.join(SUPPORT, "config.json"), JSON.stringify({
  pollIntervalSec: 300,
  bots: [
    { name: "Ann", id: "a", key: "ka", baseUrl: botApi.url, color: "pink" },
    { name: "Ben", id: "b", key: "kb", baseUrl: botApi.url, color: "green" }
  ],
  reply: { openaiUrl: `${modelApi.url}/v1`, model: "m" },
  presets: [
    { id: "mine", name: "Tenant reply", instruction: "Rewrite for a tenant.", botId: "a" },
    { id: "bens", name: "Only Ben's", instruction: "Rewrite for Ben.", botId: "b" },
    { id: "all", name: "For everyone <b>", instruction: "Rewrite.", botId: null }
  ]
}), { mode: 0o600 });

const bridge = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  env: { ...process.env, HOME, PORT: String(PORT), MAUSBOT_NOTCH_AUTH_TOKEN: TOKEN }, stdio: "inherit"
});
try {
  const host = path.join(HOME, "ui-host");
  execFileSync("swiftc", [path.join(SCRIPTS, "ui-host.swift"), "-o", host], { stdio: "inherit" });
  for (const [page, script] of [["/?native=1", "ui-test-page.js"], ["/settings.html#bots", "settings-test-page.js"]]) {
    const test = path.join(HOME, script);
    fs.writeFileSync(test, ["ui-test-helpers.js", script].map((f) => fs.readFileSync(path.join(SCRIPTS, f), "utf8")).join("\n"));
    const run = spawn(host, [`http://127.0.0.1:${PORT}${page}`, test, SHOTS, TOKEN], { stdio: "inherit" });
    process.exitCode = await new Promise((r) => run.on("close", (code) => r(code ?? 1)));
    if (process.exitCode !== 0) break;
  }
  if (process.exitCode === 0) {
    const settings = path.join(HOME, "settings-window");
    execFileSync("swiftc", ["-parse-as-library", path.join(ROOT, "macos/SettingsWindow.swift"), path.join(SCRIPTS, "settings-window-test.swift"), "-o", settings], { stdio: "inherit" });
    const run = spawn(settings, [String(PORT), TOKEN], { stdio: "inherit" });
    process.exitCode = await new Promise((r) => run.on("close", (code) => r(code ?? 1)));
  }
  if (process.exitCode === 0) console.log("\nALL SCREEN TESTS PASSED");
} finally {
  bridge.kill();
  for (const { server } of [botApi, modelApi]) { server.closeAllConnections(); server.close(); }
  fs.rmSync(HOME, { recursive: true, force: true });
}

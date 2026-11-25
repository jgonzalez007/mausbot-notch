// Boots server.mjs against a throwaway HOME with a fake Bot API and fake model servers, and checks
// rate limiting, lost-reply handling, model choice and draft cancellation. No real services are used.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4899);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "notch-test-"));
const SUPPORT = path.join(HOME, "Library/Application Support/MausBot Notch");
fs.mkdirSync(SUPPORT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listen(handler) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    await handler(req, res, body ? JSON.parse(body) : null);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const bot = { gets: 0, posts: 0, onGet: null, onPost: null };
const botApi = await listen((req, res) => {
  if (req.method === "POST") { bot.posts++; return bot.onPost(res); }
  bot.gets++;
  return bot.onGet(res);
});

const model = { requests: [], aborted: 0, hold: false, reply: "Sounds good.", finish: "stop", tags: [], ps: [] };
const modelApi = await listen(async (req, res, body) => {
  if (req.url === "/api/ps") return json(res, 200, { models: model.ps });
  if (req.url === "/api/tags") return json(res, 200, { models: model.tags });
  model.requests.push({ url: req.url, body });
  if (model.hold) {
    res.on("close", () => { if (!res.writableEnded) model.aborted++; });
    return;
  }
  if (req.url === "/api/chat") {
    if (body.model === "missing") return json(res, 404, { error: "not found" });
    return json(res, 200, { message: { content: model.reply } });
  }
  return json(res, 200, { choices: [{ message: { content: model.reply }, finish_reason: model.finish }] });
});

const CONFIG = path.join(SUPPORT, "config.json");
const STATE = path.join(SUPPORT, "state.json");
const writeConfig = (reply, key = "k") => fs.writeFileSync(CONFIG, JSON.stringify({
  pollIntervalSec: 300, bots: [{ name: "B", id: "b", key, baseUrl: botApi.url }], reply
}));
writeConfig({ openaiUrl: `${modelApi.url}/v1`, model: "m" });

const token = "t".repeat(40);
const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  env: { ...process.env, HOME, PORT: String(PORT), MAUSBOT_NOTCH_AUTH_TOKEN: token }, stdio: "inherit"
});
const api = (url, options = {}) => fetch(BASE + url, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
const post = (url, body, options = {}) => api(url, { method: "POST", body: JSON.stringify(body), ...options }).then((r) => r.json());
const transcript = () => api("/api/bot/b/transcript").then((r) => r.json());
const draft = (options) => post("/api/draft-reply", { kind: "chat", app: "Slack", body: "Maria: Friday ok?" }, options);
const setPending = (extra = {}) => fs.writeFileSync(STATE, JSON.stringify({
  selectedBotId: "b", bots: { b: { thread: "t1", pending: true, messages: [], lastPollAtMs: null, backoffUntilMs: null, pendingSinceMs: Date.now(), ...extra } }
}));
const ok = (name) => console.log(`ok   - ${name}`);

try {
  for (let i = 0; ; i++) {
    try { if ((await api("/api/bootstrap")).ok) break; } catch { /* not up yet */ }
    if (i > 50) throw new Error("server did not start");
    await sleep(100);
  }

  // --- Polling ---
  bot.onGet = (res) => json(res, 202, { status: "working", thread: "t1" });
  setPending();
  for (let i = 0; i < 12; i++) await transcript();
  assert.equal(bot.gets, 1);
  ok("12 quick UI polls make one Bot API call");

  bot.gets = 0;
  bot.onGet = async (res) => { await sleep(300); json(res, 200, { reply: "hello", thread: "t1" }); };
  setPending();
  await Promise.all([transcript(), transcript(), transcript()]);
  let t = await transcript();
  assert.equal(bot.gets, 1);
  assert.deepEqual(t.entries.map((e) => e.text), ["hello"]);
  ok("polls at the same moment share one call and store the reply once");

  bot.onGet = (res) => json(res, 429, {}, { "Retry-After": "2" });
  setPending();
  t = await transcript();
  assert.equal(t.pending, true);
  assert.deepEqual(t.entries, []);
  bot.onGet = (res) => json(res, 200, { reply: "late reply", thread: "t1" });
  await sleep(8200);
  t = await transcript();
  assert.equal(t.pending, false);
  assert.equal(t.entries.at(-1).text, "late reply");
  ok("a reply survives a 429 and arrives afterwards");

  bot.onGet = (res) => json(res, 404, {});
  setPending();
  t = await transcript();
  assert.equal(t.pending, false);
  assert.match(t.entries.at(-1).text, /no longer exists/);
  ok("a conversation that is gone ends the wait");

  bot.onPost = (res) => json(res, 429, {});
  setPending({ lastPollAtMs: Date.now() });
  await post("/api/bot/b/message", { text: "second question" });
  assert.equal((await transcript()).pending, true);
  ok("a refused message doesn't cancel the reply being waited for");

  bot.gets = 0;
  bot.onGet = (res) => json(res, 202, { status: "working", thread: "t1" });
  for (let i = 0; i < 20; i++) { setPending(); await transcript(); }
  assert.ok(bot.gets <= 8, `made ${bot.gets} polls`);
  ok("polling never uses the last calls of the minute");

  // --- Stop waiting and unread ---
  const bots = () => api("/api/bootstrap").then((r) => r.json()).then((b) => b.bots[0]);
  bot.onPost = () => {}; // never answers
  setPending({ pending: false, pendingSinceMs: null });
  const sending = post("/api/bot/b/message", { text: "slow one" });
  await sleep(300);
  assert.ok((await bots()).waitingSinceMs > 0);
  await post("/api/bot/b/stop", {});
  assert.equal((await sending).status, "stopped");
  assert.equal((await bots()).waitingSinceMs, null);
  ok("stopping ends a message that is still being sent");

  bot.onGet = async (res) => { await sleep(400); json(res, 200, { reply: "too late", thread: "t1" }); };
  writeConfig({ openaiUrl: `${modelApi.url}/v1`, model: "m" }, "k2"); // a key with calls left this minute
  bot.gets = 0;
  setPending();
  const polling = transcript();
  await sleep(100);
  await post("/api/bot/b/stop", {});
  t = await polling;
  assert.equal(bot.gets, 1);
  assert.equal(t.pending, false);
  assert.deepEqual(t.entries, []);
  ok("a reply that lands after stopping is dropped");

  await post("/api/notify", { botId: "b", text: "one" });
  const first = (await transcript()).entries.at(-1);
  await post("/api/notify", { botId: "b", text: "two" });
  assert.equal((await bots()).unreadCount, 2);
  await post("/api/bot/b/read", { lastMessageId: first.id });
  assert.equal((await bots()).unreadCount, 1);
  assert.equal((await bots()).lastReplyPreview, "two");
  await post("/api/bot/b/read", { lastMessageId: "gone" });
  assert.equal((await bots()).unreadCount, 1);
  ok("only replies that were shown become read");

  for (const route of ["stop", "read"]) {
    assert.equal((await fetch(`${BASE}/api/bot/b/${route}`, { method: "POST" })).status, 401);
    assert.equal((await api(`/api/bot/nope/${route}`, { method: "POST", body: "{}" })).status, 404);
  }
  ok("stop and read need the launch token and a known bot");

  // --- Model choice ---
  let d = await draft();
  assert.equal(d.draft, "Sounds good.");
  assert.equal(model.requests.at(-1).url, "/v1/chat/completions");
  assert.equal(model.requests.at(-1).body.model, "m");
  ok("drafts with the configured OpenAI-compatible server");

  model.finish = "length";
  d = await draft();
  assert.equal(d.ok, false);
  model.finish = "stop";
  ok("a cut-off answer is never used as a draft");

  model.tags = [{ name: "nomic-embed-text", size: 1 }, { name: "big:cloud", size: 2 }, { name: "far", size: 3, remote_host: "https://x" }, { name: "large", size: 30 }, { name: "small", size: 20 }];
  writeConfig({ ollamaUrl: modelApi.url });
  d = await draft();
  assert.equal(d.model, "small");
  ok("auto-pick skips embedding and cloud models and takes the smallest");

  writeConfig({ ollamaUrl: modelApi.url, model: "missing" });
  d = await draft();
  assert.match(d.error, /isn't installed/);
  ok("a configured model that isn't installed says so");

  writeConfig({ openaiUrl: "http://127.0.0.1:9/v1", model: "m" });
  d = await draft();
  assert.match(d.error, /Couldn't reach the local model server/);
  ok("a model server that is off says so");

  // --- Cancelling ---
  writeConfig({ openaiUrl: `${modelApi.url}/v1`, model: "m" });
  model.hold = true;
  const request = new AbortController();
  const abandoned = draft({ signal: request.signal }).catch(() => "dropped");
  await sleep(300);
  request.abort();
  assert.equal(await abandoned, "dropped");
  await sleep(300);
  assert.equal(model.aborted, 1);
  ok("dropping a draft stops the model request");

  console.log("\nALL BRIDGE TESTS PASSED");
} catch (err) {
  console.error("FAIL -", err);
  process.exitCode = 1;
} finally {
  child.kill();
  botApi.server.closeAllConnections();
  botApi.server.close();
  modelApi.server.closeAllConnections();
  modelApi.server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

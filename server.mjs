import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 4799);

const HOME = os.homedir();
const SUPPORT_DIR = path.join(HOME, "Library/Application Support/MausBot Notch");
const CONFIG_FILE = path.join(SUPPORT_DIR, "config.json");
const STATE_FILE = path.join(SUPPORT_DIR, "state.json");
const AUTH_TOKEN_FILE = path.join(SUPPORT_DIR, "launch-auth-token");

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const MAX_MESSAGES_PER_BOT = 20;
const REMOTE_WAIT_SECONDS = 50;

function ensureSupportDir() {
  fs.mkdirSync(SUPPORT_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(SUPPORT_DIR, 0o700);
  } catch {
    // ignore
  }
}

function initLaunchAuthToken() {
  const fromEnv = process.env.MAUSBOT_NOTCH_AUTH_TOKEN;
  const token =
    typeof fromEnv === "string" && fromEnv.length >= 32
      ? fromEnv
      : crypto.randomBytes(32).toString("base64url");
  ensureSupportDir();
  try {
    fs.writeFileSync(AUTH_TOKEN_FILE, token, { mode: 0o600, encoding: "utf8" });
  } catch (err) {
    console.error("[mausbot-notch] Failed to write launch auth token file:", err.message);
  }
  return token;
}

const LAUNCH_AUTH_TOKEN = initLaunchAuthToken();

function authTokenMatches(provided) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(LAUNCH_AUTH_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractLaunchAuthToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  const custom = req.headers["x-mausbot-notch-token"];
  if (typeof custom === "string") return custom;
  return null;
}

function validateHostAndOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, status: 403, error: "Invalid Host" };
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return { ok: false, status: 403, error: "Invalid Origin" };
  }
  return { ok: true, origin: origin || null };
}

function corsHeadersForOrigin(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-MausBot-Notch-Token",
    Vary: "Origin"
  };
}

// ============================================================================
// CONFIG: the list of MausBot bots this Notch can talk to.
// ~/Library/Application Support/MausBot Notch/config.json
//   { "bots": [ { "name": "MausBot", "id": "<botId>", "key": "<bot-api-key>", "baseUrl": "https://your-instance" } ] }
// ============================================================================
function defaultConfig() {
  return { bots: [] };
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (!Array.isArray(raw.bots)) return defaultConfig();
    return raw;
  } catch {
    return defaultConfig();
  }
}

function ensureConfigFileExists() {
  if (fs.existsSync(CONFIG_FILE)) return;
  ensureSupportDir();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[mausbot-notch] Failed to create config.json:", err.message);
  }
}

function findBotConfig(botId) {
  const config = readConfig();
  return config.bots.find((b) => b.id === botId) || null;
}

// ============================================================================
// LOCAL STATE: selected bot + per-bot conversation thread/transcript.
// ============================================================================
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { selectedBotId: null, bots: {} };
  }
}

function writeState(state) {
  ensureSupportDir();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[mausbot-notch] Failed to write state.json:", err.message);
  }
}

function botState(state, botId) {
  if (!state.bots[botId]) {
    state.bots[botId] = { thread: null, pending: false, messages: [] };
  }
  return state.bots[botId];
}

function pushMessage(entry, role, text) {
  entry.messages.push({
    id: crypto.randomUUID(),
    role,
    text,
    timestampMs: Date.now()
  });
  if (entry.messages.length > MAX_MESSAGES_PER_BOT) {
    entry.messages.splice(0, entry.messages.length - MAX_MESSAGES_PER_BOT);
  }
}

// ============================================================================
// MausBot Bot API bridge
// https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/docs/bot-api.md
// ============================================================================
async function sendBotMessage(botConfig, text, thread) {
  const url = new URL(`/hooks/api/bots/${encodeURIComponent(botConfig.id)}/messages`, botConfig.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botConfig.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: text,
      ...(thread ? { thread } : {}),
      wait: REMOTE_WAIT_SECONDS
    })
  });
  return parseBotApiResponse(res);
}

async function pollBotThread(botConfig, thread) {
  const url = new URL(`/hooks/api/bots/${encodeURIComponent(botConfig.id)}/messages`, botConfig.baseUrl);
  url.searchParams.set("thread", thread);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${botConfig.key}` }
  });
  return parseBotApiResponse(res);
}

async function parseBotApiResponse(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 200) {
    return { ok: true, done: true, reply: body?.reply ?? "", thread: body?.thread ?? null };
  }
  if (res.status === 202) {
    return { ok: true, done: false, status: body?.status || "working", thread: body?.thread ?? null };
  }
  const reason = STATUS_REASONS[res.status] || `HTTP ${res.status}`;
  return { ok: false, done: true, error: reason };
}

const STATUS_REASONS = {
  400: "The message was rejected (bad request).",
  401: "The Bot API key is wrong.",
  403: "The Bot API is off for this bot, or the bot does not exist.",
  404: "That conversation thread no longer exists.",
  409: "That conversation is still working, or the bot is at its limit.",
  413: "The message was too large.",
  415: "The request was not JSON.",
  429: "Too many calls to this bot in the last minute.",
  502: "The bot could not answer."
};

// ============================================================================
// HTTP handlers
// ============================================================================
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  res.end(body);
}

function injectAuthTokenIntoHtml(html) {
  const escaped = LAUNCH_AUTH_TOKEN.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const snippet = `<script>window.__MAUSBOT_NOTCH_AUTH_TOKEN='${escaped}';</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${snippet}</head>`);
  }
  return `${snippet}${html}`;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function getBootstrapData() {
  const config = readConfig();
  const state = readState();
  const bots = config.bots.map((b) => ({ id: b.id, name: b.name || b.id }));
  const selectedBotId = bots.some((b) => b.id === state.selectedBotId)
    ? state.selectedBotId
    : bots[0]?.id || null;
  return { ok: true, bots, selectedBotId };
}

const server = http.createServer(async (req, res) => {
  const security = validateHostAndOrigin(req);
  const cors = corsHeadersForOrigin(security.origin);

  if (!security.ok) {
    return sendJson(res, security.status, { ok: false, error: security.error });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = parsedUrl.pathname;
  const isApiRoute = pathname === "/api" || pathname.startsWith("/api/");

  if (isApiRoute) {
    const token = extractLaunchAuthToken(req);
    if (!authTokenMatches(token)) {
      return sendJson(res, 401, { ok: false, error: "Unauthorized" }, cors);
    }
  }

  try {
    if (req.method === "GET" && pathname === "/api/bootstrap") {
      return sendJson(res, 200, getBootstrapData(), cors);
    }

    if (req.method === "POST" && pathname === "/api/select-bot") {
      const body = await readJsonBody(req);
      if (!body.botId) return sendJson(res, 400, { ok: false, error: "Missing botId" }, cors);
      const state = readState();
      state.selectedBotId = body.botId;
      writeState(state);
      return sendJson(res, 200, { ok: true, selectedBotId: body.botId }, cors);
    }

    const messageMatch = /^\/api\/bot\/([^/]+)\/message$/.exec(pathname);
    if (req.method === "POST" && messageMatch) {
      const botId = decodeURIComponent(messageMatch[1]);
      const botConfig = findBotConfig(botId);
      if (!botConfig) return sendJson(res, 404, { ok: false, error: "Unknown bot" }, cors);

      const body = await readJsonBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { ok: false, error: "Empty message" }, cors);

      const state = readState();
      const entry = botState(state, botId);
      pushMessage(entry, "user", text);
      writeState(state);

      let result;
      try {
        result = await sendBotMessage(botConfig, text, entry.thread);
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: `Could not reach ${botConfig.baseUrl}: ${err.message}` }, cors);
      }

      const freshState = readState();
      const freshEntry = botState(freshState, botId);
      if (result.thread) freshEntry.thread = result.thread;

      if (!result.ok) {
        freshEntry.pending = false;
        pushMessage(freshEntry, "assistant", `⚠️ ${result.error}`);
        writeState(freshState);
        return sendJson(res, 200, { ok: true, status: "error" }, cors);
      }

      if (result.done) {
        freshEntry.pending = false;
        pushMessage(freshEntry, "assistant", result.reply || "");
        writeState(freshState);
        return sendJson(res, 200, { ok: true, status: "done" }, cors);
      }

      freshEntry.pending = true;
      writeState(freshState);
      return sendJson(res, 200, { ok: true, status: result.status }, cors);
    }

    const transcriptMatch = /^\/api\/bot\/([^/]+)\/transcript$/.exec(pathname);
    if (req.method === "GET" && transcriptMatch) {
      const botId = decodeURIComponent(transcriptMatch[1]);
      const botConfig = findBotConfig(botId);
      if (!botConfig) return sendJson(res, 404, { ok: false, error: "Unknown bot" }, cors);

      const state = readState();
      const entry = botState(state, botId);

      if (entry.pending && entry.thread) {
        try {
          const result = await pollBotThread(botConfig, entry.thread);
          if (!result.ok) {
            entry.pending = false;
            pushMessage(entry, "assistant", `⚠️ ${result.error}`);
          } else if (result.done) {
            entry.pending = false;
            pushMessage(entry, "assistant", result.reply || "");
          }
          writeState(state);
        } catch {
          // transient network error while polling; the UI will retry
        }
      }

      return sendJson(res, 200, { ok: true, pending: entry.pending, entries: entry.messages.slice(-MAX_MESSAGES_PER_BOT) }, cors);
    }

    // Serve static files from public/
    const relPath = pathname === "/" ? "index.html" : pathname.slice(1);
    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const fullPath = path.join(PUBLIC_DIR, safePath);

    if (fullPath.startsWith(PUBLIC_DIR) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const baseHeaders = {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
        ...cors
      };
      if (ext === ".html") {
        const html = fs.readFileSync(fullPath, "utf8");
        const body = injectAuthTokenIntoHtml(html);
        res.writeHead(200, baseHeaders);
        res.end(body);
        return;
      }
      res.writeHead(200, baseHeaders);
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" }, cors);
  } catch (err) {
    console.error("[mausbot-notch] API error:", err);
    sendJson(res, 500, { ok: false, error: err.message || "Internal error" }, cors);
  }
});

ensureConfigFileExists();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mausbot-notch] MausBot Notch bridge listening on http://127.0.0.1:${PORT}`);
});

// Everything the Settings window can read or change in config.json. Saved Bot API keys never leave
// this file's caller: the window is only told whether a bot has one.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const COLORS = ["cyan", "orange", "pink", "green", "chrome", "blue", "purple", "red", "yellow"];
const DEFAULT_HOTKEY = "Option+Space";
const MAX_BOTS = 30;
const MAX_PRESETS = 50;
const MAX_BOT_CALLS_PER_MINUTE = 10;
const KEY_TEST_TIMEOUT_MS = 10_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;
// Same names and rules as macos/HotKey.swift. Control or Option is required (or a function key), so
// a shortcut can't take ⌘C, ⌘V or plain typing away from every other app.
export const HOTKEY = /^(?=.*(?:Control|Option)\+|(?:Shift\+|Command\+)*F\d)(Control\+)?(Option\+)?(Shift\+)?(Command\+)?([A-Z]|[0-9]|Space|F(?:[1-9]|1[0-9]|20)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/;

/** A mistake the person can fix, shown to them as written. */
export class SettingsError extends Error {}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function text(value, label, max, { required = true } = {}) {
  if (value !== undefined && value !== null && typeof value !== "string") throw new SettingsError(`${label} must be text.`);
  const trimmed = (value || "").trim();
  if (required && !trimmed) throw new SettingsError(`${label} is missing.`);
  if (trimmed.length > max) throw new SettingsError(`${label} is too long (at most ${max} characters).`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
function parseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsError(`${label} must be a full address, like https://your-instance.example.com.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SettingsError(`${label} must start with http:// or https://.`);
  if (url.username || url.password) throw new SettingsError(`${label} can't contain a user name or password.`);
  return url;
}

const isThisMac = ({ hostname }) => hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);

function isPrivateNetwork({ hostname }) {
  if (hostname.endsWith(".local") || hostname.endsWith(".ts.net")) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// A bot's key goes to this address with every call, so plain http is only for this Mac or a private network.
function botAddress(value) {
  const url = parseUrl(text(value, "The address", 500), "The address");
  if (url.protocol === "http:" && !isThisMac(url) && !isPrivateNetwork(url)) {
    throw new SettingsError("Use an https:// address: over plain http the bot's key could be read on the way.");
  }
  return url.origin;
}

// Emails, chats and screen text go to the model, so Settings only takes one on this Mac.
function modelAddress(value, kind) {
  const url = parseUrl(text(value, "The model server's address", 500), "The model server's address");
  if (!isThisMac(url)) throw new SettingsError("Use a model server on this Mac (127.0.0.1), so your text stays here.");
  return kind === "openai" ? `${url.origin}${url.pathname.replace(/\/+$/, "")}` : url.origin;
}

// ---------------------------------------------------------------------------
// Reading what's there. config.json can be edited by hand, so nothing in it is taken on trust.
// ---------------------------------------------------------------------------
export function configPresets(config) {
  return (Array.isArray(config.presets) ? config.presets : []).filter(
    (p) => isObject(p) && [p.id, p.name, p.instruction].every((v) => typeof v === "string" && v.trim())
  );
}

export function presetsForBot(config, botId) {
  return configPresets(config)
    .filter((p) => !p.botId || p.botId === botId)
    .map(({ id, name }) => ({ id, name }));
}

const replyKind = (reply) => (reply.openaiUrl ? "openai" : "ollama");

function publicSettings(config) {
  const reply = isObject(config.reply) ? config.reply : {};
  return {
    ok: true,
    bots: config.bots.map((b) => ({
      id: String(b.id ?? ""),
      name: String(b.name || b.id || ""),
      baseUrl: String(b.baseUrl ?? ""),
      color: COLORS.includes(b.color) ? b.color : "blue",
      hasKey: Boolean(b.key)
    })),
    model: {
      kind: replyKind(reply),
      url: String(reply.openaiUrl || reply.ollamaUrl || DEFAULT_OLLAMA_URL),
      model: String(reply.model || "")
    },
    presets: configPresets(config).map(({ id, name, instruction, botId }) => ({ id, name, instruction, botId: botId || null })),
    preferences: {
      hotkey: HOTKEY.test(config.hotkey) ? config.hotkey : DEFAULT_HOTKEY,
      doubleCommand: config.doubleCommand !== false,
      openOnReply: config.openOnReply === true
    },
    colors: COLORS
  };
}

/**
 * @param configFile  path of config.json
 * @param recentCalls (bot) => times of the Bot API calls in the last minute, shared with the poller
 * @param chat        (reply config, messages, temperature, signal) => { content, model }
 * @param onBotMoved  (botId) called when a bot's address changed: its conversation lives on the old server
 * @param onChange    called after every save
 */
export function createSettings({ configFile, recentCalls, chat, onBotMoved, onChange }) {
  // Unlike the rest of the bridge this must not treat a broken file as an empty one: saving would
  // then wipe every bot and key in it.
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(configFile, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return { bots: [] };
      throw err;
    }
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      config = null;
    }
    const broken = !isObject(config) || (config.bots !== undefined && !Array.isArray(config.bots));
    if (broken || config.bots?.some((b) => !isObject(b))) {
      throw new SettingsError("config.json has a mistake in it, so nothing was read or saved. Fix or remove that file first.");
    }
    return { ...config, bots: config.bots || [] };
  }

  // Written beside the file and swapped in, so a crash can't leave half a config behind.
  function save(config) {
    let target = configFile;
    try {
      target = fs.realpathSync(configFile);
    } catch {
      fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
    }
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, target);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
    onChange();
    return publicSettings(config);
  }

  // The bot as it would be saved. A saved key is only reused for the address it was saved for, so
  // pointing a bot somewhere else can't send its key there.
  function draftBot(config, body) {
    const id = text(body.id, "The bot's id", 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id in {}) {
      throw new SettingsError("The bot's id can only have letters, numbers, dots, dashes and underscores.");
    }
    const saved = config.bots.find((b) => b.id === id);
    const baseUrl = botAddress(body.baseUrl);
    const typedKey = text(body.key, "The key", 500, { required: false });
    if (/[^\x21-\x7e]/.test(typedKey)) throw new SettingsError("The key can't contain spaces or line breaks.");
    let savedOrigin = null;
    try {
      savedOrigin = new URL(saved?.baseUrl).origin;
    } catch {
      // no saved address to compare with
    }
    const moved = Boolean(saved) && savedOrigin !== baseUrl;
    const key = typedKey || (saved && !moved ? saved.key : "");
    if (!key) throw new SettingsError(moved && saved.key ? "The address changed, so enter this bot's key again." : "The bot's key is missing.");
    return { saved, moved, bot: { ...saved, id, baseUrl, key } };
  }

  function saveBot(body) {
    const config = load();
    const { saved, moved, bot } = draftBot(config, body);
    if (body.isNew && saved) throw new SettingsError(`That bot is already here, as ${saved.name || saved.id}.`);
    if (!body.isNew && !saved) throw new SettingsError("That bot isn't here any more.");
    bot.name = text(body.name, "The name", 40);
    if (!COLORS.includes(body.color)) throw new SettingsError("Pick one of the colors.");
    bot.color = body.color;
    if (saved) config.bots = config.bots.map((b) => (b === saved ? bot : b));
    else if (config.bots.length >= MAX_BOTS) throw new SettingsError(`At most ${MAX_BOTS} bots fit here.`);
    else config.bots = [...config.bots, bot];
    const result = save(config);
    if (moved) onBotMoved(bot.id);
    return result;
  }

  function removeBot({ id }) {
    const config = load();
    if (!config.bots.some((b) => b.id === id)) throw new SettingsError("That bot isn't here any more.");
    config.bots = config.bots.filter((b) => b.id !== id);
    if (Array.isArray(config.presets)) config.presets = config.presets.filter((p) => p?.botId !== id);
    return save(config);
  }

  // Asks for a conversation that can't exist: a good key gets "no such thread", a wrong one 401.
  // Nothing is started and the bot isn't sent anything.
  async function testBot(body) {
    const { bot } = draftBot(load(), body);
    const calls = recentCalls(bot);
    if (calls.length >= MAX_BOT_CALLS_PER_MINUTE) throw new SettingsError("This bot had ten calls in the last minute. Try again shortly.");
    calls.push(Date.now());
    const url = new URL(`/hooks/api/bots/${encodeURIComponent(bot.id)}/messages?thread=notch-key-check`, bot.baseUrl);
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${bot.key}` },
        redirect: "manual",
        signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS)
      });
    } catch {
      throw new SettingsError(`Nothing answers at ${bot.baseUrl}.`);
    }
    const answer = await res.json().catch(() => null);
    if (res.status === 401) throw new SettingsError("The key is wrong. Make a new one on the bot's Bot API card.");
    if (res.status === 403) throw new SettingsError("The Bot API is off for this bot, or the bot's id is wrong.");
    if (res.status === 429) throw new SettingsError("Too many calls to this bot in the last minute. Try again shortly.");
    if (res.status === 404 && /thread/i.test(String(answer?.error ?? ""))) return { ok: true, message: "The key works." };
    throw new SettingsError(`${bot.baseUrl} answered, but not like OpenMausBot's Bot API (${res.status}).`);
  }

  function draftReplyConfig(config, body) {
    const kind = body.kind;
    if (kind !== "openai" && kind !== "ollama") throw new SettingsError("Pick the kind of model server.");
    const { openaiUrl, ollamaUrl, model: _model, ...rest } = isObject(config.reply) ? config.reply : {};
    // An address set by hand in config.json stays usable as it is; a new one has to be on this Mac.
    const savedUrl = kind === "openai" ? openaiUrl : ollamaUrl;
    const url = savedUrl && body.url === savedUrl ? savedUrl : modelAddress(body.url, kind);
    const model = text(body.model, "The model", 200, { required: false });
    return { ...rest, [kind === "openai" ? "openaiUrl" : "ollamaUrl"]: url, ...(model ? { model } : {}) };
  }

  async function listModels(body) {
    const reply = draftReplyConfig(load(), { ...body, model: "" });
    const url = reply.openaiUrl || reply.ollamaUrl;
    const get = async (address) => {
      const res = await fetch(address, { redirect: "error", signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
      return res.json();
    };
    try {
      const names = reply.openaiUrl
        ? (await get(`${url}/models`)).data.map((m) => m.id)
        : (await get(new URL("/api/tags", url))).models.filter((m) => !m.remote_host && !/[:-]cloud$/i.test(m.name)).map((m) => m.name);
      return { ok: true, models: names.filter((n) => typeof n === "string" && !/embed/i.test(n)).sort() };
    } catch {
      throw new SettingsError(`No model server answers at ${url}.`);
    }
  }

  async function testModel(body, signal) {
    const reply = draftReplyConfig(load(), body);
    const started = Date.now();
    const { content, model } = await chat(reply, [{ role: "user", content: "Answer with the single word: ready" }], 0, signal);
    if (!content.trim()) throw new SettingsError(`${model} answered with nothing.`);
    return { ok: true, message: `${model} answered in ${((Date.now() - started) / 1000).toFixed(1)} seconds.` };
  }

  function saveModel(body) {
    const config = load();
    config.reply = draftReplyConfig(config, body);
    return save(config);
  }

  function savePreset(body) {
    const config = load();
    const presets = Array.isArray(config.presets) ? config.presets : [];
    const preset = {
      name: text(body.name, "The name", 40),
      instruction: text(body.instruction, "The instruction", 2000),
      botId: body.botId ? text(body.botId, "The bot", 100) : null
    };
    if (preset.botId && !config.bots.some((b) => b.id === preset.botId)) throw new SettingsError("That bot isn't here any more.");
    if (body.id) {
      const at = presets.findIndex((p) => p?.id === body.id);
      if (at < 0) throw new SettingsError("That preset isn't here any more.");
      config.presets = presets.map((p, i) => (i === at ? { ...p, ...preset } : p));
    } else {
      if (presets.length >= MAX_PRESETS) throw new SettingsError(`At most ${MAX_PRESETS} presets fit here.`);
      config.presets = [...presets, { id: `preset-${crypto.randomUUID()}`, ...preset }];
    }
    return save(config);
  }

  function removePreset({ id }) {
    const config = load();
    const presets = Array.isArray(config.presets) ? config.presets : [];
    if (!presets.some((p) => p?.id === id)) throw new SettingsError("That preset isn't here any more.");
    config.presets = presets.filter((p) => p?.id !== id);
    return save(config);
  }

  function savePreferences(body) {
    const config = load();
    for (const name of ["doubleCommand", "openOnReply"]) {
      if (body[name] === undefined) continue;
      if (typeof body[name] !== "boolean") throw new SettingsError(`${name} must be on or off.`);
      config[name] = body[name];
    }
    if (body.hotkey !== undefined) {
      if (typeof body.hotkey !== "string" || !HOTKEY.test(body.hotkey)) throw new SettingsError("Use ⌃ or ⌥ with another key, or a function key.");
      config.hotkey = body.hotkey;
    }
    return save(config);
  }

  const actions = {
    "bot/save": saveBot,
    "bot/remove": removeBot,
    "bot/test": testBot,
    "model/list": listModels,
    "model/test": testModel,
    "model/save": saveModel,
    "preset/save": savePreset,
    "preset/remove": removePreset,
    preferences: savePreferences
  };

  return {
    read: () => publicSettings(load()),
    has: (action) => Object.hasOwn(actions, action),
    run: (action, body, signal) => actions[action](isObject(body) ? body : {}, signal)
  };
}

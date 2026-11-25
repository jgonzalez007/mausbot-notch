// The Settings window. Saved keys are never sent here; a bot only says whether it has one.
const $ = (sel) => document.querySelector(sel);

const COLOR_VALUES = {
  cyan: "#22d3ee", orange: "#fb923c", pink: "#f472b6", green: "#4ade80", chrome: "#9ca3af",
  blue: "#5b8dee", purple: "#a78bfa", red: "#f87171", yellow: "#facc15"
};
const COMMON_ADDRESSES = {
  ollama: ["http://127.0.0.1:11434"],
  openai: ["http://127.0.0.1:8001/v1", "http://127.0.0.1:8000/v1", "http://127.0.0.1:1234/v1", "http://127.0.0.1:8080/v1"]
};
const DEFAULT_HOTKEY = "Option+Space";
const KEY_SYMBOLS = {
  Control: "⌃", Option: "⌥", Shift: "⇧", Command: "⌘", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`"
};

let settings = null;
let editingBot = null; // the bot in the form, or null for a new one
let editingPreset = null;

async function api(path, body) {
  const headers = { Authorization: `Bearer ${window.__MAUSBOT_NOTCH_AUTH_TOKEN || ""}` };
  const options = body ? { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers };
  try {
    const res = await fetch(`/api/settings${path}`, options);
    return await res.json();
  } catch {
    return { ok: false, error: "The notch isn't answering. Quit it from the menu bar and open it again." };
  }
}

// The app registers the shortcut; answers { ok, error }.
async function native(message) {
  const host = window.webkit?.messageHandlers?.settingsHost;
  if (!host) return { ok: false, error: "Open Settings from the notch's menu bar icon to change this." };
  try {
    return await host.postMessage(message);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function say(where, text, kind = "") {
  where.textContent = text || "";
  where.className = `message ${kind}`;
}

const messageIn = (form) => form.querySelector(".message");
const values = (form) => Object.fromEntries(new FormData(form));

// Runs one action with the form's buttons off, and shows what came of it.
async function act(form, working, run) {
  const where = messageIn(form);
  const buttons = form.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  say(where, working);
  const res = await run();
  buttons.forEach((b) => (b.disabled = false));
  if (res.ok) say(where, res.message || "", "good");
  else say(where, res.error || "Something went wrong.", "error");
  return res;
}

function apply(res) {
  if (!res.ok) return false;
  settings = res;
  render();
  return true;
}

// Removing takes a second press on the same button.
function confirmable(button, question, run) {
  button.addEventListener("click", () => {
    if (button.dataset.asking) {
      run();
    } else {
      button.dataset.asking = "1";
      button.textContent = question();
    }
  });
}

function resetConfirm(button) {
  delete button.dataset.asking;
  button.textContent = "Remove";
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(name) {
  const tabs = [...document.querySelectorAll("[data-tab]")];
  const tab = tabs.some((t) => t.dataset.tab === name) ? name : "bots";
  tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = !settings || p.dataset.panel !== tab));
  if (tab !== "general") stopRecording();
}

document.querySelectorAll("[data-tab]").forEach((t) =>
  t.addEventListener("click", () => {
    location.hash = t.dataset.tab;
  })
);
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------
function listItem({ color, title, detail, onClick }) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "item";
  if (color) {
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color;
    item.append(swatch);
  }
  for (const [className, text] of [["title", title], ["detail", detail]]) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    item.append(span);
  }
  item.addEventListener("click", onClick);
  return item;
}

function option(value, label) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}

const botForm = $("#bot-form");

function openBotForm(bot) {
  editingBot = bot;
  $("#bot-form-title").textContent = bot ? bot.name : "New bot";
  $("#bot-paste-hint").hidden = Boolean(bot);
  const f = botForm.elements;
  f.color.replaceChildren(...settings.colors.map((c) => option(c, c[0].toUpperCase() + c.slice(1))));
  f.name.value = bot?.name || "";
  f.baseUrl.value = bot?.baseUrl || settings.bots[0]?.baseUrl || "";
  f.id.value = bot?.id || "";
  f.id.readOnly = Boolean(bot);
  f.key.value = "";
  f.key.placeholder = bot?.hasKey ? "Saved. Leave empty to keep it." : "";
  f.color.value = bot?.color || "cyan";
  $("#bot-remove").hidden = !bot;
  resetConfirm($("#bot-remove"));
  say(messageIn(botForm), "");
  botForm.hidden = false;
  $("#bot-add").hidden = true;
  $("#bot-list").hidden = true;
  f.name.focus();
}

function closeBotForm() {
  botForm.hidden = true;
  botForm.reset(); // a typed key doesn't stay in the page
  editingBot = null;
  $("#bot-add").hidden = false;
  $("#bot-list").hidden = false;
}

const botDraft = () => ({ ...values(botForm), isNew: !editingBot });

// The card in OpenMausBot shows a ready-made command: take the address, id and key from it.
botForm.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain") || "";
  const address = /(https?:\/\/[^\s"'/]+)\/hooks\/api\/bots\/([A-Za-z0-9._-]+)/.exec(text);
  if (!address) return;
  e.preventDefault();
  const f = botForm.elements;
  f.baseUrl.value = address[1];
  if (!f.id.readOnly) f.id.value = address[2];
  const key = /Bearer\s+([^\s"']+)/.exec(text)?.[1];
  if (key && key !== "YOUR_KEY") f.key.value = key;
});

botForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await act(botForm, "Saving…", () => api("/bot/save", botDraft()));
  if (apply(res)) closeBotForm();
});
$("#bot-test").addEventListener("click", () => act(botForm, "Testing…", () => api("/bot/test", botDraft())));
$("#bot-add").addEventListener("click", () => openBotForm(null));
$("#bot-cancel").addEventListener("click", closeBotForm);
confirmable(
  $("#bot-remove"),
  () => {
    const n = settings.presets.filter((p) => p.botId === editingBot.id).length;
    return n ? `Remove with ${n} preset${n > 1 ? "s" : ""}?` : "Really remove?";
  },
  async () => {
    const res = await act(botForm, "Removing…", () => api("/bot/remove", { id: editingBot.id }));
    if (apply(res)) closeBotForm();
    resetConfirm($("#bot-remove"));
  }
);

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
const modelForm = $("#model-form");

function fillModelForm() {
  const f = modelForm.elements;
  f.kind.value = settings.model.kind;
  f.url.value = settings.model.url;
  f.model.value = settings.model.model;
  showAddresses();
}

function showAddresses() {
  $("#model-addresses").replaceChildren(...COMMON_ADDRESSES[modelForm.elements.kind.value].map((a) => option(a, a)));
}

function showModels(names) {
  $("#model-names").replaceChildren(...names.map((n) => option(n, n)));
  $("#model-choices").replaceChildren(
    ...names.map((name) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = name;
      choice.addEventListener("click", () => (modelForm.elements.model.value = name));
      return choice;
    })
  );
}

modelForm.elements.kind.addEventListener("change", () => {
  const f = modelForm.elements;
  const { kind, url, model } = settings.model;
  f.url.value = f.kind.value === kind ? url : COMMON_ADDRESSES[f.kind.value][0];
  f.model.value = f.kind.value === kind ? model : "";
  showModels([]);
  showAddresses();
});
$("#model-list").addEventListener("click", async () => {
  const res = await act(modelForm, "Looking…", () => api("/model/list", values(modelForm)));
  showModels(res.ok ? res.models : []);
  if (res.ok) say(messageIn(modelForm), res.models.length ? "Pick one:" : "The server lists no chat model.");
});
$("#model-test").addEventListener("click", () => act(modelForm, "Asking the model. Loading it can take a minute…", () => api("/model/test", values(modelForm))));
modelForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await act(modelForm, "Saving…", () => api("/model/save", values(modelForm)));
  if (!apply(res)) return;
  fillModelForm();
  say(messageIn(modelForm), "Saved.", "good");
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
const presetForm = $("#preset-form");
const botName = (id) => settings.bots.find((b) => b.id === id)?.name || "a removed bot";

function openPresetForm(preset) {
  editingPreset = preset;
  $("#preset-form-title").textContent = preset ? preset.name : "New preset";
  const f = presetForm.elements;
  f.botId.replaceChildren(option("", "All bots"), ...settings.bots.map((b) => option(b.id, b.name)));
  f.name.value = preset?.name || "";
  f.instruction.value = preset?.instruction || "";
  f.botId.value = preset?.botId || "";
  $("#preset-remove").hidden = !preset;
  resetConfirm($("#preset-remove"));
  say(messageIn(presetForm), "");
  presetForm.hidden = false;
  $("#preset-add").hidden = true;
  $("#preset-list").hidden = true;
  f.name.focus();
}

function closePresetForm() {
  presetForm.hidden = true;
  editingPreset = null;
  $("#preset-add").hidden = false;
  $("#preset-list").hidden = false;
}

presetForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await act(presetForm, "Saving…", () => api("/preset/save", { ...values(presetForm), id: editingPreset?.id }));
  if (apply(res)) closePresetForm();
});
$("#preset-add").addEventListener("click", () => openPresetForm(null));
$("#preset-cancel").addEventListener("click", closePresetForm);
confirmable($("#preset-remove"), () => "Really remove?", async () => {
  const res = await act(presetForm, "Removing…", () => api("/preset/remove", { id: editingPreset.id }));
  if (apply(res)) closePresetForm();
  resetConfirm($("#preset-remove"));
});

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------
const generalMessage = $("#general-message");
let recording = false;

// "Control+Option+KeyN" in the order macos/HotKey.swift reads it; null until a real key is pressed.
function hotkeyFromEvent(e) {
  if (/^(Control|Alt|Shift|Meta)/.test(e.code)) return null;
  const key = e.code.replace(/^(Key|Digit)(?=.$)/, "");
  return [e.ctrlKey && "Control", e.altKey && "Option", e.shiftKey && "Shift", e.metaKey && "Command", key].filter(Boolean).join("+");
}

const hotkeyLabel = (hotkey) => hotkey.split("+").map((part) => KEY_SYMBOLS[part] || part).join("");

async function setHotkey(hotkey) {
  const before = settings.preferences.hotkey;
  // Checked and saved by the bridge first, so a combination it refuses is never taken from other apps.
  const saved = await api("/preferences", { hotkey });
  if (!saved.ok) {
    await native({ type: "endRecording" });
    return say(generalMessage, saved.error, "error");
  }
  const registered = await native({ type: "setHotkey", hotkey });
  if (!registered.ok) {
    apply(await api("/preferences", { hotkey: before }));
    return say(generalMessage, registered.error, "error");
  }
  apply(saved);
  say(generalMessage, `${hotkeyLabel(hotkey)} opens and closes the notch. Press it now to check; another app may already use it.`, "good");
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  render();
  native({ type: "endRecording" });
}

$("#hotkey-record").addEventListener("click", async () => {
  if (recording) return stopRecording();
  const res = await native({ type: "beginRecording" });
  if (!res.ok) return say(generalMessage, res.error, "error");
  recording = true;
  $("#hotkey-label").textContent = "Press keys…";
  $("#hotkey-record").textContent = "Cancel";
  say(generalMessage, "");
});
window.addEventListener("keydown", (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") return stopRecording();
  const hotkey = hotkeyFromEvent(e);
  if (!hotkey) return;
  recording = false;
  render();
  setHotkey(hotkey);
}, true);
window.addEventListener("blur", stopRecording);
$("#hotkey-reset").addEventListener("click", () => {
  recording = false;
  render();
  setHotkey(DEFAULT_HOTKEY);
});

for (const [id, name] of [["#double-command", "doubleCommand"], ["#open-on-reply", "openOnReply"]]) {
  $(id).addEventListener("change", async (e) => {
    const on = e.target.checked;
    const res = await api("/preferences", { [name]: on });
    if (!apply(res)) {
      e.target.checked = !on;
      return say(generalMessage, res.error, "error");
    }
    if (name === "doubleCommand") await native({ type: "setDoubleCommand", on });
    say(generalMessage, "Saved.", "good");
  });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function render() {
  $("#bot-list").replaceChildren(
    ...settings.bots.map((bot) =>
      listItem({
        color: COLOR_VALUES[bot.color],
        title: bot.name,
        detail: bot.hasKey ? bot.baseUrl : "No key",
        onClick: () => openBotForm(bot)
      })
    )
  );
  $("#preset-list").replaceChildren(
    ...settings.presets.map((preset) =>
      listItem({ title: preset.name, detail: preset.botId ? botName(preset.botId) : "All bots", onClick: () => openPresetForm(preset) })
    )
  );
  const { hotkey, doubleCommand, openOnReply } = settings.preferences;
  if (!recording) {
    $("#hotkey-label").textContent = hotkeyLabel(hotkey);
    $("#hotkey-record").textContent = "Change";
  }
  $("#double-command").checked = doubleCommand;
  $("#open-on-reply").checked = openOnReply;
}

const loaded = await api("");
if (loaded.ok) {
  settings = loaded;
  render();
  fillModelForm();
} else {
  say($("#load-error"), loaded.error, "error");
  $("#load-error").hidden = false;
}
showTab(location.hash.slice(1));

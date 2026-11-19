const isNativeHost =
  Boolean(window.webkit?.messageHandlers?.notchHost) ||
  new URLSearchParams(location.search).get("native") === "1";

if (!isNativeHost) {
  document.body.classList.add("browser-preview");
}

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = window.__MAUSBOT_NOTCH_AUTH_TOKEN;
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}

function postNativeMessage(payload) {
  try {
    window.webkit?.messageHandlers?.notchHost?.postMessage(payload);
  } catch {}
}

// state.status: "idle" | "sending" | "working" | "needs_approval" | "error"
const state = {
  expanded: false,
  typing: false,
  bots: [],
  selectedBotId: null,
  status: "idle",
  statusCaption: ""
};

const dom = {
  pouch: document.getElementById("notch-pouch"),
  collapsedBar: document.getElementById("collapsed-bar"),
  collapsedName: document.getElementById("collapsed-name"),
  botMarkMount: document.getElementById("bot-mark-mount"),
  botTitleBlock: document.getElementById("bot-title-block"),
  botNameLabel: document.getElementById("bot-name-label"),
  botStatusCaption: document.getElementById("bot-status-caption"),
  prevBotBtn: document.getElementById("prev-bot-btn"),
  nextBotBtn: document.getElementById("next-bot-btn"),
  tapToTypeBtn: document.getElementById("tap-to-type-btn"),
  typeForm: document.getElementById("type-form"),
  typeInput: document.getElementById("type-input")
};

function getSelectedBot() {
  return state.bots.find((b) => b.id === state.selectedBotId) || state.bots[0] || null;
}

// Mirrors OpenMausBot's own per-bot color tokens (bots.json "color" field) so a bot's
// notch mark matches its icon color in the main app.
const BOT_COLORS = {
  cyan: "#22d3ee",
  orange: "#fb923c",
  pink: "#f472b6",
  green: "#4ade80",
  chrome: "#9ca3af",
  blue: "#5b8dee",
  purple: "#a78bfa",
  red: "#f87171",
  yellow: "#facc15"
};
const DEFAULT_BOT_COLOR = "#5b8dee";

// ============================================================================
// NATIVE HIT-RECT SYNC
// ============================================================================
function reportHitRectToNative() {
  const rect = dom.pouch.getBoundingClientRect();
  const bot = getSelectedBot();
  postNativeMessage({
    type: "hitRect",
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    isOpen: state.expanded,
    isTyping: state.typing,
    status: state.status,
    botName: bot?.name || "MausBot"
  });
}

const resizeObserver = new ResizeObserver(() => reportHitRectToNative());
resizeObserver.observe(dom.pouch);

function setExpanded(expanded) {
  const next = Boolean(expanded);
  if (state.expanded === next) return;
  state.expanded = next;
  dom.pouch.dataset.expanded = String(next);
  if (next) {
    refreshBootstrap();
  } else {
    setTypingMode(false);
  }
  reportHitRectToNative();
  let steps = 0;
  const timer = setInterval(() => {
    reportHitRectToNative();
    if (++steps > 10) clearInterval(timer);
  }, 35);
}

function setTypingMode(typing, initialChar = "") {
  state.typing = Boolean(typing);
  dom.pouch.dataset.typing = String(state.typing);
  dom.tapToTypeBtn.hidden = state.typing;
  dom.typeForm.hidden = !state.typing;
  if (state.typing) {
    if (initialChar) {
      dom.typeInput.value = initialChar;
    }
    setTimeout(() => {
      dom.typeInput.focus();
      const len = dom.typeInput.value.length;
      dom.typeInput.setSelectionRange(len, len);
    }, 20);
  } else {
    dom.typeInput.blur();
  }
  reportHitRectToNative();
}

// ============================================================================
// RENDER & BOT SELECTION
// ============================================================================
function renderPouch() {
  const bot = getSelectedBot();
  if (!bot) {
    dom.botNameLabel.textContent = "No bots configured";
    dom.collapsedName.textContent = "MausBot Notch";
    dom.botStatusCaption.hidden = true;
    dom.pouch.dataset.status = "idle";
    document.documentElement.style.setProperty("--bot-ink", DEFAULT_BOT_COLOR);
    reportHitRectToNative();
    return;
  }

  document.documentElement.style.setProperty("--bot-ink", BOT_COLORS[bot.color] || DEFAULT_BOT_COLOR);
  dom.pouch.dataset.status = state.status;
  dom.collapsedName.textContent = bot.name;
  dom.botNameLabel.textContent = bot.name;
  dom.typeInput.placeholder = `Message ${bot.name}…`;

  if (state.statusCaption) {
    dom.botStatusCaption.textContent = state.statusCaption;
    dom.botStatusCaption.hidden = false;
  } else {
    dom.botStatusCaption.hidden = true;
  }

  reportHitRectToNative();
}

async function selectBot(botId) {
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) return;
  state.selectedBotId = bot.id;
  state.status = "idle";
  state.statusCaption = "";
  renderPouch();

  apiFetch("/api/select-bot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId: bot.id })
  }).catch(() => {});
}

function cycleBot(delta) {
  if (state.bots.length === 0) return;
  const idx = state.bots.findIndex((b) => b.id === state.selectedBotId);
  const nextIdx = (idx + delta + state.bots.length) % state.bots.length;
  selectBot(state.bots[nextIdx].id);
}

// ============================================================================
// SEND MESSAGE + POLL FOR REPLY
// ============================================================================
let activeReplyPoll = null;

function stopReplyPoll() {
  if (activeReplyPoll) {
    clearInterval(activeReplyPoll);
    activeReplyPoll = null;
  }
}

async function sendMessage(text) {
  const bot = getSelectedBot();
  if (!bot) return;

  stopReplyPoll();
  state.status = "sending";
  state.statusCaption = "Sending…";
  renderPouch();

  let sendRes;
  try {
    sendRes = await apiFetch(`/api/bot/${encodeURIComponent(bot.id)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }).then((r) => r.json());
  } catch (err) {
    state.status = "error";
    state.statusCaption = err.message || "Failed to send";
    renderPouch();
    return;
  }

  if (!sendRes.ok) {
    state.status = "error";
    state.statusCaption = sendRes.error || "Failed to send";
    renderPouch();
    return;
  }

  if (sendRes.status === "done" || sendRes.status === "error") {
    await pollTranscriptOnce(bot.id);
    return;
  }

  state.status = sendRes.status; // "working" | "needs_approval"
  state.statusCaption = sendRes.status === "needs_approval" ? "Waiting on your approval…" : "Working…";
  renderPouch();

  const targetBotId = bot.id;
  let attempts = 0;
  activeReplyPoll = setInterval(async () => {
    attempts++;
    if (state.selectedBotId !== targetBotId) {
      stopReplyPoll();
      return;
    }
    const stillPending = await pollTranscriptOnce(targetBotId);
    if (!stillPending || attempts > 100) {
      stopReplyPoll();
    }
  }, 2000);
}

// Fetches the latest transcript; returns true while the bridge still reports a pending reply.
async function pollTranscriptOnce(botId) {
  try {
    const res = await apiFetch(`/api/bot/${encodeURIComponent(botId)}/transcript`).then((r) => r.json());
    if (!res.ok) return false;
    if (state.selectedBotId !== botId) return res.pending;

    const last = res.entries[res.entries.length - 1];
    if (last && last.role === "assistant") {
      state.status = res.pending ? state.status : "idle";
      state.statusCaption = last.text;
      renderPouch();
    } else if (res.pending) {
      renderPouch();
    }
    return res.pending;
  } catch {
    return true;
  }
}

// ============================================================================
// EVENTS & SHORTCUTS
// ============================================================================
dom.collapsedBar.addEventListener("click", () => {
  setExpanded(true);
});

// Double-tap the mark or name while expanded collapses the notch back down,
// without touching its open/close sizing or animation.
function collapseOnDoubleTap() {
  if (!state.expanded || state.typing) return;
  setExpanded(false);
}
dom.botMarkMount.addEventListener("dblclick", collapseOnDoubleTap);
dom.botTitleBlock.addEventListener("dblclick", collapseOnDoubleTap);

dom.prevBotBtn.addEventListener("pointerdown", (e) => {
  if (state.typing) e.preventDefault();
});

dom.prevBotBtn.addEventListener("click", () => {
  cycleBot(-1);
});

dom.nextBotBtn.addEventListener("pointerdown", (e) => {
  if (state.typing) e.preventDefault();
});

dom.nextBotBtn.addEventListener("click", () => {
  cycleBot(1);
});

dom.tapToTypeBtn.addEventListener("click", () => {
  setTypingMode(true);
});

dom.typeInput.addEventListener("blur", () => {
  if (dom.typeInput.value.trim().length === 0) {
    setTypingMode(false);
  }
});

dom.typeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = dom.typeInput.value.trim();
  dom.typeInput.value = "";
  setTypingMode(false);
  if (!text) return;
  sendMessage(text);
});

window.addEventListener("keydown", (e) => {
  if (!state.expanded) return;

  if (e.key === "Escape") {
    if (state.typing) {
      dom.typeInput.value = "";
      setTypingMode(false);
      return;
    }
    setExpanded(false);
    return;
  }

  if (state.typing) return;

  if (e.key === "ArrowLeft") {
    e.preventDefault();
    cycleBot(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    cycleBot(1);
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    setTypingMode(true, e.key);
  }
});

// Native host commands (⌥Space toggle, menu bar bot selection)
window.__notchCommand = async (cmd) => {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "toggleExpand":
      setExpanded(!state.expanded);
      break;
    case "openQuickReply":
      // Double-tap ⌘ (bare, no other key): jump straight to the type box so the
      // selected bot can draft/send a reply to whatever email or message is on screen.
      setExpanded(true);
      setTypingMode(true);
      break;
    case "nextBot":
      cycleBot(1);
      break;
    case "prevBot":
      cycleBot(-1);
      break;
    case "escape":
      if (state.typing) {
        dom.typeInput.value = "";
        setTypingMode(false);
      } else if (state.expanded) {
        setExpanded(false);
      }
      break;
    case "selectBot":
      if (cmd.botId) {
        await selectBot(cmd.botId);
        setExpanded(true);
      }
      break;
    case "setNotchGeometry":
      if (cmd.notchWidth && cmd.notchWidth > 100) {
        document.documentElement.style.setProperty("--notch-width", `${cmd.notchWidth}px`);
      }
      if (cmd.notchHeight && cmd.notchHeight > 20) {
        document.documentElement.style.setProperty("--notch-height", `${cmd.notchHeight}px`);
      }
      reportHitRectToNative();
      break;
  }
};

async function refreshBootstrap() {
  try {
    const data = await apiFetch("/api/bootstrap").then((r) => r.json());
    if (!data.ok || !Array.isArray(data.bots)) return;

    const oldIds = state.bots.map((b) => b.id).join(",");
    const newIds = data.bots.map((b) => b.id).join(",");
    const rosterChanged = oldIds !== newIds;

    state.bots = data.bots;
    if (!state.selectedBotId || !state.bots.some((b) => b.id === state.selectedBotId)) {
      state.selectedBotId = data.selectedBotId || state.bots[0]?.id || null;
    }

    if (rosterChanged) {
      renderPouch();
      postNativeMessage({
        type: "rosterLoaded",
        bots: state.bots.map((b) => ({ id: b.id, name: b.name })),
        selectedBotId: state.selectedBotId
      });
    }
  } catch {}
}

async function init() {
  await refreshBootstrap();
  renderPouch();
  reportHitRectToNative();
  setInterval(refreshBootstrap, 8000);
}

init();

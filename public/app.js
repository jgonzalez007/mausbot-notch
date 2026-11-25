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
  passive: false, // open because a bot replied: shown without taking the keyboard
  typing: false,
  bots: [],
  selectedBotId: null,
  status: "idle",
  statusCaption: "",
  view: "default", // "default" | "transcript"
  transcript: { botId: null, entries: [] },
  sends: {} // bot id -> when the message being sent was sent (ms); also identifies that send
};

const dom = {
  pouch: document.getElementById("notch-pouch"),
  collapsedBar: document.getElementById("collapsed-bar"),
  collapsedName: document.getElementById("collapsed-name"),
  collapsedPreview: document.getElementById("collapsed-preview"),
  collapsedOthers: document.getElementById("collapsed-others"),
  collapsedUnread: document.getElementById("collapsed-unread"),
  stopArea: document.getElementById("stop-area"),
  stopElapsed: document.getElementById("stop-elapsed"),
  stopBtn: document.getElementById("stop-btn"),
  transcriptChip: document.getElementById("transcript-chip"),
  transcriptView: document.getElementById("transcript-view"),
  transcriptList: document.getElementById("transcript-list"),
  transcriptCopy: document.getElementById("transcript-copy"),
  transcriptClose: document.getElementById("transcript-close"),
  botTitleBlock: document.getElementById("bot-title-block"),
  botNameLabel: document.getElementById("bot-name-label"),
  botStatusCaption: document.getElementById("bot-status-caption"),
  prevBotBtn: document.getElementById("prev-bot-btn"),
  nextBotBtn: document.getElementById("next-bot-btn"),
  tapToTypeBtn: document.getElementById("tap-to-type-btn"),
  typeForm: document.getElementById("type-form"),
  typeInput: document.getElementById("type-input"),
  actionChips: document.getElementById("action-chips"),
  rewriteChip: document.getElementById("rewrite-chip"),
  rewriteMenu: document.getElementById("rewrite-menu"),
  rewriteBack: document.getElementById("rewrite-back"),
  resultView: document.getElementById("result-view"),
  resultTitle: document.getElementById("result-title"),
  resultText: document.getElementById("result-text"),
  resultNotes: document.getElementById("result-notes"),
  resultCopy: document.getElementById("result-copy"),
  resultClose: document.getElementById("result-close"),
  resultReplace: document.getElementById("result-replace"),
  refineChips: document.getElementById("refine-chips"),
  resultFooter: document.getElementById("result-footer")
};

function findBot(botId) {
  return state.bots.find((b) => b.id === botId);
}

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
    isPassive: state.passive,
    isTyping: state.typing,
    status: state.status,
    botName: bot?.name || "MausBot"
  });
}

const resizeObserver = new ResizeObserver(() => reportHitRectToNative());
resizeObserver.observe(dom.pouch);

function setExpanded(expanded, { passive = false } = {}) {
  const next = Boolean(expanded);
  if (state.expanded === next) {
    if (next && !passive) takeKeyboard();
    return;
  }
  state.expanded = next;
  state.passive = next && passive;
  dom.pouch.dataset.expanded = String(next);
  if (next) {
    refreshBootstrap();
    showDeferredReply();
    showUnread();
  } else {
    setTypingMode(false);
    closeResult();
    showRewriteMenu(false);
    closeTranscript();
  }
  reportHitRectToNative();
  let steps = 0;
  const timer = setInterval(() => {
    reportHitRectToNative();
    if (++steps > 10) clearInterval(timer);
  }, 35);
}

// The user touched a notch that had opened by itself: from here on it may have the keyboard.
function takeKeyboard() {
  if (!state.passive) return;
  state.passive = false;
  reportHitRectToNative();
  showUnread();
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
  dom.pouch.dataset.result = state.result && state.expanded ? "true" : "false";
  renderResult();
  renderTranscript();
  renderStopArea();
  renderUnread();
  if (!bot) {
    dom.botNameLabel.textContent = "No bots configured";
    dom.botNameLabel.hidden = false;
    dom.collapsedName.textContent = "MausBot Notch";
    dom.botStatusCaption.hidden = true;
    dom.pouch.dataset.status = "idle";
    document.documentElement.style.setProperty("--bot-ink", DEFAULT_BOT_COLOR);
    reportHitRectToNative();
    return;
  }

  document.documentElement.style.setProperty("--bot-ink", BOT_COLORS[bot.color] || DEFAULT_BOT_COLOR);
  dom.pouch.dataset.status = state.status;
  // A double-⌘ draft needs room to be read, so the pouch grows while one is showing.
  dom.pouch.dataset.draft = state.copyText && state.expanded ? "true" : "false";

  dom.collapsedName.textContent = bot.name;
  dom.botNameLabel.textContent = bot.name;
  // The identity bar at the top already shows the name; don't repeat it in the middle.
  dom.botNameLabel.hidden = true;
  dom.typeInput.placeholder = `Message ${bot.name}…`;

  if (state.statusCaption) {
    dom.botStatusCaption.textContent = state.statusCaption;
    dom.botStatusCaption.hidden = false;
    dom.botStatusCaption.title = state.status === "idle" ? "Click to copy" : "";
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
  state.copyText = "";
  stopReplyPoll();
  showWaiting();
  renderPouch();
  showUnread();
  if (state.view === "transcript") pollTranscriptOnce(bot.id);

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

// ============================================================================
// INBOUND EVENTS: server-sent events from the local bridge.
// The bridge polls pending bot threads in the background and (once the Bot API
// grows a push channel) relays /api/notify events, so replies that land while
// the notch is collapsed or closed still pop the notch and surface.
// ============================================================================
let eventSource = null;

function connectEvents() {
  if (eventSource) return;
  const token = window.__MAUSBOT_NOTCH_AUTH_TOKEN;
  if (!token) return; // browser without token: preview mode, no events
  try {
    eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    eventSource.onmessage = (e) => {
      let evt;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      handleServerEvent(evt);
    };
  } catch {
    eventSource = null;
  }
}

function handleServerEvent(evt) {
  if (!evt || typeof evt !== "object" || !evt.type) return;

  const isCurrent = evt.botId ? evt.botId === state.selectedBotId : true;
  if (evt.type === "status") setWaiting(evt.botId, findBot(evt.botId)?.waitingSinceMs || Date.now());
  if (evt.type === "reply" || evt.type === "timeout") setWaiting(evt.botId, null);

  // Don't let bot events overwrite an open result card or a draft being written.
  // A reply that lands meanwhile is shown when the card closes or the notch next opens.
  const draftToRead = state.copyText && state.expanded;
  if (isCurrent && (state.result || state.drafting || draftToRead)) {
    if (evt.type === "reply") state.deferredReplyBotId = evt.botId;
    if (evt.type === "reply" || evt.type === "hello") refreshBootstrap();
    return;
  }

  if (evt.type === "reply") {
    if (isCurrent) {
      state.copyText = ""; // the caption becomes the reply, so a click must not copy an old draft
      // Pop the notch and pull the latest transcript so the caption updates.
      // It must not take the keyboard from whatever the user is typing in.
      if (!state.expanded) setExpanded(true, { passive: true });
      pollTranscriptOnce(evt.botId);
    }
    // Replies for other bots are kept in state.json; they show when you
    // cycle to that bot and the notch polls its transcript.
    refreshBootstrap();
  } else if (evt.type === "status" && isCurrent) {
    state.status = evt.status;
    state.statusCaption = evt.status === "needs_approval" ? "Waiting on your approval…" : "Working…";
    renderPouch();
  } else if (evt.type === "timeout" && isCurrent) {
    if (state.status !== "idle") {
      state.status = "idle";
      state.statusCaption = "";
      renderPouch();
    }
  } else if (evt.type === "hello") {
    refreshBootstrap();
  }
}

function showDeferredReply() {
  const botId = state.deferredReplyBotId;
  if (!botId || state.result || state.drafting) return;
  state.deferredReplyBotId = null;
  if (botId !== state.selectedBotId) return;
  state.copyText = "";
  pollTranscriptOnce(botId);
}

function stopReplyPoll() {
  if (activeReplyPoll) {
    clearInterval(activeReplyPoll);
    activeReplyPoll = null;
  }
}

async function sendMessage(text) {
  const bot = getSelectedBot();
  if (!bot) return;

  cancelDraft();
  stopReplyPoll();
  const startedMs = Date.now();
  state.sends[bot.id] = startedMs;
  state.copyText = "";
  state.status = "sending";
  state.statusCaption = "Sending…";
  renderPouch();
  if (state.view === "transcript") pollTranscriptOnce(bot.id);

  let sendRes;
  try {
    sendRes = await apiFetch(`/api/bot/${encodeURIComponent(bot.id)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }).then((r) => r.json());
  } catch (err) {
    sendRes = { ok: false, error: err.message };
  }
  // Stopped, or another message was sent to this bot meanwhile: this answer is no longer wanted.
  if (state.sends[bot.id] !== startedMs) return;
  delete state.sends[bot.id];
  if (sendRes.status === "stopped") return;
  const stillWorking = sendRes.ok && sendRes.status !== "done" && sendRes.status !== "error";
  if (stillWorking) setWaiting(bot.id, startedMs);
  // The user moved on to another bot: its reply shows up there as unread.
  if (state.selectedBotId !== bot.id) {
    refreshBootstrap();
    return;
  }
  // They opened a result card or a draft instead: the reply shows when that closes.
  if (isBusyWithText()) {
    state.deferredReplyBotId = bot.id;
    refreshBootstrap();
    return;
  }

  if (!sendRes.ok) {
    state.status = "error";
    state.statusCaption = sendRes.error || "Failed to send";
    renderPouch();
    return;
  }

  if (!stillWorking) {
    await pollTranscriptOnce(bot.id);
    return;
  }

  state.status = sendRes.status; // "working" | "needs_approval"
  state.statusCaption = sendRes.status === "needs_approval" ? "Waiting on your approval…" : "Working…";
  renderPouch();

  startReplyPoll(bot.id);
}

function startReplyPoll(targetBotId) {
  stopReplyPoll();
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

    state.transcript = { botId, entries: res.entries };
    const last = res.entries[res.entries.length - 1];
    const bot = findBot(botId);
    if (bot) {
      bot.unreadCount = res.entries.filter((e) => e.unread).length;
      bot.lastReplyPreview = res.entries.findLast((e) => e.role === "assistant")?.text.slice(0, 80) || "";
      if (!res.pending && !res.sending) bot.waitingSinceMs = null;
    }
    if (last && last.role === "assistant" && !res.sending && !isBusyWithText()) {
      state.status = res.pending ? "working" : "idle";
      state.statusCaption = last.text;
    }
    renderPouch();
    markShownAsRead(botId, last);
    return res.pending;
  } catch {
    return true;
  }
}

// ============================================================================
// UNREAD REPLIES
// ============================================================================
// A result card or a draft is on screen: a bot's reply must not overwrite it.
function isBusyWithText() {
  return Boolean(state.result || state.drafting || (state.copyText && state.expanded));
}

function showUnread() {
  const bot = getSelectedBot();
  if (bot?.unreadCount && state.expanded && !isBusyWithText()) pollTranscriptOnce(bot.id);
}

// Only what the user can be looking at counts as read: an open notch that they opened or touched.
function markShownAsRead(botId, last) {
  const bot = findBot(botId);
  if (!last || !bot?.unreadCount || !state.expanded || state.passive || isBusyWithText()) return;
  apiFetch(`/api/bot/${encodeURIComponent(botId)}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastMessageId: last.id })
  })
    .then((r) => r.json())
    .then((res) => {
      if (!res.ok) return;
      bot.unreadCount = res.unreadCount;
      refreshBootstrap();
    })
    .catch(() => {});
}

function renderUnread() {
  const bot = getSelectedBot();
  const count = bot?.unreadCount || 0;
  dom.pouch.dataset.unread = String(count > 0);
  dom.collapsedUnread.hidden = count === 0;
  dom.collapsedUnread.textContent = count > 99 ? "99+" : String(count);
  dom.collapsedPreview.hidden = count === 0;
  dom.collapsedPreview.textContent = bot?.lastReplyPreview || "";
  dom.collapsedOthers.replaceChildren(
    ...state.bots
      .filter((b) => b !== bot && b.unreadCount)
      .map((b) => {
        const dot = document.createElement("span");
        dot.style.background = BOT_COLORS[b.color] || DEFAULT_BOT_COLOR;
        dot.title = `${b.name}: ${b.unreadCount} unread`;
        return dot;
      })
  );
}

// ============================================================================
// WAITING FOR A REPLY: elapsed time + stop
// ============================================================================
function setWaiting(botId, sinceMs) {
  const bot = findBot(botId);
  if (bot) bot.waitingSinceMs = sinceMs;
}

function waitingSince(bot) {
  return bot ? state.sends[bot.id] || bot.waitingSinceMs : null;
}

// Coming back to a bot that still owes a reply.
function showWaiting() {
  const bot = getSelectedBot();
  if (!waitingSince(bot) || isBusyWithText()) return;
  state.status = "working";
  state.statusCaption = "Working…";
  if (!state.sends[bot.id]) startReplyPoll(bot.id);
}

let elapsedTimer = null;

function renderStopArea() {
  const since = waitingSince(getSelectedBot());
  const show = Boolean(since) && state.expanded && !state.result && !state.drafting;
  dom.stopArea.hidden = !show;
  if (show) {
    const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
    dom.stopElapsed.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    elapsedTimer ??= setInterval(renderStopArea, 1000);
  } else if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

async function stopWaiting() {
  const bot = getSelectedBot();
  if (!bot) return;
  dom.stopBtn.disabled = true;
  const res = await apiFetch(`/api/bot/${encodeURIComponent(bot.id)}/stop`, { method: "POST" })
    .then((r) => r.json())
    .catch((err) => ({ ok: false, error: err.message }));
  dom.stopBtn.disabled = false;
  if (res.ok) {
    delete state.sends[bot.id];
    setWaiting(bot.id, null);
  }
  if (state.selectedBotId !== bot.id) return;
  if (res.ok) stopReplyPoll();
  state.status = res.ok ? "idle" : "error";
  state.statusCaption = res.ok
    ? `Stopped waiting. ${bot.name} may still finish this in OpenMausBot.`
    : res.error || "Couldn't stop waiting.";
  renderPouch();
}

dom.stopBtn.addEventListener("click", stopWaiting);

// ============================================================================
// TRANSCRIPT
// ============================================================================
function openTranscript() {
  const bot = getSelectedBot();
  if (!bot) return;
  state.view = "transcript";
  dom.transcriptList.dataset.shown = "";
  renderPouch();
  pollTranscriptOnce(bot.id);
}

function closeTranscript() {
  if (state.view !== "transcript") return;
  state.view = "default";
  renderPouch();
}

function formatTime(ms) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function transcriptSpeaker(entry) {
  return entry.role === "user" ? "You" : getSelectedBot()?.name || "Bot";
}

function copyFrom(button, text) {
  postNativeMessage({ type: "copyToClipboard", text });
  const label = button.textContent;
  if (label === "Copied") return;
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = label), 900);
}

function transcriptRow(entry) {
  const row = document.createElement("div");
  row.className = `transcript-msg${entry.role === "user" ? " user" : ""}${entry.unread ? " unread" : ""}`;
  const meta = document.createElement("div");
  meta.className = "transcript-meta";
  const label = document.createElement("span");
  label.textContent = `${transcriptSpeaker(entry)} · ${formatTime(entry.timestampMs)}`;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "result-btn";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => copyFrom(copy, entry.text));
  meta.append(label, copy);
  const text = document.createElement("div");
  text.className = "transcript-text";
  text.textContent = entry.text;
  row.append(meta, text);
  return row;
}

function renderTranscript() {
  const bot = getSelectedBot();
  const show = state.view === "transcript" && state.expanded && !state.result;
  dom.transcriptView.hidden = !show;
  dom.pouch.dataset.view = show ? "transcript" : "default";
  if (!show) return;
  const entries = state.transcript.botId === bot?.id ? state.transcript.entries : [];
  dom.transcriptCopy.disabled = entries.length === 0;
  // Rebuilt only when something changed, so reading back and selecting text aren't interrupted.
  const list = dom.transcriptList;
  const key = `${bot?.id} ${entries.map((e) => `${e.id}${e.unread ? "*" : ""}`).join(" ")}`;
  if (list.dataset.shown === key) return;
  const sameBot = list.dataset.shown.startsWith(`${bot?.id} `);
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const { scrollTop } = list;
  list.dataset.shown = key;
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "transcript-empty";
    empty.textContent = `No messages with ${bot?.name || "this bot"} yet.`;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...entries.map(transcriptRow));
  list.scrollTop = sameBot && !atEnd ? scrollTop : list.scrollHeight;
}

dom.transcriptChip.addEventListener("click", openTranscript);
dom.transcriptClose.addEventListener("click", closeTranscript);
dom.transcriptCopy.addEventListener("click", () => {
  const text = state.transcript.entries
    .map((e) => `[${transcriptSpeaker(e)} · ${formatTime(e.timestampMs)}]\n${e.text}`)
    .join("\n\n");
  if (text) copyFrom(dom.transcriptCopy, text);
});

// ============================================================================
// EVENTS & SHORTCUTS
// ============================================================================

dom.pouch.addEventListener("pointerdown", takeKeyboard, true);

// Collapsed: click to expand. Expanded: click is disabled via pointer-events:none in CSS.
dom.collapsedBar.addEventListener("click", () => {
  if (!state.expanded) setExpanded(true);
});

// Double-tap the identity bar or title block while expanded collapses the notch.
function collapseOnDoubleTap() {
  if (!state.expanded || state.typing) return;
  setExpanded(false);
}
dom.collapsedBar.addEventListener("dblclick", collapseOnDoubleTap);
dom.botTitleBlock.addEventListener("dblclick", collapseOnDoubleTap);

// Click the status caption (the bot's answer) to copy it, so it can be pasted into Mail, Slack, etc.
let copiedFlashTimer = null;
dom.botStatusCaption.addEventListener("click", (e) => {
  e.stopPropagation();
  const text = (state.copyText || dom.botStatusCaption.textContent).trim();
  if (!text || state.status !== "idle") return;
  postNativeMessage({ type: "copyToClipboard", text });
  const original = text;
  dom.botStatusCaption.textContent = "Copied";
  clearTimeout(copiedFlashTimer);
  copiedFlashTimer = setTimeout(() => {
    if (dom.botStatusCaption.textContent === "Copied") dom.botStatusCaption.textContent = original;
  }, 900);
});

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

  if (state.result) {
    if (e.key === "Escape") closeResult();
    return;
  }

  if (e.key === "Escape") {
    if (state.typing) {
      dom.typeInput.value = "";
      setTypingMode(false);
      return;
    }
    if (state.view === "transcript") {
      closeTranscript();
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

// ============================================================================
// DOUBLE ⌘ REPLY (Kai OS behavior): the native side read the screen; draft a reply as the
// user with the local model, show it, and hand it back to be written into Mail or at the cursor.
// ============================================================================
let draftCloseTimer = null;
// Every double-tap gets an id from the native side. Only the newest one may show or write anything,
// so a slow draft for one conversation can't land in the next.
let draftId = 0;
let draftRequest = null;

function beginDraft(id) {
  draftId = id;
  draftRequest?.abort();
  draftRequest = null;
  clearTimeout(draftCloseTimer);
  state.copyText = "";
  state.drafting = true;
}

// The user started something else in the notch: the draft they asked for before must not pop up over
// it or be pasted behind it.
function cancelDraft() {
  if (!state.drafting) return;
  beginDraft(-1);
  state.drafting = false;
}

async function draftReply(id, context, destination) {
  if (id !== draftId) return;
  stopReplyPoll();
  closeResult(false);
  state.status = "working";
  state.statusCaption = context && context.kind === "mail" ? "Writing a reply to this email…" : "Writing a reply…";
  renderPouch();
  const request = new AbortController();
  draftRequest = request;
  let res;
  try {
    res = await apiFetch("/api/draft-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context || {}),
      signal: request.signal
    }).then((r) => r.json());
  } catch (err) {
    res = { ok: false, error: err.message || "Couldn't write a reply." };
  }
  if (id !== draftId) return;
  draftRequest = null;
  state.drafting = false;
  if (!res.ok) {
    state.status = "error";
    state.statusCaption = res.error || "Couldn't write a reply.";
    renderPouch();
    return;
  }
  state.copyText = res.draft;
  state.status = "idle";
  // Typing a message in the notch right now: taking the keyboard away would be worse than a click.
  const showOnly = destination === "awaitingCursor" || state.typing;
  state.statusCaption = showOnly
    ? `${res.draft}\n\n(Click to copy, then paste it in your reply.)`
    : res.draft;
  if (!showOnly) {
    state.drafting = true; // until the native side says it was written, or wasn't
    postNativeMessage({ type: "writeDraft", id, text: res.draft });
  }
  renderPouch();
}

// ============================================================================
// SUMMARIZE · PROOFREAD · REWRITE (Kai OS's notch chips and result card)
// The native side reads the text (the field you're writing in, or the screen); the local
// model does the work; Replace puts the suggestion back only when you press it.
// ============================================================================
const TASK_TITLES = { summarize: "Summary", proofread: "Proofread", rewrite: "Rewrite" };
const TASK_WORKING = {
  summarize: "Reading your screen…",
  proofread: "Proofreading what you wrote…",
  rewrite: "Rewriting your text…"
};
const PROMPT_NAMES = {
  "starter-concise": "Make it concise",
  "starter-simple": "Explain simply",
  "starter-bullets": "Turn into bullets",
  "starter-spanish": "Translate to Spanish"
};
// Kai's KaiScreenTask.Refinement.available(for:)
const REFINE_OPTIONS = {
  summarize: [["shorter", "Shorter"], ["actions", "Action items"], ["reply", "Draft a reply"]],
  proofread: [["formal", "More formal"], ["friendly", "Friendlier"], ["shorter", "Shorter"]],
  rewrite: [["formal", "More formal"], ["friendly", "Friendlier"], ["shorter", "Shorter"]]
};

let taskSeq = 0;

function showRewriteMenu(show) {
  dom.rewriteMenu.hidden = !show;
  dom.actionChips.hidden = show;
}

function startScreenTask(task, promptId) {
  cancelDraft();
  stopReplyPoll();
  setTypingMode(false);
  showRewriteMenu(false);
  state.copyText = "";
  state.statusCaption = "";
  state.status = "working";
  state.result = {
    seq: ++taskSeq,
    task,
    promptId: promptId || "",
    title: promptId ? PROMPT_NAMES[promptId] || TASK_TITLES[task] : TASK_TITLES[task],
    text: TASK_WORKING[task],
    notes: "",
    phase: "working",
    canReplace: false,
    replaceState: "unavailable",
    footer: ""
  };
  renderPouch();
  postNativeMessage({ type: "screenTask", task });
}

async function runScreenTask(cmd) {
  const r = state.result;
  if (!r || r.task !== cmd.task || r.phase !== "working") return;
  const seq = r.seq;
  r.source = cmd.source;
  r.original = cmd.text;
  r.canReplace = Boolean(cmd.canReplace);
  r.text = cmd.source === "field" ? `${TASK_WORKING[r.task]}\n\nRead from ${cmd.app}.` : `${TASK_WORKING[r.task]}\n\nRead from ${cmd.app || "your screen"}.`;
  renderPouch();
  let res;
  try {
    res = await apiFetch("/api/screen-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: r.task,
        promptId: r.promptId,
        source: cmd.source,
        text: cmd.text,
        isSelection: Boolean(cmd.isSelection),
        kind: cmd.kind || "",
        from: cmd.from || "",
        subject: cmd.subject || "",
        app: cmd.app || ""
      })
    }).then((x) => x.json());
  } catch (err) {
    res = { ok: false, error: err.message || "Couldn't reach the local model." };
  }
  if (!state.result || state.result.seq !== seq) return;
  if (!res.ok) {
    failResult(res.error || "Something went wrong. Try again.");
    return;
  }
  r.text = res.text;
  r.notes = res.notes || "";
  r.phase = "done";
  r.replaceState = r.canReplace ? "ready" : "unavailable";
  r.footer = r.canReplace
    ? "Read on this Mac. Nothing is replaced until you press Replace."
    : r.task === "proofread"
      ? "Read from your screen on this Mac. To replace your text from here, select it (or click into it) first, then press Proofread."
      : "Read from your screen on this Mac. Nothing was sent anywhere.";
  state.status = "idle";
  renderPouch();
}

function failResult(message) {
  if (!state.result) return;
  state.result.phase = "failed";
  state.result.text = message;
  state.result.notes = "";
  state.result.canReplace = false;
  state.status = "error";
  renderPouch();
}

async function refineResult(refinement) {
  const r = state.result;
  if (!r || r.phase !== "done" || r.refining) return;
  const seq = r.seq;
  const previous = r.text;
  r.refining = true;
  state.status = "working";
  renderPouch();
  let res;
  try {
    res = await apiFetch("/api/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previous, refinement })
    }).then((x) => x.json());
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  if (!state.result || state.result.seq !== seq) return;
  r.refining = false;
  state.status = "idle";
  if (res.ok) {
    r.text = res.text;
    r.notes = "";
  } else {
    r.footer = res.error || "Couldn't revise it.";
  }
  renderPouch();
}

function closeResult(render = true) {
  if (!state.result) return;
  state.result = null;
  state.status = "idle";
  if (render) {
    showWaiting();
    renderPouch();
    showDeferredReply();
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Kai's forDisplay: list markers become bullets; **bold** shows bold. Everything else is plain text.
function formatResult(text) {
  return String(text)
    .split("\n")
    .map((line) => {
      const m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      const out = m ? `${m[1]}• ${m[2]}` : line;
      return escapeHtml(out).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    })
    .join("\n");
}

function renderResult() {
  const r = state.result;
  dom.resultView.hidden = !r;
  if (!r) return;
  dom.resultTitle.textContent = r.title;
  dom.resultText.innerHTML = formatResult(r.refining ? `${r.text}\n\nRevising…` : r.text);
  dom.resultNotes.innerHTML = formatResult(r.notes || "");
  dom.resultCopy.hidden = r.phase !== "done";
  const replacing = r.replaceState === "replacing" || r.replaceState === "replaced";
  dom.resultReplace.hidden = !(r.phase === "done" && r.canReplace);
  dom.resultReplace.disabled = Boolean(r.refining) || replacing || r.text.trim() === String(r.original || "").trim();
  dom.resultReplace.textContent = r.replaceState === "replacing" ? "Replacing…" : r.replaceState === "replaced" ? "Replaced" : "Replace";
  dom.refineChips.replaceChildren();
  if (r.phase === "done") {
    for (const [id, label] of REFINE_OPTIONS[r.task] || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = label;
      b.disabled = Boolean(r.refining) || replacing;
      b.addEventListener("click", () => refineResult(id));
      dom.refineChips.appendChild(b);
    }
  }
  dom.resultFooter.textContent = r.footer || "";
}

dom.actionChips.querySelectorAll("[data-task]").forEach((b) =>
  b.addEventListener("click", () => startScreenTask(b.dataset.task))
);
dom.rewriteChip.addEventListener("click", () => showRewriteMenu(true));
dom.rewriteBack.addEventListener("click", () => showRewriteMenu(false));
dom.rewriteMenu.querySelectorAll("[data-prompt]").forEach((b) =>
  b.addEventListener("click", () => startScreenTask("rewrite", b.dataset.prompt))
);
dom.resultClose.addEventListener("click", () => closeResult());
dom.resultCopy.addEventListener("click", () => {
  if (!state.result) return;
  postNativeMessage({ type: "copyToClipboard", text: state.result.text });
  dom.resultCopy.textContent = "Copied";
  setTimeout(() => (dom.resultCopy.textContent = "Copy"), 900);
});
dom.resultReplace.addEventListener("click", () => {
  const r = state.result;
  if (!r || !r.canReplace || r.phase !== "done") return;
  r.replaceState = "replacing";
  renderPouch();
  postNativeMessage({ type: "replaceText", text: r.text });
});

// Native host commands (⌥Space toggle, menu bar bot selection)
window.__notchCommand = async (cmd) => {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "toggleExpand":
      // ⌥Space on a notch that opened by itself means "let me use it", not "close it".
      if (state.expanded && state.passive && cmd.byUser) takeKeyboard();
      else setExpanded(!state.expanded);
      break;
    case "screenAnswerReading":
      // Double-tap ⌘ (bare, no other key): the native side is reading the email, Slack
      // conversation, selected text, clipboard, or screen OCR in front of the user.
      beginDraft(cmd.id);
      setExpanded(true);
      setTypingMode(false);
      stopReplyPoll();
      closeResult(false);
      closeTranscript();
      state.status = "working";
      state.statusCaption = "Reading your screen…";
      renderPouch();
      break;
    case "draftReply":
      draftReply(cmd.id, cmd.context, cmd.destination);
      break;
    case "draftWriting":
      if (cmd.id !== draftId) break;
      state.passive = state.expanded; // the keyboard goes back to the user's app
      reportHitRectToNative();
      state.status = "working";
      state.statusCaption = cmd.caption || "Writing…";
      renderPouch();
      break;
    case "draftWritten":
      if (cmd.id !== draftId) break;
      state.drafting = false;
      // Like Kai: say where it went, then get out of the way of the email.
      state.status = "idle";
      state.statusCaption = cmd.caption || "Written. Review it and send it yourself.";
      renderPouch();
      clearTimeout(draftCloseTimer);
      draftCloseTimer = setTimeout(() => {
        if (state.statusCaption === cmd.caption) setExpanded(false);
      }, 2500);
      break;
    case "draftWriteFailed":
      if (cmd.id !== draftId) break;
      state.drafting = false;
      state.status = "idle";
      state.statusCaption = `${cmd.error || "Couldn't write the draft."}\n\n${state.copyText || ""}`.trim();
      renderPouch();
      break;
    case "screenAnswerFailed":
      if (cmd.id !== draftId) break;
      state.drafting = false;
      stopReplyPoll();
      state.status = "error";
      state.statusCaption = cmd.error || "Couldn't read your screen.";
      renderPouch();
      break;
    case "screenTaskText":
      runScreenTask(cmd);
      break;
    case "screenTaskFailed":
      failResult(cmd.error || "Couldn't read your screen.");
      break;
    case "replaced":
      if (state.result) {
        state.result.replaceState = "replaced";
        state.result.footer = cmd.caption || "Replaced.";
        renderPouch();
        setTimeout(() => {
          if (state.result && state.result.replaceState === "replaced") setExpanded(false);
        }, 1400);
      }
      break;
    case "replaceFailed":
      if (state.result) {
        state.result.replaceState = "ready";
        state.result.footer = cmd.error || "Couldn't replace the text. Use Copy.";
        renderPouch();
      }
      break;
    case "nextBot":
      cycleBot(1);
      break;
    case "prevBot":
      cycleBot(-1);
      break;
    case "escape":
      if (state.result) {
        closeResult();
      } else if (state.typing) {
        dom.typeInput.value = "";
        setTypingMode(false);
      } else if (state.view === "transcript") {
        closeTranscript();
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
    } else {
      renderUnread();
      renderStopArea();
    }
  } catch {}
}

async function init() {
  await refreshBootstrap();
  renderPouch();
  reportHitRectToNative();
  connectEvents();
  setInterval(refreshBootstrap, 8000);
}

init();

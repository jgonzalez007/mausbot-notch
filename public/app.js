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
// state.view: "default" | "transcript"
const state = {
  expanded: false,
  passive: false,
  typing: false,
  bots: [],
  selectedBotId: null,
  status: "idle",
  statusCaption: "",
  unreadCount: 0,
  unreadSinceMs: null,
  lastReplyPreview: "",
  view: "default",
  transcriptMessages: [],
  stopTimerInterval: null,
  stopElapsedMs: 0,
  pending: false,
  pendingSinceMs: null,
  _lastClosedAt: null
};

const dom = {
  pouch: document.getElementById("notch-pouch"),
  collapsedBar: document.getElementById("collapsed-bar"),
  collapsedName: document.getElementById("collapsed-name"),
  collapsedDot: document.getElementById("collapsed-dot"),
  collapsedUnreadBadge: document.getElementById("collapsed-unread-badge"),
  collapsedPreview: document.getElementById("collapsed-preview"),
  botTitleBlock: document.getElementById("bot-title-block"),
  botNameLabel: document.getElementById("bot-name-label"),
  botStatusCaption: document.getElementById("bot-status-caption"),
  viewSwitcher: document.getElementById("view-switcher"),
  viewDefaultPanel: document.getElementById("view-default-panel"),
  viewTranscriptPanel: document.getElementById("view-transcript-panel"),
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
  resultFooter: document.getElementById("result-footer"),
  stopArea: document.getElementById("stop-area"),
  stopBtn: document.getElementById("stop-btn"),
  stopElapsed: document.getElementById("stop-elapsed"),
  transcriptContainer: document.getElementById("transcript-container"),
  transcriptCopy: document.getElementById("transcript-copy"),
  viewDefaultBtn: document.getElementById("view-default"),
  viewTranscriptBtn: document.getElementById("view-transcript")
};

function getSelectedBot() {
  return state.bots.find((b) => b.id === state.selectedBotId) || state.bots[0] || null;
}

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
    postNativeMessage({ type: "notchOpened" });
    refreshBootstrap();
    showDeferredReply();
    if (state.status === "working" || state.status === "needs_approval") {
      startStopTimer();
    }
  } else {
    setTypingMode(false);
    closeResult();
    showRewriteMenu(false);
    stopReplyPoll();
    stopStopTimer();
    postNativeMessage({ type: "notchClosed" });
    markAllRead();
  }
  reportHitRectToNative();
  let steps = 0;
  const timer = setInterval(() => {
    reportHitRectToNative();
    if (++steps > 10) clearInterval(timer);
  }, 35);
}

function takeKeyboard() {
  if (!state.passive) return;
  state.passive = false;
  reportHitRectToNative();
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
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatTime(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function renderPouch() {
  const bot = getSelectedBot();
  dom.pouch.dataset.result = state.result && state.expanded ? "true" : "false";
  dom.pouch.dataset.view = state.view;
  renderResult();
  renderStopArea();
  renderTranscript();
  if (!bot) {
    dom.botNameLabel.textContent = "No bots configured";
    dom.botNameLabel.hidden = false;
    dom.collapsedName.textContent = "MausBot Notch";
    dom.botStatusCaption.hidden = true;
    dom.pouch.dataset.status = "idle";
    dom.collapsedUnreadBadge.hidden = true;
    dom.collapsedPreview.hidden = true;
    dom.viewSwitcher.hidden = true;
    document.documentElement.style.setProperty("--bot-ink", DEFAULT_BOT_COLOR);
    reportHitRectToNative();
    return;
  }

  document.documentElement.style.setProperty("--bot-ink", BOT_COLORS[bot.color] || DEFAULT_BOT_COLOR);
  dom.pouch.dataset.status = state.status;
  dom.pouch.dataset.draft = state.copyText && state.expanded ? "true" : "false";

  dom.collapsedName.textContent = bot.name;
  dom.botNameLabel.textContent = bot.name;
  dom.botNameLabel.hidden = true;
  dom.typeInput.placeholder = `Message ${bot.name}…`;

  // P0 #2: Show unread badge and last-reply preview on collapsed pill.
  if (state.unreadCount > 0) {
    dom.collapsedUnreadBadge.textContent = state.unreadCount > 1 ? String(state.unreadCount) : "\u25CF";
    dom.collapsedUnreadBadge.hidden = false;
  } else {
    dom.collapsedUnreadBadge.hidden = true;
  }
  if (state.lastReplyPreview) {
    dom.collapsedPreview.textContent = state.lastReplyPreview;
    dom.collapsedPreview.hidden = false;
  } else {
    dom.collapsedPreview.hidden = true;
  }

  if (state.statusCaption) {
    dom.botStatusCaption.textContent = state.statusCaption;
    dom.botStatusCaption.hidden = false;
    dom.botStatusCaption.title = state.status === "idle" ? "Click to copy" : "";
  } else {
    dom.botStatusCaption.hidden = true;
  }

  // Show view switcher when expanded and not typing.
  if (state.expanded && !state.typing) {
    dom.viewSwitcher.hidden = false;
    dom.viewDefaultBtn.classList.toggle("chip-primary", state.view === "default");
    dom.viewTranscriptBtn.classList.toggle("chip-primary", state.view === "transcript");
  } else {
    dom.viewSwitcher.hidden = true;
  }

  reportHitRectToNative();
}

async function selectBot(botId) {
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) return;
  state.selectedBotId = bot.id;
  state.status = "idle";
  state.statusCaption = "";
  state.unreadCount = 0;
  state.unreadSinceMs = null;
  state.lastReplyPreview = "";
  state.view = "default";
  state.stopElapsedMs = 0;
  state.pending = false;
  state.pendingSinceMs = null;
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

// ============================================================================
// INBOUND EVENTS: server-sent events from the local bridge.
// ============================================================================
let eventSource = null;

function connectEvents() {
  if (eventSource) return;
  const token = window.__MAUSBOT_NOTCH_AUTH_TOKEN;
  if (!token) return;
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

  const draftToRead = state.copyText && state.expanded;
  if (isCurrent && (state.result || state.drafting || draftToRead)) {
    if (evt.type === "reply") state.deferredReplyBotId = evt.botId;
    if (evt.type === "reply" || evt.type === "hello") refreshBootstrap();
    return;
  }

  if (evt.type === "reply") {
    if (isCurrent) {
      state.unreadCount = (state.unreadCount || 0) + 1;
      state.unreadSinceMs = Date.now();
      state.lastReplyPreview = evt.preview?.slice(0, 60) || "";
      state.copyText = "";
      if (!state.expanded) setExpanded(true, { passive: true });
      pollTranscriptOnce(evt.botId);
    }
    refreshBootstrap();
  } else if (evt.type === "status" && isCurrent) {
    state.status = evt.status;
    state.statusCaption = evt.status === "needs_approval" ? "Waiting on your approval\u2026" : "Working\u2026";
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
  state.unreadCount = 0;
  state.unreadSinceMs = null;
  state.copyText = "";
  state.status = "sending";
  state.statusCaption = "Sending\u2026";
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

  state.status = sendRes.status;
  state.statusCaption = sendRes.status === "needs_approval" ? "Waiting on your approval\u2026" : "Working\u2026";
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

    state.transcriptMessages = res.messages || [];
    state.unreadCount = res.unreadCount || 0;
    state.unreadSinceMs = res.unreadSinceMs || null;
    state.pending = res.pending;
    state.pendingSinceMs = res.pendingSinceMs || null;

    // Update last reply preview.
    if (state.transcriptMessages.length > 0) {
      const last = state.transcriptMessages[state.transcriptMessages.length - 1];
      state.lastReplyPreview = last.text?.slice(0, 50) || "";
    }

    const last = state.transcriptMessages[state.transcriptMessages.length - 1];
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
// P0 #1: Transcript view
// ============================================================================
// Render the transcript view - scrollable list of messages with timestamps
function renderTranscript() {
  if (state.view !== "transcript" || !state.expanded) {
    return;
  }
  const msgs = state.transcriptMessages || [];
  const container = dom.transcriptContainer;
  if (!container) return;

  container.innerHTML = "";
  if (msgs.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "transcript-msg empty-msg";
    emptyMsg.innerHTML = '<div class="transcript-msg-text">No messages yet. Say hello to ' + escapeHtml(getSelectedBot()?.name || "MausBot") + '.</div>';
    container.appendChild(emptyMsg);
    return;
  }

  for (const msg of msgs) {
    const el = document.createElement("div");
    const isUser = msg.role === "user";
    el.className = "transcript-msg" + (isUser ? " user" : "") + (msg.unread ? " unread-marker" : "");
    el.innerHTML =
      '<div class="transcript-msg-time">' + formatTime(msg.timestampMs) + '</div>' +
      '<div class="transcript-msg-text">' + escapeHtml(msg.text) + '</div>';
    container.appendChild(el);
  }

  // Auto-scroll to bottom.
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

// Mark all messages as read
async function markAllRead() {
  if (!state.selectedBotId) return;
  try {
    await apiFetch(`/api/bot/${encodeURIComponent(state.selectedBotId)}/transcript`);
  } catch {}
}

// Toggle view between default and transcript
function toggleView() {
  state.view = state.view === "default" ? "transcript" : "default";
  if (state.view === "transcript") {
    pollTranscriptOnce(state.selectedBotId).then(() => {
      renderTranscript();
      renderPouch();
    });
  } else {
    state.transcriptMessages = [];
    renderPouch();
  }
}

// Copy all transcript text to clipboard
async function copyTranscript() {
  const msgs = state.transcriptMessages || [];
  const text = msgs.map((m) => '[' + m.role.toUpperCase() + ' ' + formatTime(m.timestampMs) + '] ' + m.text).join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
    dom.transcriptCopy.textContent = "Copied!";
    setTimeout(() => { dom.transcriptCopy.textContent = "Copy All"; }, 900);
  } catch {
    dom.transcriptCopy.textContent = "Failed";
    setTimeout(() => { dom.transcriptCopy.textContent = "Copy All"; }, 900);
  }
}

// ============================================================================
// P0 #3: Stop/cancel a running reply + elapsed time
// ============================================================================
function renderStopArea() {
  const isWorking = state.status === "working" || state.status === "needs_approval";
  dom.stopArea.hidden = !isWorking;
  if (isWorking) {
    const elapsed = state.stopElapsedMs;
    const seconds = Math.floor(elapsed / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    dom.stopElapsed.textContent = mins + 'm ' + secs + 's';
    dom.stopBtn.textContent = "Stop";
  }
}

function startStopTimer() {
  stopStopTimer();
  state.stopElapsedMs = 0;
  state.stopTimerInterval = setInterval(() => {
    state.stopElapsedMs = Date.now() - (state.pendingSinceMs || Date.now());
    renderStopArea();
  }, 1000);
}

function stopStopTimer() {
  if (state.stopTimerInterval) {
    clearInterval(state.stopTimerInterval);
    state.stopTimerInterval = null;
  }
}

async function stopBotReply() {
  if (state.status !== "working" && state.status !== "needs_approval") return;
  dom.stopBtn.textContent = "Stopping\u2026";
  dom.stopBtn.disabled = true;
  try {
    const res = await apiFetch("/api/bot/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: state.selectedBotId })
    }).then((r) => r.json());
    if (res.ok || res.alreadyStopped) {
      stopStopTimer();
      state.status = "idle";
      state.statusCaption = "Reply stopped.";
      state.stopElapsedMs = res.elapsedMs || 0;
      renderPouch();
    } else {
      dom.stopBtn.textContent = "Stop";
      dom.stopBtn.disabled = false;
    }
  } catch (err) {
    dom.stopBtn.textContent = "Stop";
    dom.stopBtn.disabled = false;
  }
}

// ============================================================================
// EVENTS & SHORTCUTS
// ============================================================================
dom.pouch.addEventListener("pointerdown", takeKeyboard, true);

dom.collapsedBar.addEventListener("click", () => {
  if (!state.expanded) setExpanded(true);
});

function collapseOnDoubleTap() {
  if (!state.expanded || state.typing) return;
  setExpanded(false);
}
dom.collapsedBar.addEventListener("dblclick", collapseOnDoubleTap);
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
  } else if (e.key === "t" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    toggleView();
    return;
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    setTypingMode(true, e.key);
  }
});

// ============================================================================
// DOUBLE ⌘ REPLY (Kai OS behavior)
// ============================================================================
let draftCloseTimer = null;
let draftId = 0;
let draftRequest = null;

function beginDraft(id) {
  draftId = id;
  draftRequest?.abort();
  draftRequest = null;
  clearTimeout(draftCloseTimer);
  state.unreadCount = 0;
  state.copyText = "";
  state.drafting = true;
}

function cancelDraft() {
  if (!state.drafting) return;
  beginDraft(-1);
  state.drafting = false;
}

async function draftReply(id, context, destination) {
  if (id !== draftId) return;
  stopReplyPoll();
  closeResult(false);
  state.unreadCount = 0;
  state.status = "working";
  state.statusCaption = context && context.kind === "mail" ? "Writing a reply to this email\u2026" : "Writing a reply\u2026";
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
  const showOnly = destination === "awaitingCursor" || state.typing;
  state.statusCaption = showOnly
    ? res.draft + '\n\n(Click to copy, then paste it in your reply.)'
    : res.draft;
  if (!showOnly) {
    state.drafting = true;
    postNativeMessage({ type: "writeDraft", id, text: res.draft });
  }
  renderPouch();
}

// ============================================================================
// SUMMARIZE \u00B7 PROOFREAD \u00B7 REWRITE (Kai OS's notch chips and result card)
// ============================================================================
const TASK_TITLES = { summarize: "Summary", proofread: "Proofread", rewrite: "Rewrite" };
const TASK_WORKING = {
  summarize: "Reading your screen\u2026",
  proofread: "Proofreading what you wrote\u2026",
  rewrite: "Rewriting your text\u2026"
};
const PROMPT_NAMES = {
  "starter-concise": "Make it concise",
  "starter-simple": "Explain simply",
  "starter-bullets": "Turn into bullets",
  "starter-spanish": "Translate to Spanish"
};
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
  state.unreadCount = 0;
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
  r.text = cmd.source === "field" ? TASK_WORKING[r.task] + '\n\nRead from ' + cmd.app + '.' : TASK_WORKING[r.task] + '\n\nRead from ' + (cmd.app || "your screen") + '.';
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
      ? "Read from your screen on this Mac. To replace your text from here, select it first, then press Proofread."
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
    renderPouch();
    showDeferredReply();
  }
}

function formatResult(text) {
  return String(text)
    .split("\n")
    .map((line) => {
      const m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      const out = m ? m[1] + '\u2022 ' + m[2] : line;
      return escapeHtml(out).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    })
    .join("\n");
}

function renderResult() {
  const r = state.result;
  dom.resultView.hidden = !r;
  if (!r) return;
  dom.resultTitle.textContent = r.title;
  dom.resultText.innerHTML = formatResult(r.refining ? r.text + '\n\nRevising\u2026' : r.text);
  dom.resultNotes.innerHTML = formatResult(r.notes || "");
  dom.resultCopy.hidden = r.phase !== "done";
  const replacing = r.replaceState === "replacing" || r.replaceState === "replaced";
  dom.resultReplace.hidden = !(r.phase === "done" && r.canReplace);
  dom.resultReplace.disabled = Boolean(r.refining) || replacing || r.text.trim() === String(r.original || "").trim();
  dom.resultReplace.textContent = r.replaceState === "replacing" ? "Replacing\u2026" : r.replaceState === "replaced" ? "Replaced" : "Replace";
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
  setTimeout(() => { dom.resultCopy.textContent = "Copy"; }, 900);
});
dom.resultReplace.addEventListener("click", () => {
  const r = state.result;
  if (!r || !r.canReplace || r.phase !== "done") return;
  r.replaceState = "replacing";
  renderPouch();
  postNativeMessage({ type: "replaceText", text: r.text });
});

// ============================================================================
// NATIVE HOST COMMANDS (⌥Space toggle, menu bar bot selection)
// ============================================================================
window.__notchCommand = async (cmd) => {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "toggleExpand":
      if (state.expanded && state.passive && cmd.byUser) takeKeyboard();
      else setExpanded(!state.expanded);
      break;
    case "screenAnswerReading":
      beginDraft(cmd.id);
      setExpanded(true);
      setTypingMode(false);
      stopReplyPoll();
      closeResult(false);
      state.unreadCount = 0;
      state.copyText = "";
      state.status = "working";
      state.statusCaption = "Reading your screen\u2026";
      renderPouch();
      break;
    case "draftReply":
      draftReply(cmd.id, cmd.context, cmd.destination);
      break;
    case "draftWriting":
      if (cmd.id !== draftId) break;
      state.passive = state.expanded;
      reportHitRectToNative();
      state.status = "working";
      state.statusCaption = cmd.caption || "Writing\u2026";
      renderPouch();
      break;
    case "draftWritten":
      if (cmd.id !== draftId) break;
      state.drafting = false;
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
      state.statusCaption = (cmd.error || "Couldn't write the draft.") + '\n\n' + (state.copyText || "");
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
        document.documentElement.style.setProperty("--notch-width", cmd.notchWidth + "px");
      }
      if (cmd.notchHeight && cmd.notchHeight > 20) {
        document.documentElement.style.setProperty("--notch-height", cmd.notchHeight + "px");
      }
      reportHitRectToNative();
      break;
  }
};

// ============================================================================
// NOTCH OPEN/CLOSE NOTIFICATION (P0 #2: mark unread from when notch was closed)
// ============================================================================
async function notifyNotchOpened() {
  const lastClosedAt = state._lastClosedAt || Date.now();
  try {
    await apiFetch("/api/notch-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastClosedAt: lastClosedAt })
    }).catch(() => {});
  } catch {}
}

async function notifyNotchClosed() {
  const closedAt = Date.now();
  try {
    await apiFetch("/api/notch-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastClosedAt: closedAt })
    }).catch(() => {});
  } catch {}
}

// ============================================================================
// BOOTSTRAP + INIT
// ============================================================================
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
  connectEvents();
  setInterval(refreshBootstrap, 8000);
}

init();

// Runs inside the notch page (see ui-host.swift). Every press goes through the spot on screen where
// the button is, so a button that is hidden, covered or not wired up fails.
document.head.insertAdjacentHTML("beforeend", "<style>*{transition:none!important;animation:none!important}</style>");
await until(() => $("#collapsed-name").textContent === "Ann", "the first bot's name shows");
check(sentSince(0, "rosterLoaded"), "the bots reach the menu bar");
check(getComputedStyle(document.documentElement).getPropertyValue("--bot-ink").trim() === "#f472b6", "the bot's color is used");
ok("starts up");

await press("#collapsed-bar");
for (const sel of ["[data-task=summarize]", "[data-task=proofread]", "#rewrite-chip", "#transcript-chip"]) check(visible($(sel)), `${sel} shows when the notch opens`);
await shot("1-open");
ok("opening the notch shows Summarize, Proofread, Rewrite and Transcript");

// --- Text tasks ---
const runTask = async (task, canReplace) => {
  await until(() => window.__sent.findLast((m) => m.type === "screenTask")?.task === task, `${task} asks for the text`);
  native({ action: "screenTaskText", task, source: canReplace ? "field" : "screen", text: "helo wrld", canReplace, app: "Notes" });
  await until(() => $("#result-text").textContent.includes("Model answer") && visible($("#result-copy")), `${task} shows its answer`);
};
await press("[data-task=summarize]");
await runTask("summarize", false);
check(!visible($("#result-replace")), "a summary can't replace text");
check((await copies("#result-copy")) === "Model answer.", "Copy copies the answer");
for (const label of ["Shorter", "Action items", "Draft a reply"]) {
  const chip = [...$("#refine-chips").children].find((b) => b.textContent === label);
  await press(chip, label);
  await until(() => [...$("#refine-chips").children].every((b) => !b.disabled), `${label} finishes`);
}
await press("#result-close");
check(visible($("[data-task=proofread]")), "closing the card brings the buttons back");
ok("Summarize, Copy, the three revisions and close");

await press("[data-task=proofread]");
await runTask("proofread", true);
await shot("2-proofread");
let n = window.__sent.length;
await press("#result-replace");
await until(() => sentSince(n, "replaceText"), "Replace hands the text back");
native({ action: "replaced", caption: "Replaced." });
await until(() => $("#notch-pouch").dataset.expanded === "false", "Replace closes the notch");
ok("Proofread and Replace");

await press("#collapsed-bar");
await press("#rewrite-chip");
await shot("3-rewrite");
await press("#rewrite-back");
check(visible($("#rewrite-chip")), "back returns to the buttons");
for (const prompt of ["starter-concise", "starter-simple", "starter-bullets", "starter-spanish", "mine", "all"]) {
  await press("#rewrite-chip");
  await press(`[data-prompt=${prompt}]`);
  await runTask("rewrite", true);
  await press("#result-close");
}
ok("Rewrite, its four choices and the person's own");

await press("#rewrite-chip");
check([...$("#rewrite-mine").children].map((b) => b.textContent).join() === "Tenant reply,For everyone <b>", "only this bot's and everyone's presets show");
await press("#next-bot-btn");
check($("#rewrite-mine").textContent.startsWith("Only Ben's"), "the other bot has its own");
if (!visible($("#rewrite-back"))) await press("#rewrite-chip");
await press("[data-prompt=bens]");
await until(() => $("#result-title").textContent === "Only Ben's", "its own preset is used");
await runTask("rewrite", true);
await press("#result-close");
await press("#prev-bot-btn");
n = window.__sent.length;
if (!visible($("#rewrite-edit"))) await press("#rewrite-chip");
await press("#rewrite-edit");
await until(() => sentSince(n, "openSettings")?.tab === "presets", "Edit opens the presets in Settings");
await until(() => $("#notch-pouch").dataset.expanded === "false", "Settings closes the notch");
await press("#collapsed-bar");
if (visible($("#rewrite-back"))) await press("#rewrite-back");
n = window.__sent.length;
await press("#settings-chip");
await until(() => sentSince(n, "openSettings")?.tab === "bots", "the gear opens Settings");
await press("#collapsed-bar");
ok("presets per bot, Edit and the Settings button");

// --- Talking to a bot ---
key("t");
check($("#type-input").value === "t" && visible($("#type-input")), "typing t starts a message");
key("Escape");
await say("hello");
await until(() => caption() === "Hi there.", "the reply shows");
check((await copies("#bot-status-caption")) === "Hi there.", "clicking the reply copies it");
ok("typing any letter, sending, and clicking the reply to copy it");

await say("slow");
await until(() => visible($("#stop-btn")) && $("#stop-elapsed").textContent === "1s", "the wait and its time show while sending");
await shot("4-waiting");
await press("#stop-btn");
await until(() => caption().startsWith("Stopped waiting"), "stopping says so");
check(!visible($("#stop-btn")), "the stop button goes away");
ok("stops waiting while the message is being sent");

await say("work");
await until(() => caption() === "Working…" && visible($("#stop-btn")), "a long reply shows as working");
await press("[data-task=summarize]");
check(!visible($("#stop-btn")), "a result card covers the wait");
await runTask("summarize", false);
await press("#result-close");
await until(() => visible($("#stop-btn")), "the wait is back after closing the card");
await press("#next-bot-btn");
check(!visible($("#stop-btn")) && $("#collapsed-name").textContent === "Ben", "the other bot isn't waiting");
await press("#prev-bot-btn");
await until(() => visible($("#stop-btn")), "the wait is still there for the first bot");
await press("#stop-btn");
await until(() => caption().startsWith("Stopped waiting"), "stopping a long reply says so");
await sleep(8300);
check(!visible($("#stop-btn")), "a stopped wait doesn't come back");
ok("stops waiting for a long reply, per bot");

// --- Transcript ---
await press("#transcript-chip");
await until(() => document.querySelectorAll(".transcript-msg").length === 4, "all messages are listed");
check(/You · .*\d:\d\d:\d\d/.test($(".transcript-msg.user").textContent), "messages have a speaker and time");
check((await copies(".transcript-msg:nth-child(2) button")) === "Hi there.", "one message can be copied");
check((await copies("#transcript-copy")).includes("Hi there."), "the conversation can be copied");
await say("html <img src=x onerror=__errors.push('injected')>");
await until(() => document.querySelectorAll(".transcript-msg").length === 6, "a message sent from here is listed");
check(!$(".transcript-list img"), "message text is never treated as HTML");
await say("long");
await until(() => $(".transcript-list").scrollHeight > $(".transcript-list").clientHeight, "a long conversation scrolls");
const list = $(".transcript-list");
check(list.scrollHeight - list.scrollTop - list.clientHeight < 2, "the newest message is in view");
await shot("5-transcript");
list.scrollTop = 0;
await notify("a", { status: "working" });
await sleep(300);
check(list.scrollTop === 0, "reading back isn't interrupted");
await press("#transcript-close");
check(visible($("[data-task=proofread]")), "closing the transcript brings the buttons back");
await press("#transcript-chip");
key("Escape");
check(visible($("#transcript-chip")), "Esc closes the transcript but not the notch");
ok("transcript, copying, scrolling and closing");

// --- Unread ---
await collapse();
await notify("a", { text: "Rent is paid for Egger." });
await until(() => visible($("#collapsed-unread")), "a reply shows as unread");
await sleep(300);
check($("#notch-pouch").dataset.expanded === "false", "a reply leaves the notch closed");
check($("#notch-pouch").dataset.peek === "true", "a reply is previewed");
check($("#collapsed-unread").textContent === "1" && $("#collapsed-preview").textContent === "Rent is paid for Egger.", "count and preview");
await notify("b", { text: "Pool is at 84." });
await until(() => $("#collapsed-name").textContent === "Ben" && $("#collapsed-preview").textContent === "Pool is at 84.", "another bot's reply is previewed under its name");
check($("#collapsed-others").children.length === 1, "the first bot's unread reply shows as its dot");
await shot("6-preview");
await sleep(7300);
check($("#collapsed-name").textContent === "Ann" && $("#notch-pouch").dataset.peek === "false", "the preview gives way to the selected bot");
check($("#collapsed-others").children.length === 1 && visible($("#collapsed-unread")), "its count and the other bot's dot stay");
await shot("7-unread");
await press("#collapsed-bar");
await until(() => caption() === "Rent is paid for Egger." && $("#collapsed-unread").hidden, "opening shows the reply and marks it read");
await press("#next-bot-btn");
await until(() => caption() === "Pool is at 84." && $("#collapsed-others").children.length === 0, "the other bot's reply shows and is marked read");
await collapse();
check(!visible($("#collapsed-unread")), "nothing left unread");
check($("#collapsed-name").textContent === "Ben", "Ben is selected");
await notify("a", { text: "Lease is signed." });
await until(() => $("#collapsed-name").textContent === "Ann", "a reply from the bot that isn't selected is previewed too");
await press("#collapsed-bar");
await until(() => caption() === "Lease is signed." && $("#collapsed-name").textContent === "Ann", "opening a preview opens its bot");
await collapse();
check(!visible($("#collapsed-unread")), "a previewed reply that was opened is read");
const preference = (body) => fetch("/api/settings/preferences", {
  method: "POST",
  headers: { Authorization: `Bearer ${window.__MAUSBOT_NOTCH_AUTH_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
await preference({ openOnReply: true });
await sleep(300);
await notify("a", { text: "Opens by itself." });
await until(() => $("#notch-pouch").dataset.expanded === "true" && caption() === "Opens by itself.", "a reply opens the notch when Settings says so");
check(window.__sent.findLast((m) => m.type === "hitRect").isPassive, "and doesn't take the keyboard");
native({ action: "toggleExpand" });
await until(() => visible($("#collapsed-unread")), "an untouched reply stays unread");
await press("#collapsed-bar");
await collapse();
await preference({ openOnReply: false });
ok("unread count, preview and marking read, per bot");

// --- Double-command draft still works on top of all this ---
await press("#collapsed-bar");
await press("#transcript-chip");
native({ action: "screenAnswerReading", id: 7 });
check(visible($("#bot-status-caption")), "a draft closes the transcript");
n = window.__sent.length;
native({ action: "draftReply", id: 7, context: { kind: "chat", app: "Slack", body: "Friday ok?" }, destination: "cursor" });
await until(() => sentSince(n, "writeDraft")?.id === 7, "the draft is handed back to be written");
native({ action: "draftWriteFailed", id: 7, error: "Not there." });
await until(() => caption().startsWith("Not there."), "a failed write keeps the draft to copy");
check((await copies("#bot-status-caption")) === "Model answer.", "the draft can be copied");
await press("#prev-bot-btn");
check(!caption().includes("Model answer.") && $("#notch-pouch").dataset.draft === "false", "switching bots drops the old draft");
ok("double-command draft");

// --- Nothing missed ---
const missed = [...document.querySelectorAll("button")].map(buttonName).filter((b) => !pressed.has(b));
check(missed.length === 0, `buttons this test never pressed: ${missed.join(", ")}`);
check(pressed.has("refine") && pressed.has("row-copy"), "revision and message Copy buttons were pressed");
check(window.__errors.length === 0, "the page reported errors");
ok(`every button was pressed (${pressed.size}) and the page reported no errors`);
return log.join("\n");

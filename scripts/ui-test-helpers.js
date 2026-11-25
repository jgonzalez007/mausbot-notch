// Put in front of each page test by ui-test.mjs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const pressed = new Set();
const $ = (sel) => document.querySelector(sel);
const ok = (name) => log.push(`ok   - ${name}`);
const fail = (why) => { throw new Error([...log, why, ...window.__errors].join("\n")); };
const check = (cond, why) => { if (!cond) fail(why); };
const until = async (cond, why) => {
  for (let i = 0; i < 60; i++) { if (cond()) return; await sleep(50); }
  fail(`never happened: ${why}`);
};
const visible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return Boolean(top && (el === top || el.contains(top)));
};
const buttonName = (b) => b.id || b.dataset.task || b.dataset.prompt || b.dataset.tab || (b.closest("#refine-chips") ? "refine" : b.closest("#model-choices") ? "model-choice" : b.matches(".item") ? "item" : "row-copy");
const press = async (target, why = target) => {
  const el = typeof target === "string" ? $(target) : target;
  el?.scrollIntoView({ block: "nearest" });
  await until(() => visible(el) && !el.disabled, `${why} can be pressed`);
  if (el.matches("button")) pressed.add(buttonName(el)); // before the click, which may replace it
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  hit.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(30);
};
const key = (k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const native = (cmd) => window.__notchCommand(cmd);
const sentSince = (n, type) => window.__sent.slice(n).find((m) => m.type === type);
const copies = async (target) => {
  const n = window.__sent.length;
  await press(target);
  await until(() => sentSince(n, "copyToClipboard"), `${target} copies`);
  return sentSince(n, "copyToClipboard").text;
};
const notify = (botId, body) => fetch("/api/notify", {
  method: "POST",
  headers: { Authorization: `Bearer ${window.__MAUSBOT_NOTCH_AUTH_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ botId, ...body })
});
const say = async (text) => {
  await press("#tap-to-type-btn");
  $("#type-input").value = text;
  $("#type-form").requestSubmit();
};
const caption = () => ($("#bot-status-caption").hidden ? "" : $("#bot-status-caption").textContent);
const collapse = async () => { native({ action: "escape" }); await until(() => $("#notch-pouch").dataset.expanded === "false", "collapses"); };
const shot = (name) => webkit.messageHandlers.snapshot.postMessage(name);

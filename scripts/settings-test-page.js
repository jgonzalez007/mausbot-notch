// Runs inside the Settings page (see ui-host.swift), like ui-test-page.js does in the notch.
const tab = async (name) => { await press(`[data-tab=${name}]`); await until(() => visible($(`[data-panel=${name}]`)) || !$(`[data-panel=${name}]`).hidden, `${name} shows`); };
const message = (form) => $(`${form} .message`).textContent;
const set = (form, name, value) => {
  const field = $(form).elements[name];
  field.value = value;
  field.dispatchEvent(new Event("change", { bubbles: true }));
};
const itemNamed = (list, name) => [...$(list).children].find((b) => b.querySelector(".title").textContent === name);
const titles = (list) => [...$(list).children].map((b) => b.querySelector(".title").textContent).join();
const pressKeys = (code, held = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true, ...held }));
const settingsNow = () => fetch("/api/settings", { headers: { Authorization: `Bearer ${window.__MAUSBOT_NOTCH_AUTH_TOKEN}` } }).then((r) => r.json());

// --- Bots ---
await until(() => titles("#bot-list") === "Ann,Ben", "the bots are listed");
check(!document.documentElement.outerHTML.includes('"ka"') && !JSON.stringify(await settingsNow()).includes('"ka"'), "keys stay out of the page");
await shot("8-settings-bots");
await press(itemNamed("#bot-list", "Ann"), "Ann");
check($("#bot-form").elements.key.value === "" && $("#bot-form").elements.id.readOnly, "a saved key isn't shown and the id is fixed");
await press("#bot-test");
await until(() => message("#bot-form") === "The key works.", "a saved key can be tested");
set("#bot-form", "key", "wrong");
await press("#bot-test");
await until(() => message("#bot-form").startsWith("The key is wrong"), "a wrong key says so");
await shot("9-settings-wrong-key");
set("#bot-form", "key", "");
set("#bot-form", "baseUrl", "https://elsewhere.example");
await press("#bot-test");
await until(() => message("#bot-form").startsWith("The address changed"), "a saved key isn't sent to another address");
await press("#bot-cancel");
check($("#bot-form").hidden, "Cancel closes the form");
ok("editing and testing a bot");

await press("#bot-add");
const base = (await settingsNow()).bots[0].baseUrl;
const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
paste.clipboardData.setData("text/plain", `curl -X POST '${base}/hooks/api/bots/c-1' -H 'Authorization: Bearer kc' -d '{"message":"hi"}'`);
$("#bot-form").elements.id.dispatchEvent(paste);
check($("#bot-form").elements.id.value === "c-1" && $("#bot-form").elements.key.value === "kc" && $("#bot-form").elements.baseUrl.value === base, "a pasted command fills the form");
set("#bot-form", "name", "Cat <img src=x onerror=__errors.push(1)>");
set("#bot-form", "color", "yellow");
await press("#bot-test");
await until(() => message("#bot-form") === "The key works.", "a new key can be tested before saving");
await press("#bot-save");
await until(() => $("#bot-form").hidden && titles("#bot-list").startsWith("Ann,Ben,Cat"), "the bot is added");
check(!$("#bot-list img"), "names are never treated as HTML");
check($("#bot-form").elements.key.value === "", "a typed key doesn't stay in the page");
ok("adding a bot from its pasted command");

// --- Presets ---
await tab("presets");
await press("#preset-add");
set("#preset-form", "name", "For Cat");
set("#preset-form", "instruction", "Make it feline.");
set("#preset-form", "botId", "c-1");
await press("#preset-save");
await until(() => titles("#preset-list").endsWith("For Cat"), "the preset is added");
await press(itemNamed("#preset-list", "For Cat"), "For Cat");
check($("#preset-form").elements.instruction.value === "Make it feline." && $("#preset-form").elements.botId.value === "c-1", "the preset is there to change");
set("#preset-form", "name", "");
await press("#preset-save");
await until(() => message("#preset-form") === "The name is missing.", "a preset needs a name");
await press("#preset-cancel");
await press(itemNamed("#preset-list", "Only Ben's"), "Only Ben's");
await shot("10-settings-preset");
await press("#preset-remove");
check($("#preset-remove").textContent === "Really remove?" && titles("#preset-list").includes("Only Ben's"), "removing asks first");
await press("#preset-remove");
await until(() => !titles("#preset-list").includes("Only Ben's") && $("#preset-form").hidden, "the preset is gone");
await tab("bots");
await press([...$("#bot-list").children][2], "Cat");
await press("#bot-remove");
check($("#bot-remove").textContent === "Remove with 1 preset?", "removing a bot names what goes with it");
await press("#bot-remove");
await until(() => titles("#bot-list") === "Ann,Ben", "the bot is gone");
await tab("presets");
check(!titles("#preset-list").includes("For Cat"), "and so is its preset");
ok("adding, changing and removing presets, and removing a bot");

// --- Model ---
await tab("model");
check($("#model-form").elements.kind.value === "openai" && $("#model-form").elements.model.value === "m", "the current model shows");
await press("#model-list");
await until(() => $("#model-choices").children.length === 2, "chat models are listed, embedding ones aren't");
await press($("#model-choices").children[1], "m2");
check($("#model-form").elements.model.value === "m2", "a listed model can be picked");
await press("#model-test");
await until(() => /^m2 answered in/.test(message("#model-form")), "the model can be tested before saving");
await shot("11-settings-model");
await press("#model-save");
await until(() => message("#model-form") === "Saved.", "the model is saved");
check((await settingsNow()).model.model === "m2", "and is the one used");
set("#model-form", "url", "http://192.168.1.5:8000/v1");
await press("#model-save");
await until(() => message("#model-form").startsWith("Use a model server on this Mac"), "a model elsewhere is refused");
set("#model-form", "kind", "ollama");
check($("#model-form").elements.url.value === "http://127.0.0.1:11434" && $("#model-form").elements.model.value === "", "the other kind starts from its usual address");
ok("picking, testing and saving the model");

// --- General ---
await tab("general");
check($("#hotkey-label").textContent === "⌥Space", "the shortcut shows");
const lastNative = () => window.__native.at(-1);
await press("#hotkey-record");
await until(() => lastNative()?.type === "beginRecording" && $("#hotkey-label").textContent === "Press keys…", "recording lets go of the old shortcut");
pressKeys("ControlLeft", { ctrlKey: true });
pressKeys("KeyN", { ctrlKey: true, altKey: true });
await until(() => lastNative().type === "setHotkey" && $("#hotkey-label").textContent === "⌃⌥N", "the new shortcut is used and shown");
check(lastNative().hotkey === "Control+Option+N" && (await settingsNow()).preferences.hotkey === "Control+Option+N", "and saved");
await press("#hotkey-record");
await until(() => $("#hotkey-label").textContent === "Press keys…", "records again");
pressKeys("KeyC", { metaKey: true });
await until(() => $("#general-message").textContent.startsWith("Use ⌃ or ⌥"), "⌘C is refused");
check($("#hotkey-label").textContent === "⌃⌥N" && lastNative().type === "endRecording", "and the old shortcut is back");
window.__nativeAnswer = { ok: false, error: "macOS already uses F5." };
await press("#hotkey-reset");
await until(() => $("#general-message").textContent === "macOS already uses F5.", "a clash with macOS says so");
check($("#hotkey-label").textContent === "⌃⌥N" && (await settingsNow()).preferences.hotkey === "Control+Option+N", "and isn't saved");
window.__nativeAnswer = { ok: true };
await press("#hotkey-record");
await until(() => $("#hotkey-label").textContent === "Press keys…", "records once more");
pressKeys("Escape");
await until(() => lastNative().type === "endRecording" && $("#hotkey-label").textContent === "⌃⌥N", "Esc cancels");
await press("#hotkey-reset");
await until(() => $("#hotkey-label").textContent === "⌥Space", "Reset goes back to ⌥Space");
await shot("12-settings-general");
for (const [box, name, value] of [["#double-command", "doubleCommand", false], ["#open-on-reply", "openOnReply", true]]) {
  $(box).click();
  await until(() => $("#general-message").textContent === "Saved." && $(box).checked === value, `${name} is saved`);
  for (let i = 0; (await settingsNow()).preferences[name] !== value; i++) { check(i < 20, `${name} is stored`); await sleep(50); }
  $(box).click();
  await until(() => $(box).checked !== value, `${name} goes back`);
}
await until(() => window.__native.filter((m) => m.type === "setDoubleCommand").map((m) => m.on).join() === "false,true", "the app is told about double-⌘");
ok("shortcut, double-⌘ and opening on replies");

// --- Nothing missed ---
const missed = [...document.querySelectorAll("button")].map(buttonName).filter((b) => !pressed.has(b));
check(missed.length === 0, `buttons this test never pressed: ${missed.join(", ")}`);
check(window.__errors.length === 0, "the page reported errors");
ok(`every Settings button was pressed (${pressed.size}) and the page reported no errors`);
return log.join("\n");

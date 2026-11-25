// The app and the bridge each check shortcuts; a difference would save one that never works.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { HOTKEY } from "../settings.mjs";

const keys = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "Space", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon",
  "Quote", "Comma", "Period", "Slash", "Backquote", ...Array.from({ length: 22 }, (_, i) => `F${i}`), "Nope", "", "Escape", "a"
];
const modifiers = ["", "Control+", "Option+", "Shift+", "Command+", "Shift+Command+", "Option+Shift+", "Control+Option+Shift+Command+", "Command+Option+", "Option+Option+"];
const all = keys.flatMap((key) => modifiers.map((m) => m + key));
const app = execFileSync(process.argv[2], all, { encoding: "utf8" }).trim().split("\n");
assert.equal(app.length, all.length);
for (const [i, hotkey] of all.entries()) assert.equal(app[i], HOTKEY.test(hotkey) ? "accepted" : "refused", hotkey);
console.log(`ok   - the app and the bridge agree on ${all.length} shortcuts`);

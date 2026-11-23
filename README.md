# MausBot Notch

[![Platform: macOS 13+](https://img.shields.io/badge/platform-macOS%2013%2B-black?logo=apple)](https://github.com/jgonzalez007/mausbot-notch)
[![Node.js: 18+](https://img.shields.io/badge/node-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-violet.svg)](LICENSE)

This project reuses the native notch panel architecture (NSPanel + WKWebView + a
global ⌥Space hotkey) from [robzilla1738/grokbot-notch](https://github.com/robzilla1738/grokbot-notch)
(MIT license), with the Grok/xAI-specific bridge, realtime voice mode and
character rendering removed and replaced with a small bridge that talks to
OpenMausBot's [Bot API](https://github.com/milind-soni/OpenMausBot/blob/main/docs/bot-api.md).

**Running [OpenMausBot](https://github.com/milind-soni/OpenMausBot)?** This is
your notch: one `Option+Space` and your bots live in the notch — cycle them
with `←` / `→`, tap to type, and replies that land while the notch is closed
pop it open. Zero npm dependencies; the only runtime is Node.js built-ins.

---

## ⚡ Setup

```bash
git clone https://github.com/jgonzalez007/mausbot-notch.git ~/mausbot-notch
cd ~/mausbot-notch
./scripts/setup.sh
```

**No compiler? Install a release instead** (downloads the latest universal
Apple Silicon + Intel DMG, installs to `/Applications`, clears the quarantine
flag and launches — no clone or Xcode Command Line Tools needed):

```bash
curl -fsSL https://raw.githubusercontent.com/jgonzalez007/mausbot-notch/main/install.sh | bash
```

To also install `MausBot Notch.app` into `/Applications`:

```bash
./scripts/setup.sh --install
```

`./scripts/setup.sh` creates an empty bots config the first time it runs (see
**Configuring bots** below) and then builds and launches the app. Relaunch
with `./scripts/launch.sh` after editing the config.

> **Requirements:** macOS 13+, Node.js 18+, Xcode Command Line Tools (`swiftc`).
> No npm or other package manager needed — `server.mjs` uses only Node built-ins.

---

## 1. Enable the Bot API for a bot

In OpenMausBot, open the bot you want to reach from the notch → **Settings**
(the gear) → **Advanced: Access** → **Bot API** → turn on **Let apps talk to
this bot**. The settings card shows a key — copy it now, it is only shown
once.

Two kinds of key:

- **A normal key (default, recommended to start with).** Every message sent
  through it runs **confined**, in **Ask**, with none of the bot's saved
  tools, connected apps, shell, browser or computer access — it can only
  answer from the bot's standing instructions, memory and the thread itself.
  This is the safe way to try MausBot Notch.
- **A key marked "Acts as me"** (set by the bot's owner on the same card).
  Messages sent through it run **unconfined**, at the bot's own access level,
  as if the owner had typed them — including any tools, connected apps or
  computer access that level allows. Treat a marked key like your own
  password: anyone who has it can make the bot do anything its level allows.

Start with a normal key. Only mark a key "Acts as me" once you understand
that trade-off.

## 2. Configure the bots MausBot Notch can reach

MausBot Notch reads its bot list from:

```
~/Library/Application Support/MausBot Notch/config.json
```

```json
{
  "notifyToken": "",
  "pollIntervalSec": 20,
  "bots": [
    {
      "name": "MausBot",
      "id": "<the bot's id, shown on the same Bot API card>",
      "key": "<the Bot API key from step 1>",
      "baseUrl": "https://your-instance.example.com",
      "color": "cyan"
    }
  ]
}
```

- `notifyToken` (optional): a stable 32+ character string that survives
  relaunches. Lets a same-host OpenMausBot instance (or a hook script) push
  events to `POST http://127.0.0.1:4799/api/notify`. Empty = disabled. It only
  unlocks `/api/notify` — never the bootstrap or message routes.
- `pollIntervalSec` (optional, 10–300, default 20): how often the bridge
  re-checks each pending bot thread, so a reply that lands while the notch is
  closed still pops it open. Respects the Bot API's 10 calls/min rate limit.
- `baseUrl` is wherever this server's webhooks are reachable — a Cloud's
  public address, or your self-hosted domain. The Bot API lives under that
  same host's `/hooks/api/bots/<id>/messages` path.
- Add one object per bot; the notch cycles through all of them with `←` / `→`
  or from the menu-bar icon.
- `color` is optional and matches the bot's own color in OpenMausBot (the
  `color` field in that bot's profile — e.g. `cyan`, `orange`, `pink`,
  `green`, `chrome`, `blue`, `purple`, `red`, `yellow`): the notch's mark and
  accents switch to it when that bot is selected. Left out, it falls back to
  the default blue.
- A bot whose model doesn't support the Bot API (OpenMausBot shows "This
  bot's AI can't take Bot API calls" on its Bot API toggle) can't be added
  here until you switch that bot to a model that does.
- The file is created mode `0600`, readable only by your account, because it
  holds Bot API keys.

Relaunch with `./scripts/launch.sh` after editing it.

---

## ⌨️ Keyboard Shortcuts & Controls

| Action | Shortcut / Gesture |
| :--- | :--- |
| **Expand / Collapse Notch** | **`⌥Space`** *(Option + Space)* or click the collapsed notch |
| **Previous / Next bot** | **`←` / `→`** *(when expanded)* or click **`<` / `>`** |
| **Type a message** | Tap the center dots *(or start typing any letter when expanded)* → **`Enter`** to send |
| **Cancel typing / Close** | **`Esc`** or click outside the notch pouch |

The menu-bar icon (✦ / ⏳) also lets you pick a bot, quit, and toggle
**Launch at Login** (an `SMAppService` login item, so the notch comes back on
boot). Registration works best with the app in a stable location — install to
`/Applications` (release or `setup.sh --install`) rather than a throwaway
build directory.

---

## 🏗️ Architecture

```text
mausbot-notch/
├── macos/
│   ├── NotchApp.swift        # Native NSPanel + WKWebView hit-testing + Carbon global ⌥Space hotkey
│   ├── Info.plist            # LSUIElement bundle metadata
│   └── entitlements.plist    # Network client/server entitlements
├── public/
│   ├── index.html            # Collapsed chin bar + expanded notch pouch
│   ├── styles.css            # Black hardware-notch geometry and spring transitions
│   └── app.js                # Notch state machine, bot cycling, tap-to-type chat
├── server.mjs                # Local Node.js bridge to the OpenMausBot Bot API (+ SSE, /api/notify, background poller)
├── config.example.json       # Template copied to the real bots config on first setup
├── install.sh                # Release installer: download DMG → /Applications → launch
├── .github/workflows/        # ci.yml (build + smoke test), release.yml (tag → universal DMG release)
└── scripts/
    ├── setup.sh               # Prerequisite check, config template, build & launch
    ├── build-mac-app.sh        # Compiles the Swift binary & signs MausBot Notch.app
    ├── make-release.sh         # Universal (arm64 + x86_64) build + DMG + sha256
    ├── smoke-test.sh           # Boots the bridge in a throwaway HOME; asserts auth, Host/Origin, SSE
    └── launch.sh               # Starts the local bridge server & opens MausBot Notch.app
```

### How a message flows

1. You type in the notch and press **Enter** → `public/app.js` calls
   `POST /api/bot/<id>/message` on the local bridge.
2. `server.mjs` calls OpenMausBot's Bot API:
   `POST {baseUrl}/hooks/api/bots/<id>/messages` with
   `Authorization: Bearer <key>` and `{"message": "...", "thread": "...", "wait": 50}`.
3. A `200` reply is shown immediately. A `202` (`status: "working"` or
   `"needs_approval"`) means the bot is still working or waiting on you in the
   app itself; the notch polls `GET /api/bot/<id>/transcript` every two
   seconds, which re-checks `GET {baseUrl}/hooks/api/bots/<id>/messages?thread=<id>`
   until a reply lands.
4. Replies and errors are kept, per bot, in
   `~/Library/Application Support/MausBot Notch/state.json` (the last 20
   messages), so switching bots and reopening the notch shows the latest
   status again.

### Inbound notifications (bot → notch)

The Bot API is outbound-only, so "inbound" is built in three layers:

1. **Server-side poller.** While a conversation is `pending` (the bot is
   still working, or waiting on an approval in the app), the bridge keeps
   polling the thread every `pollIntervalSec` seconds — even when the notch
   is closed or the app was relaunched. When a reply lands, it is stored in
   `state.json` and pushed to the open UI over server-sent events
   (`GET /api/events`), which pops the notch and refreshes the caption.
   Polling respects the Bot API's 10 calls/min per key (60 s cooldown,
   5 min backoff on `429`) and gives up on a thread after 30 minutes.
2. **`POST /api/notify`.** A loopback endpoint for same-host pushes. Point a
   same-host OpenMausBot instance (or a hook script) at
   `http://127.0.0.1:4799/api/notify` with the stable `notifyToken` from
   `config.json` and body `{"botId": "…", "text": "…"}` or
   `{"botId": "…", "status": "working|needs_approval"}`. This is the forward
   hook: the day the Bot API gains a push channel, wire it here and the notch
   pops with zero app changes.
3. **UI event stream.** The notch subscribes to `/api/events` on load
   (`EventSource`; the launch token travels as a query parameter, since
   `EventSource` cannot send headers) and handles `reply`, `status` and
   `timeout` events per bot.

Note: a *hosted* OpenMausBot Cloud cannot reach your loopback bridge; layer 2
only works for same-host/self-hosted setups. Fully proactive pings (the bot
choosing to interrupt you) await a push channel upstream.

---

## 🔒 Local bridge security

The Node bridge binds to **127.0.0.1 only** and rejects requests whose `Host`
is not `127.0.0.1:4799` / `localhost:4799` or whose `Origin` (when present) is
not the matching loopback URL. This blocks DNS rebinding and cross-site
browser access.

Each server launch gets a random **32-byte auth token** (also writable via
`MAUSBOT_NOTCH_AUTH_TOKEN` when the Swift app spawns the process). The token
is stored at:

`~/Library/Application Support/MausBot Notch/launch-auth-token` (mode `0600`)

All `/api/*` routes require `Authorization: Bearer <token>` (or
`X-MausBot-Notch-Token`). The notch web UI receives the token via injected
HTML / a Swift `WKUserScript`; `public/app.js` sends it on every API call.
Query-parameter tokens are only accepted on `/api/events` and `/api/notify`.
The optional stable `notifyToken` from `config.json` only unlocks
`/api/notify`, never the bootstrap or message routes.

Bot API keys live only in `config.json` (mode `0600`) and are never logged or
echoed back to the web UI.

Manual health check:

```bash
TOKEN="$(cat "$HOME/Library/Application Support/MausBot Notch/launch-auth-token")"
curl -s -H "Authorization: Bearer $TOKEN" -H "Host: 127.0.0.1:4799" \
  http://127.0.0.1:4799/api/bootstrap | head -c 400
```

Server logs go to `~/Library/Logs/mausbot-notch/server.log`
(directory `0700`, log file `0600`).

---

## 🔧 Requirements

- **macOS 13.0+** (Apple Silicon or Intel)
- **Node.js 18+** — no npm, no package installation needed
- **Xcode Command Line Tools** (`swiftc`)
- A bot with the **Bot API** turned on (see step 1 above)

---

## 📦 Releases

Push a semver tag — the release workflow builds a universal (Apple Silicon +
Intel) ad-hoc-signed DMG and attaches it to a GitHub Release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Ad-hoc signed builds show a Gatekeeper warning on first direct launch;
`install.sh` clears the quarantine flag for you.

## 📄 License

[MIT](LICENSE) — architecture derived from
[robzilla1738/grokbot-notch](https://github.com/robzilla1738/grokbot-notch)
(MIT), with its Grok/xAI bridge, realtime voice mode and character rendering
replaced by a MausBot Bot API bridge.

#!/usr/bin/env bash
# Smoke test: boots server.mjs against a throwaway HOME and asserts the
# security and inbound-event behavior. No network calls to a real bot —
# the config points at a dead local port and pollIntervalSec is large.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# The app's own bridge listens on 4799 when it is running, so pick a free port unless told.
if [ -z "${PORT:-}" ]; then
  PORT="$(for p in 4791 4792 4793 4794 4795; do lsof -nP -iTCP:"$p" -sTCP:LISTEN > /dev/null 2>&1 || { echo "$p"; break; }; done)"
fi
PORT="${PORT:-4791}"
BASE="http://127.0.0.1:$PORT"
TEST_HOME="$(mktemp -d)"
SERVER_PID=""
NOTIFY_TOKEN="smoke-test-notify-token-0123456789abcdef"

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TEST_HOME"
}
trap cleanup EXIT

SUPPORT_DIR="$TEST_HOME/Library/Application Support/MausBot Notch"
mkdir -p "$SUPPORT_DIR"
cat > "$SUPPORT_DIR/config.json" <<EOF
{
  "notifyToken": "$NOTIFY_TOKEN",
  "pollIntervalSec": 300,
  "bots": [
    { "name": "SmokeBot", "id": "bot-smoke", "key": "unused", "baseUrl": "http://127.0.0.1:9", "color": "cyan" }
  ]
}
EOF
chmod 600 "$SUPPORT_DIR/config.json"

HOME="$TEST_HOME" PORT="$PORT" node "$ROOT_DIR/server.mjs" > "$TEST_HOME/server.out" 2>&1 &
SERVER_PID=$!

# Wait for the launch token file (the server writes it before listen()).
TOKEN=""
for _ in $(seq 1 100); do
  if [ -s "$SUPPORT_DIR/launch-auth-token" ]; then
    TOKEN="$(cat "$SUPPORT_DIR/launch-auth-token")"
    break
  fi
  sleep 0.1
done
if [ -z "$TOKEN" ]; then
  echo "FAIL - server did not start (no launch token):"
  cat "$TEST_HOME/server.out"
  exit 1
fi

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

assert() { # assert <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1 (expected $2, got $3)"
    exit 1
  fi
}

# 1. Auth on /api routes
assert "bootstrap with launch token"        200 "$(code -H "Authorization: Bearer $TOKEN" "$BASE/api/bootstrap")"
assert "bootstrap without token"            401 "$(code "$BASE/api/bootstrap")"
assert "bootstrap with notify token denied" 401 "$(code -H "Authorization: Bearer $NOTIFY_TOKEN" "$BASE/api/bootstrap")"

# 2. Host/Origin validation (DNS-rebinding guard)
assert "bootstrap with spoofed Host"        403 "$(code -H "Host: evil.example" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/bootstrap")"
assert "bootstrap with spoofed Origin"      403 "$(code -H "Origin: http://evil.example" -H "Authorization: Bearer $TOKEN" "$BASE/api/bootstrap")"

# 3. /api/notify — accepts the notify token, rejects others
assert "notify with notify token"           200 "$(code -X POST -H "Authorization: Bearer $NOTIFY_TOKEN" -H 'Content-Type: application/json' -d '{"botId":"bot-smoke","text":"hello from smoke"}' "$BASE/api/notify")"
assert "notify with launch token"           200 "$(code -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"botId":"bot-smoke","status":"needs_approval"}' "$BASE/api/notify")"
assert "notify with bad token"              401 "$(code -X POST -H "Authorization: Bearer wrongwrongwrongwrongwrongwrongwrongw" -H 'Content-Type: application/json' -d '{"botId":"bot-smoke","text":"nope"}' "$BASE/api/notify")"
assert "notify for unknown bot"             404 "$(code -X POST -H "Authorization: Bearer $NOTIFY_TOKEN" -H 'Content-Type: application/json' -d '{"botId":"bot-nope","text":"nope"}' "$BASE/api/notify")"
assert "notify with empty body"             400 "$(code -X POST -H "Authorization: Bearer $NOTIFY_TOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/api/notify")"

# 4. SSE stream delivers events (token via query param)
SSE_OUT="$TEST_HOME/sse.out"
curl -sN -m 5 -H "Authorization: Bearer $TOKEN" "$BASE/api/events" > "$SSE_OUT" 2>/dev/null &
SSE_PID=$!
sleep 0.5
assert "SSE without token"                  401 "$(code "$BASE/api/events")"
curl -s -X POST -H "Authorization: Bearer $NOTIFY_TOKEN" -H 'Content-Type: application/json' -d '{"botId":"bot-smoke","status":"working"}' "$BASE/api/notify" > /dev/null
sleep 0.5
kill "$SSE_PID" 2>/dev/null || true
if grep -q '"type":"hello"' "$SSE_OUT"; then echo "ok   - SSE hello on connect"; else echo "FAIL - SSE hello missing"; cat "$SSE_OUT"; exit 1; fi
if grep -q '"type":"status"' "$SSE_OUT"; then echo "ok   - SSE delivered status event"; else echo "FAIL - SSE event not delivered"; cat "$SSE_OUT"; exit 1; fi

# 5. State persisted with the notify'd message
if grep -q '"hello from smoke"' "$SUPPORT_DIR/state.json"; then echo "ok   - state.json holds notify'd message"; else echo "FAIL - state.json missing message"; cat "$SUPPORT_DIR/state.json"; exit 1; fi
if grep -q '"pending": true' "$SUPPORT_DIR/state.json"; then echo "ok   - state.json holds pending status"; else echo "FAIL - state.json missing pending"; cat "$SUPPORT_DIR/state.json"; exit 1; fi

echo ""
echo "ALL SMOKE TESTS PASSED"

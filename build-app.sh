#!/usr/bin/env bash
# Build Lantern.app — a double-clickable macOS bundle wrapping the Python server.
#
#   ./build-app.sh                 -> ./dist/Lantern.app
#   ./build-app.sh /Applications   -> installs straight to /Applications
#
# Needs nothing but the macOS command line tools (iconutil, sips) and python3.
set -euo pipefail
cd "$(dirname "$0")"

DEST="${1:-dist}"
APP="$DEST/Lantern.app"
# server.py owns the version; read it rather than keeping a second copy that can
# drift from what the app actually reports.
VERSION="$(sed -n 's/^VERSION = "\(.*\)"$/\1/p' server.py | head -1)"
[ -n "$VERSION" ] || { echo "Cannot read VERSION from server.py" >&2; exit 1; }

echo "==> Building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

# ── payload ────────────────────────────────────────────────────────────────
cp server.py "$APP/Contents/Resources/app/"
cp -R static "$APP/Contents/Resources/app/"
find "$APP/Contents/Resources/app" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

# ── icon ───────────────────────────────────────────────────────────────────
echo "==> Rendering icon"
ICONSET="$(mktemp -d)/Lantern.iconset"
mkdir -p "$ICONSET"
python3 tools/make_icon.py "$ICONSET/base.png" 1024 >/dev/null
for pair in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" \
            "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" \
            "512 512x512" "1024 512x512@2x"; do
  set -- $pair
  sips -z "$1" "$1" "$ICONSET/base.png" --out "$ICONSET/icon_$2.png" >/dev/null 2>&1
done
rm "$ICONSET/base.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Lantern.icns"
rm -rf "$(dirname "$ICONSET")"

# ── native host, if Swift is available ─────────────────────────────────────
# Preferred: a real NSWindow + WKWebView, no browser involved.
# Fallback: a shell launcher that opens a Chromium browser in --app mode.
NATIVE=0
if command -v swiftc >/dev/null 2>&1; then
  echo "==> Compiling native host (swiftc)"
  if swiftc -O native/main.swift -o "$APP/Contents/MacOS/Lantern" \
       -framework Cocoa -framework WebKit 2>&1 | sed 's/^/    /'; then
    NATIVE=1
  fi
  [ -x "$APP/Contents/MacOS/Lantern" ] && NATIVE=1
fi
if [ "$NATIVE" = "1" ]; then
  echo "==> Native window host built ($(du -h "$APP/Contents/MacOS/Lantern" | cut -f1))"
else
  echo "==> swiftc unavailable — falling back to browser launcher"
fi

# ── Info.plist ─────────────────────────────────────────────────────────────
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>Lantern</string>
  <key>CFBundleDisplayName</key>       <string>Lantern</string>
  <key>CFBundleExecutable</key>        <string>Lantern</string>
  <key>CFBundleIdentifier</key>        <string>local.lantern.app</string>
  <key>CFBundleIconFile</key>          <string>Lantern</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key>           <string>$VERSION</string>
  <key>LSMinimumSystemVersion</key>    <string>11.0</string>
  <key>NSHighResolutionCapable</key>   <true/>
  <key>LSApplicationCategoryType</key> <string>public.app-category.productivity</string>
  <key>NSSupportsAutomaticTermination</key> <false/>
  <key>NSSupportsSuddenTermination</key>    <false/>
  <!-- WKWebView refuses plain http by default; this permits localhost only -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key> <true/>
  </dict>
</dict>
</plist>
PLIST

# ── fallback launcher (only when there is no native host) ──────────────────
if [ "$NATIVE" != "1" ]; then
cat > "$APP/Contents/MacOS/Lantern" <<'LAUNCH'
#!/bin/bash
# Lantern launcher: ensure Ollama is up, start the server, open a clean window.
# Runs the server in the foreground so quitting from the Dock stops it.

RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
APPDIR="$RES/app"
DATA="$HOME/Library/Application Support/Lantern"
LOG="$DATA/lantern.log"
mkdir -p "$DATA"
export LANTERN_DATA="$DATA"

exec >>"$LOG" 2>&1
echo "--- launch $(date) ---"

note() {                      # surface a failure to the user, we have no UI yet
  osascript -e "display alert \"Lantern\" message \"$1\"" >/dev/null 2>&1 || true
}

# 1. python: prefer a modern one, fall back to the macOS system python
PY=""
for cand in \
  /opt/homebrew/bin/python3 \
  /usr/local/bin/python3 \
  /Library/Frameworks/Python.framework/Versions/3.14/bin/python3 \
  /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
  /usr/bin/python3
do
  [ -x "$cand" ] && PY="$cand" && break
done
if [ -z "$PY" ]; then
  note "No python3 found. Install the Xcode command line tools: xcode-select --install"
  exit 1
fi
echo "python: $PY ($("$PY" --version 2>&1))"

OLLAMA_URL="${OLLAMA_HOST:-http://127.0.0.1:11434}"
alive() { curl -sf --max-time 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; }
lantern_on() { curl -sf --max-time 2 "http://127.0.0.1:$1/api/ping" 2>/dev/null | grep -q '"lantern"'; }

# 2. already running? just re-open the window
PORT=""
if [ -f "$DATA/.port" ] && lantern_on "$(cat "$DATA/.port")"; then
  PORT="$(cat "$DATA/.port")"
  echo "reusing running instance on $PORT"
else
  # 3. make sure Ollama is listening when it is the selected backend
  BACKEND="$("$PY" -c 'import json,sys; p=sys.argv[1]; print(json.load(open(p)).get("backend","ollama"))' "$DATA/settings.json" 2>/dev/null || echo ollama)"
  if [ "$BACKEND" != "openai" ] && ! alive; then
    echo "starting Ollama"
    if [ -d /Applications/Ollama.app ]; then
      open -g -a Ollama || true
    elif command -v ollama >/dev/null 2>&1; then
      nohup ollama serve >/dev/null 2>&1 &
    fi
    for _ in $(seq 1 30); do alive && break; sleep 0.4; done
  fi
  if [ "$BACKEND" != "openai" ]; then
    alive || echo "warning: Ollama still unreachable; Lantern will show a banner"
  fi

  # 4. first free port from 8777
  for p in $(seq 8777 8797); do
    if ! nc -z 127.0.0.1 "$p" >/dev/null 2>&1; then PORT="$p"; break; fi
  done
  if [ -z "$PORT" ]; then note "No free port in 8777-8797."; exit 1; fi

  echo "starting server on $PORT"
  "$PY" "$APPDIR/server.py" --host 127.0.0.1 --port "$PORT" &
  SERVER=$!
  for _ in $(seq 1 40); do lantern_on "$PORT" && break; sleep 0.25; done
  if ! lantern_on "$PORT"; then
    note "Lantern's server failed to start. See $LOG"
    exit 1
  fi
  echo "$PORT" > "$DATA/.port"
fi

URL="http://127.0.0.1:$PORT"

# 5. open a chrome-less window if a Chromium browser is available, so it looks
#    like an app rather than a tab. Dedicated profile keeps localStorage ours.
BROWSER=""
for b in "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium"
do
  [ -x "$b" ] && BROWSER="$b" && break
done

if [ -n "$BROWSER" ]; then
  echo "window: $BROWSER"
  "$BROWSER" --app="$URL" \
    --user-data-dir="$DATA/browser" \
    --no-first-run --no-default-browser-check \
    --class=Lantern >/dev/null 2>&1 &
else
  echo "window: default browser"
  open "$URL"
fi

# 6. if we started the server, stay in the foreground so Dock quit stops it
if [ -n "${SERVER:-}" ]; then
  trap 'kill $SERVER 2>/dev/null; rm -f "$DATA/.port"; exit 0' TERM INT
  wait $SERVER
  rm -f "$DATA/.port"
fi
LAUNCH
fi

chmod +x "$APP/Contents/MacOS/Lantern"

# ── seed data from the dev folder, first run only ───────────────────────────
# Must not create the folder when a pre-rename "Slate" folder is still present:
# doing so shadows the app's own migration and orphans the real history.
SEED="$HOME/Library/Application Support/Lantern"
LEGACY="$HOME/Library/Application Support/Slate"
if [ -d data ] && [ ! -d "$SEED" ] && [ ! -d "$LEGACY" ]; then
  echo "==> Seeding $SEED from ./data"
  mkdir -p "$SEED"
  cp -R data/. "$SEED/" 2>/dev/null || true
elif [ -d "$LEGACY" ]; then
  echo "==> Legacy data present; leaving migration to the app"
fi

# ── ad-hoc sign so Gatekeeper and the firewall stop asking ──────────────────
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 \
    && echo "==> Ad-hoc signed" || echo "==> Signing skipped"
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo
echo "Built: $APP  ($(du -sh "$APP" | cut -f1))"
if [ "$NATIVE" = "1" ]; then
  echo "  window: native NSWindow + WKWebView (no browser needed)"
else
  echo "  window: Chromium --app mode (swiftc was unavailable)"
fi
echo "  open \"$APP\"            # run it"
echo "  cp -R \"$APP\" /Applications/   # install"

#!/usr/bin/env bash
# Install outpost as a launchd LaunchAgent so it starts at login and
# restarts if it crashes. Run from anywhere; the script resolves paths via $0.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Label is per-user so multiple installs on a shared box don't collide. Override
# with OUTPOST_PLIST_LABEL if you want something specific (e.g. an org prefix).
PLIST_LABEL="${OUTPOST_PLIST_LABEL:-local.outpost.$USER}"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
TEMPLATE_PATH="$PROJECT_ROOT/install/outpost.plist.template"

# Resolve absolute paths to node and tsx. launchd doesn't go through your shell,
# so anything PATH-based will fail unless we hardcode.
NODE_PATH="$(command -v node || true)"
TSX_PATH="$PROJECT_ROOT/node_modules/.bin/tsx"
if [[ ! -x "$NODE_PATH" ]]; then
  echo "node not found on PATH. Install Node.js or set PATH to include it before running this script." >&2
  exit 1
fi
if [[ ! -f "$TSX_PATH" ]]; then
  echo "tsx not found at $TSX_PATH. Run 'npm install' in $PROJECT_ROOT first." >&2
  exit 1
fi

# Build a PATH that launchd-spawned subprocesses (claude, tailscale, etc.) can use.
# Reuse the current shell's PATH and prepend a few well-known locations in case the
# user's interactive shell PATH is itself missing them when this script runs.
PATH_FOR_LAUNCHD="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"

# Propagate any OUTPOST_*-prefixed env vars exported by the caller (e.g.
# OUTPOST_CWD, OUTPOST_SESSION_DIR) into the plist so they survive across
# reinstalls without having to edit the file by hand.
EXTRA_ENV=""
for var in $(env | sed -n 's/^\(OUTPOST_[A-Z_]*\)=.*/\1/p'); do
  val="${!var}"
  # XML-escape the three chars launchd's plist parser actually cares about.
  val="${val//&/&amp;}"
  val="${val//</&lt;}"
  val="${val//>/&gt;}"
  EXTRA_ENV+="    <key>$var</key><string>$val</string>"$'\n'
done
EXTRA_ENV="${EXTRA_ENV%$'\n'}"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Stop any running instance so the new plist takes over cleanly.
launchctl unload "$PLIST_PATH" 2>/dev/null || true
pkill -f "tsx src/daemon.ts" 2>/dev/null || true
sleep 1

# sed with | as delimiter so file paths with / don't have to be escaped.
# awk handles the multiline __EXTRA_ENV__ replacement that sed can't do cleanly.
sed \
  -e "s|__PLIST_LABEL__|$PLIST_LABEL|g" \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__TSX_PATH__|$TSX_PATH|g" \
  -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
  -e "s|__PATH__|$PATH_FOR_LAUNCHD|g" \
  -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE_PATH" | awk -v env="$EXTRA_ENV" '
    /__EXTRA_ENV__/ { if (env != "") print env; next }
    { print }
  ' > "$PLIST_PATH"

launchctl load "$PLIST_PATH"

# Quick health check: wait briefly, then check that the process is alive.
sleep 2
if launchctl list | grep -q "$PLIST_LABEL"; then
  PID=$(launchctl list | awk -v label="$PLIST_LABEL" '$3 == label { print $1 }')
  if [[ "$PID" == "-" || -z "$PID" ]]; then
    echo "Loaded $PLIST_LABEL but no PID — check logs:"
    echo "  tail -50 $HOME/Library/Logs/outpost.err.log"
    exit 1
  fi
  echo "✓ $PLIST_LABEL loaded (pid $PID)"
  echo "  logs:  $HOME/Library/Logs/outpost.{log,err.log}"
  echo "  stop:  launchctl unload $PLIST_PATH"
  echo "  start: launchctl load $PLIST_PATH"
else
  echo "Failed to load $PLIST_LABEL"
  exit 1
fi

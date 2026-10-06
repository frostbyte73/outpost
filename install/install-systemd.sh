#!/usr/bin/env bash
# Install outpost as a systemd user service (Linux / WSL2) so it starts at boot and
# restarts if it crashes. Run from anywhere; the script resolves paths via $0.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_NAME="${OUTPOST_UNIT_NAME:-outpost}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME.service"
TEMPLATE_PATH="$PROJECT_ROOT/install/outpost.service.template"

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemd user manager not reachable." >&2
  if grep -qi microsoft /proc/version 2>/dev/null; then
    echo "On WSL, add this to /etc/wsl.conf, then run 'wsl.exe --shutdown' from Windows and reopen:" >&2
    echo "  [boot]" >&2
    echo "  systemd=true" >&2
  fi
  exit 1
fi

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
if ! command -v expect >/dev/null; then
  echo "warning: expect(1) not installed — logging in to Claude / MCP servers from the PWA won't work." >&2
  echo "  sudo apt install expect" >&2
fi

# The user manager's PATH is minimal; claude, gh, and nvm-installed node live outside it.
PATH_FOR_SYSTEMD="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

mkdir -p "$UNIT_DIR"
systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
pkill -f "tsx src/daemon.ts" 2>/dev/null || true

sed \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__TSX_PATH__|$TSX_PATH|g" \
  -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
  -e "s|__PATH__|$PATH_FOR_SYSTEMD|g" \
  "$TEMPLATE_PATH" > "$UNIT_PATH"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

# Without lingering the user manager only runs while a login session is open, so the
# daemon would stop with the last terminal rather than run from boot.
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"
fi

sleep 2
if systemctl --user is-active --quiet "$UNIT_NAME"; then
  echo "✓ $UNIT_NAME.service running (pid $(systemctl --user show "$UNIT_NAME" -p MainPID --value))"
  echo "  logs:    journalctl --user -u $UNIT_NAME -f"
  echo "  restart: systemctl --user restart $UNIT_NAME"
  echo "  stop:    systemctl --user stop $UNIT_NAME"
else
  echo "$UNIT_NAME.service failed to start — check logs:"
  echo "  journalctl --user -u $UNIT_NAME -n 50"
  exit 1
fi

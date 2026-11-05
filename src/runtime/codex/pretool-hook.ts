// Codex runs the tool on any hook exit but 0 or 2-with-stderr, so all else exits 2; no single quotes, it sits in `sh -c '…'`.
export const PRETOOL_HOOK_SCRIPT = `DENY="The Outpost permission gate was unreachable, so this call was not run."
if [ -z "\${DAEMON_AUTH:-}" ] || [ -z "\${OUTPOST_HOOK_PORT:-}" ]; then echo "$DENY" >&2; exit 2; fi
out=$(curl -sS -o - -w "\\n%{http_code}" --max-time "\${OUTPOST_HOOK_CURL_TIMEOUT_S:-600}" -H "x-daemon-auth: $DAEMON_AUTH" -H "content-type: application/json" --data-binary @- "http://127.0.0.1:$OUTPOST_HOOK_PORT/hook/codex/pretool" 2>/dev/null)
if [ $? -ne 0 ]; then echo "$DENY" >&2; exit 2; fi
code=\${out##*
}
body=\${out%
*}
if [ "$code" != 200 ]; then echo "$DENY" >&2; exit 2; fi
case "$body" in
  "{\\"decision\\":\\"allow\\"}") exit 0 ;;
  deny:?*) printf "%s\\n" "\${body#deny:}" >&2; exit 2 ;;
esac
echo "$DENY" >&2
exit 2`;

// Inline rather than a script path: Codex's trust hash covers this string, and there is no file that can go missing.
export const PRETOOL_HOOK_COMMAND = `sh -c '${PRETOOL_HOOK_SCRIPT}'`;

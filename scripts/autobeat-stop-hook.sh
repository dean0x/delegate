#!/bin/bash
# Unified Stop hook for Claude Code and Codex

[[ "${AUTOBEAT_WORKER:-}" = "true" ]] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

# SECURITY: Claude Code guarantees stdin pipe closure on every stop-hook
# invocation (synchronous call, always completes), so head will not hang
# in practice. Defense-in-depth: cap at 10 MiB so an unexpectedly large
# payload cannot stall this process indefinitely.
HOOK_DATA=$(head -c 10485760)

# Extract all fields from HOOK_DATA in one jq pass.
# SECURITY: @sh shells-quotes each value so that eval is equivalent to a safe
# assignment. jq @sh produces single-quoted tokens with internal single-quotes
# escaped as '\'' — the output cannot contain bare shell metacharacters.
# The trust boundary is: HOOK_DATA originates from Claude Code / Codex over a
# local pipe; it is not attacker-controlled in normal operation.
# Fields:
#   RESPONSE       — last_assistant_message (Codex path); empty when absent
#   STOP_REASON    — stop_reason, defaulting to "end_turn"
#   USAGE_JSON     — .usage as compact JSON string, or "" when absent
#   TOTAL_COST_USD — .total_cost_usd as raw decimal string, or "" when absent
eval "$(printf '%s' "$HOOK_DATA" | jq -r '
  "RESPONSE=" + (.last_assistant_message // "" | @sh) + "\n" +
  "STOP_REASON=" + (.stop_reason // "end_turn" | @sh) + "\n" +
  "USAGE_JSON=" + (if .usage then (.usage | tojson | @sh) else "'\''" + "'\''" end) + "\n" +
  "TOTAL_COST_USD=" + (if .total_cost_usd then (.total_cost_usd | tostring | @sh) else "'\''" + "'\''" end)
' 2>/dev/null)" 2>/dev/null || true

# Defensive post-eval guard: if jq produced malformed/truncated output (e.g.
# due to OOM or a signal mid-write), one or more variables may be unset.
# Reset all four to safe defaults so the rest of the script never sees an
# unbound variable and cannot execute an unintended fragment.
if [ -z "${STOP_REASON+x}" ]; then
  RESPONSE=''
  STOP_REASON='end_turn'
  USAGE_JSON=''
  TOTAL_COST_USD=''
fi

[ -n "$RESPONSE" ] && RESPONSE_FROM_DIRECT=true || RESPONSE_FROM_DIRECT=false

if [ -z "$RESPONSE" ]; then
  TRANSCRIPT=$(printf '%s' "$HOOK_DATA" | jq -r '.transcript_path // empty' 2>/dev/null)
  # SECURITY: Validate transcript_path is within a trusted directory before
  # reading it.  Accept only paths under well-known Claude Code / Codex / OS-temp
  # prefixes.  Reject anything containing ".." regardless.
  #   /tmp/            — Linux temp dir (Claude Code writes here on Linux CI)
  #   /var/folders/    — macOS temp dir (os.tmpdir() on macOS)
  #   /private/var/    — macOS realpath alias for /var/folders/
  #   $HOME/.claude/   — Claude Code config/transcript directory
  #   $HOME/.codex/    — Codex config/transcript directory
  _transcript_allowed=false
  if [ -n "$TRANSCRIPT" ]; then
    case "$TRANSCRIPT" in
      /tmp/*|/var/folders/*|/private/var/folders/*|"${HOME}/.claude/"*|"${HOME}/.codex/"*)
        _transcript_allowed=true ;;
    esac
    # Belt-and-suspenders: reject any path that still contains a traversal segment.
    case "$TRANSCRIPT" in
      *..*)
        _transcript_allowed=false ;;
    esac
  fi
  if [ "$_transcript_allowed" = "true" ] && [ -f "$TRANSCRIPT" ]; then
    RESPONSE=$(tail -n 50 "$TRANSCRIPT" | \
      jq -s '[.[] | select(.role == "assistant")] | last |
        if .message.content | type == "array"
        then [.message.content[] | select(.type == "text") | .text] | join("")
        else .message.content // ""
        end' 2>/dev/null)
  fi
fi

# Resolve task context once; both the early-exit and main path share these variables.
TMUX_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
CURRENT_TASK_ID=$(tmux show-environment -t "$TMUX_SESSION" AUTOBEAT_TASK_ID 2>/dev/null | cut -d= -f2-)
[ -z "$CURRENT_TASK_ID" ] && CURRENT_TASK_ID="${AUTOBEAT_TASK_ID:-}"

[[ "$CURRENT_TASK_ID" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 0

SESSIONS_DIR="${AUTOBEAT_SESSIONS_DIR:-}"
[ -z "$SESSIONS_DIR" ] && exit 0

[[ "$SESSIONS_DIR" =~ \.\. ]] && exit 0

if [ -z "$RESPONSE" ]; then
  TASK_DIR="$SESSIONS_DIR/$CURRENT_TASK_ID"
  mkdir -p "$TASK_DIR"
  echo "1" > "$TASK_DIR/.exit.tmp"
  mv "$TASK_DIR/.exit.tmp" "$TASK_DIR/.exit"
  exit 0
fi

TASK_DIR="$SESSIONS_DIR/$CURRENT_TASK_ID"
MESSAGES_DIR="$TASK_DIR/messages"
SEQ_FILE="$TASK_DIR/.seq"

mkdir -p "$MESSAGES_DIR"

# NOTE: Sequential invocation model — Claude Code fires Stop hooks synchronously,
# one per turn. Concurrent invocations are not possible under normal operation,
# so this read-increment-write is safe without flock (flock is unavailable on
# macOS without Homebrew).
SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
SEQ=$((SEQ + 1))
echo "$SEQ" > "$SEQ_FILE"
PADDED=$(printf "%05d" "$SEQ")

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%FT%TZ)

# Direct payload responses are raw strings that need JSON-string escaping.
# Transcript fallback responses come from jq join() and are already safe as-is.
# Fall back to empty JSON string if jq -Rs fails (e.g. OOM),
# rather than producing a malformed content field in the message JSON.
if [ "$RESPONSE_FROM_DIRECT" = "true" ]; then
  ESCAPED=$(printf '%s' "$RESPONSE" | jq -Rs . 2>/dev/null)
  if [ -z "$ESCAPED" ]; then
    ESCAPED='""'
  fi
else
  ESCAPED="$RESPONSE"
fi

MSG_FILE="$MESSAGES_DIR/${PADDED}-result.json"
printf '{"sequence":%d,"timestamp":"%s","type":"result","content":%s}\n' \
  "$SEQ" "$TIMESTAMP" "$ESCAPED" > "${MSG_FILE}.tmp"
mv "${MSG_FILE}.tmp" "$MSG_FILE"

# Emit a synthetic stdout message containing the JSON usage blob so UsageParser can
# find {"type":"result",...,"usage":{...}} in the concatenated stdout buffer.
# Only written when usage fields are present (Claude Code path).
# Codex and transcript-fallback paths omit usage gracefully — UsageParser handles ok(null).
if [ -n "$USAGE_JSON" ] && [ -n "$TOTAL_COST_USD" ]; then
  SEQ2=$((SEQ + 1))
  echo "$SEQ2" > "$SEQ_FILE"
  PADDED2=$(printf "%05d" "$SEQ2")

  # Build the JSON result blob that UsageParser searches for.  We use jq to
  # produce a compact, correctly-escaped JSON string from the extracted fields.
  USAGE_CONTENT=$(printf '{"type":"result","usage":%s,"total_cost_usd":%s}' \
    "$USAGE_JSON" "$TOTAL_COST_USD" | jq -Rs .)
  if [ -n "$USAGE_CONTENT" ]; then
    USAGE_MSG_FILE="$MESSAGES_DIR/${PADDED2}-stdout.json"
    printf '{"sequence":%d,"timestamp":"%s","type":"stdout","content":%s}\n' \
      "$SEQ2" "$TIMESTAMP" "$USAGE_CONTENT" > "${USAGE_MSG_FILE}.tmp"
    mv "${USAGE_MSG_FILE}.tmp" "$USAGE_MSG_FILE"
  fi
fi

case "$STOP_REASON" in
  end_turn|stop_sequence|max_tokens)
    echo "0" > "$TASK_DIR/.done.tmp"
    mv "$TASK_DIR/.done.tmp" "$TASK_DIR/.done"
    ;;
  *)
    echo "1" > "$TASK_DIR/.exit.tmp"
    mv "$TASK_DIR/.exit.tmp" "$TASK_DIR/.exit"
    ;;
esac

exit 0

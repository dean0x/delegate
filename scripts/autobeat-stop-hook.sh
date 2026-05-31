#!/bin/bash
# Unified Stop hook for Claude Code and Codex

[[ "${AUTOBEAT_WORKER:-}" = "true" ]] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

HOOK_DATA=$(cat)

RESPONSE=$(printf '%s' "$HOOK_DATA" | jq -r '.last_assistant_message // empty' 2>/dev/null)

if [ -z "$RESPONSE" ]; then
  TRANSCRIPT=$(printf '%s' "$HOOK_DATA" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    RESPONSE=$(tail -n 50 "$TRANSCRIPT" | \
      jq -s '[.[] | select(.role == "assistant")] | last |
        if .message.content | type == "array"
        then [.message.content[] | select(.type == "text") | .text] | join("")
        else .message.content // ""
        end' 2>/dev/null)
  fi
fi

if [ -z "$RESPONSE" ]; then
  TMUX_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
  CURRENT_TASK_ID=$(tmux show-environment -t "$TMUX_SESSION" AUTOBEAT_TASK_ID 2>/dev/null | cut -d= -f2-)
  [ -z "$CURRENT_TASK_ID" ] && CURRENT_TASK_ID="${AUTOBEAT_TASK_ID:-}"
  SESSIONS_DIR="${AUTOBEAT_SESSIONS_DIR:-}"
  if [ -n "$CURRENT_TASK_ID" ] && [ -n "$SESSIONS_DIR" ]; then
    TASK_DIR="$SESSIONS_DIR/$CURRENT_TASK_ID"
    mkdir -p "$TASK_DIR"
    echo "1" > "$TASK_DIR/.exit.tmp"
    mv "$TASK_DIR/.exit.tmp" "$TASK_DIR/.exit"
  fi
  exit 0
fi

TMUX_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
CURRENT_TASK_ID=$(tmux show-environment -t "$TMUX_SESSION" AUTOBEAT_TASK_ID 2>/dev/null | cut -d= -f2-)
[ -z "$CURRENT_TASK_ID" ] && CURRENT_TASK_ID="${AUTOBEAT_TASK_ID:-}"
[ -z "$CURRENT_TASK_ID" ] && exit 0

[[ "$CURRENT_TASK_ID" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 0

SESSIONS_DIR="${AUTOBEAT_SESSIONS_DIR:-}"
[ -z "$SESSIONS_DIR" ] && exit 0

[[ "$SESSIONS_DIR" =~ \.\. ]] && exit 0

TASK_DIR="$SESSIONS_DIR/$CURRENT_TASK_ID"
MESSAGES_DIR="$TASK_DIR/messages"
SEQ_FILE="$TASK_DIR/.seq"

mkdir -p "$MESSAGES_DIR"

SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
SEQ=$((SEQ + 1))
echo "$SEQ" > "$SEQ_FILE"
PADDED=$(printf "%05d" "$SEQ")

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%FT%TZ)

if printf '%s' "$HOOK_DATA" | jq -e '.last_assistant_message' >/dev/null 2>&1; then
  ESCAPED=$(printf '%s' "$RESPONSE" | jq -Rs .)
else
  ESCAPED="$RESPONSE"
fi

MSG_FILE="$MESSAGES_DIR/${PADDED}-result.json"
printf '{"sequence":%d,"timestamp":"%s","type":"result","content":%s}\n' \
  "$SEQ" "$TIMESTAMP" "$ESCAPED" > "${MSG_FILE}.tmp"
mv "${MSG_FILE}.tmp" "$MSG_FILE"

STOP_REASON=$(printf '%s' "$HOOK_DATA" | jq -r '.stop_reason // "end_turn"' 2>/dev/null)
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

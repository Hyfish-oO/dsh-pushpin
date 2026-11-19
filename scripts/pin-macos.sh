#!/usr/bin/env bash
# macOS backend: the system ships no CLI for window level, so this drives
# yabai when it is installed. Without yabai there is nothing to poke, and the
# client hides the button. Layer > 0 counts as pinned; yabai's 0 is normal.
set -u

action="${1:-get}"

json_error() {
  printf '{"ok":false,"error":"%s"}\n' "$1"
  exit 0
}

command -v yabai >/dev/null 2>&1 || json_error "missing-tool"

window_id=$(
  yabai -m query --windows 2>/dev/null \
    | tr '}' '\n' \
    | grep -i 'DeepSeek Harness' \
    | grep -o '"id":[0-9]*' \
    | head -n 1 \
    | cut -d: -f2
)
[ -n "$window_id" ] || json_error "no-window"

read_state() {
  local layer
  layer=$(
    yabai -m query --windows --window "$1" 2>/dev/null \
      | grep -o '"layer":[0-9-]*' \
      | head -n 1 \
      | cut -d: -f2
  )
  [ -n "$layer" ] || layer=0
  if [ "$layer" -gt 0 ] 2>/dev/null; then
    printf 'true'
  else
    printf 'false'
  fi
}

current=$(read_state "$window_id")

case "$action" in
  toggle)
    if [ "$current" = "true" ]; then action="off"; else action="on"; fi
    ;;
esac

case "$action" in
  on)
    yabai -m window "$window_id" --layer above >/dev/null 2>&1
    ;;
  off)
    yabai -m window "$window_id" --layer normal >/dev/null 2>&1
    ;;
esac

if [ "$action" = "on" ] || [ "$action" = "off" ]; then
  sleep 0.08
  current=$(read_state "$window_id")
fi

printf '{"ok":true,"topmost":%s,"window":%s}\n' "$current" "$window_id"

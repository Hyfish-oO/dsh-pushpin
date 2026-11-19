#!/usr/bin/env bash
# X11 backend: wmctrl changes the EWMH above state, xprop reads it back.
# Wayland has no equivalent poke, so this reports missing-tool there.
set -u

action="${1:-get}"

json_error() {
  printf '{"ok":false,"error":"%s"}\n' "$1"
  exit 0
}

command -v wmctrl >/dev/null 2>&1 || json_error "missing-tool"
command -v xprop >/dev/null 2>&1 || json_error "missing-tool"

find_window() {
  local line
  line=$(wmctrl -l 2>/dev/null | grep -i "deepseek harness" | head -n 1)
  if [ -z "$line" ]; then
    line=$(wmctrl -l 2>/dev/null | grep -i "deepseek" | head -n 1)
  fi
  printf '%s' "$line" | awk '{print $1}'
}

read_state() {
  if xprop -id "$1" _NET_WM_STATE 2>/dev/null | grep -q "_NET_WM_STATE_ABOVE"; then
    printf 'true'
  else
    printf 'false'
  fi
}

window_id=$(find_window)
[ -n "$window_id" ] || json_error "no-window"

current=$(read_state "$window_id")

case "$action" in
  toggle)
    if [ "$current" = "true" ]; then action="off"; else action="on"; fi
    ;;
esac

case "$action" in
  on)
    wmctrl -i -r "$window_id" -b add,above >/dev/null 2>&1
    ;;
  off)
    wmctrl -i -r "$window_id" -b remove,above >/dev/null 2>&1
    ;;
esac

if [ "$action" = "on" ] || [ "$action" = "off" ]; then
  sleep 0.08
  current=$(read_state "$window_id")
fi

printf '{"ok":true,"topmost":%s,"window":"%s"}\n' "$current" "$window_id"

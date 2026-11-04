#!/usr/bin/env bash
# Drives a real Claude Code session with this mod loaded, on a private tmux server, so the
# lens can be seen and snapshotted without touching the owner's own tmux or sessions.
#
#   lab.sh start [cols] [rows]   start claude in a throwaway repo with a fixture plan
#   lab.sh keys <tmux keys...>   send keys, e.g.  lab.sh keys '/vada plan.md' Enter
#   lab.sh snap <name>           save and print what the screen shows now
#   lab.sh resize <cols> <rows>  resize the lab window
#   lab.sh stop                  kill the lab server (the throwaway repo is kept for reading)
set -euo pipefail

readonly SOCKET=vada-lab
readonly SESSION=lab
MOD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly MOD
readonly LAB="${VADA_LAB:-${TMPDIR:-/tmp}/vada-lab}"
readonly REPO="$LAB/repo"
readonly SNAPS="$LAB/snaps"

lab_tmux() { tmux -L "$SOCKET" "$@"; }

die() { printf 'lab: %s\n' "$*" >&2; exit 1; }

screen() { lab_tmux capture-pane -p -t "$SESSION"; }

# Waits until the screen shows the text, so steps never race the app; fails loudly on timeout.
wait_for() {
  local -r text="$1" seconds="${2:-30}"
  local waited=0
  until screen | grep -qF -- "$text"; do
    (( waited >= seconds * 4 )) && { screen >&2; die "timed out after ${seconds}s waiting for: $text"; }
    sleep 0.25
    waited=$(( waited + 1 ))
  done
}

fixture() {
  mkdir -p "$REPO" "$SNAPS"
  cp "$MOD/demo/fixture-plan.md" "$REPO/plan.md"
  [[ -d "$REPO/.git" ]] || git -C "$REPO" init -q
}

start() {
  local -r cols="${1:-200}" rows="${2:-50}"
  lab_tmux has-session -t "$SESSION" 2>/dev/null && die "already running; lab.sh stop first"
  fixture
  lab_tmux new-session -d -s "$SESSION" -x "$cols" -y "$rows" -c "$REPO" \
    "claude --plugin-dir '$MOD' --debug-file '$LAB/lab.log'"
  # A folder opened for the first time asks for trust before any mod loads.
  sleep 3
  if screen | grep -qi 'trust'; then lab_tmux send-keys -t "$SESSION" Enter; fi
  wait_for '?' 60
  printf 'lab: up at %sx%s in %s (debug log %s)\n' "$cols" "$rows" "$REPO" "$LAB/lab.log"
}

keys() {
  (( $# > 0 )) || die "keys needs at least one key"
  lab_tmux send-keys -t "$SESSION" "$@"
  sleep "${VADA_LAB_SETTLE:-1.5}"
}

snap() {
  local -r name="${1:?snap needs a name}"
  screen | tee "$SNAPS/$name.txt"
}

resize() { lab_tmux resize-window -t "$SESSION" -x "${1:?cols}" -y "${2:?rows}"; sleep 1; }

stop() { lab_tmux kill-server 2>/dev/null || true; }

main() {
  local -r command="${1:-}"
  shift || true
  case "$command" in
    start) start "$@" ;;
    keys) keys "$@" ;;
    snap) snap "$@" ;;
    resize) resize "$@" ;;
    stop) stop ;;
    *) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 2 ;;
  esac
}

main "$@"

#!/bin/bash
set -euo pipefail
addon_root="$(cd "$(dirname "$0")" && pwd)"
cd "$addon_root/task-agent-source"
export SCREENHAND_API_URL="${SCREENHAND_API_URL:-http://127.0.0.1:3013}"
export SCREENHAND_LOCAL_CONTROL_PLANE_URL="$SCREENHAND_API_URL"
export SCREENHAND_TASK_CONSOLE_URL="${SCREENHAND_TASK_CONSOLE_URL:-http://127.0.0.1:3027}"
export SCREENHAND_TASK_CONSOLE_PORT="${SCREENHAND_TASK_CONSOLE_PORT:-3027}"
task_pid=""
cleanup() {
  if [[ -n "$task_pid" ]]; then kill "$task_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
npm run tasks:server &
task_pid=$!
npm run dev:3011:ui

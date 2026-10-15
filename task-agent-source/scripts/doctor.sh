#!/bin/zsh
set -u
failures=0

check_http() {
  local label="$1"
  local url="$2"

  if curl --max-time 1 -fsS "$url" >/dev/null 2>&1; then
    print "✓ $label"
  else
    print "✗ $label"
    failures=$((failures + 1))
  fi
}

print "ScreenHand connection check"
print ""

if curl --max-time 1 -fsS http://127.0.0.1:3016/status >/dev/null 2>&1; then
  print "✓ Supervisor  http://127.0.0.1:3016"
else
  print "○ Supervisor   not running (development mode)"
fi

check_http "Dashboard    http://127.0.0.1:3012" "http://127.0.0.1:3012"
check_http "Control API  http://127.0.0.1:3013" "http://127.0.0.1:3013/health"

device_state="$(curl --max-time 2 -fsS http://127.0.0.1:3013/api/v1/devices 2>/dev/null || true)"
if print -r -- "$device_state" | grep -q '"hardware":"black-arm-direct"'; then
  if print -r -- "$device_state" | grep -q '"connected":true'; then
    print "✓ Black arm    node online"
  else
    print "✗ Black arm    node offline"
    failures=$((failures + 1))
  fi
  if print -r -- "$device_state" | grep -q '"cameraReady":true'; then
    print "✓ UVC camera   live video online"
  else
    print "✗ UVC camera   no live video"
    print "  Allow ScreenHand Camera in System Settings → Privacy & Security → Camera,"
    print "  then run: screenhand restart"
    failures=$((failures + 1))
  fi
  if print -r -- "$device_state" | grep -q '"grbl":{[^}]*"connected":true'; then
    print "✓ Controller   CH340 / 95200 online"
  else
    print "✗ Controller   black-arm serial offline"
    failures=$((failures + 1))
  fi
else
  print "! Black arm    waiting for one controller and one UVC camera"
  failures=$((failures + 1))
fi

if (( failures > 0 )); then
  print ""
  print "ScreenHand is installed, but hardware setup is not ready."
  exit 1
fi

print ""
print "ScreenHand is ready."

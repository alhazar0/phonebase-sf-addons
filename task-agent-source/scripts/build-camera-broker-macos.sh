#!/bin/zsh
set -euo pipefail

screenhand_root="${0:A:h:h}"
application="$screenhand_root/build/ScreenHandCameraBroker.app"
contents="$application/Contents"
executable="$contents/MacOS/ScreenHandCameraBroker"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "ScreenHand Camera currently supports macOS only."
  exit 1
fi

command -v swiftc >/dev/null 2>&1 || {
  print -u2 "Swift compiler is unavailable. Install Apple command-line tools first."
  exit 2
}

mkdir -p "$contents/MacOS"
cp "$screenhand_root/resources/ScreenHandCameraBroker-Info.plist" "$contents/Info.plist"
swiftc -O "$screenhand_root/bridge/CameraBroker.swift" -o "$executable"
chmod +x "$executable"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$application" >/dev/null
fi

print "ScreenHand Camera app built: $application"

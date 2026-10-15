#!/bin/zsh
set -euo pipefail

screenhand_dir="${0:A:h:h}"
cd "$screenhand_dir"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "ScreenHand currently supports macOS only."
  exit 1
fi

missing=()
for command_name in node npm python3 ffmpeg swift; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing+=("$command_name")
  fi
done

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if (( node_major < 22 )); then
    missing+=("Node.js 22+")
  fi
fi

if (( ${#missing[@]} > 0 )); then
  print -u2 "ScreenHand needs: ${missing[*]}"
  print -u2 "Install the missing runtime, then run this setup again."
  print -u2 "With Homebrew: brew install node@22 ffmpeg python"
  print -u2 "For Swift tools: xcode-select --install"
  exit 2
fi

print "ScreenHand system check passed."
print "Installing the local application…"
npm install
./scripts/build-camera-broker-macos.sh

cli_dir="${SCREENHAND_CLI_DIRECTORY:-$HOME/.screenhand/bin}"
mkdir -p "$cli_dir"
ln -sfn "$screenhand_dir/bin/screenhand.mjs" "$cli_dir/screenhand"
chmod +x "$screenhand_dir/bin/screenhand.mjs" "$cli_dir/screenhand"

profile_file="$HOME/.zprofile"
path_line="export PATH=\"$cli_dir:\$PATH\" # ScreenHand CLI"
if ! grep -Fq "ScreenHand CLI" "$profile_file" 2>/dev/null; then
  print "" >> "$profile_file"
  print -r -- "$path_line" >> "$profile_file"
fi

print ""
print "Setup complete."
print "1. Connect one ScreenHand controller and one UVC camera."
print "2. Run: $cli_dir/screenhand onboard --prepared"
print "3. Open: http://127.0.0.1:3012"

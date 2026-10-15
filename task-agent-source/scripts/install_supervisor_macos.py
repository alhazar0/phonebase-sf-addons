#!/usr/bin/env python3
"""Install ScreenHand supervisor as a per-user macOS LaunchAgent."""

from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent.parent
LABEL = "ai.phonefarm.screenhand"
TARGET = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG_DIR = ROOT / "build" / "runtime" / "supervisor" / "logs"


def env_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text("utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def reference_checkpoint(status: dict[str, Any]) -> dict[str, Any] | None:
    if status.get("reference_mode") != "manual" or status.get("homed") is not True:
        return None
    if status.get("connected") is not True or status.get("state") != "Idle":
        raise ValueError("the live manual reference is not connected and Idle")
    controller = status.get("controller_position")
    offset = status.get("coordinate_offset")
    if not isinstance(controller, dict) or not isinstance(offset, dict):
        raise ValueError("the live manual reference has no controller position/offset")
    required = ("x", "y", "z", "a")
    if not all(isinstance(controller.get(key), (int, float)) for key in required):
        raise ValueError("the live controller position is incomplete")
    if not all(isinstance(offset.get(key), (int, float)) for key in required):
        raise ValueError("the live coordinate offset is incomplete")
    port = status.get("port")
    if not isinstance(port, str) or not port.startswith("/dev/cu.usbserial"):
        raise ValueError("the live manual reference has no verified serial port")
    return {
        "version": 1,
        "serialPort": port,
        "controllerPosition": {key: controller[key] for key in required},
        "coordinateOffset": {key: offset[key] for key in required},
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def snapshot_live_reference(settings: dict[str, str]) -> bool:
    if settings.get("SCREENHAND_BLACK_RESTORE_MANUAL_REFERENCE") != "1":
        return False
    port = int(settings.get("SCREENHAND_BLACK_PORT", "3014"))
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2) as response:
            status = json.load(response)
    except (URLError, TimeoutError, OSError, json.JSONDecodeError):
        return False
    checkpoint = reference_checkpoint(status)
    if checkpoint is None:
        return False
    configured_path = Path(
        settings.get(
            "SCREENHAND_BLACK_REFERENCE_STATE_PATH",
            "build/runtime/black-arm-reference.json",
        )
    )
    target = configured_path if configured_path.is_absolute() else ROOT / configured_path
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(checkpoint, ensure_ascii=False, indent=2) + "\n",
            "utf-8",
        )
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass
    return True


def main() -> int:
    if sys.platform != "darwin":
        print("This installer only supports macOS", file=sys.stderr)
        return 2
    env_path = ROOT / ".env.supervisor"
    if not env_path.exists():
        print("Create .env.supervisor before installing the LaunchAgent", file=sys.stderr)
        return 2
    settings = env_values(env_path)
    if any(
        marker in value
        for value in settings.values()
        for marker in ("REPLACE_ME", "CHANGE_ME", "replace-with-", ".example")
    ):
        print(
            ".env.supervisor still contains example placeholders; installation stopped",
            file=sys.stderr,
        )
        return 2
    missing = [name for name in ("npm", "lsof", "pgrep") if not shutil.which(name)]
    if missing:
        print(
            "Missing required commands in the current PATH: " + ", ".join(missing),
            file=sys.stderr,
        )
        return 2
    try:
        captured_reference = snapshot_live_reference(settings)
    except (ValueError, OSError) as error:
        print(
            "Unable to preserve the live manual reference; installation stopped: "
            + str(error),
            file=sys.stderr,
        )
        return 2
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": [
            sys.executable,
            str(ROOT / "scripts" / "supervisor.py"),
        ],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Interactive",
        "ThrottleInterval": 5,
        # launchd's default PATH omits Homebrew on both Apple Silicon and many
        # Intel Macs. Capture the verified install-shell PATH so npm and
        # cloudflared remain available after logout/reboot.
        "EnvironmentVariables": {
            "PATH": os.environ.get(
                "PATH",
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            ),
        },
        "StandardOutPath": str(LOG_DIR / "launchd.out.log"),
        "StandardErrorPath": str(LOG_DIR / "launchd.err.log"),
    }
    with TARGET.open("wb") as handle:
        plistlib.dump(payload, handle)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain, str(TARGET)], check=False)
    subprocess.run(["launchctl", "bootstrap", domain, str(TARGET)], check=True)
    subprocess.run(["launchctl", "enable", f"{domain}/{LABEL}"], check=True)
    print(f"Installed {TARGET}")
    if captured_reference:
        print("Captured the live manual reference before supervisor takeover")
    print("Supervisor status: http://127.0.0.1:3016/status")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

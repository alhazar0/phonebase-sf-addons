#!/usr/bin/env python3
"""Long-running supervisor for a production ScreenHand station.

The supervisor deliberately treats infrastructure health and touch readiness
as separate states. A failed limit switch may lock physical touch, but it must
not take the camera, console, control plane, gateway, or diagnostics offline.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "build" / "runtime" / "supervisor"
LOGS = RUNTIME / "logs"
STATUS_PATH = RUNTIME / "status.json"
LOCK_PATH = RUNTIME / "supervisor.lock"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text("utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key] = value


# Process environment always wins.  Among files, the station-specific file is
# intentionally loaded first so a generic developer .env cannot silently
# override production serial ports, tokens, or recovery policy.
for env_path in (ROOT / ".env.supervisor", ROOT / ".env.local", ROOT / ".env"):
    load_env_file(env_path)


SUPERVISOR_PORT = int(os.environ.get("SCREENHAND_SUPERVISOR_PORT", "3016"))
CHECK_INTERVAL = float(os.environ.get("SCREENHAND_SUPERVISOR_INTERVAL", "2"))
FAILURE_THRESHOLD = int(os.environ.get("SCREENHAND_SUPERVISOR_FAILURES", "3"))
CONSOLE_PORT = int(os.environ.get("SCREENHAND_CONSOLE_PORT", "3012"))
CONTROL_PLANE_PORT = int(os.environ.get("SCREENHAND_CONTROL_PLANE_PORT", "3013"))
DRIVER_PORT = int(os.environ.get("SCREENHAND_BLACK_PORT", "3014"))
GATEWAY_PORT = int(os.environ.get("SCREENHAND_REMOTE_PORT", "3015"))
AUTO_HOME = os.environ.get(
    "SCREENHAND_SUPERVISOR_AUTO_HOME",
    "0" if os.environ.get("SCREENHAND_BLACK_SKIP_START_HOME") == "1" else "1",
) == "1"


RUNTIME.mkdir(parents=True, exist_ok=True)
LOGS.mkdir(parents=True, exist_ok=True)


def rotating_logger(name: str, path: Path) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = RotatingFileHandler(path, maxBytes=5_000_000, backupCount=4)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
    return logger


LOGGER = rotating_logger("screenhand.supervisor", LOGS / "supervisor.log")


def http_json(url: str, headers: dict[str, str] | None = None) -> tuple[bool, Any]:
    try:
        request = Request(url, headers=headers or {})
        with urlopen(request, timeout=1.5) as response:
            body = response.read()
            if response.status < 200 or response.status >= 300:
                return False, None
            if not body:
                return True, None
            try:
                return True, json.loads(body)
            except json.JSONDecodeError:
                return True, None
    except (HTTPError, URLError, TimeoutError, OSError):
        return False, None


def http_post_json(url: str, value: Any, timeout: float = 55) -> tuple[bool, Any]:
    try:
        body = json.dumps(value).encode("utf-8")
        request = Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=timeout) as response:
            payload = response.read()
            return response.status < 300, json.loads(payload) if payload else None
    except HTTPError as error:
        try:
            return False, json.loads(error.read())
        except (OSError, json.JSONDecodeError):
            return False, {"error": str(error)}
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
        return False, {"error": str(error)}


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def listener_pid(port: int) -> int | None:
    try:
        value = subprocess.check_output(
            ["lsof", "-nP", "-tiTCP:%d" % port, "-sTCP:LISTEN"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).strip().splitlines()
        return int(value[0]) if value else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def matching_pid(pattern: str) -> int | None:
    try:
        values = subprocess.check_output(
            ["pgrep", "-f", pattern],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).strip().splitlines()
        candidates = [int(value) for value in values if int(value) != os.getpid()]
        return candidates[0] if candidates else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")
    os.replace(temporary, path)


def command_from_env(name: str, fallback: str) -> list[str]:
    return shlex.split(os.environ.get(name, fallback))


def redacted_command(command: list[str]) -> str:
    redacted = list(command)
    for index, value in enumerate(redacted[:-1]):
        if value in ("--token", "--credentials-contents"):
            redacted[index + 1] = "[REDACTED]"
    return shlex.join(redacted)


@dataclass
class Service:
    name: str
    command: list[str]
    port: int | None = None
    health_url: str | None = None
    health_headers: dict[str, str] = field(default_factory=dict)
    process_pattern: str | None = None
    enabled: bool = True
    process: subprocess.Popen[bytes] | None = None
    pid: int | None = None
    adopted: bool = False
    healthy: bool = False
    consecutive_failures: int = 0
    restart_count: int = 0
    next_start_at: float = 0
    started_at: float | None = None
    last_error: str = ""
    log_thread: threading.Thread | None = None

    def discover(self) -> int | None:
        if self.port is not None:
            return listener_pid(self.port)
        if self.process_pattern:
            return matching_pid(self.process_pattern)
        return None

    def alive(self) -> bool:
        if self.process is not None:
            return self.process.poll() is None
        return pid_alive(self.pid)

    def probe(self) -> bool:
        if not self.alive():
            return False
        if not self.health_url:
            return True
        ok, _ = http_json(self.health_url, self.health_headers)
        return ok

    def adopt_if_running(self) -> bool:
        existing = self.discover()
        if not existing:
            return False
        self.pid = existing
        self.adopted = True
        self.started_at = time.time()
        self.healthy = self.probe()
        LOGGER.info("adopted %s pid=%s healthy=%s", self.name, self.pid, self.healthy)
        return True

    def _pump_output(self, pipe: Any) -> None:
        logger = rotating_logger(f"screenhand.service.{self.name}", LOGS / f"{self.name}.log")
        try:
            for raw in iter(pipe.readline, b""):
                logger.info(raw.decode("utf-8", "replace").rstrip())
        finally:
            pipe.close()

    def start(self) -> None:
        if not self.enabled or self.alive() or time.time() < self.next_start_at:
            return
        LOGGER.info("starting %s: %s", self.name, redacted_command(self.command))
        try:
            self.process = subprocess.Popen(
                self.command,
                cwd=ROOT,
                env=os.environ.copy(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            self.pid = self.process.pid
            self.adopted = False
            self.started_at = time.time()
            self.last_error = ""
            if self.process.stdout:
                self.log_thread = threading.Thread(
                    target=self._pump_output,
                    args=(self.process.stdout,),
                    daemon=True,
                )
                self.log_thread.start()
        except OSError as error:
            self.last_error = str(error)
            self.restart_count += 1
            self.next_start_at = time.time() + min(30, 2 ** min(self.restart_count, 5))
            LOGGER.exception("unable to start %s", self.name)

    def stop(self) -> None:
        pid = self.pid
        if not pid_alive(pid):
            self.process = None
            self.pid = None
            return
        LOGGER.info("stopping %s pid=%s adopted=%s", self.name, pid, self.adopted)
        try:
            if self.process is not None:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            else:
                os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.time() + 4
        while pid_alive(pid) and time.time() < deadline:
            time.sleep(0.1)
        if pid_alive(pid):
            try:
                if self.process is not None:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                else:
                    os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        self.process = None
        self.pid = None
        self.adopted = False
        self.healthy = False

    def tick(self) -> None:
        if not self.enabled:
            return
        if not self.alive():
            if time.time() < self.next_start_at:
                return
            if self.process is not None or self.pid is not None:
                exit_code = self.process.poll() if self.process is not None else None
                self.last_error = f"process exited ({exit_code})"
                self.process = None
                self.pid = None
                self.adopted = False
                self.healthy = False
                self.consecutive_failures = 0
                self.restart_count += 1
                self.next_start_at = time.time() + min(
                    30, 2 ** min(self.restart_count, 5)
                )
                return
            self.start()
            return
        healthy = self.probe()
        if healthy:
            self.healthy = True
            self.consecutive_failures = 0
            if self.started_at and time.time() - self.started_at > 60:
                self.restart_count = 0
            return
        self.healthy = False
        self.consecutive_failures += 1
        self.last_error = f"health check failed ({self.consecutive_failures}/{FAILURE_THRESHOLD})"
        if self.consecutive_failures >= FAILURE_THRESHOLD:
            self.restart_count += 1
            self.next_start_at = time.time() + min(30, 2 ** min(self.restart_count, 5))
            self.stop()
            self.consecutive_failures = 0
            self.start()

    def public(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "pid": self.pid,
            "managed": self.process is not None,
            "adopted": self.adopted,
            "alive": self.alive(),
            "healthy": self.healthy,
            "restartCount": self.restart_count,
            "startedAt": self.started_at,
            "lastError": self.last_error or None,
        }


def gateway_headers() -> dict[str, str]:
    token = os.environ.get("SCREENHAND_REMOTE_TOKEN", "")
    origin = os.environ.get("SCREENHAND_REMOTE_ALLOWED_ORIGINS", "").split(",")[0]
    return {
        "Origin": origin,
        "Authorization": f"Bearer {token}",
    }


remote_ready = bool(
    os.environ.get("SCREENHAND_REMOTE_TOKEN") and
    os.environ.get("SCREENHAND_REMOTE_ALLOWED_ORIGINS")
)
tunnel_command = os.environ.get("SCREENHAND_TUNNEL_COMMAND", "").strip()

SERVICES = [
    Service(
        "driver",
        command_from_env("SCREENHAND_DRIVER_COMMAND", "python3 bridge/black_arm_driver.py"),
        port=DRIVER_PORT,
        health_url=f"http://127.0.0.1:{DRIVER_PORT}/health",
    ),
    Service(
        "control-plane",
        command_from_env("SCREENHAND_CONTROL_PLANE_COMMAND", "npm run control-plane"),
        port=CONTROL_PLANE_PORT,
        health_url=f"http://127.0.0.1:{CONTROL_PLANE_PORT}/health",
    ),
    Service(
        "node",
        command_from_env("SCREENHAND_NODE_COMMAND", "npm run black:node"),
        process_pattern=r"tsx bridge/black_arm_node\.ts",
    ),
    Service(
        "console",
        command_from_env("SCREENHAND_CONSOLE_COMMAND", "npm run start:3012"),
        port=CONSOLE_PORT,
        health_url=f"http://127.0.0.1:{CONSOLE_PORT}/",
    ),
    Service(
        "gateway",
        command_from_env("SCREENHAND_GATEWAY_COMMAND", "npm run remote:gateway"),
        port=GATEWAY_PORT,
        health_url=f"http://127.0.0.1:{GATEWAY_PORT}/health",
        health_headers=gateway_headers(),
        enabled=remote_ready,
    ),
    Service(
        "tunnel",
        command_from_env("SCREENHAND_TUNNEL_COMMAND", tunnel_command or "true"),
        process_pattern=r"cloudflared.*tunnel|ngrok.*3015",
        enabled=bool(tunnel_command),
    ),
]

CURRENT_STATUS: dict[str, Any] = {}
STOP_EVENT = threading.Event()


class ReferenceReconciler:
    """Home once per driver process without blocking service supervision."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._attempted_pid: int | None = None
        self._in_progress = False
        self._last: dict[str, Any] = {
            "enabled": AUTO_HOME,
            "status": "waiting" if AUTO_HOME else "disabled",
        }

    def tick(self, driver: Service) -> None:
        if not AUTO_HOME or not driver.alive() or not driver.healthy or not driver.pid:
            return
        with self._lock:
            if self._in_progress or self._attempted_pid == driver.pid:
                return
        ok, payload = http_json(f"http://127.0.0.1:{DRIVER_PORT}/api/status")
        if not ok or not isinstance(payload, dict) or payload.get("connected") is not True:
            return
        if payload.get("homed") is True:
            with self._lock:
                self._attempted_pid = driver.pid
                self._last = {
                    "enabled": True,
                    "status": "ready",
                    "driverPid": driver.pid,
                    "referenceMode": payload.get("reference_mode"),
                }
            return
        with self._lock:
            self._attempted_pid = driver.pid
            self._in_progress = True
            self._last = {
                "enabled": True,
                "status": "running",
                "driverPid": driver.pid,
            }
        threading.Thread(
            target=self._run,
            args=(driver.pid,),
            daemon=True,
        ).start()

    def _run(self, driver_pid: int) -> None:
        ok, payload = http_post_json(
            f"http://127.0.0.1:{DRIVER_PORT}/api/home-machine",
            {},
        )
        with self._lock:
            self._in_progress = False
            self._last = {
                "enabled": True,
                "status": "ready" if ok else "failed",
                "driverPid": driver_pid,
                "result": payload,
            }

    def public(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._last)


REFERENCE_RECONCILER = ReferenceReconciler()


def station_state() -> dict[str, Any]:
    services = {service.name: service.public() for service in SERVICES}
    control_plane_ok, device_payload = http_json(
        f"http://127.0.0.1:{CONTROL_PLANE_PORT}/api/v1/devices/black-arm-01"
    )
    device = device_payload.get("device", {}) if control_plane_ok and isinstance(device_payload, dict) else {}
    state = device.get("state", {}) if isinstance(device, dict) else {}
    grbl = state.get("grbl", {}) if isinstance(state, dict) else {}
    capabilities = device.get("capabilities", {}) if isinstance(device, dict) else {}
    actions = capabilities.get("actions", {}) if isinstance(capabilities, dict) else {}
    tap = actions.get("tap", {}) if isinstance(actions, dict) else {}
    required = [value for value in SERVICES if value.enabled and value.name != "tunnel"]
    infrastructure_online = all(value.alive() and value.healthy for value in required)
    gateway = next(value for value in SERVICES if value.name == "gateway")
    tunnel = next(value for value in SERVICES if value.name == "tunnel")
    remote_online = (
        gateway.enabled and gateway.alive() and gateway.healthy and
        (not tunnel.enabled or (tunnel.alive() and tunnel.healthy))
    )
    return {
        "ok": infrastructure_online,
        "service": "ScreenHand supervisor",
        "updatedAt": time.time(),
        "infrastructureOnline": infrastructure_online,
        "remoteOnline": remote_online,
        "touchReady": tap.get("available") is True,
        "touchBlockedReason": None if tap.get("available") is True else tap.get("reason"),
        "deviceConnected": device.get("connected") is True,
        "cameraReady": state.get("cameraReady") is True,
        "digitalReady": state.get("digitalReady") is True,
        "grbl": {
            "connected": grbl.get("connected") is True,
            "state": grbl.get("state"),
            "homed": grbl.get("homed") is True,
            "referenceMode": grbl.get("referenceMode"),
            "limitPins": grbl.get("limitPins"),
        },
        "referenceReconciliation": REFERENCE_RECONCILER.public(),
        "services": services,
    }


class StatusHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path not in ("/", "/health", "/status"):
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps(CURRENT_STATUS, ensure_ascii=False).encode("utf-8")
        self.send_response(200 if CURRENT_STATUS.get("ok") else 503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def status_server() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", SUPERVISOR_PORT), StatusHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def shutdown(*_args: Any) -> None:
    STOP_EVENT.set()


def run(adopt: bool) -> int:
    global CURRENT_STATUS
    lock = LOCK_PATH.open("a+")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("ScreenHand supervisor is already running", file=sys.stderr)
        return 2
    lock.seek(0)
    lock.truncate()
    lock.write(str(os.getpid()))
    lock.flush()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    server = status_server()
    LOGGER.info("supervisor started pid=%s adopt=%s", os.getpid(), adopt)

    for service in SERVICES:
        if not service.enabled:
            continue
        if not adopt or not service.adopt_if_running():
            service.start()
        time.sleep(0.25)

    CURRENT_STATUS = station_state()
    atomic_json(STATUS_PATH, CURRENT_STATUS)

    while not STOP_EVENT.wait(CHECK_INTERVAL):
        for service in SERVICES:
            service.tick()
        REFERENCE_RECONCILER.tick(
            next(service for service in SERVICES if service.name == "driver")
        )
        CURRENT_STATUS = station_state()
        atomic_json(STATUS_PATH, CURRENT_STATUS)

    LOGGER.info("supervisor stopping")
    for service in reversed(SERVICES):
        if service.enabled and not service.adopted:
            service.stop()
    server.shutdown()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-adopt", action="store_true", help="do not adopt existing services")
    parser.add_argument("--status-once", action="store_true")
    args = parser.parse_args()
    if args.status_once:
        try:
            request = Request(f"http://127.0.0.1:{SUPERVISOR_PORT}/status")
            try:
                response = urlopen(request, timeout=1.5)
            except HTTPError as error:
                response = error
            with response:
                payload = json.loads(response.read())
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0
        except (URLError, TimeoutError, OSError, json.JSONDecodeError):
            pass
        for service in SERVICES:
            if not service.enabled:
                continue
            service.pid = service.discover()
            service.adopted = service.pid is not None
            service.healthy = service.probe()
        print(json.dumps(station_state(), ensure_ascii=False, indent=2))
        return 0
    return run(adopt=not args.no_adopt)


if __name__ == "__main__":
    raise SystemExit(main())

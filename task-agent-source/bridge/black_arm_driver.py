#!/usr/bin/env python3
"""Direct macOS driver and local HTTP API for the black ScreenHand arm.

The vendor Windows applications are deliberately not used.  The controller is
opened through its CH340 at the firmware's unusual 95200 baud rate and driven
with the custom absolute commands recovered from the vendor package.
"""

from __future__ import annotations

import fcntl
import glob
import json
import os
import re
import select
import struct
import sys
import termios
import threading
import time
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = os.environ.get("SCREENHAND_BLACK_HOST", "127.0.0.1")
PORT = int(os.environ.get("SCREENHAND_BLACK_PORT", "3014"))
SERIAL_PORT = os.environ.get("SCREENHAND_BLACK_SERIAL", "/dev/cu.usbserial-130")
MAINTENANCE_ENABLED = os.environ.get("SCREENHAND_BLACK_MAINTENANCE") == "1"
BAUD = 95_200
IOSSIOSPEED = 0x80085402

# First real-device profile, measured 2026-08-01.  Bounds are deliberately
# inset from the physical phone edges.  Z=1 is the post-homing hover position;
# Z=9 produced the first verified capacitive touch.
MIN_X = float(os.environ.get("SCREENHAND_BLACK_MIN_X", "5.8"))
MAX_X = float(os.environ.get("SCREENHAND_BLACK_MAX_X", "78.5"))
MIN_Y = float(os.environ.get("SCREENHAND_BLACK_MIN_Y", "10.5"))
MAX_Y = float(os.environ.get("SCREENHAND_BLACK_MAX_Y", "168.0"))
CALIBRATION_MIN_X = float(os.environ.get("SCREENHAND_BLACK_CALIBRATION_MIN_X", "1.0"))
CALIBRATION_MAX_X = float(os.environ.get("SCREENHAND_BLACK_CALIBRATION_MAX_X", "82.0"))
CALIBRATION_MIN_Y = float(os.environ.get("SCREENHAND_BLACK_CALIBRATION_MIN_Y", "1.0"))
CALIBRATION_MAX_Y = float(os.environ.get("SCREENHAND_BLACK_CALIBRATION_MAX_Y", "170.0"))
HOVER_Z = float(os.environ.get("SCREENHAND_BLACK_HOVER_Z", "1.0"))
TOUCH_Z = float(os.environ.get("SCREENHAND_BLACK_TOUCH_Z", "10.0"))
MIN_TOUCH_Z = float(os.environ.get("SCREENHAND_BLACK_MIN_TOUCH_Z", "9.5"))
SEQUENCE_RELEASE_Z = float(
    # Z=8.5 turned consecutive taps into iOS QuickPath words, and Z=7.0 still
    # produced a ghost key on a long diagonal move. Z=5.0 keeps a generous
    # capacitive disconnect while retaining the batched GRBL program and is
    # substantially faster than returning to full hover between characters.
    os.environ.get("SCREENHAND_BLACK_SEQUENCE_RELEASE_Z", "5.0")
)
SWIPE_TOUCH_Z = float(os.environ.get("SCREENHAND_BLACK_SWIPE_Z", "10.0"))
MAX_Z = float(os.environ.get("SCREENHAND_BLACK_MAX_Z", "10.0"))
SYSTEM_EDGE_MAX_EXTENSION_MM = 6.0
SYSTEM_EDGE_TAP_MAX_EXTENSION_MM = 10.0
SYSTEM_EDGE_MAX_LATERAL_DRIFT_MM = 5.0
SYSTEM_EDGE_MIN_INWARD_TRAVEL_MM = 10.0
SYSTEM_EDGE_MAX_INWARD_TRAVEL_MM = 120.0
PARK_X = 18.0
PARK_BOTTOM_Y = 20.5
PARK_TOP_Y = 165.0
DEFAULT_TAP_MS = 40
MIN_TAP_MS = 30
MAX_LONG_PRESS_MS = 5_000
LIVE_TOUCH_TIMEOUT_SECONDS = float(
    os.environ.get("SCREENHAND_BLACK_LIVE_TOUCH_TIMEOUT_SECONDS", "1.5")
)
LIMIT_RELEASE_STEP_MM = float(
    os.environ.get("SCREENHAND_BLACK_LIMIT_RELEASE_STEP_MM", "0.5")
)
LIMIT_RELEASE_MAX_MM = {
    "X": float(os.environ.get("SCREENHAND_BLACK_X_RELEASE_MAX_MM", "8.0")),
    "Y": float(os.environ.get("SCREENHAND_BLACK_Y_RELEASE_MAX_MM", "8.0")),
    "Z": float(os.environ.get("SCREENHAND_BLACK_Z_RELEASE_MAX_MM", "2.0")),
}
MAINTENANCE_PROBE_POSITIONS = (
    (40.0, 80.0),
    (25.0, 40.0),
    (55.0, 120.0),
)
MAINTENANCE_START_POSITIONS = ((8.0, 0.0),) + MAINTENANCE_PROBE_POSITIONS
MAINTENANCE_STROKE_MM = 1.0
MAX_MANUAL_REFERENCE_OFFSET_MM = float(
    os.environ.get("SCREENHAND_BLACK_MAX_MANUAL_REFERENCE_OFFSET_MM", "15.0")
)
RESTORE_MANUAL_REFERENCE = (
    os.environ.get("SCREENHAND_BLACK_RESTORE_MANUAL_REFERENCE") == "1"
)
MANUAL_REFERENCE_STATE_PATH = Path(
    os.environ.get(
        "SCREENHAND_BLACK_REFERENCE_STATE_PATH",
        "build/runtime/black-arm-reference.json",
    )
)
REFERENCE_RESTORE_TOLERANCE_MM = float(
    os.environ.get("SCREENHAND_BLACK_REFERENCE_RESTORE_TOLERANCE_MM", "0.15")
)
if not 0 < MAX_MANUAL_REFERENCE_OFFSET_MM <= 100:
    raise ValueError(
        "SCREENHAND_BLACK_MAX_MANUAL_REFERENCE_OFFSET_MM must be within (0, 100]"
    )
if not 0 < REFERENCE_RESTORE_TOLERANCE_MM <= 0.5:
    raise ValueError(
        "SCREENHAND_BLACK_REFERENCE_RESTORE_TOLERANCE_MM must be within (0, 0.5]"
    )
if not 0.5 <= LIVE_TOUCH_TIMEOUT_SECONDS <= 5.0:
    raise ValueError(
        "SCREENHAND_BLACK_LIVE_TOUCH_TIMEOUT_SECONDS must be within [0.5, 5.0]"
    )
if not HOVER_Z <= SEQUENCE_RELEASE_Z < MIN_TOUCH_Z:
    raise ValueError(
        "SCREENHAND_BLACK_SEQUENCE_RELEASE_Z must be at or above hover Z and "
        "strictly below the verified minimum touch Z"
    )

STATUS_RE = re.compile(
    r"<(?P<state>[^|>]+).*?MPos:"
    r"(?P<x>-?\d+(?:\.\d+)?),(?P<y>-?\d+(?:\.\d+)?),"
    r"(?P<z>-?\d+(?:\.\d+)?)(?:,(?P<a>-?\d+(?:\.\d+)?))?"
    r".*?(?:FS:(?P<feed>-?\d+(?:\.\d+)?),(?P<spindle>-?\d+(?:\.\d+)?))?.*?>"
)
PINS_RE = re.compile(r"(?:^|\|)Pn:(?P<pins>[^|>]*)")


def nearest_park_y(y: float) -> float:
    """Return the already-verified screen-out park closest to an action."""
    return min((PARK_BOTTOM_Y, PARK_TOP_Y), key=lambda candidate: abs(candidate - y))


@dataclass
class Position:
    x: float
    y: float
    z: float
    a: float = 0.0


def positions_match(
    current: Position,
    expected: Position,
    tolerance: float = REFERENCE_RESTORE_TOLERANCE_MM,
) -> bool:
    return all(
        abs(getattr(current, axis) - getattr(expected, axis)) <= tolerance
        for axis in ("x", "y", "z", "a")
    )


@dataclass
class MachineStatus:
    ok: bool
    connected: bool
    port: str | None
    state: str
    position: Position
    normalized_z: float
    feed: float
    spindle: float
    latency_ms: int
    updated_at: str
    homed: bool = False
    limit_pins: str = ""
    reference_mode: str = "unreferenced"
    controller_position: Position | None = None
    coordinate_offset: Position | None = None
    recovery: dict[str, Any] | None = None
    live_touch: dict[str, Any] | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        if self.error is None:
            value.pop("error")
        if self.recovery is None:
            value.pop("recovery")
        if self.controller_position is None:
            value.pop("controller_position")
        if self.coordinate_offset is None:
            value.pop("coordinate_offset")
        if self.live_touch is None:
            value.pop("live_touch")
        return value


class BlackArmDriver:
    def __init__(self, serial_port: str = SERIAL_PORT) -> None:
        self.serial_port = serial_port
        self._fd: int | None = None
        self._lock = threading.RLock()
        self._last_error = ""
        self._homed = False
        self._recovery_attempted = False
        self._last_recovery: dict[str, Any] | None = None
        self._manual_reference = False
        self._coordinate_offset = Position(0, 0, 0)
        self._maintenance_tap_count = 0
        self._maintenance_probe_index = 0
        self._maintenance_retry_count = 0
        self._last_reference_checkpoint: tuple[float, float, float, float] | None = None
        self._last_reference_checkpoint_at = 0.0
        self._live_touch_session: str | None = None
        self._live_touch_deadline = 0.0
        self._live_touch_z = TOUCH_Z
        self._live_touch_watchdog: threading.Thread | None = None
        self._closing = threading.Event()

    @property
    def homed(self) -> bool:
        return self._homed

    def _discover_port(self) -> str:
        if os.path.exists(self.serial_port):
            return self.serial_port
        candidates = sorted(glob.glob("/dev/cu.usbserial*"))
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            raise RuntimeError("No black-arm CH340 serial port was found.")
        raise RuntimeError(f"Multiple CH340 serial ports were found; select one explicitly: {candidates}")

    def _connect(self) -> None:
        if self._fd is not None:
            return
        port = self._discover_port()
        fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            attrs = termios.tcgetattr(fd)
            attrs[0] = 0
            attrs[1] = 0
            attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            attrs[3] = 0
            attrs[4] = termios.B9600
            attrs[5] = termios.B9600
            attrs[6][termios.VMIN] = 0
            attrs[6][termios.VTIME] = 1
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
            fcntl.ioctl(fd, IOSSIOSPEED, struct.pack("L", BAUD))
            fcntl.fcntl(fd, fcntl.F_SETFL, 0)
            termios.tcflush(fd, termios.TCIOFLUSH)
        except Exception:
            os.close(fd)
            raise
        self._fd = fd
        self.serial_port = port
        self._last_error = ""
        self._recovery_attempted = False
        self._last_recovery = None
        self._manual_reference = False
        self._coordinate_offset = Position(0, 0, 0)
        self._maintenance_tap_count = 0
        self._maintenance_probe_index = 0
        self._maintenance_retry_count = 0
        time.sleep(0.08)
        self._restore_manual_reference_locked()

    def _restore_manual_reference_locked(self) -> None:
        """Restore only when the live controller exactly matches our checkpoint.

        A driver process restart does not reset GRBL coordinates, while a power
        cycle normally does.  Matching the full controller position means a
        harmless software restart can recover immediately, but a cable pull,
        controller reset, or controller-coordinate change remains locked. GRBL
        cannot detect a manually shifted phone or skipped belt by itself.
        """

        if not RESTORE_MANUAL_REFERENCE or not MANUAL_REFERENCE_STATE_PATH.exists():
            return
        try:
            value = json.loads(MANUAL_REFERENCE_STATE_PATH.read_text("utf-8"))
            if value.get("version") != 1 or value.get("serialPort") != self.serial_port:
                return
            expected = Position(**value["controllerPosition"])
            coordinate_offset = Position(**value["coordinateOffset"])
            self._write(b"?")
            raw = self._read_until(lambda text: ">" in text, 0.5)
            current = self._parse_status(raw, self.serial_port, 0)
            if current.state != "Idle" or not positions_match(current.position, expected):
                return
            if abs(current.position.z - HOVER_Z) > 0.08:
                return
            if (
                abs(coordinate_offset.x) > MAX_MANUAL_REFERENCE_OFFSET_MM
                or abs(coordinate_offset.y) > MAX_MANUAL_REFERENCE_OFFSET_MM
                or abs(coordinate_offset.z) > 0.001
            ):
                return
            logical_x = current.position.x - coordinate_offset.x
            logical_y = current.position.y - coordinate_offset.y
            self._validate_xy(logical_x, logical_y)
            self._coordinate_offset = coordinate_offset
            self._manual_reference = True
            self._homed = True
            self._last_reference_checkpoint = (
                current.position.x,
                current.position.y,
                current.position.z,
                current.position.a,
            )
            self._last_reference_checkpoint_at = time.monotonic()
            self._last_recovery = {
                "status": "restored-manual-reference",
                "completedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "coordinateOffset": asdict(self._coordinate_offset),
                "warning": (
                    "The manual reference was safely restored from the same controller position. "
                    "A power cycle or position change will prevent restoration."
                ),
            }
        except (
            KeyError,
            TypeError,
            ValueError,
            OSError,
            RuntimeError,
            json.JSONDecodeError,
        ):
            # A stale or damaged checkpoint never prevents the driver from
            # starting; it simply leaves physical touch locked.
            return

    def _persist_manual_reference_locked(self, controller: Position) -> None:
        if not RESTORE_MANUAL_REFERENCE or not self._manual_reference:
            return
        signature = (controller.x, controller.y, controller.z, controller.a)
        now = time.monotonic()
        if (
            signature == self._last_reference_checkpoint
            and now - self._last_reference_checkpoint_at < 10
        ):
            return
        payload = {
            "version": 1,
            "serialPort": self.serial_port,
            "controllerPosition": asdict(controller),
            "coordinateOffset": asdict(self._coordinate_offset),
            "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        temporary = MANUAL_REFERENCE_STATE_PATH.with_name(
            f".{MANUAL_REFERENCE_STATE_PATH.name}.{os.getpid()}.tmp"
        )
        try:
            MANUAL_REFERENCE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                "utf-8",
            )
            os.replace(temporary, MANUAL_REFERENCE_STATE_PATH)
        except OSError:
            # Diagnostics persistence must never turn a healthy serial link
            # into an OFFLINE device because the disk is full or read-only.
            return
        finally:
            try:
                temporary.unlink()
            except OSError:
                pass
        self._last_reference_checkpoint = signature
        self._last_reference_checkpoint_at = now

    @staticmethod
    def _clear_manual_reference_checkpoint() -> None:
        try:
            MANUAL_REFERENCE_STATE_PATH.unlink()
        except OSError:
            pass

    def _disconnect(self, reason: str) -> None:
        if self._live_touch_session is not None and self._fd is not None:
            try:
                # Best effort only: a read failure must not skip the final Z
                # command when the serial write path is still usable.
                self._write(f"Z{HOVER_Z:.3f}\r".encode())
            except OSError:
                pass
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
        self._fd = None
        self._last_error = reason
        self._homed = False
        self._manual_reference = False
        self._coordinate_offset = Position(0, 0, 0)
        self._maintenance_tap_count = 0
        self._maintenance_probe_index = 0
        self._maintenance_retry_count = 0
        self._clear_live_touch_locked()

    def _write(self, value: bytes) -> None:
        if self._fd is None:
            raise RuntimeError("The black-arm serial port is not connected.")
        os.write(self._fd, value)

    def _read_until(self, predicate, timeout: float) -> str:
        if self._fd is None:
            raise RuntimeError("The black-arm serial port is not connected.")
        deadline = time.monotonic() + timeout
        output = bytearray()
        while time.monotonic() < deadline:
            wait = min(0.03, max(0.0, deadline - time.monotonic()))
            ready, _, _ = select.select([self._fd], [], [], wait)
            if not ready:
                continue
            chunk = os.read(self._fd, 4096)
            if chunk:
                output.extend(chunk)
                text = output.decode("utf-8", "replace")
                if predicate(text):
                    return text.strip()
        text = output.decode("utf-8", "replace").strip()
        raise RuntimeError(f"The controller response timed out: {text or 'empty response'}")

    def _send_command(self, command: str, timeout: float = 1.0) -> str:
        self._write(f"{command}\r".encode())

        def terminal(text: str) -> bool:
            lines = [line.strip() for line in text.replace("\r", "\n").split("\n")]
            return any(
                line == "ok" or line.lower().startswith("error:") or line.startswith("ALARM:")
                for line in lines
            )

        reply = self._read_until(terminal, timeout)
        lowered = reply.lower()
        if "error:" in lowered or "alarm:" in lowered:
            raise RuntimeError(f"The controller rejected {command!r}: {reply}")
        return reply

    @staticmethod
    def _parse_status(raw: str, port: str, latency_ms: int) -> MachineStatus:
        match = STATUS_RE.search(raw)
        if not match:
            raise RuntimeError(f"Could not parse the GRBL status: {raw or 'empty response'}")
        values = match.groupdict()
        pins_match = PINS_RE.search(raw)
        position = Position(
            x=float(values["x"]),
            y=float(values["y"]),
            z=float(values["z"]),
            a=float(values["a"] or 0),
        )
        return MachineStatus(
            ok=True,
            connected=True,
            port=port,
            state=values["state"],
            position=position,
            normalized_z=round(position.z - HOVER_Z, 3),
            feed=float(values["feed"] or 0),
            spindle=float(values["spindle"] or 0),
            latency_ms=latency_ms,
            updated_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            limit_pins="" if pins_match is None else pins_match.group("pins"),
        )

    def _status_locked(self) -> MachineStatus:
        started = time.monotonic()
        self._connect()
        self._write(b"?")
        raw = self._read_until(lambda text: ">" in text, 0.5)
        status = self._parse_status(
            raw,
            self.serial_port,
            int((time.monotonic() - started) * 1000),
        )
        status.homed = self._homed
        status.controller_position = Position(**asdict(status.position))
        if self._manual_reference:
            self._persist_manual_reference_locked(status.controller_position)
            status.position = Position(
                x=status.position.x - self._coordinate_offset.x,
                y=status.position.y - self._coordinate_offset.y,
                z=status.position.z,
                a=status.position.a,
            )
            status.reference_mode = "manual"
            status.coordinate_offset = Position(**asdict(self._coordinate_offset))
        elif self._homed:
            status.reference_mode = "sensor-home"
        status.recovery = self._last_recovery
        if self._live_touch_session is not None:
            status.live_touch = {
                "active": True,
                "expiresInMs": max(
                    0,
                    round((self._live_touch_deadline - time.monotonic()) * 1000),
                ),
            }
        return status

    def status(self) -> MachineStatus:
        with self._lock:
            try:
                return self._status_locked()
            except (OSError, RuntimeError, ValueError) as error:
                self._disconnect(str(error))
                return MachineStatus(
                    ok=False,
                    connected=False,
                    port=None,
                    state="OFFLINE",
                    position=Position(0, 0, 0),
                    normalized_z=0,
                    feed=0,
                    spindle=0,
                    latency_ms=0,
                    updated_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    recovery=self._last_recovery,
                    error=self._last_error,
                )

    def _wait_idle(self, timeout: float = 4.0) -> MachineStatus:
        deadline = time.monotonic() + timeout
        last: MachineStatus | None = None
        while time.monotonic() < deadline:
            last = self._status_locked()
            if last.state == "Idle":
                return last
            if "Alarm" in last.state:
                raise RuntimeError(f"The arm entered an alarm state: {last.state}")
            time.sleep(0.025)
        self._write(b"!")
        raise RuntimeError(
            f"The arm did not reach its target in time. Hold was sent; final state: "
            f"{last.state if last else 'unknown'}"
        )

    @staticmethod
    def _validate_xy(x: float, y: float) -> tuple[float, float]:
        if not MIN_X <= x <= MAX_X:
            raise ValueError(f"X={x:g} is outside the black-arm screen range {MIN_X:g}..{MAX_X:g}.")
        if not MIN_Y <= y <= MAX_Y:
            raise ValueError(f"Y={y:g} is outside the black-arm screen range {MIN_Y:g}..{MAX_Y:g}.")
        return x, y

    @staticmethod
    def _validate_calibration_xy(x: float, y: float) -> tuple[float, float]:
        if not CALIBRATION_MIN_X <= x <= CALIBRATION_MAX_X:
            raise ValueError(
                f"Calibration X={x:g} is outside the safe hover travel range "
                f"{CALIBRATION_MIN_X:g}..{CALIBRATION_MAX_X:g}"
            )
        if not CALIBRATION_MIN_Y <= y <= CALIBRATION_MAX_Y:
            raise ValueError(
                f"Calibration Y={y:g} is outside the safe hover travel range "
                f"{CALIBRATION_MIN_Y:g}..{CALIBRATION_MAX_Y:g}"
            )
        return x, y

    def _controller_xy(self, x: float, y: float) -> tuple[float, float]:
        if not self._manual_reference:
            return x, y
        return (
            x + self._coordinate_offset.x,
            y + self._coordinate_offset.y,
        )

    def _move_xy_at_z_locked(
        self,
        x: float,
        y: float,
        travel_z: float,
    ) -> MachineStatus:
        if not self._homed:
            raise RuntimeError("The arm has not been homed in this session; movement and touch are locked.")
        x, y = self._validate_xy(x, y)
        before = self._status_locked()
        if before.state != "Idle":
            raise RuntimeError(f"The arm cannot move in its current state: {before.state}")
        if abs(before.position.z - travel_z) > 0.08:
            raise RuntimeError(
                f"The stylus must be raised to Z={travel_z:g} before XY movement; "
                f"current Z={before.position.z:g}."
            )
        controller_x, controller_y = self._controller_xy(x, y)
        self._send_command(f"X{controller_x:.3f}Y{controller_y:.3f}")
        return self._wait_idle()

    def _move_xy_locked(self, x: float, y: float) -> MachineStatus:
        return self._move_xy_at_z_locked(x, y, HOVER_Z)

    def move_xy(self, x: float, y: float) -> MachineStatus:
        with self._lock:
            self._connect()
            return self._move_xy_locked(float(x), float(y))

    def calibration_move_xy(self, x: float, y: float) -> MachineStatus:
        """Move at hover height inside the wider calibration-only travel area."""
        with self._lock:
            self._connect()
            if not self._homed:
                raise RuntimeError("The arm has not been homed in this session; calibration movement is locked.")
            x, y = self._validate_calibration_xy(float(x), float(y))
            before = self._status_locked()
            if before.state != "Idle":
                raise RuntimeError(f"The arm cannot make a calibration move in its current state: {before.state}")
            if abs(before.position.z - HOVER_Z) > 0.08:
                raise RuntimeError(
                    f"The stylus must be at hover Z={HOVER_Z:g} before a calibration move; "
                    f"current Z={before.position.z:g}."
                )
            controller_x, controller_y = self._controller_xy(x, y)
            self._send_command(f"X{controller_x:.3f}Y{controller_y:.3f}")
            return self._wait_idle()

    def _set_z_locked(self, z: float) -> MachineStatus:
        if not HOVER_Z <= z <= MAX_Z:
            raise ValueError(f"Z={z:g} is outside the verified range {HOVER_Z:g}..{MAX_Z:g}.")
        self._send_command(f"Z{z:.3f}")
        return self._wait_idle()

    @staticmethod
    def _touch_z(value: float | None, fallback: float) -> float:
        z = fallback if value is None else float(value)
        if not MIN_TOUCH_Z <= z <= MAX_Z:
            raise ValueError(
                f"Touch Z={z:g} is outside the verified pressure range "
                f"{MIN_TOUCH_Z:g}..{MAX_Z:g}."
            )
        return z

    @staticmethod
    def _validate_live_touch_session(session_id: str) -> str:
        session = str(session_id).strip()
        if not session or len(session) > 160:
            raise ValueError("A live-touch session id of 1 to 160 characters is required.")
        return session

    def _clear_live_touch_locked(self) -> None:
        self._live_touch_session = None
        self._live_touch_deadline = 0.0
        self._live_touch_z = TOUCH_Z

    def _start_live_touch_watchdog_locked(self) -> None:
        if self._live_touch_watchdog is not None and self._live_touch_watchdog.is_alive():
            return
        self._live_touch_watchdog = threading.Thread(
            target=self._live_touch_watchdog_loop,
            name="screenhand-live-touch-watchdog",
            daemon=True,
        )
        self._live_touch_watchdog.start()

    def _release_expired_live_touch_locked(self, now: float | None = None) -> bool:
        current = time.monotonic() if now is None else now
        if (
            self._live_touch_session is None
            or current < self._live_touch_deadline
        ):
            return False
        try:
            self._set_z_locked(HOVER_Z)
        finally:
            self._clear_live_touch_locked()
        return True

    def _live_touch_watchdog_loop(self) -> None:
        while not self._closing.wait(0.1):
            try:
                with self._lock:
                    expired = self._release_expired_live_touch_locked()
                if expired:
                    print(
                        "Live-touch watchdog raised the stylus after a lost heartbeat.",
                        file=sys.stderr,
                        flush=True,
                    )
            except (OSError, RuntimeError, ValueError) as error:
                # Clearing the session prevents any further XY motion at an
                # uncertain Z. A failed serial release is surfaced in status.
                with self._lock:
                    self._last_error = f"Live-touch fail-safe release failed: {error}"
                    self._clear_live_touch_locked()
                print(self._last_error, file=sys.stderr, flush=True)

    def _require_live_touch_locked(self, session_id: str) -> str:
        session = self._validate_live_touch_session(session_id)
        self._release_expired_live_touch_locked()
        if self._live_touch_session is None:
            raise RuntimeError("No live mouse contact is active.")
        if self._live_touch_session != session:
            raise RuntimeError("The live mouse contact belongs to another session.")
        return session

    def _move_live_xy_locked(self, x: float, y: float) -> MachineStatus:
        if not self._homed:
            raise RuntimeError("The arm has not been homed in this session; live touch is locked.")
        x, y = self._validate_xy(x, y)
        before = self._status_locked()
        if before.state != "Idle":
            raise RuntimeError(f"The arm cannot drag in its current state: {before.state}")
        if abs(before.position.z - self._live_touch_z) > 0.12:
            raise RuntimeError(
                "Live XY movement is allowed only while the verified stylus contact is active."
            )
        controller_x, controller_y = self._controller_xy(x, y)
        self._send_command(f"X{controller_x:.3f}Y{controller_y:.3f}")
        return self._wait_idle()

    def live_touch_down(
        self,
        x: float,
        y: float,
        session_id: str,
        touch_z: float | None = None,
    ) -> MachineStatus:
        session = self._validate_live_touch_session(session_id)
        selected_touch_z = self._touch_z(touch_z, TOUCH_Z)
        with self._lock:
            self._connect()
            self._release_expired_live_touch_locked()
            if self._live_touch_session is not None:
                if self._live_touch_session != session:
                    raise RuntimeError("Another live mouse contact is already active.")
                self._live_touch_deadline = time.monotonic() + LIVE_TOUCH_TIMEOUT_SECONDS
                return self._status_locked()
            self._move_xy_locked(float(x), float(y))
            self._live_touch_session = session
            self._live_touch_deadline = time.monotonic() + LIVE_TOUCH_TIMEOUT_SECONDS
            self._live_touch_z = selected_touch_z
            try:
                self._set_z_locked(selected_touch_z)
            except (OSError, RuntimeError, ValueError):
                try:
                    self._set_z_locked(HOVER_Z)
                finally:
                    self._clear_live_touch_locked()
                raise
            self._start_live_touch_watchdog_locked()
            return self._status_locked()

    def live_touch_move(
        self,
        x: float,
        y: float,
        session_id: str,
    ) -> MachineStatus:
        with self._lock:
            self._connect()
            self._require_live_touch_locked(session_id)
            self._live_touch_deadline = time.monotonic() + LIVE_TOUCH_TIMEOUT_SECONDS
            self._move_live_xy_locked(float(x), float(y))
            self._live_touch_deadline = time.monotonic() + LIVE_TOUCH_TIMEOUT_SECONDS
            return self._status_locked()

    def live_touch_keepalive(self, session_id: str) -> MachineStatus:
        with self._lock:
            self._connect()
            self._require_live_touch_locked(session_id)
            self._live_touch_deadline = time.monotonic() + LIVE_TOUCH_TIMEOUT_SECONDS
            return self._status_locked()

    def live_touch_up(self, session_id: str) -> MachineStatus:
        session = self._validate_live_touch_session(session_id)
        with self._lock:
            self._connect()
            if self._live_touch_session is None:
                return self._status_locked()
            if self._live_touch_session != session:
                raise RuntimeError("The live mouse contact belongs to another session.")
            try:
                self._set_z_locked(HOVER_Z)
            finally:
                self._clear_live_touch_locked()
            return self._status_locked()

    def tap(
        self,
        x: float,
        y: float,
        duration_ms: int = DEFAULT_TAP_MS,
        touch_z: float | None = None,
    ) -> MachineStatus:
        duration_ms = max(MIN_TAP_MS, min(int(duration_ms), 450))
        selected_touch_z = self._touch_z(touch_z, TOUCH_Z)
        with self._lock:
            self._connect()
            self._move_xy_locked(float(x), float(y))
            try:
                self._set_z_locked(selected_touch_z)
                time.sleep(duration_ms / 1000)
            finally:
                self._set_z_locked(HOVER_Z)
            self._move_xy_locked(PARK_X, nearest_park_y(float(y)))
            return self._status_locked()

    def system_edge_tap(
        self,
        x: float,
        y: float,
        duration_ms: int,
        boundary: str,
        confirmation: str,
        touch_z: float | None = None,
    ) -> MachineStatus:
        """Tap one verified system control just outside the app touch inset."""

        if confirmation != "CALIBRATED_SYSTEM_EDGE_TAP":
            raise ValueError("The calibrated system-edge tap confirmation is required.")
        x, y = self._validate_calibration_xy(float(x), float(y))
        rules = {
            "minimumX": (MIN_X - x, MIN_Y <= y <= MAX_Y),
            "maximumX": (x - MAX_X, MIN_Y <= y <= MAX_Y),
            "minimumY": (MIN_Y - y, MIN_X <= x <= MAX_X),
            "maximumY": (y - MAX_Y, MIN_X <= x <= MAX_X),
        }
        if boundary not in rules:
            raise ValueError("The system-edge tap boundary is invalid.")
        extension, cross_axis_safe = rules[boundary]
        if not 0 < extension <= SYSTEM_EDGE_TAP_MAX_EXTENSION_MM:
            raise ValueError("The system-edge tap is outside its bounded edge extension.")
        if not cross_axis_safe:
            raise ValueError("The system-edge tap is outside the cross-axis touch range.")
        duration_ms = max(MIN_TAP_MS, min(int(duration_ms), 250))
        selected_touch_z = self._touch_z(touch_z, MIN_TOUCH_Z)
        with self._lock:
            self._connect()
            if not self._homed:
                raise RuntimeError("The arm has not been homed; system-edge touch is locked.")
            before = self._status_locked()
            if before.state != "Idle":
                raise RuntimeError(
                    f"The arm cannot start a system-edge tap in {before.state}."
                )
            if abs(before.position.z - HOVER_Z) > 0.08:
                raise RuntimeError(
                    f"The stylus must be at hover Z={HOVER_Z:g} before a system-edge tap."
                )
            controller_x, controller_y = self._controller_xy(x, y)
            self._send_command(f"X{controller_x:.3f}Y{controller_y:.3f}")
            self._wait_idle()
            try:
                self._set_z_locked(selected_touch_z)
                time.sleep(duration_ms / 1000)
            finally:
                self._set_z_locked(HOVER_Z)
            self._move_xy_locked(PARK_X, nearest_park_y(y))
            return self._status_locked()

    def tap_sequence(
        self,
        points: list[dict[str, Any]],
        duration_ms: int = 55,
        touch_z: float | None = None,
    ) -> MachineStatus:
        if not isinstance(points, list) or not 1 <= len(points) <= 256:
            raise ValueError("A tap sequence must contain 1 to 256 coordinates.")
        validated: list[tuple[float, float]] = []
        for index, point in enumerate(points):
            if not isinstance(point, dict) or "x" not in point or "y" not in point:
                raise ValueError(f"Tap-sequence coordinate {index} is invalid.")
            validated.append(self._validate_xy(float(point["x"]), float(point["y"])))
        duration_ms = max(MIN_TAP_MS, min(int(duration_ms), 150))
        selected_touch_z = self._touch_z(touch_z, TOUCH_Z)
        with self._lock:
            self._connect()
            self._move_xy_locked(*validated[0])
            try:
                # Stream one ordered GRBL program instead of waiting for an
                # Idle status after every axis command. GRBL acknowledges a
                # line only after it has room in its planner, so this remains
                # bounded while motion, dwell, release, and travel execute in
                # exactly that order on the controller.
                for index, (_x, _y) in enumerate(validated):
                    self._send_command(f"Z{selected_touch_z:.3f}")
                    self._send_command(f"G4P{duration_ms / 1000:.3f}")
                    self._send_command(f"Z{SEQUENCE_RELEASE_Z:.3f}")
                    if index + 1 < len(validated):
                        controller_x, controller_y = self._controller_xy(
                            *validated[index + 1]
                        )
                        self._send_command(
                            f"X{controller_x:.3f}Y{controller_y:.3f}"
                        )
                self._wait_idle(max(8.0, len(validated) * 0.8))
            finally:
                # A failed character must never leave the stylus pressed.
                try:
                    current = self._status_locked()
                    if abs(current.position.z - HOVER_Z) > 0.08:
                        self._set_z_locked(HOVER_Z)
                    self._move_xy_locked(PARK_X, nearest_park_y(validated[-1][1]))
                except (OSError, RuntimeError, ValueError):
                    try:
                        self._write(b"!")
                    except OSError:
                        pass
            return self._status_locked()

    def long_press(
        self,
        x: float,
        y: float,
        duration_ms: int,
        touch_z: float | None = None,
    ) -> MachineStatus:
        duration_ms = max(500, min(int(duration_ms), MAX_LONG_PRESS_MS))
        selected_touch_z = self._touch_z(touch_z, TOUCH_Z)
        with self._lock:
            self._connect()
            self._move_xy_locked(float(x), float(y))
            try:
                self._set_z_locked(selected_touch_z)
                time.sleep(duration_ms / 1000)
            finally:
                self._set_z_locked(HOVER_Z)
            self._move_xy_locked(PARK_X, nearest_park_y(float(y)))
            return self._status_locked()

    def swipe(
        self,
        start_x: float,
        start_y: float,
        end_x: float,
        end_y: float,
        duration_ms: int,
        touch_z: float | None = None,
    ) -> MachineStatus:
        start_x, start_y = self._validate_xy(float(start_x), float(start_y))
        end_x, end_y = self._validate_xy(float(end_x), float(end_y))
        duration_ms = max(250, min(int(duration_ms), 3_000))
        steps = max(8, min(90, round(duration_ms / 16)))
        selected_touch_z = self._touch_z(touch_z, SWIPE_TOUCH_Z)
        with self._lock:
            self._connect()
            self._move_xy_locked(start_x, start_y)
            try:
                self._set_z_locked(selected_touch_z)
                started = time.monotonic()
                for index in range(1, steps + 1):
                    # Smoothstep removes abrupt acceleration at both ends while
                    # preserving the operator's requested duration.
                    linear = index / steps
                    eased = linear * linear * (3 - 2 * linear)
                    x = start_x + (end_x - start_x) * eased
                    y = start_y + (end_y - start_y) * eased
                    controller_x, controller_y = self._controller_xy(x, y)
                    self._send_command(
                        f"X{controller_x:.3f}Y{controller_y:.3f}"
                    )
                    target = started + duration_ms / 1000 * linear
                    remaining = target - time.monotonic()
                    if remaining > 0:
                        time.sleep(remaining)
                self._wait_idle(max(4.0, duration_ms / 1000 + 2))
            finally:
                self._set_z_locked(HOVER_Z)
            self._move_xy_locked(PARK_X, nearest_park_y(float(end_y)))
            return self._status_locked()

    def system_edge_swipe(
        self,
        start_x: float,
        start_y: float,
        end_x: float,
        end_y: float,
        duration_ms: int,
        boundary: str,
        confirmation: str,
        touch_z: float | None = None,
    ) -> MachineStatus:
        """Perform one inward OS edge gesture in calibrated hover travel.

        Normal taps and mouse control remain inside the inset touch bounds.
        This narrowly scoped primitive permits only a short excursion through
        exactly one boundary, followed by a substantial inward move ending in
        the normal touch area. It exists for bezel-originated OS navigation.
        """

        if confirmation != "CALIBRATED_SYSTEM_EDGE_GESTURE":
            raise ValueError("The calibrated system-edge confirmation is required.")
        start_x, start_y = self._validate_calibration_xy(
            float(start_x),
            float(start_y),
        )
        end_x, end_y = self._validate_xy(float(end_x), float(end_y))
        rules = {
            "minimumX": (
                MIN_X - start_x,
                end_x - start_x,
                abs(end_y - start_y),
                MIN_Y <= start_y <= MAX_Y,
            ),
            "maximumX": (
                start_x - MAX_X,
                start_x - end_x,
                abs(end_y - start_y),
                MIN_Y <= start_y <= MAX_Y,
            ),
            "minimumY": (
                MIN_Y - start_y,
                end_y - start_y,
                abs(end_x - start_x),
                MIN_X <= start_x <= MAX_X,
            ),
            "maximumY": (
                start_y - MAX_Y,
                start_y - end_y,
                abs(end_x - start_x),
                MIN_X <= start_x <= MAX_X,
            ),
        }
        if boundary not in rules:
            raise ValueError("The system-edge boundary is invalid.")
        extension, inward_travel, lateral_drift, cross_axis_safe = rules[boundary]
        if not 0 < extension <= SYSTEM_EDGE_MAX_EXTENSION_MM:
            raise ValueError(
                "The system-edge start must be just outside one normal touch boundary."
            )
        if not cross_axis_safe:
            raise ValueError("The system-edge start is outside the cross-axis touch range.")
        if not (
            SYSTEM_EDGE_MIN_INWARD_TRAVEL_MM
            <= inward_travel
            <= SYSTEM_EDGE_MAX_INWARD_TRAVEL_MM
        ):
            raise ValueError("The system-edge swipe is not a bounded inward gesture.")
        if lateral_drift > SYSTEM_EDGE_MAX_LATERAL_DRIFT_MM:
            raise ValueError("The system-edge swipe has excessive lateral drift.")

        duration_ms = max(250, min(int(duration_ms), 700))
        steps = max(12, min(50, round(duration_ms / 16)))
        selected_touch_z = self._touch_z(touch_z, MIN_TOUCH_Z)
        with self._lock:
            self._connect()
            if not self._homed:
                raise RuntimeError("The arm has not been homed; system-edge touch is locked.")
            before = self._status_locked()
            if before.state != "Idle":
                raise RuntimeError(
                    f"The arm cannot start a system-edge swipe in {before.state}."
                )
            if abs(before.position.z - HOVER_Z) > 0.08:
                raise RuntimeError(
                    f"The stylus must be at hover Z={HOVER_Z:g} before a system-edge swipe."
                )
            controller_x, controller_y = self._controller_xy(start_x, start_y)
            self._send_command(f"X{controller_x:.3f}Y{controller_y:.3f}")
            self._wait_idle()
            try:
                self._set_z_locked(selected_touch_z)
                started = time.monotonic()
                for index in range(1, steps + 1):
                    linear = index / steps
                    eased = linear * linear * (3 - 2 * linear)
                    x = start_x + (end_x - start_x) * eased
                    y = start_y + (end_y - start_y) * eased
                    self._validate_calibration_xy(x, y)
                    controller_x, controller_y = self._controller_xy(x, y)
                    self._send_command(f"X{controller_x:.3f}Y{controller_y:.3f}")
                    remaining = started + duration_ms / 1000 * linear - time.monotonic()
                    if remaining > 0:
                        time.sleep(remaining)
                self._wait_idle(max(4.0, duration_ms / 1000 + 2))
            finally:
                self._set_z_locked(HOVER_Z)
            self._move_xy_locked(PARK_X, nearest_park_y(end_y))
            return self._status_locked()

    def hold(self) -> MachineStatus:
        with self._lock:
            self._connect()
            if self._live_touch_session is not None:
                try:
                    self._set_z_locked(HOVER_Z)
                finally:
                    self._clear_live_touch_locked()
            self._write(b"!")
            time.sleep(0.08)
            return self._status_locked()

    def resume(self) -> MachineStatus:
        with self._lock:
            self._connect()
            before = self._status_locked()
            if before.state == "Idle":
                return before
            if not before.state.startswith("Hold"):
                raise RuntimeError(f"Resume is allowed only from Hold; current state: {before.state}")
            self._write(b"~")
            return self._wait_idle(3.0)

    def maintenance_tap_current(self) -> MachineStatus:
        """Touch at the current XY without accepting any remote coordinates.

        This is used only to draw a visible one-millimetre reference stroke
        after a sensor has failed.  iOS Notes does not reliably render a
        stationary down/up as ink, so the stylus moves only in the verified
        positive X release direction and returns at hover height.  The action
        is limited to three attempts per serial session.
        """

        if not MAINTENANCE_ENABLED:
            raise RuntimeError("Local black-arm maintenance mode is not enabled.")
        with self._lock:
            self._connect()
            if self._homed:
                raise RuntimeError("The arm already has a valid reference; maintenance touch is not allowed.")
            if self._maintenance_tap_count >= 3:
                raise RuntimeError("This connection has reached the maintenance-touch limit.")
            if self._maintenance_probe_index != self._maintenance_tap_count + 1:
                raise RuntimeError("Move the probe into the fixed screen calibration area first.")
            before = self._status_locked()
            if before.state != "Idle":
                raise RuntimeError(f"Maintenance touch requires Idle; current state: {before.state}")
            if set(before.limit_pins) not in ({"X"}, {"X", "Y"}):
                raise RuntimeError(
                    "Maintenance touch is only for a confirmed X or X+Y input fault; active inputs: "
                    + (before.limit_pins or "none")
                )
            if not 0.8 <= before.position.z <= 2.1:
                raise RuntimeError(
                    f"Z must be in the safe hover range before maintenance touch; current Z={before.position.z:g}."
                )
            self._maintenance_tap_count += 1
            controller = before.controller_position or before.position
            stroke_x = controller.x + MAINTENANCE_STROKE_MM
            try:
                self._set_z_locked(TOUCH_Z)
                self._send_command(f"X{stroke_x:.3f}Y{controller.y:.3f}")
                self._wait_idle()
                time.sleep(DEFAULT_TAP_MS / 1000)
            finally:
                self._set_z_locked(before.position.z)
                self._send_command(
                    f"X{controller.x:.3f}Y{controller.y:.3f}"
                )
                self._wait_idle()
            return self._status_locked()

    def maintenance_move_probe(self) -> MachineStatus:
        """Enter one fixed, previously verified screen coordinate.

        The failed US unit is left at controller X=8/Y=0 after the bounded
        sensor release.  That point is outside the useful screen.  The three
        fixed XY positions move only in the verified positive release
        directions and cover the lower, middle, and upper drawing canvas.
        This action accepts no coordinates; each position may be touched only
        once.
        """

        if not MAINTENANCE_ENABLED:
            raise RuntimeError("Local black-arm maintenance mode is not enabled.")
        with self._lock:
            self._connect()
            if self._homed:
                raise RuntimeError("The arm already has a valid reference; maintenance probe movement is not allowed.")
            if self._maintenance_probe_index >= len(MAINTENANCE_PROBE_POSITIONS):
                raise RuntimeError("This connection has used all fixed maintenance-probe positions.")
            before = self._status_locked()
            controller = before.controller_position or before.position
            if before.state != "Idle":
                raise RuntimeError(f"Maintenance probe movement requires Idle; current state: {before.state}")
            if set(before.limit_pins) not in ({"X"}, {"X", "Y"}):
                raise RuntimeError(
                    "Maintenance probe movement is only for a confirmed X or X+Y input fault; active inputs: "
                    + (before.limit_pins or "none")
                )
            if not 0.8 <= controller.z <= 2.1:
                raise RuntimeError(
                    f"Z must be in the safe hover range before maintenance probe movement; current Z={controller.z:g}."
                )
            if self._maintenance_probe_index == 0:
                valid_start = any(
                    abs(controller.x - start_x) <= 0.5
                    and abs(controller.y - start_y) <= 0.5
                    for start_x, start_y in MAINTENANCE_START_POSITIONS
                )
                expected_description = "one of the four fixed recovery points"
            else:
                expected_x, expected_y = MAINTENANCE_PROBE_POSITIONS[
                    self._maintenance_probe_index - 1
                ]
                valid_start = (
                    abs(controller.x - expected_x) <= 0.5
                    and abs(controller.y - expected_y) <= 0.5
                )
                expected_description = f"X={expected_x:g}/Y={expected_y:g}"
            if not valid_start:
                raise RuntimeError(
                    "Maintenance probe movement is limited to the fixed screen sequence "
                    "(40,80) -> (25,40) -> (55,120); current "
                    f"X={controller.x:g}/Y={controller.y:g}; expected "
                    f"{expected_description}"
                )

            target_x, target_y = MAINTENANCE_PROBE_POSITIONS[
                self._maintenance_probe_index
            ]
            self._send_command(
                f"X{target_x:.3f}Y{target_y:.3f}"
            )
            after = self._wait_idle(8.0)
            after_controller = after.controller_position or after.position
            if (
                abs(after_controller.x - target_x) > 0.1
                or abs(after_controller.y - target_y) > 0.1
            ):
                raise RuntimeError("The maintenance probe did not reach the fixed calibration position.")
            self._maintenance_probe_index += 1
            return self._status_locked()

    def set_manual_reference(
        self,
        logical_x: float,
        logical_y: float,
        confirmed: bool,
    ) -> MachineStatus:
        """Anchor this controller session to one observed phone-screen point."""

        if confirmed is not True:
            raise ValueError("An on-site operator must confirm the manual reference point.")
        if not MAINTENANCE_ENABLED:
            raise RuntimeError("Local black-arm maintenance mode is not enabled.")
        logical_x, logical_y = self._validate_xy(
            float(logical_x),
            float(logical_y),
        )
        with self._lock:
            self._connect()
            if self._homed:
                raise RuntimeError("The arm already has a reference for this connection.")
            if self._maintenance_tap_count < 1:
                raise RuntimeError("Make one maintenance touch and read its actual screen position first.")
            before = self._status_locked()
            if before.state != "Idle":
                raise RuntimeError(f"Setting a reference requires Idle; current state: {before.state}")
            if set(before.limit_pins) not in ({"X"}, {"X", "Y"}):
                raise RuntimeError(
                    "Manual reference is only for a confirmed X or X+Y input fault; active inputs: "
                    + (before.limit_pins or "none")
                )
            if abs(before.position.z - HOVER_Z) > 1.1:
                raise RuntimeError(
                    f"The stylus must be hovering while setting a reference; current Z={before.position.z:g}."
                )

            controller = before.controller_position or before.position
            coordinate_offset = Position(
                x=controller.x - logical_x,
                y=controller.y - logical_y,
                z=0,
            )
            if (
                abs(coordinate_offset.x) > MAX_MANUAL_REFERENCE_OFFSET_MM
                or abs(coordinate_offset.y) > MAX_MANUAL_REFERENCE_OFFSET_MM
            ):
                raise RuntimeError(
                    "The visual-reference offset from the fixed fixture is too large: "
                    f"X={coordinate_offset.x:g}/Y={coordinate_offset.y:g} mm"
                )
            self._coordinate_offset = coordinate_offset
            # The failed recovery left this unit at Z=1.5.  Raising it to the
            # verified Z=1 hover plane is both mechanically safe and required
            # by the normal control-plane touch gate.
            if abs(before.position.z - HOVER_Z) > 0.08:
                self._set_z_locked(HOVER_Z)
            self._manual_reference = True
            self._homed = True
            self._last_recovery = {
                "status": "manual-reference",
                "completedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "anchor": {
                    "logical": {"x": logical_x, "y": logical_y},
                    "controller": {"x": controller.x, "y": controller.y},
                },
                "coordinateOffset": asdict(self._coordinate_offset),
                "warning": (
                    "The X/Y limit inputs still require repair. Restoration across a driver restart "
                    "is allowed only when the controller position matches exactly."
                ),
            }
            return self._status_locked()

    def revoke_manual_reference(self) -> MachineStatus:
        """Relock touch immediately if the automatic validation point fails."""

        if not MAINTENANCE_ENABLED:
            raise RuntimeError("Local black-arm maintenance mode is not enabled.")
        with self._lock:
            self._connect()
            before = self._status_locked()
            if not self._manual_reference:
                raise RuntimeError("The arm has no manual reference to revoke.")
            if abs(before.position.z - HOVER_Z) > 0.08:
                self._set_z_locked(HOVER_Z)
            self._homed = False
            self._manual_reference = False
            self._coordinate_offset = Position(0, 0, 0)
            self._clear_manual_reference_checkpoint()
            self._last_recovery = {
                "status": "failed",
                "failedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "error": "The second-point visual-reference check failed; touch has been relocked.",
            }
            return self._status_locked()

    def prepare_visual_retry(self) -> MachineStatus:
        """Return once from the known post-validation park to a fixed probe.

        A failed second-point check parks the stylus near the X/Z home corner
        before revoking the temporary coordinate offset.  This bounded action
        accepts no coordinates and moves only positive Z/X/Y from that narrow
        known envelope back to X=40/Y=80/Z=1.5.  It can run once per serial
        connection, allowing a corrected browser-scale profile to be verified
        without power cycling or bypassing the normal motion gate.
        """

        if not MAINTENANCE_ENABLED:
            raise RuntimeError("Local black-arm maintenance mode is not enabled.")
        with self._lock:
            self._connect()
            if self._maintenance_retry_count >= 1:
                raise RuntimeError("The visual retry for this serial connection has already been used.")
            if self._homed or self._manual_reference:
                raise RuntimeError("The arm already has a valid reference; visual retry cannot be prepared.")
            before = self._status_locked()
            controller = before.controller_position or before.position
            if before.state != "Idle":
                raise RuntimeError(f"Visual-retry preparation requires Idle; current state: {before.state}")
            if not set(before.limit_pins).issubset({"X", "Y", "Z"}) or (
                "X" not in before.limit_pins
            ):
                raise RuntimeError(
                    "Visual retry is only for a confirmed homing-input fault that includes X."
                )
            if not (
                2.0 <= controller.x <= 35.0
                and 2.0 <= controller.y <= 40.0
                and 0.8 <= controller.z <= 2.1
            ):
                raise RuntimeError(
                    "The arm is outside the verified failed-park area; automatic retry is blocked: "
                    f"X={controller.x:g}/Y={controller.y:g}/Z={controller.z:g}"
                )

            # Different units release the physical Z input at slightly
            # different heights.  The US unit needs Z=2.0 while the first
            # fixture released at Z=1.5.  Walk upward in bounded 0.5 mm steps
            # instead of assuming every switch clears at the first height.
            # 2.1 mm is already the verified maintenance ceiling used by the
            # rest of this recovery path.
            raised = before
            while "Z" in raised.limit_pins and raised.position.z < 2.05:
                target_z = min(2.0, max(1.5, raised.position.z + 0.5))
                raised = self._set_z_locked(target_z)
            if "Z" in raised.limit_pins:
                raise RuntimeError("The Z input remained active after raising to 2.0 mm.")
            self._send_command("X40.000Y80.000")
            moved = self._wait_idle(8.0)
            moved_controller = moved.controller_position or moved.position
            if (
                abs(moved_controller.x - 40.0) > 0.1
                or abs(moved_controller.y - 80.0) > 0.1
            ):
                raise RuntimeError("Visual retry did not reach the fixed X=40/Y=80 calibration point.")
            self._maintenance_probe_index = 0
            self._maintenance_tap_count = 0
            self._maintenance_retry_count += 1
            self._last_recovery = {
                "status": "visual-retry-ready",
                "preparedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "position": asdict(moved_controller),
            }
            return self._status_locked()

    @staticmethod
    def _recovery_status(status: MachineStatus) -> dict[str, Any]:
        return {
            "state": status.state,
            "limitPins": status.limit_pins,
            "position": asdict(status.position),
        }

    def _release_active_limits_locked(self, status: MachineStatus) -> MachineStatus:
        """Move only away from active homing inputs before starting `$H`.

        This controller can boot while its X or Z homing input is still active.
        GRBL then aborts with ALARM:8 because the normal 1 mm pull-off is not
        enough to clear the input.  The directions below are established by
        the machine's `$23=7` profile and were verified on the first unit:
        positive X/Y/Z moves away from the homing inputs.

        The recovery is deliberately bounded and may run only once per serial
        connection.  It never attempts to ignore an input that remains active.
        """

        unsupported = sorted(set(status.limit_pins) - {"X", "Y", "Z"})
        if unsupported:
            raise RuntimeError(
                "Unsupported homing inputs detected: " + "".join(unsupported)
            )

        for axis in ("Z", "X", "Y"):
            if axis not in status.limit_pins:
                continue
            if axis in {"X", "Y"} and status.position.z > 2.1:
                raise RuntimeError(
                    f"The stylus is at Z={status.position.z:g}; the {axis} input cannot be released safely."
                )

            origin = float(getattr(status.position, axis.lower()))
            maximum = LIMIT_RELEASE_MAX_MM[axis]
            step_count = max(1, int(maximum / LIMIT_RELEASE_STEP_MM))
            for index in range(1, step_count + 1):
                distance = min(index * LIMIT_RELEASE_STEP_MM, maximum)
                target = origin + distance
                if axis == "Z":
                    command = f"Z{target:.3f}"
                else:
                    x = target if axis == "X" else status.position.x
                    y = target if axis == "Y" else status.position.y
                    command = f"X{x:.3f}Y{y:.3f}"
                self._send_command(command)
                status = self._wait_idle()
                if self._last_recovery is not None:
                    self._last_recovery["steps"].append(
                        {
                            "axis": axis,
                            "distanceMm": round(distance, 3),
                            "command": command,
                            **self._recovery_status(status),
                        }
                    )
                    self._last_recovery["current"] = self._recovery_status(status)
                if axis not in status.limit_pins:
                    break

            if axis in status.limit_pins:
                raise RuntimeError(
                    f"The {axis} homing input remained active after moving away {maximum:g} mm; "
                    "the sensor, wiring, or controller input may be faulty."
                )
        return status

    def home(self) -> MachineStatus:
        with self._lock:
            self._connect()
            before = self._status_locked()
            if self._homed and before.state == "Idle":
                return before
            if self._recovery_attempted:
                previous = self._last_recovery or {}
                raise RuntimeError(
                    str(previous.get("error") or "Homing recovery has already been attempted for this serial connection.")
                )

            self._recovery_attempted = True
            self._last_recovery = {
                "status": "running",
                "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "initial": self._recovery_status(before),
                "current": self._recovery_status(before),
                "steps": [],
            }
            try:
                if before.state.startswith("Hold"):
                    self._write(b"~")
                    before = self._wait_idle(3.0)
                elif before.state.startswith("Alarm"):
                    self._send_command("$X")
                    before = self._status_locked()
                if before.state != "Idle":
                    raise RuntimeError(f"The arm could not enter the homing-ready state: {before.state}")

                before = self._release_active_limits_locked(before)
                self._last_recovery["beforeHome"] = self._recovery_status(before)

                # This GRBL fork starts homing immediately but does not emit
                # the normal command-level `ok` until the cycle has completed.
                self._write(b"$H\r")
                started = time.monotonic()
                saw_cycle = False
                last: MachineStatus | None = None
                while time.monotonic() - started < 45.0:
                    time.sleep(0.08)
                    last = self._status_locked()
                    if last.state != "Idle":
                        saw_cycle = True
                    if last.state.startswith("Alarm"):
                        raise RuntimeError(
                            f"Arm homing alarm: {last.state}"
                            + (f"; active inputs: {last.limit_pins}" if last.limit_pins else "")
                        )
                    if last.state == "Idle" and (
                        saw_cycle or time.monotonic() - started >= 0.8
                    ):
                        self._homed = True
                        self._manual_reference = False
                        self._coordinate_offset = Position(0, 0, 0)
                        self._clear_manual_reference_checkpoint()
                        last.homed = True
                        self._last_recovery.update(
                            {
                                "status": "complete",
                                "completedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                                "current": self._recovery_status(last),
                            }
                        )
                        last.recovery = self._last_recovery
                        return last
                self._write(b"!")
                raise RuntimeError(
                    "Arm homing timed out. Hold was sent; final state: "
                    + (last.state if last else "unknown")
                )
            except (OSError, RuntimeError, ValueError) as error:
                try:
                    current = self._status_locked()
                    current_value = self._recovery_status(current)
                except (OSError, RuntimeError, ValueError):
                    current_value = self._last_recovery.get("current", {})
                self._last_recovery.update(
                    {
                        "status": "failed",
                        "failedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                        "current": current_value,
                        "error": str(error),
                    }
                )
                raise

    def close(self) -> None:
        with self._lock:
            if self._live_touch_session is not None and self._fd is not None:
                try:
                    self._set_z_locked(HOVER_Z)
                except (OSError, RuntimeError, ValueError):
                    pass
                finally:
                    self._clear_live_touch_locked()
            self._closing.set()
            self._disconnect("Service stopped.")


DRIVER = BlackArmDriver()


class Handler(BaseHTTPRequestHandler):
    server_version = "ScreenHandBlackArm/0.1"

    def _headers(self, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _json(self, value: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        self._headers(status)
        self.wfile.write(json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._headers(HTTPStatus.NO_CONTENT)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in {"/", "/health"}:
            self._json(
                {
                    "ok": True,
                    "service": "ScreenHand black arm direct driver",
                    "serial": f"{BAUD} 8N1",
                    "maintenance": MAINTENANCE_ENABLED,
                    "profile": {
                        "x": [MIN_X, MAX_X],
                        "y": [MIN_Y, MAX_Y],
                        "hoverZ": HOVER_Z,
                        "touchZ": TOUCH_Z,
                        "minimumTouchZ": MIN_TOUCH_Z,
                        "sequenceReleaseZ": SEQUENCE_RELEASE_Z,
                        "maximumTouchZ": MAX_Z,
                        "liveTouchTimeoutMs": round(LIVE_TOUCH_TIMEOUT_SECONDS * 1000),
                        "calibrationX": [CALIBRATION_MIN_X, CALIBRATION_MAX_X],
                        "calibrationY": [CALIBRATION_MIN_Y, CALIBRATION_MAX_Y],
                    },
                }
            )
            return
        if self.path == "/api/status":
            self._json(DRIVER.status().to_dict())
            return
        self._json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        try:
            body = self._body()
            if self.path == "/api/move":
                status = DRIVER.move_xy(float(body["x"]), float(body["y"]))
            elif self.path == "/api/calibration/move":
                status = DRIVER.calibration_move_xy(
                    float(body["x"]),
                    float(body["y"]),
                )
            elif self.path == "/api/tap":
                status = DRIVER.tap(
                    float(body["x"]),
                    float(body["y"]),
                    int(body.get("durationMs", DEFAULT_TAP_MS)),
                    float(body["touchZ"]) if "touchZ" in body else None,
                )
            elif self.path == "/api/live-touch/down":
                status = DRIVER.live_touch_down(
                    float(body["x"]),
                    float(body["y"]),
                    str(body["sessionId"]),
                    float(body["touchZ"]) if "touchZ" in body else None,
                )
            elif self.path == "/api/live-touch/move":
                status = DRIVER.live_touch_move(
                    float(body["x"]),
                    float(body["y"]),
                    str(body["sessionId"]),
                )
            elif self.path == "/api/live-touch/up":
                status = DRIVER.live_touch_up(str(body["sessionId"]))
            elif self.path == "/api/live-touch/keepalive":
                status = DRIVER.live_touch_keepalive(str(body["sessionId"]))
            elif self.path == "/api/tap_sequence":
                status = DRIVER.tap_sequence(
                    body["points"],
                    int(body.get("durationMs", 55)),
                    float(body["touchZ"]) if "touchZ" in body else None,
                )
            elif self.path == "/api/long_press":
                status = DRIVER.long_press(
                    float(body["x"]),
                    float(body["y"]),
                    int(body.get("durationMs", 800)),
                    float(body["touchZ"]) if "touchZ" in body else None,
                )
            elif self.path == "/api/swipe":
                status = DRIVER.swipe(
                    float(body["startX"]),
                    float(body["startY"]),
                    float(body["endX"]),
                    float(body["endY"]),
                    int(body.get("durationMs", 500)),
                    float(body["touchZ"]) if "touchZ" in body else None,
                )
            elif self.path == "/api/system-edge-swipe":
                status = DRIVER.system_edge_swipe(
                    float(body["startX"]),
                    float(body["startY"]),
                    float(body["endX"]),
                    float(body["endY"]),
                    int(body.get("durationMs", 360)),
                    str(body["boundary"]),
                    str(body.get("confirmation", "")),
                    float(body["touchZ"]) if "touchZ" in body else None,
                )
            elif self.path == "/api/system-edge-tap":
                status = DRIVER.system_edge_tap(
                    float(body["x"]),
                    float(body["y"]),
                    int(body.get("durationMs", DEFAULT_TAP_MS)),
                    str(body["boundary"]),
                    str(body.get("confirmation", "")),
                    float(body["touchZ"]) if "touchZ" in body else None,
                )
            elif self.path == "/api/hold":
                status = DRIVER.hold()
            elif self.path == "/api/resume":
                status = DRIVER.resume()
            elif self.path == "/api/home-machine":
                status = DRIVER.home()
            elif self.path == "/api/maintenance/tap-current":
                status = DRIVER.maintenance_tap_current()
            elif self.path == "/api/maintenance/probe-screen":
                status = DRIVER.maintenance_move_probe()
            elif self.path == "/api/maintenance/manual-reference":
                status = DRIVER.set_manual_reference(
                    float(body["logicalX"]),
                    float(body["logicalY"]),
                    body.get("confirmed") is True,
                )
            elif self.path == "/api/maintenance/revoke-reference":
                status = DRIVER.revoke_manual_reference()
            elif self.path == "/api/maintenance/prepare-visual-retry":
                status = DRIVER.prepare_visual_retry()
            else:
                self._json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
                return
            self._json({"ok": True, "status": status.to_dict()})
        except (KeyError, ValueError, RuntimeError, OSError, json.JSONDecodeError) as error:
            self._json(
                {"ok": False, "error": str(error)},
                HTTPStatus.BAD_REQUEST,
            )

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Black arm driver listening on http://{HOST}:{PORT}", flush=True)
    print(f"Serial {SERIAL_PORT} at {BAUD}; hover Z={HOVER_Z:g}, touch Z={TOUCH_Z:g}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        DRIVER.close()
        server.server_close()


if __name__ == "__main__":
    main()

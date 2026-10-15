import {
  containDimensions,
  describeStep,
  interpolateHoverPath,
  MAX_HOVER_PATH_DURATION_MS,
  MAX_HOVER_PATH_POINTS,
  materializeAction,
  normalizeStep,
  normalizeWorkflow,
  shouldRunStep,
} from "./workflow.js";

const API_ROOT = "/screenhand";
const LIVE_SOCKET_ORIGIN = "ws://127.0.0.1:3013";
const LEGACY_WORKFLOW_STORAGE_KEY = "screenhand.action-recorder.workflow.v1";
const WORKFLOW_STORAGE_PREFIX = "screenhand.action-recorder.workflow.v1:";
const LEASE_STORAGE_PREFIX = "screenhand.action-recorder.lease.v1:";
const RECORDER_PREFERENCES_KEY = "screenhand.action-recorder.preferences.v1";
const REQUESTED_DEVICE_ID = new URLSearchParams(window.location.search).get("device")?.trim() ?? "";
const HOVER_MOVE_INTERVAL_MS = 50;
const HOVER_REPLAY_FRAME_REFRESH_MS = 1_000;

const elements = Object.fromEntries([
  "systemDot", "systemText", "refreshDevices", "deviceSelect", "connectionValue",
  "videoValue", "touchValue", "machineValue", "gateReason", "executeWhileRecording",
  "recordMouseTrajectory", "pressurePreset",
  "startRecording", "stopRecording", "clearSteps", "infiniteLoop", "loopCount",
  "loopDelay", "runLoop", "stopLoop", "emergencyHold", "phoneTitle", "frameDetail",
  "recordingBadge", "runningBadge", "phoneStage", "phoneCanvas", "stageEmpty",
  "mouseTracker", "mouseTrackerLabel", "gesturePreview", "stageHint", "streamDot", "streamText", "sequenceText",
  "workflowName", "saveWorkflow", "exportWorkflow", "importWorkflow", "importFile",
  "stepList", "stepCount", "stepsEmpty", "clearLog", "activityLog", "toast",
].map((id) => [id, document.getElementById(id)]));

const state = {
  devices: [],
  selectedId: "",
  preferredDeviceId: REQUESTED_DEVICE_ID,
  loadedWorkflowDeviceId: "",
  frame: null,
  socket: null,
  reconnectTimer: null,
  pendingMetadata: null,
  queuedFrame: null,
  decodeActive: false,
  recording: false,
  lastRecordedAt: null,
  pointer: null,
  steps: [],
  runners: new Map(),
  toastTimer: null,
  recordExecutionChain: Promise.resolve(),
  hoverTimer: null,
  pendingHover: null,
  lastHoverSent: null,
  activeHoverPath: null,
};

function workflowStorageKey(deviceId) {
  return `${WORKFLOW_STORAGE_PREFIX}${encodeURIComponent(deviceId || "unassigned")}`;
}

function leaseStorageKey(deviceId) {
  return `${LEASE_STORAGE_PREFIX}${encodeURIComponent(deviceId)}`;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function log(message, type = "") {
  const line = document.createElement("div");
  line.className = `activity-line ${type}`.trim();
  const time = document.createElement("time");
  time.textContent = nowLabel();
  const text = document.createElement("span");
  text.textContent = message;
  line.append(time, text);
  elements.activityLog.append(line);
  elements.activityLog.scrollTop = elements.activityLog.scrollHeight;
}

function toast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 3_200);
}

function loadRecorderPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(RECORDER_PREFERENCES_KEY) ?? "null");
    if (typeof preferences?.recordMouseTrajectory === "boolean") {
      elements.recordMouseTrajectory.checked = preferences.recordMouseTrajectory;
    }
  } catch {
    localStorage.removeItem(RECORDER_PREFERENCES_KEY);
  }
}

function saveRecorderPreferences() {
  localStorage.setItem(RECORDER_PREFERENCES_KEY, JSON.stringify({
    recordMouseTrajectory: elements.recordMouseTrajectory.checked,
  }));
}

async function api(path, init = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { error: `ScreenHand returned ${response.status}.` };
  }
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error ?? `ScreenHand returned ${response.status}.`);
    error.status = response.status;
    error.code = payload?.code ?? "";
    throw error;
  }
  return payload;
}

function selectedDevice() {
  return state.devices.find((device) => device.id === state.selectedId) ?? null;
}

function runnerFor(deviceId) {
  return state.runners.get(deviceId) ?? null;
}

function selectedRunner() {
  return runnerFor(state.selectedId);
}

function selectedDeviceIsRunning() {
  return Boolean(selectedRunner());
}

function setStatusValue(element, value, tone = "") {
  element.textContent = value;
  element.className = tone;
}

function renderDeviceStatus() {
  const device = selectedDevice();
  elements.phoneTitle.textContent = device ? device.id : "No device selected";
  if (!device) {
    setStatusValue(elements.connectionValue, "—");
    setStatusValue(elements.videoValue, "—");
    setStatusValue(elements.touchValue, "—");
    setStatusValue(elements.machineValue, "—");
    elements.gateReason.textContent = "Select an online ScreenHand device.";
    elements.gateReason.className = "notice";
    return;
  }
  setStatusValue(elements.connectionValue, device.connected ? "Online" : "Offline", device.connected ? "good" : "bad");
  const videoMode = device.state?.videoMode === "wired" ? "Wired" : device.state?.cameraReady ? "Physical camera" : "Waiting";
  setStatusValue(elements.videoValue, videoMode, device.state?.cameraReady || device.state?.digitalReady ? "good" : "bad");
  const touch = device.capabilities?.actions?.tap;
  setStatusValue(elements.touchValue, touch?.available ? "Ready" : "Locked", touch?.available ? "good" : "bad");
  const machineState = device.state?.grbl?.state ?? "Unknown";
  setStatusValue(elements.machineValue, machineState, machineState === "Idle" ? "good" : "bad");
  elements.gateReason.textContent = touch?.available
    ? "Physical touch is calibrated. The recorder will still re-check every action."
    : touch?.reason ?? "Physical actions are unavailable.";
  elements.gateReason.className = `notice ${touch?.available ? "" : "error"}`.trim();
}

function renderDeviceOptions() {
  const previous = state.selectedId;
  elements.deviceSelect.replaceChildren();
  if (state.devices.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No ScreenHand devices";
    elements.deviceSelect.append(option);
    state.selectedId = "";
  } else {
    for (const device of state.devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = `${device.id} · ${device.connected ? "online" : "offline"}${runnerFor(device.id) ? " · running" : ""}`;
      elements.deviceSelect.append(option);
    }
    state.selectedId = state.devices.some((device) => device.id === previous)
      ? previous
      : state.devices.some((device) => device.id === state.preferredDeviceId)
        ? state.preferredDeviceId
        : state.devices[0].id;
    elements.deviceSelect.value = state.selectedId;
  }
  if (state.selectedId !== previous) {
    connectLiveFrames();
    if (state.selectedId && state.loadedWorkflowDeviceId !== state.selectedId) {
      state.loadedWorkflowDeviceId = state.selectedId;
      loadStoredWorkflow(state.selectedId);
    }
    updateRunnerButtons();
  }
  renderDeviceStatus();
}

async function refreshDevices({ quiet = false } = {}) {
  try {
    const payload = await api("/api/v1/devices");
    state.devices = payload.devices ?? [];
    elements.systemDot.className = "status-dot online";
    const online = state.devices.filter((device) => device.connected).length;
    const running = state.runners.size;
    elements.systemText.textContent = `${online} device${online === 1 ? "" : "s"} online${running ? ` · ${running} running` : ""}`;
    renderDeviceOptions();
  } catch (error) {
    elements.systemDot.className = "status-dot error";
    elements.systemText.textContent = "Control plane unavailable";
    if (!quiet) {
      const message = error instanceof Error ? error.message : "Unable to load devices.";
      log(message, "error");
      toast(message);
    }
  }
}

function solve(rows) {
  const size = rows.length;
  const matrix = rows.map((row) => [...row]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-10) throw new Error("Invalid screen calibration.");
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const scale = matrix[column][column];
    for (let item = column; item <= size; item += 1) matrix[column][item] /= scale;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let item = column; item <= size; item += 1) matrix[row][item] -= factor * matrix[column][item];
    }
  }
  return matrix.map((row) => row[size]);
}

function homography(source, destination) {
  const rows = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = source[index];
    const { x: u, y: v } = destination[index];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const value = solve(rows);
  return [value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7], 1];
}

function project(matrix, point) {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function drawTriangle(context, image, source, destination) {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
  const denominator = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denominator) < 1e-8) return;
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denominator;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denominator;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denominator;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denominator;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denominator;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denominator;
  context.save();
  context.beginPath();
  context.moveTo(d0.x, d0.y);
  context.lineTo(d1.x, d1.y);
  context.lineTo(d2.x, d2.y);
  context.closePath();
  context.clip();
  context.setTransform(a, b, c, d, e, f);
  context.drawImage(image, 0, 0);
  context.restore();
}

function drawFrame(image, metadata) {
  const canvas = elements.phoneCanvas;
  canvas.width = metadata.width;
  canvas.height = metadata.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#050608";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!metadata.rectified || !metadata.imagePoints) {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return;
  }
  const outputCorners = [
    { x: 0, y: 0 },
    { x: canvas.width, y: 0 },
    { x: canvas.width, y: canvas.height },
    { x: 0, y: canvas.height },
  ];
  const outputToCamera = homography(outputCorners, metadata.imagePoints);
  const columns = 20;
  const rows = 36;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = (column / columns) * canvas.width;
      const right = ((column + 1) / columns) * canvas.width;
      const top = (row / rows) * canvas.height;
      const bottom = ((row + 1) / rows) * canvas.height;
      const d00 = { x: left, y: top };
      const d10 = { x: right, y: top };
      const d11 = { x: right, y: bottom };
      const d01 = { x: left, y: bottom };
      const s00 = project(outputToCamera, d00);
      const s10 = project(outputToCamera, d10);
      const s11 = project(outputToCamera, d11);
      const s01 = project(outputToCamera, d01);
      drawTriangle(context, image, [s00, s10, s11], [d00, d10, d11]);
      drawTriangle(context, image, [s00, s11, s01], [d00, d11, d01]);
    }
  }
}

function fitPhoneCanvas() {
  const canvas = elements.phoneCanvas;
  const stage = elements.phoneStage;
  const sourceWidth = canvas.width;
  const sourceHeight = canvas.height;
  const availableWidth = Math.max(1, stage.clientWidth - 2);
  const availableHeight = Math.max(1, stage.clientHeight - 2);
  if (sourceWidth <= 0 || sourceHeight <= 0 || availableWidth <= 1 || availableHeight <= 1) return;
  const fitted = containDimensions(sourceWidth, sourceHeight, availableWidth, availableHeight);
  canvas.style.width = `${fitted.width}px`;
  canvas.style.height = `${fitted.height}px`;
}

async function decodeLatestFrame() {
  if (state.decodeActive) return;
  state.decodeActive = true;
  try {
    while (state.queuedFrame) {
      const next = state.queuedFrame;
      state.queuedFrame = null;
      const bitmap = await createImageBitmap(new Blob([next.bytes], { type: next.metadata.mimeType }));
      if (!state.frame || next.metadata.sequence >= state.frame.sequence) {
        drawFrame(bitmap, next.metadata);
        state.frame = next.metadata;
        elements.stageEmpty.hidden = true;
        elements.phoneCanvas.hidden = false;
        fitPhoneCanvas();
        elements.startRecording.disabled = state.recording || selectedDeviceIsRunning() || !state.selectedId;
        elements.frameDetail.textContent = `${next.metadata.width}×${next.metadata.height} · ${next.metadata.source}`;
        elements.sequenceText.textContent = `Frame ${next.metadata.sequence}`;
      }
      bitmap.close();
    }
  } catch (error) {
    log(error instanceof Error ? error.message : "Unable to decode live frame.", "error");
  } finally {
    state.decodeActive = false;
    if (state.queuedFrame) void decodeLatestFrame();
  }
}

function setStreamState(connected, message) {
  elements.streamDot.className = connected ? "online" : "";
  elements.streamText.textContent = message;
}

function connectLiveFrames() {
  if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
  state.socket?.close(1000, "device changed");
  state.socket = null;
  state.pendingMetadata = null;
  state.queuedFrame = null;
  state.frame = null;
  elements.phoneCanvas.hidden = true;
  elements.stageEmpty.hidden = false;
  elements.mouseTracker.hidden = true;
  elements.sequenceText.textContent = "Frame —";
  if (!state.selectedId) {
    setStreamState(false, "Stream disconnected");
    return;
  }
  const deviceId = state.selectedId;
  const url = new URL("/api/live/socket", LIVE_SOCKET_ORIGIN);
  url.searchParams.set("deviceId", deviceId);
  const socket = new WebSocket(url);
  state.socket = socket;
  socket.binaryType = "arraybuffer";
  socket.onopen = () => setStreamState(true, "Live stream connected");
  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const metadata = JSON.parse(event.data);
        if (metadata.type === "frame") state.pendingMetadata = metadata;
      } catch {
        setStreamState(false, "Invalid frame metadata");
      }
      return;
    }
    const metadata = state.pendingMetadata;
    state.pendingMetadata = null;
    if (!metadata || metadata.deviceId && metadata.deviceId !== state.selectedId) return;
    state.queuedFrame = { metadata, bytes: event.data };
    void decodeLatestFrame();
  };
  socket.onerror = () => setStreamState(false, "Live stream error");
  socket.onclose = () => {
    if (state.socket !== socket) return;
    setStreamState(false, "Reconnecting live stream");
    state.reconnectTimer = window.setTimeout(connectLiveFrames, 900);
  };
}

function pointFromPointer(event) {
  const bounds = elements.phoneCanvas.getBoundingClientRect();
  if (!state.frame || bounds.width <= 0 || bounds.height <= 0) return null;
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return null;
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    displayX: event.clientX - elements.phoneStage.getBoundingClientRect().left,
    displayY: event.clientY - elements.phoneStage.getBoundingClientRect().top,
  };
}

function showGesturePreview(point) {
  elements.gesturePreview.style.left = `${point.displayX}px`;
  elements.gesturePreview.style.top = `${point.displayY}px`;
  elements.gesturePreview.hidden = false;
}

function showMouseTracker(point, pressed = false) {
  elements.mouseTracker.style.left = `${point.displayX}px`;
  elements.mouseTracker.style.top = `${point.displayY}px`;
  elements.mouseTrackerLabel.textContent = `${Math.round(point.x * 100)}%, ${Math.round(point.y * 100)}%`;
  elements.mouseTracker.classList.toggle("pressed", pressed);
  elements.mouseTracker.hidden = false;
}

function hideMouseTracker() {
  elements.mouseTracker.classList.remove("pressed");
  elements.mouseTracker.hidden = true;
}

function cancelPendingHover() {
  state.pendingHover = null;
  state.lastHoverSent = null;
  if (state.hoverTimer !== null) {
    window.clearTimeout(state.hoverTimer);
    state.hoverTimer = null;
  }
}

function finalizeHoverPath() {
  const active = state.activeHoverPath;
  state.activeHoverPath = null;
  if (!active) return;
  const step = state.steps[active.index];
  if (!step || step.type !== "hover_path") return;
  renderSteps();
  saveWorkflowToStorage(false);
  log(`Recorded ${describeStep(step)}.`);
}

function recordHoverPoint(point, recordedAt = performance.now()) {
  if (!state.recording || state.pointer || !point || !elements.recordMouseTrajectory.checked) return;
  let active = state.activeHoverPath;
  if (active) {
    const current = state.steps[active.index];
    const elapsed = Math.round(recordedAt - active.startedAt);
    if (
      !current || current.type !== "hover_path" ||
      current.points.length >= MAX_HOVER_PATH_POINTS ||
      elapsed > MAX_HOVER_PATH_DURATION_MS
    ) {
      finalizeHoverPath();
      active = null;
    }
  }
  if (!active) {
    const delayBeforeMs = state.lastRecordedAt === null
      ? 0
      : Math.min(60_000, Math.round(recordedAt - state.lastRecordedAt));
    const step = normalizeStep({
      id: newStepId(),
      type: "hover_path",
      delayBeforeMs,
      chance: 1,
      points: [{ x: point.x, y: point.y, atMs: 0 }],
    });
    state.steps.push(step);
    state.activeHoverPath = {
      index: state.steps.length - 1,
      startedAt: recordedAt,
    };
  } else {
    const step = state.steps[active.index];
    const atMs = Math.max(step.points.at(-1).atMs, Math.round(recordedAt - active.startedAt));
    state.steps[active.index] = normalizeStep({
      ...step,
      points: [...step.points, { x: point.x, y: point.y, atMs }],
    }, active.index);
  }
  state.lastRecordedAt = recordedAt;
  renderSteps();
  saveWorkflowToStorage(false);
}

async function dispatchPendingHover() {
  state.hoverTimer = null;
  const point = state.pendingHover;
  state.pendingHover = null;
  const device = selectedDevice();
  const frame = state.frame;
  if (!point || !frame || state.pointer || !state.recording) return;
  const recordedAt = performance.now();
  state.lastHoverSent = { point, at: recordedAt };
  recordHoverPoint(point, recordedAt);
  if (
    !device?.connected || !elements.executeWhileRecording.checked ||
    device.capabilities?.actions?.hover_move?.available !== true
  ) return;
  try {
    await api(`/api/v1/devices/${encodeURIComponent(device.id)}/actions`, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: `recorder-hover-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        action: {
          type: "hover_move",
          point: { x: point.x * frame.width, y: point.y * frame.height },
          viewport: { width: frame.width, height: frame.height },
          frameSequence: frame.sequence,
        },
      }),
    });
  } catch (error) {
    console.warn("ScreenHand recorder hover move rejected", error);
  }
}

function scheduleHover(point) {
  if (!state.recording || state.pointer || !state.frame) return;
  if (!elements.recordMouseTrajectory.checked && !elements.executeWhileRecording.checked) return;
  const last = state.lastHoverSent;
  if (last && Math.hypot(point.x - last.point.x, point.y - last.point.y) < 0.006) return;
  state.pendingHover = point;
  if (state.hoverTimer !== null) return;
  const elapsed = last ? performance.now() - last.at : HOVER_MOVE_INTERVAL_MS;
  state.hoverTimer = window.setTimeout(
    () => void dispatchPendingHover(),
    Math.max(0, HOVER_MOVE_INTERVAL_MS - elapsed),
  );
}

function newStepId() {
  return `step-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function addRecordedStep(stepInput) {
  const recordedDeviceId = state.selectedId;
  const now = performance.now();
  const delayBeforeMs = state.lastRecordedAt === null ? 0 : Math.min(60_000, Math.round(now - state.lastRecordedAt));
  state.lastRecordedAt = now;
  const step = normalizeStep({ ...stepInput, id: newStepId(), delayBeforeMs, chance: 1 });
  state.steps.push(step);
  renderSteps();
  saveWorkflowToStorage(false);
  log(`Recorded ${describeStep(step)}.`);
  if (elements.executeWhileRecording.checked) {
    state.recordExecutionChain = state.recordExecutionChain
      .then(() => executeStep(step, {
        skipDelay: true,
        source: "recording",
        deviceId: recordedDeviceId,
      }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Recorded action failed.";
        elements.executeWhileRecording.checked = false;
        log(`Live recording stopped executing: ${message}`, "error");
        toast(message);
      });
  }
}

function setRecording(enabled) {
  if (!enabled) finalizeHoverPath();
  state.recording = enabled;
  state.pointer = null;
  state.lastRecordedAt = null;
  elements.startRecording.disabled = enabled || selectedDeviceIsRunning() || !state.selectedId || !state.frame;
  elements.stopRecording.disabled = !enabled;
  elements.recordingBadge.hidden = !enabled;
  elements.phoneStage.classList.toggle("recording", enabled);
  elements.deviceSelect.disabled = enabled;
  elements.recordMouseTrajectory.disabled = enabled;
  elements.clearSteps.disabled = enabled || selectedDeviceIsRunning();
  elements.stageHint.textContent = enabled
    ? elements.recordMouseTrajectory.checked
      ? "Recording full motion: mouse travel, clicks, holds, and drags are captured."
      : "Recording touch only: mouse travel is not saved; clicks, holds, and drags are captured."
    : "Move the mouse to preview the target. Start recording to capture actions.";
  if (!enabled) {
    elements.gesturePreview.hidden = true;
    cancelPendingHover();
  }
  renderSteps();
}

function pointerDown(event) {
  const point = pointFromPointer(event);
  if (event.pointerType === "mouse" && point) showMouseTracker(point, state.recording);
  if (!state.recording) return;
  if (!point) return;
  recordHoverPoint(point);
  finalizeHoverPath();
  cancelPendingHover();
  elements.phoneStage.setPointerCapture(event.pointerId);
  state.pointer = {
    id: event.pointerId,
    startedAt: performance.now(),
    start: point,
    current: point,
  };
  showGesturePreview(point);
}

function pointerMove(event) {
  const point = pointFromPointer(event);
  if (event.pointerType === "mouse") {
    if (point) showMouseTracker(point, state.pointer?.id === event.pointerId);
    else hideMouseTracker();
    if (point) scheduleHover(point);
  }
  if (state.pointer?.id !== event.pointerId) return;
  if (!point) return;
  state.pointer.current = point;
  showGesturePreview(point);
}

function globalMouseMove(event) {
  if (event.pointerType !== "mouse") return;
  const point = pointFromPointer(event);
  if (!point) {
    if (!state.pointer) hideMouseTracker();
    return;
  }
  showMouseTracker(point, state.pointer?.id === event.pointerId);
  scheduleHover(point);
}

function pointerUp(event) {
  const pointer = state.pointer;
  state.pointer = null;
  elements.gesturePreview.hidden = true;
  const hoverPoint = pointFromPointer(event);
  if (event.pointerType === "mouse" && hoverPoint) showMouseTracker(hoverPoint, false);
  if (!pointer || pointer.id !== event.pointerId || !state.recording) return;
  const end = hoverPoint ?? pointer.current;
  const durationMs = Math.round(performance.now() - pointer.startedAt);
  const distance = Math.hypot(end.x - pointer.start.x, end.y - pointer.start.y);
  if (distance > 0.045) {
    addRecordedStep({
      type: "swipe",
      start: { x: pointer.start.x, y: pointer.start.y },
      end: { x: end.x, y: end.y },
      durationMs: Math.max(180, Math.min(durationMs, 1_200)),
      pressure: elements.pressurePreset.value,
    });
  } else if (durationMs >= 520) {
    addRecordedStep({
      type: "long_press",
      point: { x: end.x, y: end.y },
      durationMs: Math.min(durationMs, 2_500),
      pressure: elements.pressurePreset.value,
    });
  } else {
    addRecordedStep({
      type: "tap",
      point: { x: end.x, y: end.y },
      durationMs: 40,
      pressure: elements.pressurePreset.value,
    });
  }
}

function renderSteps() {
  const runner = selectedRunner();
  const running = Boolean(runner);
  const locked = running || state.recording;
  elements.stepList.replaceChildren();
  elements.stepsEmpty.hidden = state.steps.length > 0;
  elements.stepCount.textContent = `${state.steps.length} step${state.steps.length === 1 ? "" : "s"}`;
  state.steps.forEach((step, index) => {
    const item = document.createElement("li");
    item.className = `step-card ${runner?.activeStep === index ? "active" : ""}`.trim();
    item.dataset.index = String(index);
    const title = document.createElement("div");
    title.className = "step-title";
    const description = document.createElement("span");
    description.textContent = `${index + 1}. ${describeStep(step)}`;
    const actions = document.createElement("div");
    actions.className = "step-actions";
    for (const [action, label] of [["up", "↑"], ["down", "↓"], ["delete", "×"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = label;
      button.setAttribute("aria-label", `${action} step ${index + 1}`);
      button.disabled = locked || (action === "up" && index === 0) || (action === "down" && index === state.steps.length - 1);
      actions.append(button);
    }
    title.append(description, actions);
    const fields = document.createElement("div");
    fields.className = "step-fields";
    const fieldDefinitions = [
      { key: "delayBeforeMs", label: "Delay ms", value: step.delayBeforeMs, min: 0, max: 60000, step: 1 },
      step.type === "hover_path"
        ? { key: "durationMs", label: "Path ms", value: step.durationMs, min: 0, max: MAX_HOVER_PATH_DURATION_MS, step: 1, readOnly: true }
        : { key: "durationMs", label: "Duration ms", value: step.durationMs, min: step.type === "swipe" ? 100 : step.type === "long_press" ? 300 : 30, max: 5000, step: 1 },
      { key: "chance", label: "Chance %", value: Math.round(step.chance * 100), min: 0, max: 100, step: 1 },
    ];
    for (const field of fieldDefinitions) {
      const label = document.createElement("label");
      label.textContent = field.label;
      const input = document.createElement("input");
      input.type = "number";
      input.dataset.field = field.key;
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step);
      input.value = String(field.value);
      input.disabled = locked || field.readOnly === true;
      label.append(input);
      fields.append(label);
    }
    if (step.type !== "hover_path") {
      const pressureLabel = document.createElement("label");
      pressureLabel.textContent = "Pressure";
      const pressure = document.createElement("select");
      pressure.dataset.field = "pressure";
      for (const [value, label] of [["light", "Light"], ["natural", "Normal"], ["firm", "Firm"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        pressure.append(option);
      }
      pressure.value = step.pressure;
      pressure.disabled = locked;
      pressureLabel.append(pressure);
      fields.append(pressureLabel);
    }
    item.append(title, fields);
    elements.stepList.append(item);
  });
  elements.runLoop.disabled = running || state.steps.length === 0 || !state.selectedId;
}

function currentWorkflow() {
  return normalizeWorkflow({
    version: 2,
    name: elements.workflowName.value,
    deviceId: state.selectedId,
    steps: state.steps,
    loop: {
      infinite: elements.infiniteLoop.checked,
      count: Number(elements.loopCount.value),
      delayMs: Number(elements.loopDelay.value),
    },
  });
}

function applyWorkflow(workflowInput) {
  const workflow = normalizeWorkflow(workflowInput);
  elements.workflowName.value = workflow.name;
  state.steps = workflow.steps;
  elements.infiniteLoop.checked = workflow.loop.infinite;
  elements.loopCount.value = String(workflow.loop.count);
  elements.loopCount.disabled = workflow.loop.infinite;
  elements.loopDelay.value = String(workflow.loop.delayMs);
  state.preferredDeviceId = workflow.deviceId;
  if (workflow.deviceId && state.devices.some((device) => device.id === workflow.deviceId)) {
    state.selectedId = workflow.deviceId;
    elements.deviceSelect.value = workflow.deviceId;
    connectLiveFrames();
  }
  renderSteps();
  renderDeviceStatus();
}

function saveWorkflowToStorage(showToast = true) {
  try {
    const workflow = currentWorkflow();
    if (!workflow.deviceId) return;
    localStorage.setItem(workflowStorageKey(workflow.deviceId), JSON.stringify(workflow));
    if (showToast) toast("Workflow saved in this browser.");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Unable to save workflow.");
  }
}

function loadStoredWorkflow(deviceId) {
  let stored = localStorage.getItem(workflowStorageKey(deviceId));
  if (!stored) {
    const legacy = localStorage.getItem(LEGACY_WORKFLOW_STORAGE_KEY);
    try {
      if (legacy && JSON.parse(legacy)?.deviceId === deviceId) stored = legacy;
    } catch {
      localStorage.removeItem(LEGACY_WORKFLOW_STORAGE_KEY);
    }
  }
  if (!stored) {
    elements.workflowName.value = `${deviceId} workflow`;
    state.steps = [];
    elements.infiniteLoop.checked = true;
    elements.loopCount.value = "1";
    elements.loopCount.disabled = true;
    elements.loopDelay.value = "500";
    renderSteps();
    return;
  }
  try {
    const workflow = JSON.parse(stored);
    workflow.deviceId = deviceId;
    applyWorkflow(workflow);
    localStorage.setItem(workflowStorageKey(deviceId), JSON.stringify(currentWorkflow()));
    log(`Restored the saved workflow for ${deviceId}.`);
  } catch (error) {
    log(error instanceof Error ? error.message : "Saved workflow is invalid.", "error");
  }
}

function exportWorkflow() {
  try {
    const workflow = currentWorkflow();
    const blob = new Blob([`${JSON.stringify(workflow, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "screenhand-workflow"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    log(`Exported ${workflow.steps.length} workflow steps.`, "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Unable to export workflow.");
  }
}

async function importWorkflow(file) {
  if (!file) return;
  try {
    applyWorkflow(JSON.parse(await file.text()));
    saveWorkflowToStorage(false);
    log(`Imported workflow from ${file.name}.`, "success");
    toast("Workflow imported.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow file is invalid.";
    log(message, "error");
    toast(message);
  } finally {
    elements.importFile.value = "";
  }
}

function updateRunnerButtons() {
  const runner = selectedRunner();
  const running = Boolean(runner);
  elements.runLoop.disabled = running || state.steps.length === 0 || !state.selectedId;
  elements.stopLoop.disabled = !running || runner?.stopRequested;
  elements.startRecording.disabled = state.recording || running || !state.selectedId || !state.frame;
  elements.runningBadge.hidden = !running;
  elements.deviceSelect.disabled = state.recording;
  elements.pressurePreset.disabled = running;
  elements.clearSteps.disabled = running || state.recording;
  elements.stopLoop.textContent = runner?.stopRequested ? "Stopping after current action" : "Stop loop";
  renderSteps();
}

function acquireLease(runner) {
  const deviceId = runner.deviceId;
  const now = Date.now();
  const storageKey = leaseStorageKey(deviceId);
  try {
    const current = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (current?.id !== runner.leaseId && current?.expiresAt > now) {
      throw new Error("Another recorder tab is already running this device.");
    }
  } catch (error) {
    if (error instanceof SyntaxError) localStorage.removeItem(storageKey);
    else throw error;
  }
  runner.leaseId = crypto.randomUUID();
  const renew = () => {
    const current = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (current?.id && current.id !== runner.leaseId && current.expiresAt > Date.now()) {
      runner.stopRequested = true;
      throw new Error(`Recorder lease for ${deviceId} was taken by another tab.`);
    }
    localStorage.setItem(storageKey, JSON.stringify({
      id: runner.leaseId,
      deviceId,
      expiresAt: Date.now() + 5_000,
    }));
  };
  renew();
  runner.leaseTimer = window.setInterval(() => {
    try {
      renew();
    } catch (error) {
      log(`[${deviceId}] ${error instanceof Error ? error.message : "Recorder lease was lost."}`, "error");
      if (state.selectedId === deviceId) updateRunnerButtons();
    }
  }, 2_000);
}

function releaseLease(runner) {
  if (runner.leaseTimer) window.clearInterval(runner.leaseTimer);
  runner.leaseTimer = null;
  const storageKey = leaseStorageKey(runner.deviceId);
  try {
    const current = JSON.parse(storageKey ? localStorage.getItem(storageKey) ?? "null" : "null");
    if (current?.id === runner.leaseId) localStorage.removeItem(storageKey);
  } catch {
    localStorage.removeItem(storageKey);
  }
  runner.leaseId = "";
}

async function interruptibleDelay(durationMs, runner = null) {
  const deadline = Date.now() + durationMs;
  while (!runner?.stopRequested && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}

async function latestRunnableDevice(deviceId, actionType) {
  const payload = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}`);
  const device = payload.device;
  if (!device?.connected) throw new Error("The selected ScreenHand device is offline.");
  const availability = device.capabilities?.actions?.[actionType];
  if (!availability?.available) throw new Error(availability?.reason ?? `${actionType} is safety locked.`);
  const machineState = device.state?.grbl?.state;
  if (machineState && machineState !== "Idle") {
    throw new Error(`The machine must be Idle before replay; current state is ${machineState}.`);
  }
  if (!device.screen?.sequence || Date.now() - Number(device.screen.capturedAt) > 4_500) {
    throw new Error("A fresh ScreenHand frame is required before replay.");
  }
  return device;
}

async function waitForReceipt(deviceId, receiptId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}/actions/${encodeURIComponent(receiptId)}`);
    const receipt = payload.receipt;
    if (receipt?.status === "completed") return receipt;
    if (receipt?.status === "failed") throw new Error(receipt.error ?? "ScreenHand action failed.");
    await new Promise((resolve) => window.setTimeout(resolve, 160));
  }
  throw new Error("ScreenHand action receipt timed out.");
}

async function submitAction(deviceId, action) {
  const queued = await queueAction(deviceId, action);
  if (queued.result.status === "completed") return queued.result;
  if (!queued.receiptId) throw new Error("ScreenHand did not return an action receipt.");
  return waitForReceipt(deviceId, queued.receiptId, action.type === "long_press" ? 20_000 : 15_000);
}

async function queueAction(deviceId, action) {
  const idempotencyKey = `recorder-${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
  const payload = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}/actions`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey, action }),
  });
  const result = payload.result ?? payload;
  if (result.status === "failed") {
    throw new Error(result.receipt?.error ?? result.error ?? "ScreenHand action failed.");
  }
  const receiptId = result.receipt?.id ?? result.commandId;
  return { result, receiptId };
}

async function latestHoverReplayDevice(deviceId) {
  const payload = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}`);
  const device = payload.device;
  if (!device?.connected) throw new Error("The selected ScreenHand device is offline.");
  if (!device.screen?.sequence || Date.now() - Number(device.screen.capturedAt) > 4_500) {
    throw new Error("A fresh ScreenHand frame is required before replay.");
  }
  return device;
}

function isTransientHoverBusyError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /must be idle|not Idle|current physical operation|another physical operation|controller (?:state )?is (?:Run|Jog)|controller is busy/i.test(message);
}

function hoverAction(point, frame) {
  return {
    type: "hover_move",
    point: { x: point.x * frame.width, y: point.y * frame.height },
    viewport: { width: frame.width, height: frame.height },
    frameSequence: frame.sequence,
  };
}

async function finishHoverPoint(deviceId, point, initialSubmission, runner) {
  const deadline = Date.now() + 5_000;
  let submission = initialSubmission;
  while (!runner?.stopRequested && Date.now() < deadline) {
    try {
      if (!submission) {
        const device = await latestHoverReplayDevice(deviceId);
        submission = await queueAction(device.id, hoverAction(point, device.screen));
      }
      if (submission.result.status === "completed") return;
      if (!submission.receiptId) throw new Error("ScreenHand did not return a hover receipt.");
      await waitForReceipt(deviceId, submission.receiptId);
      return;
    } catch (error) {
      if (!isTransientHoverBusyError(error)) throw error;
      submission = null;
      await interruptibleDelay(120, runner);
    }
  }
  if (!runner?.stopRequested) {
    throw new Error("The arm stayed busy for more than 5 seconds after the hover path.");
  }
}

async function executeHoverPath(step, { deviceId, runner = null } = {}) {
  const replayPoints = interpolateHoverPath(step.points, HOVER_MOVE_INTERVAL_MS);
  const startedAt = performance.now();
  let device = await latestRunnableDevice(deviceId, "hover_move");
  let refreshedAt = startedAt;
  let finalSubmission = null;
  let completedPoints = 0;
  let skippedBusyPoints = 0;
  log(`[${deviceId}] Replaying a smooth hover path with ${replayPoints.length} motion points.`);
  for (let index = 0; index < replayPoints.length; index += 1) {
    const point = replayPoints[index];
    const remainingDelay = point.atMs - (performance.now() - startedAt);
    if (remainingDelay > 0) await interruptibleDelay(remainingDelay, runner);
    if (runner?.stopRequested) break;
    if (performance.now() - refreshedAt >= HOVER_REPLAY_FRAME_REFRESH_MS) {
      device = await latestHoverReplayDevice(deviceId);
      refreshedAt = performance.now();
    }
    const frame = device.screen;
    try {
      finalSubmission = await queueAction(device.id, hoverAction(point, frame));
      completedPoints += 1;
    } catch (error) {
      if (!isTransientHoverBusyError(error)) throw error;
      finalSubmission = null;
      skippedBusyPoints += 1;
    }
  }
  if (runner?.stopRequested) {
    log(`[${deviceId}] Hover path stopped after ${completedPoints}/${replayPoints.length} motion points.`);
    return;
  }
  await finishHoverPoint(deviceId, replayPoints.at(-1), finalSubmission, runner);
  if (skippedBusyPoints > 0) {
    log(`[${deviceId}] Coalesced ${skippedBusyPoints} transient busy points without stopping the loop.`);
  }
  log(`[${deviceId}] Completed ${describeStep(step)}.`, "success");
}

async function executeStep(stepValue, { skipDelay = false, source = "loop", deviceId = state.selectedId, runner = null } = {}) {
  const step = normalizeStep(stepValue);
  if (!skipDelay && step.delayBeforeMs > 0) await interruptibleDelay(step.delayBeforeMs, runner);
  if (source === "loop" && runner?.stopRequested) return;
  if (step.type === "hover_path") {
    await executeHoverPath(step, { deviceId, runner });
    return;
  }
  const device = await latestRunnableDevice(deviceId, step.type);
  const action = materializeAction(step, device.screen, device.state?.grbl?.tapProfile);
  log(`[${deviceId}] Sending ${describeStep(step)} on fresh frame ${device.screen.sequence}.`);
  await submitAction(device.id, action);
  log(`[${deviceId}] Completed ${describeStep(step)}.`, "success");
}

async function runWorkflow() {
  const workflow = currentWorkflow();
  const runDeviceId = workflow.deviceId;
  if (!runDeviceId || runnerFor(runDeviceId)) return;
  const runner = {
    deviceId: runDeviceId,
    workflow,
    stopRequested: false,
    activeStep: -1,
    leaseId: "",
    leaseTimer: null,
  };
  try {
    if (workflow.steps.length === 0) throw new Error("Record at least one action first.");
    if (!runDeviceId || runDeviceId !== state.selectedId) {
      throw new Error("The workflow must remain bound to the selected device.");
    }
    acquireLease(runner);
    state.runners.set(runDeviceId, runner);
    setRecording(false);
    updateRunnerButtons();
    log(`[${runDeviceId}] Started ${workflow.loop.infinite ? "an unlimited" : workflow.loop.count} loop run.`, "success");
    const maximum = workflow.loop.infinite ? Number.POSITIVE_INFINITY : workflow.loop.count;
    for (let iteration = 0; iteration < maximum && !runner.stopRequested; iteration += 1) {
      log(`[${runDeviceId}] Iteration ${iteration + 1} started.`);
      for (let index = 0; index < workflow.steps.length && !runner.stopRequested; index += 1) {
        runner.activeStep = index;
        if (state.selectedId === runDeviceId) renderSteps();
        const step = workflow.steps[index];
        if (step.delayBeforeMs > 0) await interruptibleDelay(step.delayBeforeMs, runner);
        if (runner.stopRequested) break;
        if (!shouldRunStep(step)) {
          log(`[${runDeviceId}] Skipped step ${index + 1} by chance rule.`);
          continue;
        }
        await executeStep(step, { skipDelay: true, deviceId: runDeviceId, runner });
      }
      runner.activeStep = -1;
      if (state.selectedId === runDeviceId) renderSteps();
      if (!runner.stopRequested && iteration + 1 < maximum && workflow.loop.delayMs > 0) {
        await interruptibleDelay(workflow.loop.delayMs, runner);
      }
    }
    log(`[${runDeviceId}] ${runner.stopRequested ? "Loop stopped by operator." : "Workflow completed."}`, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow failed.";
    log(`[${runDeviceId || "unassigned"}] Workflow stopped: ${message}`, "error");
    toast(message);
  } finally {
    runner.stopRequested = false;
    runner.activeStep = -1;
    releaseLease(runner);
    state.runners.delete(runDeviceId);
    if (state.selectedId === runDeviceId) updateRunnerButtons();
  }
}

async function emergencyHold() {
  if (!state.selectedId) {
    toast("Select a ScreenHand device first.");
    return;
  }
  const runner = selectedRunner();
  if (runner) runner.stopRequested = true;
  updateRunnerButtons();
  try {
    log("Sending emergency hold.");
    await submitAction(state.selectedId, { type: "hold" });
    log("Emergency hold accepted. Resume must be explicit.", "success");
    toast("Emergency hold accepted.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Emergency hold failed.";
    log(message, "error");
    toast(message);
  }
}

elements.deviceSelect.addEventListener("change", () => {
  if (state.selectedId) saveWorkflowToStorage(false);
  state.selectedId = elements.deviceSelect.value;
  state.preferredDeviceId = state.selectedId;
  state.loadedWorkflowDeviceId = state.selectedId;
  const url = new URL(window.location.href);
  if (state.selectedId) url.searchParams.set("device", state.selectedId);
  else url.searchParams.delete("device");
  window.history.replaceState(window.history.state, "", url);
  renderDeviceStatus();
  connectLiveFrames();
  if (state.selectedId) loadStoredWorkflow(state.selectedId);
  updateRunnerButtons();
});
elements.refreshDevices.addEventListener("click", () => void refreshDevices());
elements.startRecording.addEventListener("click", () => {
  if (!state.frame) return toast("Wait for a live frame before recording.");
  setRecording(true);
  const recordingMode = elements.recordMouseTrajectory.checked
    ? "full mouse trajectory and touch actions"
    : "touch actions only";
  const executionMode = elements.executeWhileRecording.checked
    ? "live hardware execution is on"
    : "hardware execution is off";
  log(`Recording ${recordingMode}; ${executionMode}.`, "success");
});
elements.stopRecording.addEventListener("click", () => {
  setRecording(false);
  log("Recording stopped.");
});
elements.clearSteps.addEventListener("click", () => {
  if (selectedDeviceIsRunning() || state.recording) return;
  state.activeHoverPath = null;
  state.steps = [];
  renderSteps();
  saveWorkflowToStorage(false);
  log("Cleared recorded steps.");
});
elements.infiniteLoop.addEventListener("change", () => {
  elements.loopCount.disabled = elements.infiniteLoop.checked;
  saveWorkflowToStorage(false);
});
elements.recordMouseTrajectory.addEventListener("change", () => {
  saveRecorderPreferences();
  toast(elements.recordMouseTrajectory.checked
    ? "Mouse trajectory recording enabled."
    : "Touch-only recording enabled.");
});
elements.runLoop.addEventListener("click", () => void runWorkflow());
elements.stopLoop.addEventListener("click", () => {
  const runner = selectedRunner();
  if (!runner) return;
  runner.stopRequested = true;
  updateRunnerButtons();
  log(`[${runner.deviceId}] Stop requested; no new action will be submitted.`);
});
elements.emergencyHold.addEventListener("click", () => void emergencyHold());
elements.phoneStage.addEventListener("pointerdown", pointerDown);
elements.phoneStage.addEventListener("pointermove", pointerMove);
window.addEventListener("pointermove", globalMouseMove, { capture: true, passive: true });
elements.phoneStage.addEventListener("pointerup", pointerUp);
elements.phoneStage.addEventListener("pointerleave", (event) => {
  if (event.pointerType === "mouse" && state.pointer?.id !== event.pointerId) {
    hideMouseTracker();
    finalizeHoverPath();
    cancelPendingHover();
  }
});
elements.phoneStage.addEventListener("pointercancel", () => {
  state.pointer = null;
  elements.gesturePreview.hidden = true;
  hideMouseTracker();
});
elements.stepList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const card = event.target.closest(".step-card");
  if (!button || !card || selectedDeviceIsRunning() || state.recording) return;
  const index = Number(card.dataset.index);
  const action = button.dataset.action;
  if (action === "delete") state.steps.splice(index, 1);
  if (action === "up" && index > 0) [state.steps[index - 1], state.steps[index]] = [state.steps[index], state.steps[index - 1]];
  if (action === "down" && index < state.steps.length - 1) [state.steps[index + 1], state.steps[index]] = [state.steps[index], state.steps[index + 1]];
  renderSteps();
  saveWorkflowToStorage(false);
});
elements.stepList.addEventListener("change", (event) => {
  const input = event.target.closest("[data-field]");
  const card = event.target.closest(".step-card");
  if (!input || !card || selectedDeviceIsRunning() || state.recording) return;
  const index = Number(card.dataset.index);
  const field = input.dataset.field;
  const numericValue = Number(input.value);
  const value = field === "pressure"
    ? input.value
    : field === "chance"
      ? numericValue / 100
      : numericValue;
  const updated = { ...state.steps[index], [field]: value };
  try {
    state.steps[index] = normalizeStep(updated, index);
    renderSteps();
    saveWorkflowToStorage(false);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Step value is invalid.");
    renderSteps();
  }
});
elements.saveWorkflow.addEventListener("click", () => saveWorkflowToStorage(true));
elements.exportWorkflow.addEventListener("click", exportWorkflow);
elements.importWorkflow.addEventListener("click", () => elements.importFile.click());
elements.importFile.addEventListener("change", () => void importWorkflow(elements.importFile.files?.[0]));
elements.clearLog.addEventListener("click", () => elements.activityLog.replaceChildren());
for (const element of [elements.workflowName, elements.loopCount, elements.loopDelay]) {
  element.addEventListener("change", () => saveWorkflowToStorage(false));
}

window.addEventListener("beforeunload", () => {
  state.socket?.close(1000, "page closed");
  for (const runner of state.runners.values()) {
    runner.stopRequested = true;
    releaseLease(runner);
  }
});

elements.phoneCanvas.hidden = true;
new ResizeObserver(fitPhoneCanvas).observe(elements.phoneStage);
loadRecorderPreferences();
renderSteps();
setRecording(false);
void refreshDevices();
window.setInterval(() => void refreshDevices({ quiet: true }), 800);

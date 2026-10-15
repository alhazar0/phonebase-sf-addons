import WebSocket from "ws";

const baseUrl = process.env.SCREENHAND_MOCK_CONTROL_PLANE_URL ?? "http://127.0.0.1:3024";
const deviceId = process.env.SCREENHAND_MOCK_DEVICE_ID ?? "black-arm-simulator";
const maximumCommands = Number(process.env.SCREENHAND_MOCK_COMMANDS ?? 4);
const timeoutMs = Number(process.env.SCREENHAND_MOCK_TIMEOUT_MS ?? 60000);
const socketUrl = new URL("/api/node/socket", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

const socket = new WebSocket(socketUrl);
let commands = 0;
let completedCommands = 0;
const state = {
  appVersion: "0.1.13",
  controlPlaneConnected: true,
  cameraReady: true,
  grbl: {
    connected: true,
    state: "Hold:0",
    x: 0,
    y: 0,
    z: 0,
    activeOperation: null,
    lastOperation: {},
    calibrationActive: true,
    calibrationRemainingMs: 600000,
    tapProfile: {
      id: "black-arm-simulator-profile-v1",
      supportsLongPress: true,
      supportsSwipe: true
    }
  }
};

function heartbeat() {
  socket.send(JSON.stringify({
    type: "heartbeat",
    deviceId,
    at: Date.now(),
    state
  }));
}

function finishCommand() {
  completedCommands += 1;
  if (completedCommands >= maximumCommands) {
    socket.close(1000, "simulation complete");
  }
}

socket.on("open", heartbeat);
const timer = setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) heartbeat();
}, 1000);

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type !== "command") return;
  commands += 1;
  process.stdout.write(`${JSON.stringify({
    command: commands,
    action: message.action,
    params: message.params ?? null
  })}\n`);
  const isTouch = ["tap", "long_press", "swipe"].includes(message.action);
  if (isTouch) {
    state.grbl.activeOperation = {
      id: message.id,
      type: message.action,
      status: "running",
      startedAt: Date.now()
    };
    state.grbl.lastOperation = {};
  }
  socket.send(JSON.stringify({
    type: "event",
    deviceId,
    name: "command-result",
    payload: {
      id: message.id,
      action: message.action,
      ok: true,
      state: state.grbl
    }
  }));
  heartbeat();
  if (!isTouch) {
    finishCommand();
    return;
  }
  setTimeout(() => {
    state.grbl.activeOperation = null;
    state.grbl.lastOperation = {
      id: message.id,
      type: message.action,
      status: "completed",
      completedAt: Date.now()
    };
    heartbeat();
    finishCommand();
  }, 180);
});

socket.on("close", () => {
  clearInterval(timer);
  process.exit(completedCommands === maximumCommands ? 0 : 2);
});

setTimeout(() => {
  clearInterval(timer);
  socket.close(1011, "simulation timeout");
}, timeoutMs).unref();

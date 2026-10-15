import { readFile } from "node:fs/promises";
import WebSocket from "ws";

const baseUrl = process.env.SCREENHAND_SMOKE_CONTROL_PLANE_URL ?? "http://127.0.0.1:3025";
const deviceId = "black-arm-calibration-simulator";
const socketUrl = new URL("/api/node/socket", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

const imagePoints = [
  { x: 154, y: 92 },
  { x: 810, y: 116 },
  { x: 846, y: 1204 },
  { x: 112, y: 1180 }
];
const machinePoints = [
  { x: 6, y: 11 },
  { x: 78, y: 11 },
  { x: 78, y: 168 },
  { x: 6, y: 168 }
];
const jpeg = await readFile("/tmp/screenhand-sim-frame.jpg");
const socket = new WebSocket(socketUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

const grbl = {
  connected: true,
  state: "Hold:0",
  x: 0,
  y: 0,
  z: 0,
  calibrationActive: true,
  calibrationRemainingMs: 600000,
  tapProfile: {
    id: "black-arm-simulator-profile-v1",
    supportsLongPress: true,
    supportsSwipe: true
  }
};

function heartbeat() {
  socket.send(JSON.stringify({
    type: "heartbeat",
    deviceId,
    at: Date.now(),
    state: {
      appVersion: "0.1.13",
      controlPlaneConnected: true,
      cameraReady: true,
      grbl
    }
  }));
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${payload.error}`);
  return payload;
}

async function uploadFrame() {
  const response = await fetch(`${baseUrl}/api/frame/jpeg`, {
    method: "POST",
    headers: {
      "content-type": "image/jpeg",
      "x-screenhand-frame-width": "960",
      "x-screenhand-frame-height": "1280",
      "x-screenhand-device-id": deviceId
    },
    body: jpeg
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${payload.error}`);
  return payload.frame;
}

heartbeat();
await new Promise((resolve) => setTimeout(resolve, 40));
await uploadFrame();
const path = `/api/v1/devices/${deviceId}/calibration`;
await post(path, { operation: "begin", screenWidth: 720, screenHeight: 1280 });

for (let index = 0; index < 4; index += 1) {
  await post(path, {
    operation: "capture_image_point",
    index,
    ...imagePoints[index]
  });
  grbl.x = machinePoints[index].x;
  grbl.y = machinePoints[index].y;
  heartbeat();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await post(path, { operation: "capture_machine_point", index });
}

const activated = await post(path, {
  operation: "activate",
  index: 0,
  confirmation: "PHONE_FIXED_AND_POINTS_VERIFIED"
});
const rectified = await uploadFrame();
if (
  activated.calibration?.active?.deviceId !== deviceId ||
  rectified.width !== 720 ||
  rectified.height !== 1280 ||
  rectified.rectified !== true
) {
  throw new Error("Calibration did not activate the rectified viewport");
}

process.stdout.write(JSON.stringify({
  activeProfile: activated.calibration.active.id,
  raw: `${rectified.rawWidth}x${rectified.rawHeight}`,
  rectified: `${rectified.width}x${rectified.height}`,
  imagePoints: activated.calibration.active.imagePoints,
  machinePoints: activated.calibration.active.machinePoints
}, null, 2));
process.stdout.write("\n");
socket.close(1000, "calibration smoke complete");

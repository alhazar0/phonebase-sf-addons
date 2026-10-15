# ScreenHand Device Platform

ScreenHand combines a real phone, a UVC camera, and a physical XY/Z robot arm. Operators can control the phone from a local Dashboard. Developers can use the same hardware through REST, WebSocket video, or MCP.

This version supports the ScreenHand black arm.

## Start here

The full customer guide is available at:

```text
http://127.0.0.1:3012/docs
```

The same guide is included in the hosted website at `/docs`.

### Recommended install

```bash
curl -fsSL --proto '=https' --tlsv1.2 \
  https://screenhand-remote-console.alhazaranwar205.chatgpt.site/install.sh | bash
```

The installer verifies the published package, installs under
`~/.screenhand`, creates the `screenhand` command, installs localhost
background services, and starts guided onboarding. It never homes or moves the
arm.

After installation:

```bash
screenhand status
screenhand doctor
screenhand dashboard
```

When macOS asks, allow **ScreenHand Camera** to use the connected UVC camera.
If permission was denied, enable it in **System Settings → Privacy & Security →
Camera**, then run `screenhand restart`.

### Requirements

- macOS
- Node.js 22 or newer
- Python 3
- FFmpeg
- Swift command-line tools
- One ScreenHand black-arm controller and one UVC camera

### Install from source

```bash
./scripts/setup-macos.sh
npm run local
```

Open:

- Dashboard: `http://127.0.0.1:3012`
- Developer docs: `http://127.0.0.1:3012/docs`
- Control API: `http://127.0.0.1:3013`
- OpenAPI: `http://127.0.0.1:3013/api/v1/openapi.json`

With exactly one controller and one camera connected, the fleet runtime discovers them in safe setup mode. It never homes the arm automatically.

### Vision-assisted reconnect development console

The isolated development branch runs its console and camera-registration
sidecar together:

```bash
npm run dev:3011
```

Open `http://127.0.0.1:3011`, select **Auto setup**, and inspect the camera
overlay. A station still needs one physically verified four-corner calibration.
After the operator saves one matching camera reference, later reconnects use
macOS Vision homographic registration to recover a shifted phone placement.

Preview and dry-run requests never move the arm. A real Home cycle remains
behind an explicit clear-workspace confirmation because the phone-facing camera
cannot observe the arm's entire travel path. Low confidence, a changed profile
or camera resolution, excessive drift, and out-of-range coordinates all stop
before Home.

## ScreenHand CLI

```text
screenhand onboard
screenhand dashboard
screenhand docs
screenhand doctor
screenhand status
screenhand start
screenhand stop
screenhand restart
screenhand repair
screenhand logs --follow
screenhand audit
screenhand update
screenhand agent-guide --copy
screenhand mcp
screenhand uninstall
```

`screenhand uninstall` removes the background services but intentionally
preserves local configuration, calibration, logs, and application files.

## Product architecture

```text
Dashboard :3012
    │
    ├── REST API :3013
    ├── Live WebSocket :3013
    └── MCP stdio server
             │
       Control plane
             │
       Black-arm node
        ├── UVC camera
        └── GRBL driver → XY/Z arm
```

- **Devices** provides live video and human control.
- **Connections** shows camera, controller, homing, and calibration readiness.
- **Developer** shows live capabilities, API examples, OpenAPI, and MCP configuration.
- **Control plane** validates every action and tracks final hardware receipts.
- **Fleet supervisor** binds each controller and camera to a stable `deviceId`.

## Hardware setup

For one new arm, connect one controller and one UVC camera, then run `npm run local`.

For a permanent or multi-arm installation:

```bash
cp config/device-fleet.example.json config/device-fleet.json
```

Give each arm a unique:

- `deviceId`
- controller serial path or USB topology prefix
- camera AVFoundation `uniqueID` prefix
- driver port
- verified calibration profile

Do not store a camera number that can change after reconnecting USB. The fleet supervisor refuses ambiguous hardware identity instead of guessing.

## Safety model

A physical touch is available only when all conditions are true:

- the requested device and USB identity match;
- a fresh frame exists for that device;
- the controller completed homing for this connection;
- a verified calibration matches the device and frame size;
- the target is inside the verified phone area;
- touch depth is inside the accepted device range; and
- the controller is not in Hold or a fault state.

The Dashboard starts in view-only mode. The operator must explicitly enable control.

Home requires the exact `CLEAR_WORKSPACE_AND_HOME` API confirmation. MCP Home is disabled unless a local administrator sets `SCREENHAND_MCP_ALLOW_HOME=1` after establishing a human clearance process.

## REST API

List devices and current capabilities:

```bash
curl http://127.0.0.1:3013/api/v1/devices
```

Read a screenshot:

```http
GET /api/v1/devices/:deviceId/screenshot
```

The response headers provide:

- `X-ScreenHand-Frame-Sequence`
- `X-ScreenHand-Frame-Width`
- `X-ScreenHand-Frame-Height`
- `X-ScreenHand-Captured-At`

Coordinate actions must use the exact sequence and viewport returned for the screenshot used to choose the point.

Submit an action:

```http
POST /api/v1/devices/black-arm-01/actions
Content-Type: application/json

{
  "idempotencyKey": "qa-run-42-step-3",
  "action": {
    "type": "tap",
    "point": { "x": 360, "y": 780 },
    "viewport": { "width": 720, "height": 1560 },
    "frameSequence": 123
  }
}
```

Public actions:

- `status`
- `hold`
- `resume`
- `home`
- `hover_move`
- `touch_down`
- `touch_move`
- `touch_up`
- `touch_keepalive`
- `tap`
- `long_press`
- `swipe`
- `input_text`
- `phone_key`
- `wait`

HTTP `202` means the physical action was accepted. It does not mean movement finished. Read the final receipt:

```http
GET /api/v1/devices/:deviceId/actions/:receiptId
```

Receipt states are `accepted`, `executing`, `completed`, and `failed`.
Receipts are persisted locally with caller-provided `X-Request-Id` and
`X-ScreenHand-Actor` values. Unfinished receipts become `failed` after a
control-plane restart; inspect the latest events with `screenhand audit`.

The runnable first-tap example gets a fresh frame and waits for the final receipt:

```bash
npm run example:first-tap -- black-arm-01 360 780 --execute
```

### Camera-only natural-language Agent

The product-wide status, priorities, performance budgets, and promotion gates
are maintained in [`docs/SCREENHAND_MASTER_PLAN.md`](docs/SCREENHAND_MASTER_PLAN.md).

The `feature/general-mobile-agent` implementation adds a platform-neutral
observe → understand → plan → act → verify → recover → remember loop. Common
commands use local OCR and geometry; an optional image model is called only
when that fast path is inconclusive. Every physical primitive still passes
through the same capability, calibration, fresh-frame, and receipt gates.

Preview a goal without moving the arm:

```bash
npm run agent:run -- --device black-arm-01 "open Telegram app" --dry-run \
  --api-url http://127.0.0.1:3013
```

Execute a bounded run:

```bash
npm run agent:run -- --device black-arm-01 "go home" --execute \
  --max-steps 4 --timeout-ms 20000 --api-url http://127.0.0.1:3013
```

The isolated development Dashboard on port 3011 exposes the same flow under
**ScreenHand Agent**. It starts in Preview mode; Run remains locked until the
operator enables control and accepts the physical-movement confirmation. The
stable human-control Dashboard on port 3012 remains unchanged.

The REST entry point is:

```http
POST /api/v1/devices/:deviceId/agent/runs
Content-Type: application/json

{
  "goal": "click Continue",
  "mode": "dry_run",
  "maxSteps": 8,
  "timeoutMs": 45000
}
```

Poll `GET /api/v1/devices/:deviceId/agent/runs/:runId` until the run is
`finished`. The result includes observation, OCR, optional-model, receipt, and
total latency metrics. Runs are serialized per physical device.

For optional visual fallback, set `OPENAI_API_KEY`. The defaults are
`SCREENHAND_VISION_MODEL=gpt-5.6-luna`; accounts configured for lower latency
may set `SCREENHAND_OPENAI_SERVICE_TIER=priority`. Without a key, unsupported
goals fail closed while all local fast-path commands remain available.

## MCP for customer Agents

Any Agent host that supports a local stdio MCP server can connect:

```json
{
  "mcpServers": {
    "screenhand": {
      "command": "screenhand",
      "args": ["mcp"],
      "env": {
        "SCREENHAND_API_URL": "http://127.0.0.1:3013"
      }
    }
  }
}
```

The MCP server provides 15 tools for devices, screenshots, actions, and receipts. It supports MCP protocol 2026-07-28 and compatible 2025 clients. Coordinate tools require a fresh screenshot. Action tools wait for the final hardware receipt by default.

Copy the complete machine-readable operating guide for an Agent:

```bash
screenhand agent-guide --copy
```

The same plain-text guide is available at `/agent-guide.txt` on both the hosted
documentation site and the local Dashboard.

Recommended Agent instruction:

```text
Always list devices and read capabilities first.
Get a fresh screenshot before every coordinate action.
Use the exact frameSequence and viewport returned with the screenshot.
Never bypass a locked capability; report its reason.
Never home the arm without a human workspace check.
```

Remote MCP connections are blocked unless `SCREENHAND_MCP_ALLOW_REMOTE=1`. Provide `SCREENHAND_API_TOKEN` when using the authenticated remote gateway.

## Calibration

Open:

```text
http://127.0.0.1:3012/calibrate?deviceId=<deviceId>
```

Each profile belongs to one arm, camera frame size, phone placement, and verified touch range. Moving the phone, fixture, or camera requires validation again.

Device profiles are stored in the ignored `build/devices/` directory so one customer's physical coordinates cannot be committed and reused on another arm.

## Production service

Create the production configuration:

```bash
cp .env.supervisor.example .env.supervisor
npm run stable:install
npm run stable:status
```

The local control plane binds to `127.0.0.1` by default. Do not expose port 3013 directly to the internet. Use the authenticated remote gateway for an approved remote deployment.

## Development and verification

```bash
npm run dev:3012
npm run control-plane
npm run fleet
npm run mcp
npm run doctor
npm test
npm run lint
```

The OpenAPI 3.1 source is `public/openapi.json`. Treat the live capability response as the source of truth for current physical availability.

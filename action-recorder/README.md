# ScreenHand Action Recorder

An isolated local client for recording and safely replaying ScreenHand semantic
actions. It does not import or modify the ScreenHand dashboard, control plane,
hardware node, serial driver, or G-code layer.

## Run

Keep the ScreenHand control plane running on `127.0.0.1:3013`, then:

```bash
cd action-recorder
npm run dev
```

Open `http://127.0.0.1:3017`.

The recorder binds to loopback and exposes a narrow same-origin proxy for:

- device list and device status;
- semantic actions;
- action receipts.

Live frames connect directly to the existing ScreenHand WebSocket. The proxy
does not expose hardware-node commands, calibration writes, frame uploads,
driver routes, serial commands, or G-code.

## Safety behavior

- Recorded points are normalized screen coordinates, never machine millimetres.
- **Record mouse trajectory** chooses between full timed `hover_path` recording and the original touch-only mode.
- **Execute while recording** independently controls live arm movement; turning it off never prevents trajectory capture when trajectory recording is enabled.
- Replayed hover paths are interpolated, streamed through the device's `hover_move` safety capability, and coalesced by the hardware node.
- Every replayed touch is materialized against the latest device frame.
- Touch actions execute one at a time; streamed hover paths wait for their final receipt before the next touch.
- A lost device, locked capability, stale frame, or failed receipt stops the loop.
- **Stop loop** submits no new actions and lets the current primitive finish.
- **Emergency hold** is separate and intentionally latching.
- Workflows are stored in browser local storage and can be exported/imported as JSON.

## Three devices at the same time

One recorder page can run independent workflows for multiple devices. Start a
loop for one device, switch the device picker, then record or start another
device; the first loop continues in the background. Run/stop state, current
step, cancellation, and execution leases are all device-scoped, so stopping one
device does not stop the others.

Dedicated tabs remain available when separate windows are more convenient.
Duplicate runners for the same device are rejected across tabs:

```text
http://127.0.0.1:3017/?device=black-arm-01
http://127.0.0.1:3017/?device=black-arm-02
http://127.0.0.1:3017/?device=black-arm-03
```

The selected Light, Normal, or Firm pressure is saved on every recorded step
and materialized inside that device's verified Z range during replay.

The recorder cannot make a locked ScreenHand device controllable. Physical
calibration and acceptance must succeed in the existing control plane first.

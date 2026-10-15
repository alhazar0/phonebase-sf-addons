"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle,
  CircleNotch,
  Crosshair,
  DeviceMobileCamera,
  FloppyDisk,
  MapPin,
  Play,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { LiveScreen, type LiveFrame, type ScreenPoint } from "../live-screen";
import {
  controlPlaneFetch,
  liveControlPlaneBaseUrl,
  resolveControlPlaneEndpoint,
  type ControlPlaneEndpoint,
} from "../control-plane-endpoint";
import { calibrationReadinessIssue } from "../../shared/calibration-readiness";

const CORNERS = ["Top left", "Top right", "Bottom right", "Bottom left"];

type MachinePoint = { x: number; y: number };
type Draft = {
  frame: { width: number; height: number; sequence: number };
  screen: { width: number; height: number };
  imagePoints: Array<ScreenPoint | null>;
  machinePoints: Array<MachinePoint | null>;
};
type CalibrationResponse = {
  ok: boolean;
  error?: string;
  calibration?: { draft: Draft | null; active: { id: string } | null };
};
type Device = {
  id: string;
  connected: boolean;
  state?: {
    appVersion?: string;
    grbl?: {
      connected?: boolean;
      calibrationActive?: boolean;
      state?: string;
      x?: number;
      y?: number;
      z?: number;
      activeOperation?: { type?: string; status?: string } | null;
    };
  };
};

export default function CalibratePage() {
  const [requestedDeviceId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("deviceId")?.trim() ?? "";
  });
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [endpoint, setEndpoint] = useState<ControlPlaneEndpoint | null>(null);
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedCorner, setSelectedCorner] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Connect the camera node to begin.");
  const [confirmed, setConfirmed] = useState(false);
  const [jogStep, setJogStep] = useState<0.5 | 2 | 10>(2);
  const stageRef = useRef<HTMLDivElement>(null);

  const device = devices.find((item) => item.id === deviceId) ?? devices[0];
  const grbl = device?.state?.grbl;

  const refresh = useCallback(async () => {
    if (!endpoint) return;
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/devices", { cache: "no-store" });
      const payload = await response.json() as { devices?: Device[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to load devices");
      const next = payload.devices ?? [];
      setDevices(next);
      if (!deviceId && next[0]) {
        setDeviceId(next.some((item) => item.id === requestedDeviceId) ? requestedDeviceId : next[0].id);
      }
    } catch {
      setMessage("ScreenHand control plane is offline.");
    }
  }, [deviceId, endpoint, requestedDeviceId]);

  const loadCalibration = useCallback(async (targetId: string) => {
    if (!targetId || !endpoint) return;
    try {
      const response = await controlPlaneFetch(
        endpoint,
        `/api/v1/devices/${encodeURIComponent(targetId)}/calibration`,
        { cache: "no-store" },
      );
      const payload = await response.json() as CalibrationResponse;
      if (!response.ok) throw new Error(payload.error ?? "Unable to load calibration");
      setDraft(payload.calibration?.draft ?? null);
      setActiveId(payload.calibration?.active?.id ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load calibration");
    }
  }, [endpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const resolved = resolveControlPlaneEndpoint();
      setEndpoint(resolved.endpoint);
      if (!resolved.endpoint && resolved.error) setMessage(resolved.error);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = setTimeout(() => void loadCalibration(deviceId), 0);
    return () => clearTimeout(timer);
  }, [deviceId, loadCalibration]);

  const calibrationRequest = async (body: Record<string, unknown>) => {
    if (!deviceId || !endpoint) return;
    setBusy(true);
    try {
      const response = await controlPlaneFetch(
        endpoint,
        `/api/v1/devices/${encodeURIComponent(deviceId)}/calibration`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json() as CalibrationResponse;
      if (!response.ok) throw new Error(payload.error ?? "Calibration request failed");
      setDraft(payload.calibration?.draft ?? null);
      setActiveId(payload.calibration?.active?.id ?? null);
      setMessage("Calibration data updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Calibration request failed");
    } finally {
      setBusy(false);
    }
  };

  const begin = () => {
    setSelectedCorner(0);
    setConfirmed(false);
    void calibrationRequest({
      operation: "begin",
      screenWidth: 720,
      screenHeight: 1560,
    });
  };

  const captureImagePoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft || !frame || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    const renderedWidth = frame.width * scale;
    const renderedHeight = frame.height * scale;
    const x = (event.clientX - rect.left - (rect.width - renderedWidth) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - renderedHeight) / 2) / scale;
    if (x < 0 || x > frame.width || y < 0 || y > frame.height) return;
    setConfirmed(false);
    void calibrationRequest({
      operation: "capture_image_point",
      index: selectedCorner,
      x,
      y,
    });
  };

  const captureMachinePoint = () => {
    setConfirmed(false);
    void calibrationRequest({
      operation: "capture_machine_point",
      index: selectedCorner,
    });
  };

  const jog = (axis: "X" | "Y", distance: number) => {
    setConfirmed(false);
    void calibrationRequest({
      operation: "jog",
      axis,
      distance,
    });
  };

  const resumeMotion = async () => {
    if (!deviceId || !endpoint) return;
    setBusy(true);
    try {
      const response = await controlPlaneFetch(
        endpoint,
        `/api/v1/devices/${encodeURIComponent(deviceId)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `calibration-resume-${deviceId}-${Date.now()}`,
            action: { type: "resume" },
          }),
        },
      );
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to resume the controller");
      setMessage("Resume accepted. Waiting for the controller to report Idle.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to resume the controller");
    } finally {
      setBusy(false);
    }
  };

  const imagePointCount = draft?.imagePoints.filter(Boolean).length ?? 0;
  const machinePointCount = draft?.machinePoints.filter(Boolean).length ?? 0;
  const readinessIssue = draft ? calibrationReadinessIssue(draft) : null;
  const complete = Boolean(draft && !readinessIssue);
  const moving = Boolean(grbl?.activeOperation);
  const readinessMessage = readinessIssue ?? (
    confirmed
      ? "All four camera and machine points are valid. The profile can be activated."
      : "All four point pairs are valid. Check the physical verification box to activate."
  );

  return (
    <main className="calibration-shell">
      <header className="calibration-header">
        <Link href="/"><ArrowLeft size={18} /> Back to control</Link>
        <div>
          <span className="brand-icon"><Crosshair size={21} weight="bold" /></span>
          <div><strong>Screen calibration</strong><span>Camera pixels → physical millimetres</span></div>
        </div>
        <span className={`status-pill ${activeId ? "ready" : "preview"}`}>
          {activeId ? "PROFILE ACTIVE" : "NOT CALIBRATED"}
        </span>
      </header>

      <div className="calibration-grid">
        <section className="calibration-camera-card">
          <div className="section-heading">
            <span>Raw camera frame</span>
            <small>{frame ? `${frame.width}×${frame.height} · ${frame.sequence}` : "waiting"}</small>
          </div>
          <div
            className={`calibration-stage ${draft ? "picking" : ""}`}
            ref={stageRef}
            onPointerDown={captureImagePoint}
          >
            {deviceId && endpoint ? (
              <LiveScreen
                controlPlaneUrl={liveControlPlaneBaseUrl(endpoint)}
                accessToken={endpoint.accessToken}
                deviceId={deviceId}
                raw
                onFrame={setFrame}
                onConnection={(connected, detail) => {
                  if (connected) setMessage("Camera connected. Ready to start calibration.");
                  else if (detail) setMessage(detail);
                }}
              />
            ) : (
              <div className="screen-empty"><DeviceMobileCamera size={34} /><strong>No camera node</strong></div>
            )}
            {draft?.imagePoints.map((point, index) => point ? (
              <span
                key={index}
                className={`calibration-marker ${selectedCorner === index ? "active" : ""}`}
                style={{
                  left: `${(point.x / draft.frame.width) * 100}%`,
                  top: `${(point.y / draft.frame.height) * 100}%`,
                }}
              >{index + 1}</span>
            ) : null)}
          </div>
          <p className="calibration-hint">
            Click the visible screen corners in order. Keep the camera and target phone fixed after recording them.
          </p>
        </section>

        <aside className="calibration-steps-card">
          <div className="section-heading">
            <span>Four-point workflow</span>
            {draft ? <small>camera {imagePointCount}/4 · machine {machinePointCount}/4</small> : null}
          </div>

          {!draft ? (
            <button className="primary-calibration-button" type="button" onClick={begin} disabled={!frame || busy}>
              {busy ? <CircleNotch className="spin" size={18} /> : <Crosshair size={18} />}
              Start calibration
            </button>
          ) : (
            <>
              <div className="corner-tabs">
                {CORNERS.map((label, index) => (
                  <button
                    key={label}
                    type="button"
                    className={selectedCorner === index ? "active" : ""}
                    onClick={() => setSelectedCorner(index)}
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>
                        {draft.imagePoints[index] ? "camera ✓" : "camera —"} · {draft.machinePoints[index] ? "machine ✓" : "machine —"}
                      </small>
                    </div>
                  </button>
                ))}
              </div>

              <div className="capture-position-card">
                <div><MapPin size={19} /><strong>Record machine point {selectedCorner + 1}</strong></div>
                <p>
                  Move the hovering stylus to the same screen corner. Each arrow moves 0.5 mm and touch remains disabled. Keep Z at hover height.
                </p>
                <div className="mini-coordinates">
                  <span>X <b>{Number(grbl?.x ?? 0).toFixed(2)}</b></span>
                  <span>Y <b>{Number(grbl?.y ?? 0).toFixed(2)}</b></span>
                  <span>Z <b>{Number(grbl?.z ?? 0).toFixed(2)}</b></span>
                </div>
                {String(grbl?.state ?? "").startsWith("Hold") ? (
                  <div className="calibration-hold-notice">
                    <span>Motion is paused in {grbl?.state}. Resume changes controller state only; it does not move the arm.</span>
                    <button type="button" onClick={() => void resumeMotion()} disabled={busy || moving}>
                      <Play size={15} weight="fill" /> Resume calibration motion
                    </button>
                  </div>
                ) : null}
                {draft.machinePoints[selectedCorner] ? (
                  <small className="captured-machine-point">
                    Recorded for corner {selectedCorner + 1}: X {draft.machinePoints[selectedCorner]!.x.toFixed(2)} · Y {draft.machinePoints[selectedCorner]!.y.toFixed(2)}
                  </small>
                ) : null}
                <div className="calibration-step-size" aria-label="Calibration movement step">
                  <span>Move step</span>
                  {([0.5, 2, 10] as const).map((step) => (
                    <button key={step} type="button" className={jogStep === step ? "active" : ""} onClick={() => setJogStep(step)}>
                      {step} mm
                    </button>
                  ))}
                </div>
                <div className="calibration-jog" aria-label="Calibration jog controls">
                  <button type="button" aria-label="Move stylus up" onClick={() => jog("Y", jogStep)} disabled={busy || moving || !grbl?.calibrationActive}><ArrowUp size={16} /></button>
                  <button type="button" aria-label="Move stylus left" onClick={() => jog("X", jogStep)} disabled={busy || moving || !grbl?.calibrationActive}><ArrowLeft size={16} /></button>
                  <span>{jogStep} mm</span>
                  <button type="button" aria-label="Move stylus right" onClick={() => jog("X", -jogStep)} disabled={busy || moving || !grbl?.calibrationActive}><ArrowRight size={16} /></button>
                  <button type="button" aria-label="Move stylus down" onClick={() => jog("Y", -jogStep)} disabled={busy || moving || !grbl?.calibrationActive}><ArrowDown size={16} /></button>
                </div>
                <button type="button" onClick={captureMachinePoint} disabled={busy || moving || !grbl?.calibrationActive}>
                  <MapPin size={17} /> Capture current XY
                </button>
                {!grbl?.calibrationActive ? <small>Enable the local calibration window on this hardware node first.</small> : null}
              </div>

              <div className={`calibration-readiness ${readinessIssue ? "blocked" : "ready"}`}>
                {readinessIssue ? <WarningCircle size={18} /> : <CheckCircle size={18} />}
                <p><strong>{readinessIssue ? "Calibration is not ready" : "Four point pairs are valid"}</strong><span>{readinessMessage}</span></p>
              </div>

              <label className={`verification-check ${!complete ? "disabled" : ""}`}>
                <input type="checkbox" checked={confirmed} disabled={!complete} onChange={(event) => setConfirmed(event.target.checked)} />
                <ShieldCheck size={19} />
                <span>I verified the phone is fixed and all four camera/machine points match.</span>
              </label>

              <button
                className="primary-calibration-button"
                type="button"
                disabled={!complete || !confirmed || busy || moving || !grbl?.calibrationActive}
                onClick={() => void calibrationRequest({
                  operation: "activate",
                  index: 0,
                  confirmation: "PHONE_FIXED_AND_POINTS_VERIFIED",
                })}
              >
                {busy ? <CircleNotch className="spin" size={18} /> : <FloppyDisk size={18} />}
                Verify and activate profile
              </button>
            </>
          )}

          <div className={`calibration-message ${message.includes("failed") || message.includes("offline") ? "error" : ""}`}>
            {message.includes("failed") || message.includes("offline") ? <WarningCircle size={17} /> : <CheckCircle size={17} />}
            <span>{message}</span>
          </div>
        </aside>
      </div>
    </main>
  );
}

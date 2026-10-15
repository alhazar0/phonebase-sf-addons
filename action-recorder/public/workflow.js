export const WORKFLOW_VERSION = 2;
export const ACTION_TYPES = new Set(["tap", "long_press", "swipe", "hover_path"]);
export const PRESSURE_TYPES = new Set(["light", "natural", "firm"]);
export const MAX_HOVER_PATH_POINTS = 2_000;
export const MAX_HOVER_PATH_DURATION_MS = 300_000;

function finite(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizedPoint(value, label) {
  const point = value && typeof value === "object" ? value : {};
  return {
    x: finite(point.x, `${label}.x`, 0, 1),
    y: finite(point.y, `${label}.y`, 0, 1),
  };
}

export function containDimensions(sourceWidthValue, sourceHeightValue, maximumWidthValue, maximumHeightValue) {
  const sourceWidth = finite(sourceWidthValue, "sourceWidth", 1, 16_384);
  const sourceHeight = finite(sourceHeightValue, "sourceHeight", 1, 16_384);
  const maximumWidth = finite(maximumWidthValue, "maximumWidth", 1, 32_768);
  const maximumHeight = finite(maximumHeightValue, "maximumHeight", 1, 32_768);
  const scale = Math.min(1, maximumWidth / sourceWidth, maximumHeight / sourceHeight);
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
  };
}

export function normalizeStep(value, index = 0) {
  const input = value && typeof value === "object" ? value : {};
  const type = String(input.type ?? "");
  if (!ACTION_TYPES.has(type)) {
    throw new Error(`Step ${index + 1} has an unsupported action type.`);
  }
  const common = {
    id: String(input.id ?? `step-${Date.now()}-${index}`).slice(0, 120),
    type,
    delayBeforeMs: Math.round(finite(input.delayBeforeMs ?? 0, "delayBeforeMs", 0, 60_000)),
    chance: finite(input.chance ?? 1, "chance", 0, 1),
  };
  if (type === "hover_path") {
    if (!Array.isArray(input.points) || input.points.length < 1 || input.points.length > MAX_HOVER_PATH_POINTS) {
      throw new Error(`A hover path must contain between 1 and ${MAX_HOVER_PATH_POINTS} points.`);
    }
    let previousAtMs = -1;
    const points = input.points.map((pointValue, pointIndex) => {
      const point = normalizedPoint(pointValue, `points[${pointIndex}]`);
      const atMs = Math.round(finite(
        pointValue?.atMs ?? 0,
        `points[${pointIndex}].atMs`,
        0,
        MAX_HOVER_PATH_DURATION_MS,
      ));
      if (pointIndex === 0 && atMs !== 0) {
        throw new Error("The first hover path point must start at 0 ms.");
      }
      if (atMs < previousAtMs) {
        throw new Error("Hover path point times must be in order.");
      }
      previousAtMs = atMs;
      return { ...point, atMs };
    });
    return {
      ...common,
      points,
      durationMs: points.at(-1).atMs,
    };
  }
  const pressure = PRESSURE_TYPES.has(String(input.pressure ?? "natural"))
    ? String(input.pressure ?? "natural")
    : "natural";
  if (type === "swipe") {
    return {
      ...common,
      pressure,
      start: normalizedPoint(input.start, "start"),
      end: normalizedPoint(input.end, "end"),
      durationMs: Math.round(finite(input.durationMs ?? 420, "durationMs", 100, 5_000)),
    };
  }
  return {
    ...common,
    pressure,
    point: normalizedPoint(input.point, "point"),
    durationMs: Math.round(finite(
      input.durationMs ?? (type === "long_press" ? 800 : 40),
      "durationMs",
      type === "long_press" ? 300 : 30,
      5_000,
    )),
  };
}

export function normalizeWorkflow(value) {
  const input = value && typeof value === "object" ? value : {};
  if (!Array.isArray(input.steps) || input.steps.length > 500) {
    throw new Error("A workflow must contain at most 500 steps.");
  }
  return {
    version: WORKFLOW_VERSION,
    name: String(input.name ?? "Untitled workflow").trim().slice(0, 120) || "Untitled workflow",
    deviceId: String(input.deviceId ?? "").trim().slice(0, 120),
    steps: input.steps.map((step, index) => normalizeStep(step, index)),
    loop: {
      infinite: input.loop?.infinite !== false,
      count: Math.round(finite(input.loop?.count ?? 1, "loop.count", 1, 10_000)),
      delayMs: Math.round(finite(input.loop?.delayMs ?? 500, "loop.delayMs", 0, 60_000)),
    },
  };
}

export function interpolateHoverPath(pointsValue, intervalMs = 50) {
  const interval = Math.round(finite(intervalMs, "hover interval", 20, 250));
  const path = normalizeStep({ type: "hover_path", points: pointsValue }).points;
  if (path.length === 1 || path.at(-1).atMs === 0) return [path.at(-1)];

  const output = [];
  let segmentIndex = 1;
  const durationMs = path.at(-1).atMs;
  for (let atMs = 0; atMs < durationMs; atMs += interval) {
    while (segmentIndex < path.length - 1 && path[segmentIndex].atMs < atMs) {
      segmentIndex += 1;
    }
    const start = path[segmentIndex - 1];
    const end = path[segmentIndex];
    const segmentDuration = end.atMs - start.atMs;
    const ratio = segmentDuration <= 0
      ? 1
      : Math.max(0, Math.min(1, (atMs - start.atMs) / segmentDuration));
    output.push({
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
      atMs,
    });
  }
  output.push({ ...path.at(-1) });
  return output;
}

function materializedTouchZ(pressure, tapProfile) {
  const maximum = Number(tapProfile?.maximumTouchZ ?? tapProfile?.touchZ);
  const minimum = Number(
    tapProfile?.minimumTouchZ ??
    (Number.isFinite(maximum) ? maximum - 0.5 : Number.NaN),
  );
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
    return null;
  }
  const ratio = pressure === "light" ? 0.2 : pressure === "firm" ? 1 : 0.65;
  return Math.round((minimum + (maximum - minimum) * ratio) * 1000) / 1000;
}

export function materializeAction(stepValue, frame, tapProfile) {
  const step = normalizeStep(stepValue);
  const width = finite(frame?.width, "frame.width", 64, 8192);
  const height = finite(frame?.height, "frame.height", 64, 8192);
  const frameSequence = Math.round(finite(frame?.sequence, "frame.sequence", 1, Number.MAX_SAFE_INTEGER));
  const viewport = { width, height };
  const point = (value) => ({ x: value.x * width, y: value.y * height });
  if (step.type === "hover_path") {
    return {
      type: "hover_path",
      points: step.points.map((value) => ({ ...point(value), atMs: value.atMs })),
      viewport,
      frameSequence,
      durationMs: step.durationMs,
    };
  }
  const touchZ = materializedTouchZ(step.pressure, tapProfile);
  const pressure = touchZ === null ? {} : { touchZ };
  if (step.type === "swipe") {
    return {
      type: "swipe",
      start: point(step.start),
      end: point(step.end),
      viewport,
      frameSequence,
      durationMs: step.durationMs,
      ...pressure,
    };
  }
  return {
    type: step.type,
    point: point(step.point),
    viewport,
    frameSequence,
    durationMs: step.durationMs,
    ...pressure,
  };
}

export function shouldRunStep(step, random = Math.random) {
  return random() < normalizeStep(step).chance;
}

export function describeStep(stepValue) {
  const step = normalizeStep(stepValue);
  if (step.type === "hover_path") {
    return `Hover path · ${step.points.length} point${step.points.length === 1 ? "" : "s"} · ${step.durationMs} ms`;
  }
  const pressure = step.pressure === "light" ? "Light" : step.pressure === "firm" ? "Firm" : "Normal";
  if (step.type === "swipe") {
    return `Swipe ${Math.round(step.start.x * 100)}%,${Math.round(step.start.y * 100)}% → ${Math.round(step.end.x * 100)}%,${Math.round(step.end.y * 100)}% · ${pressure}`;
  }
  const label = step.type === "long_press" ? "Long press" : "Tap";
  return `${label} ${Math.round(step.point.x * 100)}%,${Math.round(step.point.y * 100)}% · ${pressure}`;
}

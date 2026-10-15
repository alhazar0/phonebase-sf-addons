export const SCREENHAND_ACTION_TYPES = [
  "status",
  "hold",
  "resume",
  "home",
  "hover_move",
  "touch_down",
  "touch_move",
  "touch_up",
  "touch_keepalive",
  "tap",
  "long_press",
  "swipe",
  "input_text",
  "phone_key",
  "wait",
] as const;

export type ScreenHandActionType = (typeof SCREENHAND_ACTION_TYPES)[number];

export const SCREENHAND_MAX_TEXT_LENGTH = 120;

export type ScreenHandViewport = {
  width: number;
  height: number;
};

export type ScreenHandPoint = {
  x: number;
  y: number;
};

export type ScreenHandSemanticAction =
  | { type: "status" }
  | { type: "hold" }
  | { type: "resume" }
  | { type: "home"; confirmation: "CLEAR_WORKSPACE_AND_HOME" }
  | {
      type: "hover_move";
      point: ScreenHandPoint;
      viewport: ScreenHandViewport;
      frameSequence: number;
    }
  | {
      type: "touch_down";
      point: ScreenHandPoint;
      viewport: ScreenHandViewport;
      frameSequence: number;
      sessionId: string;
      touchZ?: number;
    }
  | {
      type: "touch_move";
      point: ScreenHandPoint;
      viewport: ScreenHandViewport;
      frameSequence: number;
      sessionId: string;
    }
  | { type: "touch_up"; sessionId: string }
  | { type: "touch_keepalive"; sessionId: string }
  | {
      type: "tap";
      point: ScreenHandPoint;
      viewport: ScreenHandViewport;
      frameSequence: number;
      durationMs?: number;
      touchZ?: number;
    }
  | {
      type: "long_press";
      point: ScreenHandPoint;
      viewport: ScreenHandViewport;
      frameSequence: number;
      durationMs: number;
      touchZ?: number;
    }
  | {
      type: "swipe";
      start: ScreenHandPoint;
      end: ScreenHandPoint;
      viewport: ScreenHandViewport;
      frameSequence: number;
      durationMs: number;
      touchZ?: number;
    }
  | { type: "input_text"; text: string; touchZ?: number }
  | { type: "phone_key"; key: "back" | "home" | "enter" | "keyboard_next" }
  | { type: "wait"; durationMs: number };

export type ScreenHandActionEnvelope = {
  idempotencyKey: string;
  action: ScreenHandSemanticAction;
};

export type ScreenHandActionAvailability = {
  available: boolean;
  reason?: string;
};

export type ScreenHandCapabilities = {
  protocolVersion: "2026-07-29";
  observation: {
    screenshot: ScreenHandActionAvailability;
    liveFrames: ScreenHandActionAvailability;
    uiHierarchy: ScreenHandActionAvailability;
  };
  actions: Record<ScreenHandActionType, ScreenHandActionAvailability>;
};

export class ScreenHandActionValidationError extends Error {
  readonly code = "INVALID_ACTION";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ScreenHandActionValidationError(
      `${label} contains unsupported field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}.`,
    );
  }
}

function finiteNumber(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ScreenHandActionValidationError(`${label} must be a finite number.`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new ScreenHandActionValidationError(`${label} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new ScreenHandActionValidationError(`${label} must be at most ${options.max}.`);
  }
  return parsed;
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = finiteNumber(value, label, options);
  if (!Number.isInteger(parsed)) {
    throw new ScreenHandActionValidationError(`${label} must be an integer.`);
  }
  return parsed;
}

function nonEmptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ScreenHandActionValidationError(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ScreenHandActionValidationError(`${label} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function viewport(value: unknown): ScreenHandViewport {
  const record = asRecord(value);
  assertOnlyKeys(record, ["width", "height"], "viewport");
  return {
    width: finiteNumber(record.width, "viewport.width", { min: 64, max: 8192 }),
    height: finiteNumber(record.height, "viewport.height", { min: 64, max: 8192 }),
  };
}

function point(value: unknown, field: string, size: ScreenHandViewport): ScreenHandPoint {
  const record = asRecord(value);
  assertOnlyKeys(record, ["x", "y"], field);
  return {
    x: finiteNumber(record.x, `${field}.x`, { min: 0, max: size.width }),
    y: finiteNumber(record.y, `${field}.y`, { min: 0, max: size.height }),
  };
}

function touchContext(record: Record<string, unknown>) {
  const size = viewport(record.viewport);
  return {
    viewport: size,
    frameSequence: integer(record.frameSequence, "frameSequence", { min: 1 }),
  };
}

function optionalTouchZ(record: Record<string, unknown>) {
  return record.touchZ === undefined
    ? {}
    : {
        touchZ: finiteNumber(record.touchZ, "touchZ", {
          min: -20,
          max: 20,
        }),
      };
}

export function parseScreenHandActionEnvelope(value: unknown): ScreenHandActionEnvelope {
  const envelope = asRecord(value);
  assertOnlyKeys(envelope, ["idempotencyKey", "action"], "request");
  const idempotencyKey = nonEmptyString(
    envelope.idempotencyKey,
    "idempotencyKey",
    160,
  );
  const actionRecord = asRecord(envelope.action);
  const type = nonEmptyString(actionRecord.type, "action.type", 40);
  if (!SCREENHAND_ACTION_TYPES.includes(type as ScreenHandActionType)) {
    throw new ScreenHandActionValidationError(`Unsupported action type: ${type}.`);
  }

  const allowedFields: Record<ScreenHandActionType, readonly string[]> = {
    status: ["type"],
    hold: ["type"],
    resume: ["type"],
    home: ["type", "confirmation"],
    wait: ["type", "durationMs"],
    input_text: ["type", "text", "touchZ"],
    phone_key: ["type", "key"],
    hover_move: ["type", "point", "viewport", "frameSequence"],
    touch_down: ["type", "point", "viewport", "frameSequence", "sessionId", "touchZ"],
    touch_move: ["type", "point", "viewport", "frameSequence", "sessionId"],
    touch_up: ["type", "sessionId"],
    touch_keepalive: ["type", "sessionId"],
    tap: ["type", "point", "viewport", "frameSequence", "durationMs", "touchZ"],
    long_press: ["type", "point", "viewport", "frameSequence", "durationMs", "touchZ"],
    swipe: ["type", "start", "end", "viewport", "frameSequence", "durationMs", "touchZ"],
  };
  assertOnlyKeys(actionRecord, allowedFields[type as ScreenHandActionType], "action");

  let action: ScreenHandSemanticAction;
  if (type === "status" || type === "hold" || type === "resume") {
    action = { type };
  } else if (type === "home") {
    const confirmation = nonEmptyString(
      actionRecord.confirmation,
      "confirmation",
      80,
    );
    if (confirmation !== "CLEAR_WORKSPACE_AND_HOME") {
      throw new ScreenHandActionValidationError(
        "Home requires confirmation CLEAR_WORKSPACE_AND_HOME.",
      );
    }
    action = { type, confirmation };
  } else if (type === "wait") {
    action = {
      type,
      durationMs: integer(actionRecord.durationMs, "durationMs", {
        min: 0,
        max: 30_000,
      }),
    };
  } else if (type === "input_text") {
    action = {
      type,
      text: nonEmptyString(actionRecord.text, "text", SCREENHAND_MAX_TEXT_LENGTH),
      ...optionalTouchZ(actionRecord),
    };
  } else if (type === "phone_key") {
    const key = nonEmptyString(actionRecord.key, "key", 20);
    if (
      key !== "back" && key !== "home" && key !== "enter" &&
      key !== "keyboard_next"
    ) {
      throw new ScreenHandActionValidationError(`Unsupported phone key: ${key}.`);
    }
    action = { type, key };
  } else if (type === "touch_up" || type === "touch_keepalive") {
    action = {
      type,
      sessionId: nonEmptyString(actionRecord.sessionId, "sessionId", 160),
    };
  } else if (type === "swipe") {
    const context = touchContext(actionRecord);
    action = {
      type,
      ...context,
      ...optionalTouchZ(actionRecord),
      start: point(actionRecord.start, "start", context.viewport),
      end: point(actionRecord.end, "end", context.viewport),
      durationMs: integer(actionRecord.durationMs ?? 500, "durationMs", {
        min: 250,
        max: 3_000,
      }),
    };
  } else if (type === "hover_move") {
    const context = touchContext(actionRecord);
    action = {
      type,
      ...context,
      point: point(actionRecord.point, "point", context.viewport),
    };
  } else if (type === "touch_down" || type === "touch_move") {
    const context = touchContext(actionRecord);
    action = {
      type,
      ...context,
      ...(type === "touch_down" ? optionalTouchZ(actionRecord) : {}),
      point: point(actionRecord.point, "point", context.viewport),
      sessionId: nonEmptyString(actionRecord.sessionId, "sessionId", 160),
    };
  } else {
    const context = touchContext(actionRecord);
    const touchType: "tap" | "long_press" = type === "long_press"
      ? "long_press"
      : "tap";
    const durationMs = integer(
      actionRecord.durationMs ?? (touchType === "long_press" ? 800 : 40),
      "durationMs",
      {
        min: touchType === "long_press" ? 500 : 30,
        max: touchType === "long_press" ? 5_000 : 250,
      },
    );
    action = {
      type: touchType,
      ...context,
      ...optionalTouchZ(actionRecord),
      point: point(actionRecord.point, "point", context.viewport),
      durationMs,
    };
  }

  return { idempotencyKey, action };
}

export function normalizeScreenHandPoint(
  pointValue: ScreenHandPoint,
  viewportValue: ScreenHandViewport,
): ScreenHandPoint {
  return {
    x: pointValue.x / viewportValue.width,
    y: pointValue.y / viewportValue.height,
  };
}

export function buildScreenHandCapabilities(input: {
  frameReady: boolean;
  calibrationReady: boolean;
  homeReady?: boolean;
  homeReason?: string;
  resumeReady?: boolean;
  resumeReason?: string;
  longPressReady?: boolean;
  swipeReady?: boolean;
  inputTextReady?: boolean;
  phoneKeyReady?: boolean;
}): ScreenHandCapabilities {
  const requiresFrame = input.frameReady
    ? { available: true }
    : { available: false, reason: "A fresh camera frame is required." };
  const calibrationReason = input.frameReady
    ? "Physical XY/Z calibration is required."
    : "A fresh camera frame and physical XY/Z calibration are required.";
  const physicalAction = input.frameReady && input.calibrationReady
    ? { available: true }
    : { available: false, reason: calibrationReason };

  return {
    protocolVersion: "2026-07-29",
    observation: {
      screenshot: requiresFrame,
      liveFrames: requiresFrame,
      uiHierarchy: {
        available: false,
        reason: "Physical phones are observed visually and do not expose Android UI XML.",
      },
    },
    actions: {
      status: { available: true },
      hold: { available: true },
      resume: input.resumeReady
        ? { available: true }
        : {
            available: false,
            reason: input.resumeReason ?? "A connected, homed controller in Hold is required.",
          },
      home: input.homeReady
        ? { available: true }
        : {
            available: false,
            reason: input.homeReason ?? "A connected idle controller that has not been homed is required.",
          },
      hover_move: physicalAction,
      touch_down: physicalAction,
      touch_move: physicalAction,
      // Release and keepalive remain routable even when the latest frame has
      // expired. The driver validates the active session and owns the final
      // watchdog, so a safety release can never be blocked by vision state.
      touch_up: { available: true },
      touch_keepalive: { available: true },
      tap: physicalAction,
      long_press: input.longPressReady
        ? physicalAction
        : {
            available: false,
            reason: "Long press requires a matching hardware gesture profile.",
          },
      swipe: input.swipeReady
        ? physicalAction
        : {
            available: false,
            reason: "Swipe requires a matching hardware gesture profile.",
          },
      input_text: input.inputTextReady
        ? physicalAction
        : {
            available: false,
            reason: "Text entry requires a verified iOS keyboard profile.",
          },
      phone_key: input.phoneKeyReady
        ? physicalAction
        : {
            available: false,
            reason: "Phone Back, Home, and Enter require calibrated gestures.",
          },
      wait: { available: true },
    },
  };
}

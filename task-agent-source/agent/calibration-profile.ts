import { readFileSync } from "node:fs";
import {
  homographyFromFourPoints,
  mapImagePointToMachine,
  type FourPointCalibration,
  type Point,
} from "./homography";

export type ScreenHandCalibrationProfile = {
  id: string;
  deviceId: string;
  verified: true;
  verifiedAt: string;
  frame: {
    width: number;
    height: number;
  };
  screen: {
    width: number;
    height: number;
  };
  imagePoints: [Point, Point, Point, Point];
  machinePoints: [Point, Point, Point, Point];
  /** Current clean-screen corners in machine space. The camera calibration
   * remains fixed while this value can be refreshed when the phone is reseated. */
  controlMachinePoints?: [Point, Point, Point, Point];
  placementCalibration?: {
    method: "joint-camera-touch-v1";
    verifiedAt: string;
    cameraRmsePx: number;
    cameraMaximumErrorPx: number;
  };
  navigation?: {
    home:
      | {
          strategy: "physical-button";
          machinePoint: Point;
          durationMs: number;
          source: "legacy-ios-16x9-geometry-v1";
        }
      | {
          strategy: "screen-swipe";
          startPoint: Point;
          endPoint: Point;
          durationMs: number;
          source: "ios-face-id-home-v1";
        };
  };
  /** Optional device-specific touch points for a visible iOS Latin keyboard.
   * `strict` prevents an unverified generic key map from being mixed into a
   * physically calibrated sequence. */
  keyboard?: {
    strategy: "screen-point-overrides-v1";
    layout: "ios-latin-qwerty";
    verifiedAt: string;
    strict: true;
    points: Record<string, Point>;
  };
  safeMachineBounds: {
    minimumX: number;
    maximumX: number;
    minimumY: number;
    maximumY: number;
  };
  tap: {
    hoverZ: number;
    touchZ: number;
    zStep: number;
    feed: number;
    dwellMs: number;
  };
};

export type CalibrationReadiness = {
  ready: boolean;
  reason?: string;
};

export function retainedKeyboardCalibration(
  previousProfile: ScreenHandCalibrationProfile | null,
  next: {
    deviceId: string;
    profileId: string;
    screen: { width: number; height: number };
  },
): ScreenHandCalibrationProfile["keyboard"] | undefined {
  if (
    previousProfile?.deviceId !== next.deviceId ||
    previousProfile.id !== next.profileId ||
    previousProfile.screen.width !== next.screen.width ||
    previousProfile.screen.height !== next.screen.height
  ) return undefined;
  return previousProfile.keyboard;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("标定档案必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 不能为空`);
  }
  return value.trim();
}

function numberValue(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} 必须是有限数字`);
  }
  return parsed;
}

function integerValue(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} 必须是整数`);
  }
  return parsed;
}

function point(value: unknown, label: string): Point {
  const input = record(value);
  return {
    x: numberValue(input.x, `${label}.x`),
    y: numberValue(input.y, `${label}.y`),
  };
}

function fourPoints(
  value: unknown,
  label: string,
): [Point, Point, Point, Point] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${label} 必须恰好包含四个点`);
  }
  return [
    point(value[0], `${label}[0]`),
    point(value[1], `${label}[1]`),
    point(value[2], `${label}[2]`),
    point(value[3], `${label}[3]`),
  ];
}

export function parseScreenHandCalibrationProfile(
  value: unknown,
): ScreenHandCalibrationProfile {
  const input = record(value);
  if (input.verified !== true) {
    throw new Error("标定档案必须经过人工验证");
  }

  const frameInput = record(input.frame);
  const frame = {
    width: integerValue(frameInput.width, "frame.width"),
    height: integerValue(frameInput.height, "frame.height"),
  };
  if (
    frame.width < 64 ||
    frame.width > 4096 ||
    frame.height < 64 ||
    frame.height > 4096
  ) {
    throw new Error("标定画面尺寸超出允许范围");
  }

  const imagePoints = fourPoints(input.imagePoints, "imagePoints");
  imagePoints.forEach((valuePoint, index) => {
    if (
      valuePoint.x < 0 ||
      valuePoint.x > frame.width ||
      valuePoint.y < 0 ||
      valuePoint.y > frame.height
    ) {
      throw new Error(`imagePoints[${index}] 超出标定画面`);
    }
  });
  const machinePoints = fourPoints(input.machinePoints, "machinePoints");
  const controlMachinePoints = input.controlMachinePoints === undefined
    ? undefined
    : fourPoints(input.controlMachinePoints, "controlMachinePoints");
  let placementCalibration: ScreenHandCalibrationProfile["placementCalibration"];
  if (input.placementCalibration !== undefined) {
    const placement = record(input.placementCalibration);
    if (placement.method !== "joint-camera-touch-v1") {
      throw new Error("placementCalibration.method 无效");
    }
    const cameraRmsePx = numberValue(
      placement.cameraRmsePx,
      "placementCalibration.cameraRmsePx",
    );
    const cameraMaximumErrorPx = numberValue(
      placement.cameraMaximumErrorPx,
      "placementCalibration.cameraMaximumErrorPx",
    );
    if (
      cameraRmsePx < 0 || cameraRmsePx > 10 ||
      cameraMaximumErrorPx < 0 || cameraMaximumErrorPx > 16
    ) {
      throw new Error("物理相机位置验收误差超出允许范围");
    }
    placementCalibration = {
      method: "joint-camera-touch-v1",
      verifiedAt: stringValue(
        placement.verifiedAt,
        "placementCalibration.verifiedAt",
      ),
      cameraRmsePx,
      cameraMaximumErrorPx,
    };
  }

  const screenInput = record(input.screen);
  const screen = {
    width: integerValue(screenInput.width, "screen.width"),
    height: integerValue(screenInput.height, "screen.height"),
  };
  if (
    screen.width < 320 ||
    screen.width > 2160 ||
    screen.height < 480 ||
    screen.height > 4096
  ) {
    throw new Error("校正后屏幕尺寸超出允许范围");
  }

  const boundsInput = record(input.safeMachineBounds);
  const safeMachineBounds = {
    minimumX: numberValue(boundsInput.minimumX, "safeMachineBounds.minimumX"),
    maximumX: numberValue(boundsInput.maximumX, "safeMachineBounds.maximumX"),
    minimumY: numberValue(boundsInput.minimumY, "safeMachineBounds.minimumY"),
    maximumY: numberValue(boundsInput.maximumY, "safeMachineBounds.maximumY"),
  };
  if (
    safeMachineBounds.minimumX >= safeMachineBounds.maximumX ||
    safeMachineBounds.minimumY >= safeMachineBounds.maximumY
  ) {
    throw new Error("标定安全范围无效");
  }
  if (
    safeMachineBounds.minimumX < -300 ||
    safeMachineBounds.maximumX > 300 ||
    safeMachineBounds.minimumY < -300 ||
    safeMachineBounds.maximumY > 300
  ) {
    throw new Error("标定安全范围超出 ScreenHand 支持的机械坐标范围");
  }

  const tapInput = record(input.tap);
  const tapValues = {
    hoverZ: numberValue(tapInput.hoverZ, "tap.hoverZ"),
    touchZ: numberValue(tapInput.touchZ, "tap.touchZ"),
    zStep: numberValue(tapInput.zStep, "tap.zStep"),
    feed: numberValue(tapInput.feed, "tap.feed"),
    dwellMs: integerValue(tapInput.dwellMs, "tap.dwellMs"),
  };
  if (
    tapValues.hoverZ < -20 || tapValues.hoverZ > 20 ||
    tapValues.touchZ < -20 || tapValues.touchZ > 20 ||
    tapValues.touchZ === tapValues.hoverZ ||
    tapValues.zStep <= 0 || tapValues.zStep > 5 ||
    tapValues.feed < 1 || tapValues.feed > 20_000 ||
    tapValues.dwellMs < 20 || tapValues.dwellMs > 5_000
  ) {
    throw new Error("标定点击参数超出 ScreenHand 支持范围");
  }
  const tap = tapValues;

  let navigation: ScreenHandCalibrationProfile["navigation"];
  if (input.navigation !== undefined) {
    const navigationInput = record(input.navigation);
    const homeInput = record(navigationInput.home);
    if (homeInput.strategy === "physical-button") {
      if (homeInput.source !== "legacy-ios-16x9-geometry-v1") {
        throw new Error("navigation.home.source 无效");
      }
      const machinePoint = point(
        homeInput.machinePoint,
        "navigation.home.machinePoint",
      );
      if (
        machinePoint.x < safeMachineBounds.minimumX ||
        machinePoint.x > safeMachineBounds.maximumX ||
        machinePoint.y < safeMachineBounds.minimumY ||
        machinePoint.y > safeMachineBounds.maximumY
      ) {
        throw new Error("实体 Home 键坐标超出机械臂安全范围");
      }
      navigation = {
        home: {
          strategy: "physical-button",
          machinePoint,
          durationMs: integerValue(
            homeInput.durationMs,
            "navigation.home.durationMs",
          ),
          source: "legacy-ios-16x9-geometry-v1",
        },
      };
    } else if (homeInput.strategy === "screen-swipe") {
      if (homeInput.source !== "ios-face-id-home-v1") {
        throw new Error("navigation.home.source 无效");
      }
      const startPoint = point(homeInput.startPoint, "navigation.home.startPoint");
      const endPoint = point(homeInput.endPoint, "navigation.home.endPoint");
      for (const [label, navigationPoint] of [
        ["startPoint", startPoint],
        ["endPoint", endPoint],
      ] as const) {
        if (
          navigationPoint.x < 0 || navigationPoint.x > screen.width ||
          navigationPoint.y < 0 || navigationPoint.y > screen.height
        ) {
          throw new Error(`navigation.home.${label} 超出校正后的屏幕画面`);
        }
      }
      if (
        startPoint.y < screen.height * 0.88 ||
        endPoint.y > screen.height * 0.8 ||
        endPoint.y >= startPoint.y - screen.height * 0.12 ||
        Math.abs(startPoint.x - endPoint.x) > screen.width * 0.15
      ) {
        throw new Error("Face ID Home 手势必须从屏幕底部向上滑动");
      }
      navigation = {
        home: {
          strategy: "screen-swipe",
          startPoint,
          endPoint,
          durationMs: integerValue(
            homeInput.durationMs,
            "navigation.home.durationMs",
          ),
          source: "ios-face-id-home-v1",
        },
      };
    } else {
      throw new Error("navigation.home.strategy 无效");
    }
    if (
      navigation.home.durationMs < 50 ||
      navigation.home.durationMs > 1_000
    ) {
      throw new Error("实体 Home 键按压时间超出允许范围");
    }
  }

  let keyboard: ScreenHandCalibrationProfile["keyboard"];
  if (input.keyboard !== undefined) {
    const keyboardInput = record(input.keyboard);
    if (keyboardInput.strategy !== "screen-point-overrides-v1") {
      throw new Error("keyboard.strategy 无效");
    }
    if (keyboardInput.layout !== "ios-latin-qwerty") {
      throw new Error("keyboard.layout 无效");
    }
    if (keyboardInput.strict !== true) {
      throw new Error("keyboard.strict 必须为 true，禁止混用未经验证的键位");
    }
    const pointsInput = record(keyboardInput.points);
    const points: Record<string, Point> = {};
    for (const [key, value] of Object.entries(pointsInput)) {
      if (!key.trim() || key.length > 16) {
        throw new Error("keyboard.points 包含无效键名");
      }
      const keyPoint = point(value, `keyboard.points.${key}`);
      if (
        keyPoint.x < 0 || keyPoint.x > screen.width ||
        keyPoint.y < 0 || keyPoint.y > screen.height
      ) {
        throw new Error(`keyboard.points.${key} 超出校正后的屏幕画面`);
      }
      points[key] = keyPoint;
    }
    if (!Object.keys(points).length) {
      throw new Error("keyboard.points 至少需要一个已验证键位");
    }
    keyboard = {
      strategy: "screen-point-overrides-v1",
      layout: "ios-latin-qwerty",
      verifiedAt: stringValue(keyboardInput.verifiedAt, "keyboard.verifiedAt"),
      strict: true,
      points,
    };
  }

  const profile: ScreenHandCalibrationProfile = {
    id: stringValue(input.id, "id"),
    deviceId: stringValue(input.deviceId, "deviceId"),
    verified: true,
    verifiedAt: stringValue(input.verifiedAt, "verifiedAt"),
    frame,
    screen,
    imagePoints,
    machinePoints,
    ...(controlMachinePoints ? { controlMachinePoints } : {}),
    ...(placementCalibration ? { placementCalibration } : {}),
    ...(navigation ? { navigation } : {}),
    ...(keyboard ? { keyboard } : {}),
    safeMachineBounds,
    tap,
  };
  // Force the projective transform to be solved at startup so a degenerate
  // four-point profile can never make touch capabilities available.
  homographyFromFourPoints(profile.imagePoints, profile.machinePoints);
  return profile;
}

export function loadScreenHandCalibrationProfile(
  path = process.env.SCREENHAND_CALIBRATION_PATH,
): ScreenHandCalibrationProfile | null {
  if (!path?.trim()) return null;
  return parseScreenHandCalibrationProfile(
    JSON.parse(readFileSync(path.trim(), "utf8")),
  );
}

export function calibrationReadiness(
  profile: ScreenHandCalibrationProfile | null,
  input: {
    deviceId: string;
    frame: { width: number; height: number } | null;
  },
): CalibrationReadiness {
  if (!profile) {
    return {
      ready: false,
      reason: "A verified four-point physical calibration profile is required.",
    };
  }
  if (profile.deviceId !== input.deviceId) {
    return {
      ready: false,
      reason: "The physical calibration profile belongs to another device.",
    };
  }
  if (!input.frame) {
    return {
      ready: false,
      reason: "A fresh camera frame is required.",
    };
  }
  if (
    profile.frame.width !== input.frame.width ||
    profile.frame.height !== input.frame.height
  ) {
    return {
      ready: false,
      reason: "The camera frame size does not match the calibration profile.",
    };
  }
  return { ready: true };
}

export function calibratedMachinePoint(
  profile: ScreenHandCalibrationProfile,
  imagePoint: Point,
): Point {
  const calibration: FourPointCalibration = {
    imagePoints: profile.imagePoints,
    machinePoints: profile.machinePoints,
  };
  const mapped = mapImagePointToMachine(calibration, imagePoint);
  const bounds = profile.safeMachineBounds;
  if (
    mapped.x < bounds.minimumX ||
    mapped.x > bounds.maximumX ||
    mapped.y < bounds.minimumY ||
    mapped.y > bounds.maximumY
  ) {
    throw new Error("目标点映射后超出已验证的屏幕安全范围");
  }
  return {
    x: Math.round(mapped.x * 1000) / 1000,
    y: Math.round(mapped.y * 1000) / 1000,
  };
}

/**
 * Maps a point from the rectified screen shown to the operator into machine
 * space. Unlike calibratedMachinePoint(), this transform is independent of
 * camera perspective because the operator works in the flat screen viewport.
 */
export function calibratedScreenPoint(
  profile: ScreenHandCalibrationProfile,
  screenPoint: Point,
): Point {
  const { width, height } = profile.screen;
  if (
    screenPoint.x < 0 ||
    screenPoint.x > width ||
    screenPoint.y < 0 ||
    screenPoint.y > height
  ) {
    throw new Error("目标点超出校正后的屏幕画面");
  }
  const calibration: FourPointCalibration = {
    imagePoints: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    machinePoints: profile.controlMachinePoints ?? profile.machinePoints,
  };
  const mapped = mapImagePointToMachine(calibration, screenPoint);
  const bounds = profile.safeMachineBounds;
  if (
    mapped.x < bounds.minimumX ||
    mapped.x > bounds.maximumX ||
    mapped.y < bounds.minimumY ||
    mapped.y > bounds.maximumY
  ) {
    throw new Error("目标点映射后超出已验证的屏幕安全范围");
  }
  return {
    x: Math.round(mapped.x * 1000) / 1000,
    y: Math.round(mapped.y * 1000) / 1000,
  };
}

export type ReachableScreenPoint = {
  requestedScreenPoint: Point;
  screenPoint: Point;
  machinePoint: Point;
  snapped: boolean;
  snapDistancePx: number;
};

/**
 * Maps an operator point into the verified machine area while allowing only a
 * small, auditable correction at a screen edge. This makes the last few
 * pixels of rounded or mechanically inset displays usable without silently
 * redirecting a genuinely unreachable target to another control.
 */
export function calibratedReachableScreenPoint(
  profile: ScreenHandCalibrationProfile,
  requestedScreenPoint: Point,
  maximumSnapPx = Math.max(
    6,
    Math.min(profile.screen.width, profile.screen.height) * 0.025,
  ),
): ReachableScreenPoint {
  if (
    !Number.isFinite(requestedScreenPoint.x) ||
    !Number.isFinite(requestedScreenPoint.y)
  ) {
    throw new Error("目标点坐标必须是有限数字");
  }
  if (!Number.isFinite(maximumSnapPx) || maximumSnapPx < 0) {
    throw new Error("边缘吸附距离必须是非负有限数字");
  }
  const requested = {
    x: Math.max(0, Math.min(profile.screen.width, requestedScreenPoint.x)),
    y: Math.max(0, Math.min(profile.screen.height, requestedScreenPoint.y)),
  };
  try {
    return {
      requestedScreenPoint: requested,
      screenPoint: requested,
      machinePoint: calibratedScreenPoint(profile, requested),
      snapped: false,
      snapDistancePx: 0,
    };
  } catch {
    // Continue toward the known-good screen centre below.
  }

  const centre = {
    x: profile.screen.width * 0.5,
    y: profile.screen.height * 0.5,
  };
  calibratedScreenPoint(profile, centre);
  let unreachable = 0;
  let reachable = 1;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const ratio = (unreachable + reachable) * 0.5;
    const candidate = {
      x: requested.x + (centre.x - requested.x) * ratio,
      y: requested.y + (centre.y - requested.y) * ratio,
    };
    try {
      calibratedScreenPoint(profile, candidate);
      reachable = ratio;
    } catch {
      unreachable = ratio;
    }
  }

  const distanceToCentre = Math.hypot(
    centre.x - requested.x,
    centre.y - requested.y,
  );
  const interiorMarginPx = Math.max(
    2,
    Math.min(profile.screen.width, profile.screen.height) * 0.004,
  );
  const safelyInside = distanceToCentre <= interiorMarginPx
    ? reachable
    : Math.min(1, reachable + interiorMarginPx / distanceToCentre);
  const screenPoint = {
    x: requested.x + (centre.x - requested.x) * safelyInside,
    y: requested.y + (centre.y - requested.y) * safelyInside,
  };
  const snapDistancePx = Math.hypot(
    screenPoint.x - requested.x,
    screenPoint.y - requested.y,
  );
  if (snapDistancePx > maximumSnapPx) {
    throw new Error(
      `目标点距离机械可达屏幕区域 ${snapDistancePx.toFixed(1)}px，超过 ` +
      `${maximumSnapPx.toFixed(1)}px 的安全吸附上限`,
    );
  }
  const effectiveScreenPoint = {
    x: Math.round(screenPoint.x * 1000) / 1000,
    y: Math.round(screenPoint.y * 1000) / 1000,
  };
  return {
    requestedScreenPoint: requested,
    screenPoint: effectiveScreenPoint,
    machinePoint: calibratedScreenPoint(profile, effectiveScreenPoint),
    snapped: true,
    snapDistancePx: Math.round(snapDistancePx * 1000) / 1000,
  };
}

import { type ScreenHandCalibrationProfile } from "./calibration-profile";
import { mapImagePointToMachine, type Point } from "./homography";

export type PhoneNavigationKey = "back" | "home" | "enter";

export type PhoneNavigationAnchor = {
  screenPoint: Point;
  machinePoint: Point;
};

export type MachineBounds = {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
};

export type SystemEdgeBoundary =
  | "minimumX"
  | "maximumX"
  | "minimumY"
  | "maximumY";

export type PhoneNavigationContext = {
  backControl?: Point | null;
  edgeMachineBounds?: MachineBounds | null;
};

export type PhoneNavigationPlan =
  | {
      key: PhoneNavigationKey;
      action: "tap";
      strategy: "physical-home-button" | "screen-back-control" | "screen-enter-key";
      durationMs: number;
      machinePoint: Point;
      screenPoint?: Point;
    }
  | {
      key: PhoneNavigationKey;
      action: "swipe";
      strategy: "left-edge-back-gesture" | "bottom-edge-home-gesture";
      durationMs: number;
      start: PhoneNavigationAnchor;
      end: PhoneNavigationAnchor;
    }
  | {
      key: "home";
      action: "system_edge_swipe";
      strategy: "bottom-edge-home-gesture";
      durationMs: number;
      boundary: SystemEdgeBoundary;
      start: PhoneNavigationAnchor;
      end: PhoneNavigationAnchor;
    };

export type KeyboardNextPlan = {
  key: "keyboard_next";
  action: "system_edge_tap";
  strategy: "keyboard-language-key";
  durationMs: number;
  boundary: SystemEdgeBoundary;
  target: PhoneNavigationAnchor;
};

export type PhoneNavigationAvailability = Record<
  PhoneNavigationKey,
  { available: true; strategy: PhoneNavigationPlan["strategy"] } |
    {
      available: false;
      reason: string;
      requiredPlacement?: {
        direction: "toward-screen-top";
        minimumMm: number;
      };
    }
>;

export class PhoneNavigationUnavailableError extends Error {
  readonly code = "PHONE_NAVIGATION_UNAVAILABLE";

  constructor(
    readonly key: PhoneNavigationKey | "keyboard_next",
    message: string,
    readonly requiredPlacement?: {
      direction: "toward-screen-top";
      minimumMm: number;
    },
  ) {
    super(message);
    this.name = "PhoneNavigationUnavailableError";
  }
}

function unboundedMachinePoint(
  profile: ScreenHandCalibrationProfile,
  point: Point,
) {
  return mapImagePointToMachine({
    imagePoints: [
      { x: 0, y: 0 },
      { x: profile.screen.width, y: 0 },
      { x: profile.screen.width, y: profile.screen.height },
      { x: 0, y: profile.screen.height },
    ],
    machinePoints: profile.controlMachinePoints ?? profile.machinePoints,
  }, point);
}

function distanceOutsideSafeBounds(
  profile: ScreenHandCalibrationProfile,
  point: Point,
) {
  const mapped = unboundedMachinePoint(profile, point);
  const bounds = profile.safeMachineBounds;
  const dx = mapped.x < bounds.minimumX
    ? bounds.minimumX - mapped.x
    : mapped.x > bounds.maximumX
      ? mapped.x - bounds.maximumX
      : 0;
  const dy = mapped.y < bounds.minimumY
    ? bounds.minimumY - mapped.y
    : mapped.y > bounds.maximumY
      ? mapped.y - bounds.maximumY
      : 0;
  return Math.hypot(dx, dy);
}

function screenPoint(
  profile: ScreenHandCalibrationProfile,
  xRatio: number,
  yRatio: number,
): Point {
  return {
    x: profile.screen.width * xRatio,
    y: profile.screen.height * yRatio,
  };
}

function anchorWithinBounds(
  profile: ScreenHandCalibrationProfile,
  point: Point,
  bounds: MachineBounds,
): PhoneNavigationAnchor | null {
  try {
    const mapped = unboundedMachinePoint(profile, point);
    const machinePoint = {
      x: Math.round(mapped.x * 1_000) / 1_000,
      y: Math.round(mapped.y * 1_000) / 1_000,
    };
    if (
      machinePoint.x < bounds.minimumX ||
      machinePoint.x > bounds.maximumX ||
      machinePoint.y < bounds.minimumY ||
      machinePoint.y > bounds.maximumY
    ) return null;
    const interiorMargin = Math.min(
      0.25,
      Math.min(
        bounds.maximumX - bounds.minimumX,
        bounds.maximumY - bounds.minimumY,
      ) * 0.0025,
    );
    if (
      machinePoint.x - bounds.minimumX < interiorMargin ||
      bounds.maximumX - machinePoint.x < interiorMargin ||
      machinePoint.y - bounds.minimumY < interiorMargin ||
      bounds.maximumY - machinePoint.y < interiorMargin
    ) {
      return null;
    }
    return {
      screenPoint: point,
      machinePoint,
    };
  } catch {
    return null;
  }
}

function anchor(
  profile: ScreenHandCalibrationProfile,
  point: Point,
): PhoneNavigationAnchor | null {
  return anchorWithinBounds(profile, point, profile.safeMachineBounds);
}

function firstReachableSwipe(
  profile: ScreenHandCalibrationProfile,
  starts: Point[],
  ends: Point[],
): { start: PhoneNavigationAnchor; end: PhoneNavigationAnchor } | null {
  for (const startPoint of starts) {
    const start = anchor(profile, startPoint);
    if (!start) continue;
    for (const endPoint of ends) {
      const end = anchor(profile, endPoint);
      if (end) return { start, end };
    }
  }
  return null;
}

function firstExtendedHomeSwipe(
  profile: ScreenHandCalibrationProfile,
  starts: Point[],
  ends: Point[],
  edgeBounds: MachineBounds,
): {
  start: PhoneNavigationAnchor;
  end: PhoneNavigationAnchor;
  boundary: SystemEdgeBoundary;
} | null {
  for (const startPoint of starts) {
    const start = anchorWithinBounds(profile, startPoint, edgeBounds);
    if (!start) continue;
    const boundary = machinePointOutsideBounds(
      start.machinePoint,
      profile.safeMachineBounds,
    );
    if (!boundary) continue;
    for (const endPoint of ends) {
      const end = anchor(profile, endPoint);
      if (end) return { start, end, boundary };
    }
  }
  return null;
}

/**
 * The iOS language key sits below the normal app-touch inset. It is planned
 * only against the separately verified calibration travel and must remain a
 * single-boundary excursion. Slightly outside-screen candidates compensate
 * for the measured stylus tip offset at the rounded bottom edge.
 */
export function planKeyboardNext(
  profile: ScreenHandCalibrationProfile,
  edgeBounds: MachineBounds,
): KeyboardNextPlan {
  const xRatios = [0.115, 0.1, 0.13];
  const yRatios = [1.012, 1, 0.992];
  for (const yRatio of yRatios) {
    for (const xRatio of xRatios) {
      const target = anchorWithinBounds(
        profile,
        screenPoint(profile, xRatio, yRatio),
        edgeBounds,
      );
      if (!target) continue;
      const boundary = machinePointOutsideBounds(
        target.machinePoint,
        profile.safeMachineBounds,
      );
      if (!boundary) continue;
      return {
        key: "keyboard_next",
        action: "system_edge_tap",
        strategy: "keyboard-language-key",
        durationMs: 90,
        boundary,
        target,
      };
    }
  }
  throw new PhoneNavigationUnavailableError(
    "keyboard_next",
    "The calibrated arm cannot reach the iOS keyboard language key.",
  );
}

function machinePointOutsideBounds(
  point: Point,
  bounds: MachineBounds,
): SystemEdgeBoundary | null {
  const outside = [
    point.x < bounds.minimumX ? "minimumX" : null,
    point.x > bounds.maximumX ? "maximumX" : null,
    point.y < bounds.minimumY ? "minimumY" : null,
    point.y > bounds.maximumY ? "maximumY" : null,
  ].filter((value): value is SystemEdgeBoundary => value !== null);
  return outside.length === 1 ? outside[0] : null;
}

/**
 * Plans system navigation from calibrated geometry, not a phone model or a
 * hard-coded pixel size. Edge starts are deliberately restricted to the
 * outer 2.5% activation band; if that band is mechanically unreachable the
 * action fails closed instead of turning into an unrelated app gesture.
 */
export function planPhoneNavigation(
  profile: ScreenHandCalibrationProfile,
  key: PhoneNavigationKey,
  context: PhoneNavigationContext = {},
): PhoneNavigationPlan {
  if (
    key === "home" &&
    profile.navigation?.home.strategy === "physical-button"
  ) {
    return {
      key,
      action: "tap",
      strategy: "physical-home-button",
      durationMs: profile.navigation.home.durationMs,
      machinePoint: profile.navigation.home.machinePoint,
    };
  }

  if (key === "back") {
    if (context.backControl) {
      const control = anchor(profile, context.backControl);
      if (control) {
        return {
          key,
          action: "tap",
          strategy: "screen-back-control",
          durationMs: 80,
          screenPoint: control.screenPoint,
          machinePoint: control.machinePoint,
        };
      }
    }
    const insetRatios = [0.008, 0.0125, 0.018, 0.025];
    const yRatios = [0.52, 0.44, 0.6, 0.36, 0.68];
    const gesture = firstReachableSwipe(
      profile,
      yRatios.flatMap((yRatio) =>
        insetRatios.map((xRatio) => screenPoint(profile, xRatio, yRatio))
      ),
      yRatios.map((yRatio) => screenPoint(profile, 0.42, yRatio)),
    );
    if (!gesture) {
      throw new PhoneNavigationUnavailableError(
        key,
        "The calibrated arm cannot reach the phone's left-edge Back gesture activation band.",
      );
    }
    return {
      key,
      action: "swipe",
      strategy: "left-edge-back-gesture",
      durationMs: 320,
      ...gesture,
    };
  }

  if (key === "home") {
    // Face ID Home is derived from the currently calibrated viewport instead
    // of replaying saved pixels. This keeps the activation band and travel
    // proportional when a phone model, orientation, or logical resolution
    // changes while preserving an explicit physical-button profile above.
    const insetRatios = [0.008, 0.0125, 0.018, 0.025];
    const xRatios = [0.5, 0.46, 0.54, 0.42, 0.58];
    const starts = xRatios.flatMap((xRatio) =>
      insetRatios.map((insetRatio) =>
        screenPoint(profile, xRatio, 1 - insetRatio)
      )
    );
    // A short iOS bottom-edge pull settles in the app switcher and costs a
    // second physical action. Crossing roughly two thirds of the display in
    // one continuous gesture reaches Home directly while keeping both anchors
    // inside the calibrated phone geometry on every supported resolution.
    const ends = xRatios.map((xRatio) => screenPoint(profile, xRatio, 0.22));
    const gesture = firstReachableSwipe(
      profile,
      starts,
      ends,
    );
    if (!gesture && context.edgeMachineBounds) {
      const extended = firstExtendedHomeSwipe(
        profile,
        starts,
        ends,
        context.edgeMachineBounds,
      );
      if (extended) {
        return {
          key,
          action: "system_edge_swipe",
          strategy: "bottom-edge-home-gesture",
          durationMs: 250,
          ...extended,
        };
      }
    }
    if (!gesture) {
      const minimumMm = Math.max(
        0.2,
        distanceOutsideSafeBounds(
          profile,
          screenPoint(profile, 0.5, 0.975),
        ) + 0.2,
      );
      throw new PhoneNavigationUnavailableError(
        key,
        "The calibrated arm cannot reach the outer 2.5% bottom-edge Home gesture band. " +
          `Move the phone toward its screen top by at least ${minimumMm.toFixed(1)} mm and rerun vision setup.`,
        {
          direction: "toward-screen-top",
          minimumMm: Math.round(minimumMm * 10) / 10,
        },
      );
    }
    return {
      key,
      action: "swipe",
      strategy: "bottom-edge-home-gesture",
      durationMs: 360,
      ...gesture,
    };
  }

  const enterCandidates = [
    screenPoint(profile, 0.868, 0.89),
    screenPoint(profile, 0.84, 0.89),
    screenPoint(profile, 0.88, 0.85),
  ];
  for (const candidate of enterCandidates) {
    const reachable = anchor(profile, candidate);
    if (reachable) {
      return {
        key,
        action: "tap",
        strategy: "screen-enter-key",
        durationMs: 70,
        screenPoint: reachable.screenPoint,
        machinePoint: reachable.machinePoint,
      };
    }
  }
  throw new PhoneNavigationUnavailableError(
    key,
    "The calibrated arm cannot reach the expected on-screen Enter-key region.",
  );
}

export function phoneNavigationAvailability(
  profile: ScreenHandCalibrationProfile,
  context: PhoneNavigationContext = {},
): PhoneNavigationAvailability {
  return Object.fromEntries(
    (["back", "home", "enter"] as const).map((key) => {
      try {
        const plan = planPhoneNavigation(profile, key, context);
        return [key, { available: true, strategy: plan.strategy }];
      } catch (error) {
        return [key, {
          available: false,
          reason: error instanceof Error ? error.message : "Navigation is unavailable.",
          ...(error instanceof PhoneNavigationUnavailableError && error.requiredPlacement
            ? { requiredPlacement: error.requiredPlacement }
            : {}),
        }];
      }
    }),
  ) as PhoneNavigationAvailability;
}

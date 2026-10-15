export type ClientRectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ViewportPoint = { x: number; y: number };

export type IntentSwipe = {
  direction: "up" | "down" | "left" | "right";
  start: ViewportPoint;
  end: ViewportPoint;
  durationMs: number;
};

/**
 * Turns a short, deliberate pointer drag into a complete phone gesture.
 *
 * A desktop operator should only have to communicate direction; mirroring the
 * full physical travel with a mouse is slow and imprecise.  The inferred path
 * stays away from system edges, preserves the user's orthogonal anchor, and is
 * expressed as viewport-relative geometry so it works across phone sizes.
 */
export function inferIntentSwipe(
  pointerStart: ViewportPoint,
  pointerEnd: ViewportPoint,
  viewport: { width: number; height: number },
): IntentSwipe | null {
  const values = [
    pointerStart.x,
    pointerStart.y,
    pointerEnd.x,
    pointerEnd.y,
    viewport.width,
    viewport.height,
  ];
  if (
    !values.every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) return null;

  const deltaX = pointerEnd.x - pointerStart.x;
  const deltaY = pointerEnd.y - pointerStart.y;
  const distance = Math.hypot(deltaX, deltaY);
  // On the current 720-pixel logical viewport this is about 13 pixels, or
  // roughly 6 desktop pixels in the Dashboard. It rejects click jitter while
  // still feeling like a flick rather than a full drag.
  if (distance < Math.min(viewport.width, viewport.height) * 0.018) return null;

  const horizontal = Math.abs(deltaX) >= Math.abs(deltaY);
  if (horizontal) {
    const leftward = deltaX < 0;
    const y = clamp(
      (pointerStart.y + pointerEnd.y) / 2,
      viewport.height * 0.18,
      viewport.height * 0.82,
    );
    return {
      direction: leftward ? "left" : "right",
      start: { x: roundCoordinate(viewport.width * (leftward ? 0.78 : 0.22)), y },
      end: { x: roundCoordinate(viewport.width * (leftward ? 0.22 : 0.78)), y },
      durationMs: 320,
    };
  }

  const upward = deltaY < 0;
  const x = clamp(
    (pointerStart.x + pointerEnd.x) / 2,
    viewport.width * 0.18,
    viewport.width * 0.82,
  );
  return {
    direction: upward ? "up" : "down",
    start: { x, y: roundCoordinate(viewport.height * (upward ? 0.76 : 0.28)) },
    end: { x, y: roundCoordinate(viewport.height * (upward ? 0.28 : 0.76)) },
    durationMs: 320,
  };
}

/**
 * Maps a browser pointer into a contain-fitted phone viewport.
 *
 * The canvas element can be wider or taller than the pixels actually painted
 * by object-fit: contain. Coordinates in those letterbox/pillarbox bands must
 * not be sent to a physical device.
 */
export function mapContainedClientPoint(
  clientPoint: ViewportPoint,
  bounds: ClientRectLike,
  viewport: { width: number; height: number },
): ViewportPoint | null {
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  const scale = Math.min(
    bounds.width / viewport.width,
    bounds.height / viewport.height,
  );
  const displayedWidth = viewport.width * scale;
  const displayedHeight = viewport.height * scale;
  const displayedLeft = bounds.left + (bounds.width - displayedWidth) / 2;
  const displayedTop = bounds.top + (bounds.height - displayedHeight) / 2;
  const localX = clientPoint.x - displayedLeft;
  const localY = clientPoint.y - displayedTop;

  if (
    localX < 0 ||
    localX > displayedWidth ||
    localY < 0 ||
    localY > displayedHeight
  ) {
    return null;
  }

  return {
    x: Math.max(0, Math.min(viewport.width, localX / scale)),
    y: Math.max(0, Math.min(viewport.height, localY / scale)),
  };
}

/**
 * Converts a point from the complete raw camera frame into the calibrated
 * phone-screen coordinate space. Points outside the four verified screen
 * corners fail closed so clicks on the fixture never move the arm.
 */
export function mapCameraPointToScreen(
  cameraPoint: ViewportPoint,
  imagePoints: [Point, Point, Point, Point],
  screen: { width: number; height: number },
): ViewportPoint | null {
  if (
    !Number.isFinite(cameraPoint.x) ||
    !Number.isFinite(cameraPoint.y) ||
    !Number.isFinite(screen.width) ||
    !Number.isFinite(screen.height) ||
    screen.width <= 0 ||
    screen.height <= 0
  ) {
    return null;
  }

  try {
    const mapped = projectPoint(
      homographyFromFourPoints(imagePoints, [
        { x: 0, y: 0 },
        { x: screen.width, y: 0 },
        { x: screen.width, y: screen.height },
        { x: 0, y: screen.height },
      ]),
      cameraPoint,
    );
    const epsilon = 1e-6;
    if (
      !Number.isFinite(mapped.x) ||
      !Number.isFinite(mapped.y) ||
      mapped.x < -epsilon ||
      mapped.x > screen.width + epsilon ||
      mapped.y < -epsilon ||
      mapped.y > screen.height + epsilon
    ) {
      return null;
    }
    const x = Math.abs(mapped.x) <= epsilon
      ? 0
      : Math.abs(mapped.x - screen.width) <= epsilon
        ? screen.width
        : mapped.x;
    const y = Math.abs(mapped.y) <= epsilon
      ? 0
      : Math.abs(mapped.y - screen.height) <= epsilon
        ? screen.height
        : mapped.y;
    return {
      x: Math.max(0, Math.min(screen.width, x)),
      y: Math.max(0, Math.min(screen.height, y)),
    };
  } catch {
    return null;
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundCoordinate(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
import {
  homographyFromFourPoints,
  projectPoint,
  type Point,
} from "../agent/homography";

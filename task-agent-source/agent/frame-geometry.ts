import type { ScreenHandCalibrationProfile } from "./calibration-profile";
import {
  homographyFromFourPoints,
  projectPoint,
  type Point,
} from "./homography";

export type ScreenFrame = {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
  source: string;
  deviceId?: string;
  role?: "control" | "verification";
  sequence?: number;
};

export type PublicFrameGeometry = {
  width: number;
  height: number;
  rawWidth: number;
  rawHeight: number;
  rectified: boolean;
  imagePoints: ScreenHandCalibrationProfile["imagePoints"] | null;
  calibrationId: string | null;
};

/**
 * Describes how a frame must be rendered in the operator's screen space.
 *
 * A wired iPhone frame is already a flat image of the display. It only needs
 * resizing into the profile's canonical screen coordinates. Camera corner
 * points belong exclusively to the physical verification camera; applying
 * them to a wired frame crops and warps the operator's click surface.
 */
export function frameGeometryFor(
  frame: ScreenFrame,
  profile: ScreenHandCalibrationProfile | null,
): PublicFrameGeometry {
  const profileDeviceMatches = Boolean(
    profile && profile.deviceId === frame.deviceId,
  );
  if (
    profileDeviceMatches &&
    profile &&
    frame.role !== "verification" &&
    frame.source === "iphone-wired-usb-video"
  ) {
    return {
      width: profile.screen.width,
      height: profile.screen.height,
      rawWidth: frame.width,
      rawHeight: frame.height,
      rectified: false,
      imagePoints: null,
      calibrationId: profile.id,
    };
  }

  const cameraProfileMatches = Boolean(
    profileDeviceMatches &&
    profile &&
    profile.frame.width === frame.width &&
    profile.frame.height === frame.height,
  );
  if (!cameraProfileMatches || !profile) {
    return {
      width: frame.width,
      height: frame.height,
      rawWidth: frame.width,
      rawHeight: frame.height,
      rectified: false,
      imagePoints: null,
      calibrationId: null,
    };
  }
  return {
    width: profile.screen.width,
    height: profile.screen.height,
    rawWidth: frame.width,
    rawHeight: frame.height,
    rectified: true,
    imagePoints: profile.imagePoints,
    calibrationId: profile.id,
  };
}

/**
 * Converts a point from either representation advertised by ScreenHand into
 * the canonical calibrated phone-screen coordinate space.
 *
 * The screenshot HTTP endpoint intentionally returns the original encoded
 * camera bytes. Its viewport is therefore rawWidth × rawHeight. The live
 * operator canvas performs perspective correction and uses width × height.
 * Both are legitimate action inputs as long as the frame sequence is retained.
 */
export function framePointToScreenPoint(
  frame: ScreenFrame,
  profile: ScreenHandCalibrationProfile | null,
  point: Point,
  viewport: { width: number; height: number },
): Point {
  const geometry = frameGeometryFor(frame, profile);
  if (
    viewport.width === geometry.width &&
    viewport.height === geometry.height
  ) {
    return { ...point };
  }

  if (
    viewport.width !== geometry.rawWidth ||
    viewport.height !== geometry.rawHeight
  ) {
    throw new RangeError(
      `Viewport ${viewport.width}×${viewport.height} matches neither ` +
        `screen ${geometry.width}×${geometry.height} nor raw frame ` +
        `${geometry.rawWidth}×${geometry.rawHeight}.`,
    );
  }

  if (geometry.rectified && geometry.imagePoints) {
    const screenCorners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: geometry.width, y: 0 },
      { x: geometry.width, y: geometry.height },
      { x: 0, y: geometry.height },
    ];
    return projectPoint(
      homographyFromFourPoints(geometry.imagePoints, screenCorners),
      point,
    );
  }

  if (geometry.calibrationId) {
    return {
      x: point.x * geometry.width / geometry.rawWidth,
      y: point.y * geometry.height / geometry.rawHeight,
    };
  }

  return { ...point };
}

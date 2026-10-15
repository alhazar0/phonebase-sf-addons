import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseToolContactAnchorArtifact,
  type ToolContactAnchorArtifact,
} from "../active-world/tool-contact-anchor";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import { parseStationPlaneArtifact } from "../../auto-setup/station-plane";

export type RealtimeContactAnchorLoadResult =
  | {
    status: "ready";
    reason: "verified-artifacts-loaded";
    stationPlaneSha256: string;
    artifact: ToolContactAnchorArtifact;
  }
  | {
    status: "unavailable";
    reason: "station-plane-missing" | "tool-contact-anchor-missing";
  }
  | {
    status: "invalid";
    reason:
      | "artifact-invalid"
      | "artifact-station-mismatch"
      | "artifact-profile-mismatch"
      | "artifact-frame-mismatch";
    error: string;
  };

/** Loads optional manufacturing evidence without ever creating or modifying it. */
export async function loadRealtimeContactAnchor(
  deviceId: string,
  stateDirectory = process.env.SCREENHAND_AUTO_SETUP_STATE_DIRECTORY ??
    ".runtime/auto-setup",
): Promise<RealtimeContactAnchorLoadResult> {
  try {
    const safeId = safeDeviceId(deviceId);
    const directory = resolve(stateDirectory);
    const [stationValue, anchorValue] = await Promise.all([
      readOptionalJson(resolve(directory, `${safeId}.station-plane.json`)),
      readOptionalJson(resolve(directory, `${safeId}.tool-contact-anchor.json`)),
    ]);
    if (stationValue === null) {
      return { status: "unavailable", reason: "station-plane-missing" };
    }
    if (anchorValue === null) {
      return { status: "unavailable", reason: "tool-contact-anchor-missing" };
    }
    const station = parseStationPlaneArtifact(stationValue);
    const artifact = parseToolContactAnchorArtifact(anchorValue);
    if (
      station.calibration.deviceId !== deviceId ||
      artifact.calibration.deviceId !== deviceId ||
      artifact.calibration.stationPlaneSha256 !== station.sha256
    ) {
      return {
        status: "invalid",
        reason: "artifact-station-mismatch",
        error: "Tool contact anchor is not bound to the active device station plane.",
      };
    }
    return {
      status: "ready",
      reason: "verified-artifacts-loaded",
      stationPlaneSha256: station.sha256,
      artifact,
    };
  } catch (error) {
    return {
      status: "invalid",
      reason: "artifact-invalid",
      error: errorMessage(error),
    };
  }
}

export function bindRealtimeContactAnchorToProfile(
  result: RealtimeContactAnchorLoadResult,
  profile: ScreenHandCalibrationProfile,
): RealtimeContactAnchorLoadResult {
  if (result.status !== "ready") return result;
  if (result.artifact.calibration.sourceProfileId !== profile.id) {
    return {
      status: "invalid",
      reason: "artifact-profile-mismatch",
      error: "Tool contact anchor source profile does not match the active calibration.",
    };
  }
  if (
    result.artifact.calibration.frame.width !== profile.frame.width ||
    result.artifact.calibration.frame.height !== profile.frame.height
  ) {
    return {
      status: "invalid",
      reason: "artifact-frame-mismatch",
      error: "Tool contact anchor camera frame does not match the active calibration.",
    };
  }
  return result;
}

async function readOptionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safeDeviceId(deviceId: string) {
  const safe = deviceId.trim().replace(/[^a-zA-Z0-9._-]/gu, "_");
  if (!safe) throw new Error("A device ID is required for contact anchor loading.");
  return safe;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

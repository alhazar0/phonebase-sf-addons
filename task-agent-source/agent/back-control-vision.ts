import type { Point } from "./homography";
import { detectVisualAffordances } from "./visual-affordance-detector";

/**
 * Finds one unambiguous top-left Back chevron through the same small local edge
 * pass used by the generic scene graph. Sharing the detector avoids decoding
 * and resizing a second full logical frame on every Back command.
 */
export async function detectBackControl(
  imageBuffer: Buffer,
  screen: { width: number; height: number },
): Promise<Point | null> {
  const detection = await detectVisualAffordances(imageBuffer, {
    viewport: screen,
    maximumCandidates: 32,
  });
  const candidates = detection.candidates
    .filter((candidate) =>
      candidate.symbol === "back" &&
      (candidate.symbolConfidence ?? 0) >= 0.78 &&
      candidate.center.x <= screen.width * 0.3 &&
      candidate.center.y >= screen.height * 0.055 &&
      candidate.center.y <= screen.height * 0.22
    )
    .sort((left, right) =>
      (right.symbolConfidence ?? 0) - (left.symbolConfidence ?? 0) ||
      right.confidence - left.confidence
    );
  if (!candidates.length) return null;
  if (
    candidates[1] &&
    (candidates[1].symbolConfidence ?? 0) >=
      (candidates[0].symbolConfidence ?? 0) - 0.08
  ) return null;
  return { ...candidates[0].center };
}

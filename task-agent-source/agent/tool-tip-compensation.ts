type PointerPoint = { x: number; y: number };

/** Corrects the measured inboard offset of the conductive tip at top corners. */
export function compensatePhysicalTip(
  point: PointerPoint,
  viewport: { width: number; height: number },
): PointerPoint {
  if (point.y > viewport.height * 0.13) return { ...point };
  const edge = viewport.width * 0.12;
  const offset = Math.min(36, viewport.width * 0.042);
  if (point.x < edge) return { x: Math.max(0, point.x - offset), y: point.y };
  if (point.x > viewport.width - edge) {
    return { x: Math.min(viewport.width, point.x + offset), y: point.y };
  }
  return { ...point };
}

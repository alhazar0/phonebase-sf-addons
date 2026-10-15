export type PressurePreset = "light" | "natural" | "firm";

export const PRESSURE_PRESETS: Array<{
  id: PressurePreset;
  label: string;
  ratio: number;
}> = [
  { id: "light", label: "Light", ratio: 0.2 },
  { id: "natural", label: "Normal", ratio: 0.65 },
  { id: "firm", label: "Firm", ratio: 1 },
];

export function touchZForPressure(
  preset: PressurePreset,
  limits: { minimum: number; maximum: number },
): number | null {
  if (
    !Number.isFinite(limits.minimum) ||
    !Number.isFinite(limits.maximum) ||
    limits.minimum > limits.maximum
  ) {
    return null;
  }
  const ratio = PRESSURE_PRESETS.find((item) => item.id === preset)?.ratio;
  if (ratio === undefined) return null;
  return Math.round((limits.minimum + (limits.maximum - limits.minimum) * ratio) * 1000) / 1000;
}

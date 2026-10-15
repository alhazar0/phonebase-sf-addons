export type IosKeyboardPoint = {
  x: number;
  y: number;
  key: string;
};

export type IosKeyboardCalibration = {
  points: Record<string, { x: number; y: number }>;
  strict: boolean;
};

export type IosKeyboardState = {
  shiftActive?: boolean | null;
};

const alphaRows = [
  { keys: "qwertyuiop", xs: [43, 115, 187, 259, 331, 403, 475, 547, 619, 685], y: 1_105 },
  { keys: "asdfghjkl", xs: [79, 151, 223, 295, 367, 439, 511, 583, 653], y: 1_198 },
  { keys: "zxcvbnm", xs: [151, 223, 295, 367, 439, 511, 583], y: 1_292 },
] as const;

const numericRows = [
  { keys: "1234567890", xs: [43, 115, 187, 259, 331, 403, 475, 547, 619, 685], y: 1_105 },
  { keys: ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'], xs: [43, 115, 187, 259, 331, 403, 475, 547, 619, 685], y: 1_198 },
  { keys: [".", ",", "?", "!", "'"], xs: [163, 259, 367, 475, 571], y: 1_292 },
] as const;

const alphabet = new Map<string, IosKeyboardPoint>();
for (const row of alphaRows) {
  [...row.keys].forEach((key, index) => {
    alphabet.set(key, { x: row.xs[index], y: row.y, key });
  });
}

const numeric = new Map<string, IosKeyboardPoint>();
for (const row of numericRows) {
  [...row.keys].forEach((key, index) => {
    numeric.set(key, { x: row.xs[index], y: row.y, key });
  });
}

const switchMode = { x: 50, y: 1_388 } as const;
const shift = { x: 52, y: 1_292 } as const;
const space = { x: 360, y: 1_388, key: "space" } as const;

/**
 * Converts text into taps on the calibrated iOS portrait English keyboard.
 * A standard alphabet keyboard must be focused initially. The sequence always
 * restores alphabet mode. Enter is intentionally a separate explicit action.
 */
export function iosEnglishKeyboardSequence(
  text: string,
  calibration?: IosKeyboardCalibration,
  state: IosKeyboardState = {},
): IosKeyboardPoint[] {
  const points: IosKeyboardPoint[] = [];
  let mode: "alpha" | "numeric" = "alpha";
  let shiftActive = state.shiftActive === true;

  const setMode = (next: typeof mode) => {
    if (mode === next) return;
    points.push({ ...switchMode, key: next === "alpha" ? "ABC" : "123" });
    mode = next;
  };

  for (const character of text) {
    if (character === " ") {
      points.push(space);
      continue;
    }
    if (character === "\n" || character === "\r") {
      throw new Error("input_text does not submit forms; use the key action with enter explicitly");
    }
    const lower = character.toLowerCase();
    const letter = alphabet.get(lower);
    if (letter) {
      setMode("alpha");
      const wantsUppercase = character !== lower;
      if (shiftActive !== wantsUppercase) {
        points.push({ ...shift, key: "shift" });
      }
      points.push(letter);
      // iOS Shift is one-shot for a normal key press, including the automatic
      // capitalization state shown when a fresh text field receives focus.
      shiftActive = false;
      continue;
    }
    const symbol = numeric.get(character);
    if (symbol) {
      setMode("numeric");
      points.push(symbol);
      continue;
    }
    throw new Error(`The calibrated iOS English keyboard cannot type ${JSON.stringify(character)}`);
  }

  setMode("alpha");
  if (!calibration) return points;
  return points.map((keyPoint) => {
    const calibrated = calibration.points[keyPoint.key];
    if (calibrated) return { ...calibrated, key: keyPoint.key };
    if (calibration.strict) {
      throw new Error(
        `The physical keyboard key ${JSON.stringify(keyPoint.key)} is not calibrated for this device`,
      );
    }
    return keyPoint;
  });
}

import { decode } from "jpeg-js";

// 24×24 luminance fingerprint of this fixed iPhone's calibrated bottom-left
// "123" key while the standard alphabet keyboard is visible.  Correlation is
// used instead of absolute colors so wallpaper translucency may vary slightly.
const ALPHA_KEY_TEMPLATE = Buffer.from(
  "GhoaGxobGhoaGhsbGxwdHR0dHR4dHRweGhscHSUnJycnJycoKCgoKSoqKichHB4eHBktQ0dGR0ZGRkZHR0dHSEhISEhGLB4fHSdIR0VGRkZGRkZHR0dHR0dHR0hHSiofHDpGRUVGR0ZGRkdHR0hIR0dIR0dIRz4eHUBFRUVGRkZFR0dHR0dHR0dISEhHSEUdHUJGRkZGRkZGR0dHR0dISEdISUhHSEYeHUJFRkZGRUdHR0dHR0hIR0lJR0lISUUdHkJFRkZFQzRFRz5HO0dLO0k9SUlISEYdHUJGRkZCj+tSP7nC2VtQz73RR0pISEYeHUJGRkpQo+ZOWa8wn5ZxdDugaVBKSEcfHUNHR0ZJOuNPTEg7zXFFVJDQSklKSUcgHUNHR0ZHPeNPS0CZnTtIWJnZV01KSkYfHUNGR0dHPeNQSW+rLT5uUjp8hE5KSkYgHkNGRkdHPeNPSvDAuoN61I7bYU9KSUcgH0NHR0ZHRGtHT29ub19BbYpjSktJSUghIERISEhHR0lJRUlJSklJSkZISUpKSkggIEVISEhISElJSElISEhKSUlJSUpKSUggH0NIR0hJSEhISEdHSEhJSElJSkpKSkkiH0JJR0hJSUlHSEdHSEhJSEpJSUpJSkciHj9HR0hHR0dISEdISEhISEpJSUpJSkAjIS5IR0hIR0lHSEhISElISElJSUpJSy8kICA0R0hISEdISEhJSUlJSUpKSktJNSEkISEhJCwvLi8uLi4vLzAwMDAxMS0mIiMk",
  "base64",
);

// The same calibrated key in iOS light appearance. The physical keyboard map
// is intentionally device-bound, so keeping both appearance fingerprints is
// safer and faster than treating OCR success as the only proof of focus.
const LIGHT_ALPHA_KEY_TEMPLATE = Buffer.from(
  "f35+fHx9fn17enl5d3d3dnd3d3h4eXd3f39+e3x+fX59e3l5d3V2d3l3dnd4eXh3f358gISDgoGBgYB+fHt7fH59fXx7e3l3f3+EipGRj4yLjY2JioqIiouKiomIgXt4fYSOk5OTlJKRkJCQjo2MjIyMjIyNiH53fYmTlZSTlJOSkpCQj42MjIyMjIyMjYJ3foqSlJSTlJSUkpCPj42LjIyMjIyMjIV3f5CTk5OTlJOUkpCRkI+Mi4yMjIyMjoV2gI6UlZOUlJOSj4+QkI+NjYyNjYyMjYR1f4ySlJGSkI6PjoqCh4uJhICIi4yMjId6fo2Tk5OOXkWFhEgzSoNpPzZRh4qNjId5fY6Uk5J3RjCCbl54MnBmbnY4fIqNi4V3e46Tk5GOfDWFjY17PHiIeVhEgoiLi4R4e4qPkpKUgTODj4dMY4aIc0k7f4mMioR5eoiNkZKTfziDi1xaiIp3hIFDc4uNioR4e4yQkZOTgD6Fbx9CUHNNQ08/fIqMi4R2fI2SkpOTjXyNhW9ucX2EbGV6hoaKiYV1fIyQk5KSkpGRj4+QjIuJiomKioiIiId3fo2SlI+RkpKRkJCQkI2Li4mLi4qJiIR1foyRko6PkJCRkI+Rj42LjImJiomLjIR1fImOkJGPj4+PkJCQkI6LjImJiYmKjYRzd4SNkZCQkpCQj4+Pj42Li4iJiYmIiH9yc32KjZCQkZCRkI+OjYqJiYiIh4eHg3hxdXeBiIyNjIyMjIuMi4eHiIeGhYOEfXJx",
  "base64",
);

function fingerprint(jpeg: Buffer) {
  const image = decode(jpeg, {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 2,
  });
  const scaleX = image.width / 720;
  const scaleY = image.height / 1_560;
  if (
    image.width < 320 || image.height < 690 ||
    Math.abs(scaleX - scaleY) > 0.025
  ) return null;
  const output = new Uint8Array(24 * 24);
  const left = 8 * scaleX;
  const top = 1_344 * scaleY;
  const width = 86 * scaleX;
  const height = 84 * scaleY;
  for (let row = 0; row < 24; row += 1) {
    for (let column = 0; column < 24; column += 1) {
      let total = 0;
      let samples = 0;
      const startY = Math.floor(top + row * height / 24);
      const endY = Math.floor(top + (row + 1) * height / 24);
      const startX = Math.floor(left + column * width / 24);
      const endX = Math.floor(left + (column + 1) * width / 24);
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * image.width + x) * 4;
          total += image.data[offset] * 0.2126 +
            image.data[offset + 1] * 0.7152 +
            image.data[offset + 2] * 0.0722;
          samples += 1;
        }
      }
      output[row * 24 + column] = Math.round(total / samples);
    }
  }
  return output;
}

function correlation(left: Uint8Array, right: Uint8Array) {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    covariance += a * b;
    leftVariance += a * a;
    rightVariance += b * b;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? covariance / denominator : 0;
}

export function iosEnglishKeyboardConfidence(jpeg: Buffer) {
  try {
    const current = fingerprint(jpeg);
    return current
      ? Math.max(
          correlation(current, ALPHA_KEY_TEMPLATE),
          correlation(current, LIGHT_ALPHA_KEY_TEMPLATE),
        )
      : 0;
  } catch {
    return 0;
  }
}

export function iosEnglishKeyboardVisible(jpeg: Buffer) {
  // Perspective correction and the 1024px realtime OCR raster soften key
  // edges compared with the full-resolution calibration capture. Positive
  // camera samples remain above 0.80 while pages without a keyboard are near
  // zero; 0.78 preserves that margin without forcing a slow OCR retry.
  return iosEnglishKeyboardConfidence(jpeg) >= 0.78;
}

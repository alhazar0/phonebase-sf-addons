import sharp from "sharp";

import type { AgentFrame } from "../screen-observer";

export type NormalizedRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PixelFrame = {
  sequence: number;
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
};

export class VisualProbe {
  private readonly cache = new Map<number, Promise<PixelFrame>>();

  constructor(
    private readonly rasterWidth = 180,
    private readonly rasterHeight = 390,
    private readonly maximumCacheEntries = 12,
  ) {}

  async difference(
    before: AgentFrame,
    after: AgentFrame,
    region: NormalizedRegion = FULL_SCREEN,
  ) {
    const [left, right] = await Promise.all([this.raster(before), this.raster(after)]);
    if (left.width !== right.width || left.height !== right.height) return 1;
    const bounds = pixelBounds(region, left.width, left.height);
    let total = 0;
    let samples = 0;
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) {
        const index = (y * left.width + x) * left.channels;
        total += Math.abs(left.pixels[index] - right.pixels[index]);
        total += Math.abs(left.pixels[index + 1] - right.pixels[index + 1]);
        total += Math.abs(left.pixels[index + 2] - right.pixels[index + 2]);
        samples += 3;
      }
    }
    return samples ? total / samples / 255 : 0;
  }

  async redFraction(frame: AgentFrame, region: NormalizedRegion) {
    const raster = await this.raster(frame);
    const bounds = pixelBounds(region, raster.width, raster.height);
    let red = 0;
    let samples = 0;
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) {
        const index = (y * raster.width + x) * raster.channels;
        const r = raster.pixels[index];
        const g = raster.pixels[index + 1];
        const b = raster.pixels[index + 2];
        if (r >= 130 && r >= g * 1.35 && r >= b * 1.2 && r - Math.min(g, b) >= 35) {
          red += 1;
        }
        samples += 1;
      }
    }
    return samples ? red / samples : 0;
  }

  clear() {
    this.cache.clear();
  }

  private raster(frame: AgentFrame) {
    let promise = this.cache.get(frame.sequence);
    if (!promise) {
      promise = sharp(frame.bytes, { failOn: "error" })
        .resize({
          width: this.rasterWidth,
          height: this.rasterHeight,
          fit: "fill",
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data, info }) => ({
          sequence: frame.sequence,
          width: info.width,
          height: info.height,
          channels: info.channels,
          pixels: data,
        }));
      this.cache.set(frame.sequence, promise);
      while (this.cache.size > this.maximumCacheEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return promise;
  }
}

const FULL_SCREEN: NormalizedRegion = {
  left: 0,
  top: 0,
  width: 1,
  height: 1,
};

function pixelBounds(region: NormalizedRegion, width: number, height: number) {
  const left = clamp(Math.floor(region.left * width), 0, width - 1);
  const top = clamp(Math.floor(region.top * height), 0, height - 1);
  const right = clamp(Math.ceil((region.left + region.width) * width), left + 1, width);
  const bottom = clamp(Math.ceil((region.top + region.height) * height), top + 1, height);
  return { left, top, right, bottom };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

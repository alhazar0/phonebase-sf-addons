import sharp from "sharp";

import type { ScreenHandPoint, ScreenHandViewport } from "./action-contract";

export type VisualAffordanceRole = "icon" | "control" | "navigation";
export type VisualAffordanceSymbol = "back" | "close" | "add" | "search";

export type VisualAffordance = {
  role: VisualAffordanceRole;
  label: string;
  confidence: number;
  center: ScreenHandPoint;
  bounds: { left: number; top: number; width: number; height: number };
  source: "local_edges" | "local_intensity";
  edgeDensity: number;
  localContrast: number;
  symbol?: VisualAffordanceSymbol;
  symbolConfidence?: number;
};

export type VisualAffordanceDetection = {
  candidates: VisualAffordance[];
  elapsedMs: number;
  sample: { width: number; height: number; edgeThreshold: number };
};

export type VisualAffordanceDetectorOptions = {
  viewport: ScreenHandViewport;
  excludeBounds?: Array<{ left: number; top: number; width: number; height: number }>;
  excludeBottomRatio?: number;
  sampleWidth?: number;
  maximumCandidates?: number;
};

type PixelComponent = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  pixelCount: number;
};

/**
 * Finds visually bounded, unlabeled interaction candidates without an app
 * allowlist or accessibility tree. It intentionally predicts only hit areas
 * and coarse roles; semantic meaning remains the planner's responsibility.
 */
export async function detectVisualAffordances(
  imageBuffer: Buffer,
  options: VisualAffordanceDetectorOptions,
): Promise<VisualAffordanceDetection> {
  const startedAt = performance.now();
  const sampleWidth = boundedInteger(options.sampleWidth, 96, 240, 144);
  const sampleHeight = Math.max(
    128,
    Math.min(480, Math.round(sampleWidth * options.viewport.height / options.viewport.width)),
  );
  const pixels = await sharp(imageBuffer, { failOn: "error" })
    .resize({ width: sampleWidth, height: sampleHeight, fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  const gradient = sobelMagnitude(pixels, sampleWidth, sampleHeight);
  const edgeThreshold = adaptiveEdgeThreshold(gradient);
  const edges = thresholdEdges(gradient, sampleWidth, sampleHeight, edgeThreshold);
  const connected = dilate(edges, sampleWidth, sampleHeight);
  const components = connectedComponents(connected, sampleWidth, sampleHeight);
  const scaleX = options.viewport.width / sampleWidth;
  const scaleY = options.viewport.height / sampleHeight;
  const excluded = options.excludeBounds ?? [];
  const candidates = components
    .map((component) => componentCandidate({
      component,
      pixels,
      gradient,
      edges,
      edgeThreshold,
      sampleWidth,
      sampleHeight,
      scaleX,
      scaleY,
      viewport: options.viewport,
    }))
    .filter((candidate): candidate is VisualAffordance => candidate !== null)
    // Camera-visible status indicators and gesture bars are not application
    // affordances. Excluding the extreme safe-area bands prevents an explicit
    // "top-right icon" request from selecting Wi-Fi or battery glyphs.
    .filter((candidate) =>
      candidate.center.y >= options.viewport.height * 0.055 &&
      candidate.center.y <= options.viewport.height * 0.985
    )
    .filter((candidate) => !overlapsExcludedText(candidate.bounds, excluded))
    .filter((candidate) => {
      const excludedBottom = options.excludeBottomRatio;
      return excludedBottom === undefined ||
        candidate.center.y < options.viewport.height * excludedBottom;
    });
  const intensityBack = detectIntensityBackSymbol(
    pixels,
    sampleWidth,
    sampleHeight,
    options.viewport,
  );
  if (intensityBack && !overlapsExcludedText(intensityBack.bounds, excluded)) {
    candidates.push(intensityBack);
  }
  const isolatedSearch = detectIsolatedTopSearchSymbol(
    pixels,
    gradient,
    edgeThreshold,
    sampleWidth,
    sampleHeight,
    options.viewport,
  );
  if (isolatedSearch) appendSpecialCandidate(candidates, isolatedSearch, excluded);
  const radialSearch = detectRadialTopSearchSymbol(
    pixels,
    gradient,
    sampleWidth,
    sampleHeight,
    options.viewport,
  );
  if (radialSearch) appendSpecialCandidate(candidates, radialSearch, excluded);
  const selected = suppressOverlappingCandidates(candidates)
    .slice(0, boundedInteger(options.maximumCandidates, 1, 64, 32));
  return {
    candidates: selected,
    elapsedMs: round(performance.now() - startedAt),
    sample: { width: sampleWidth, height: sampleHeight, edgeThreshold },
  };
}

function sobelMagnitude(pixels: Buffer, width: number, height: number) {
  const gradient = new Uint16Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = pixels[(y - 1) * width + x - 1];
      const top = pixels[(y - 1) * width + x];
      const topRight = pixels[(y - 1) * width + x + 1];
      const left = pixels[y * width + x - 1];
      const right = pixels[y * width + x + 1];
      const bottomLeft = pixels[(y + 1) * width + x - 1];
      const bottom = pixels[(y + 1) * width + x];
      const bottomRight = pixels[(y + 1) * width + x + 1];
      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      gradient[y * width + x] = Math.min(1_020, Math.round(Math.hypot(gx, gy)));
    }
  }
  return gradient;
}

function adaptiveEdgeThreshold(gradient: Uint16Array) {
  const histogram = new Uint32Array(256);
  let nonZero = 0;
  for (const value of gradient) {
    if (value < 1) continue;
    histogram[Math.min(255, Math.round(value / 4))] += 1;
    nonZero += 1;
  }
  if (!nonZero) return 24;
  const target = Math.max(1, Math.round(nonZero * 0.72));
  let cumulative = 0;
  let percentile = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index];
    if (cumulative >= target) {
      percentile = index * 4;
      break;
    }
  }
  return Math.round(Math.max(24, Math.min(120, percentile * 0.58)));
}

function thresholdEdges(
  gradient: Uint16Array,
  width: number,
  height: number,
  threshold: number,
) {
  const result = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const yRatio = y / height;
      const localThreshold = yRatio >= 0.055 && yRatio <= 0.22
        ? Math.max(24, threshold * 0.56)
        : threshold;
      if (gradient[y * width + x] >= localThreshold) result[y * width + x] = 1;
    }
  }
  return result;
}

function dilate(edges: Uint8Array, width: number, height: number) {
  const result = new Uint8Array(edges.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!edges[index]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          result[(y + dy) * width + x + dx] = 1;
        }
      }
    }
  }
  return result;
}

function connectedComponents(binary: Uint8Array, width: number, height: number) {
  const remaining = binary.slice();
  const queue = new Int32Array(binary.length);
  const components: PixelComponent[] = [];
  for (let start = 0; start < remaining.length; start += 1) {
    if (!remaining[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    remaining[start] = 0;
    let left = start % width;
    let right = left;
    let top = Math.floor(start / width);
    let bottom = top;
    let pixelCount = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      pixelCount += 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        const nextY = y + dy;
        if (nextY < 0 || nextY >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          if (nextX < 0 || nextX >= width) continue;
          const next = nextY * width + nextX;
          if (!remaining[next]) continue;
          remaining[next] = 0;
          queue[tail++] = next;
        }
      }
    }
    components.push({ left, top, right, bottom, pixelCount });
  }
  return components;
}

function componentCandidate(input: {
  component: PixelComponent;
  pixels: Buffer;
  gradient: Uint16Array;
  edges: Uint8Array;
  edgeThreshold: number;
  sampleWidth: number;
  sampleHeight: number;
  scaleX: number;
  scaleY: number;
  viewport: ScreenHandViewport;
}): VisualAffordance | null {
  const { component, sampleWidth, sampleHeight } = input;
  const width = component.right - component.left + 1;
  const height = component.bottom - component.top + 1;
  const area = width * height;
  if (
    width < Math.max(4, sampleWidth * 0.018) ||
    height < Math.max(4, sampleHeight * 0.012) ||
    width > sampleWidth * 0.84 ||
    height > sampleHeight * 0.24 ||
    area > sampleWidth * sampleHeight * 0.2
  ) return null;
  const aspect = width / height;
  const compact = aspect >= 0.52 && aspect <= 1.9 &&
    width <= sampleWidth * 0.22 && height <= sampleHeight * 0.16;
  const wideControl = aspect > 1.35 && aspect <= 9 &&
    height <= sampleHeight * 0.14 && width <= sampleWidth * 0.82;
  if (!compact && !wideControl) return null;

  let edgeCount = 0;
  let edgeStrength = 0;
  for (let y = component.top; y <= component.bottom; y += 1) {
    for (let x = component.left; x <= component.right; x += 1) {
      const index = y * sampleWidth + x;
      if (!input.edges[index]) continue;
      edgeCount += 1;
      edgeStrength += input.gradient[index];
    }
  }
  if (edgeCount < 8) return null;
  const edgeDensity = edgeCount / area;
  const connectedDensity = component.pixelCount / area;
  if (edgeDensity < 0.025 || connectedDensity < 0.06) return null;
  const coverage = perimeterCoverage(
    input.edges,
    sampleWidth,
    component,
  );
  const localContrast = componentContrast(
    input.pixels,
    sampleWidth,
    sampleHeight,
    component,
  );
  const averageEdgeStrength = edgeStrength / edgeCount;
  const edgeScore = unit((averageEdgeStrength - input.edgeThreshold) / 150);
  const coverageScore = unit((coverage - 0.08) / 0.44);
  const contrastScore = unit(localContrast / 42);
  const densityScore = unit((connectedDensity - 0.06) / 0.28);
  const confidence = round(
    0.3 * edgeScore + 0.32 * coverageScore +
    0.23 * contrastScore + 0.15 * densityScore,
  );
  if (confidence < 0.5) return null;

  const bounds = {
    left: component.left * input.scaleX,
    top: component.top * input.scaleY,
    width: width * input.scaleX,
    height: height * input.scaleY,
  };
  const center = {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  };
  const geometricRole: VisualAffordanceRole = compact
    ? center.y <= input.viewport.height * 0.17 || center.y >= input.viewport.height * 0.83
      ? "navigation"
      : "icon"
    : "control";
  const symbol = compact
    ? classifyComponentSymbol({
        component,
        edges: input.edges,
        sampleWidth,
        sampleHeight,
        center,
        viewport: input.viewport,
      })
    : null;
  const role: VisualAffordanceRole = symbol?.kind === "back"
    ? "navigation"
    : geometricRole;
  const resolvedConfidence = symbol
    ? round(Math.min(0.99, 0.52 * confidence + 0.48 * symbol.confidence))
    : confidence;
  return {
    role,
    label: symbol?.kind ?? affordanceLabel(role, center, input.viewport),
    confidence: resolvedConfidence,
    center: roundedPoint(center),
    bounds: roundedBounds(bounds),
    source: "local_edges",
    edgeDensity: round(edgeDensity),
    localContrast: round(localContrast),
    ...(symbol ? {
      symbol: symbol.kind,
      symbolConfidence: round(symbol.confidence),
    } : {}),
  };
}

function classifyComponentSymbol(input: {
  component: PixelComponent;
  edges: Uint8Array;
  sampleWidth: number;
  sampleHeight: number;
  center: ScreenHandPoint;
  viewport: ScreenHandViewport;
}): { kind: VisualAffordanceSymbol; confidence: number } | null {
  const points: Array<{ x: number; y: number }> = [];
  for (let y = input.component.top; y <= input.component.bottom; y += 1) {
    for (let x = input.component.left; x <= input.component.right; x += 1) {
      if (input.edges[y * input.sampleWidth + x]) points.push({ x, y });
    }
  }
  const componentWidth = input.component.right - input.component.left + 1;
  const componentHeight = input.component.bottom - input.component.top + 1;
  if (
    points.length < 8 || componentWidth < 4 || componentHeight < 4 ||
    componentWidth > input.sampleWidth * 0.15 ||
    componentHeight > input.sampleHeight * 0.1
  ) return null;
  const normalized = points.map((point) => ({
    x: (point.x - input.component.left) / Math.max(1, componentWidth - 1),
    y: (point.y - input.component.top) / Math.max(1, componentHeight - 1),
  }));
  const xRatio = input.center.x / Math.max(1, input.viewport.width);
  const yRatio = input.center.y / Math.max(1, input.viewport.height);
  const back = yRatio >= 0.055 && yRatio <= 0.22 && xRatio <= 0.3
    ? backChevronConfidence(normalized, componentWidth, componentHeight)
    : 0;
  const close = yRatio >= 0.055 && yRatio <= 0.36 && (xRatio <= 0.3 || xRatio >= 0.7)
    ? closeSymbolConfidence(normalized, componentWidth, componentHeight)
    : 0;
  const add = yRatio >= 0.055 && yRatio <= 0.36
    ? addSymbolConfidence(normalized, componentWidth, componentHeight)
    : 0;
  const search = yRatio >= 0.055 && yRatio <= 0.42 && xRatio >= 0.62
    ? searchSymbolConfidence(normalized, componentWidth, componentHeight)
    : 0;
  const ranked = [
    { kind: "back" as const, confidence: back },
    { kind: "close" as const, confidence: close },
    { kind: "add" as const, confidence: add },
    { kind: "search" as const, confidence: search },
  ].filter((candidate) => candidate.confidence >= 0.78)
    .sort((left, right) => right.confidence - left.confidence);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[1].confidence >= ranked[0].confidence - 0.08) return null;
  return ranked[0];
}

function detectIntensityBackSymbol(
  pixels: Buffer,
  sampleWidth: number,
  sampleHeight: number,
  viewport: ScreenHandViewport,
): VisualAffordance | null {
  const region = {
    left: Math.max(1, Math.floor(sampleWidth * 0.02)),
    right: Math.min(sampleWidth - 2, Math.ceil(sampleWidth * 0.22)),
    top: Math.max(1, Math.floor(sampleHeight * 0.055)),
    bottom: Math.min(sampleHeight - 2, Math.ceil(sampleHeight * 0.13)),
  };
  const values: number[] = [];
  for (let y = region.top; y <= region.bottom; y += 1) {
    for (let x = region.left; x <= region.right; x += 1) {
      values.push(pixels[y * sampleWidth + x]);
    }
  }
  if (!values.length) return null;
  const localMean = average(values);
  const variance = average(values.map((value) => (value - localMean) ** 2));
  const deviation = Math.sqrt(variance);
  const contrast = Math.max(24, Math.min(72, deviation * 0.7));
  const binaries = [
    (value: number) => value <= localMean - contrast,
    (value: number) => value >= localMean + contrast,
  ];
  const ranked: Array<{
    component: PixelComponent;
    confidence: number;
  }> = [];
  for (const predicate of binaries) {
    const binary = new Uint8Array(sampleWidth * sampleHeight);
    for (let y = region.top; y <= region.bottom; y += 1) {
      for (let x = region.left; x <= region.right; x += 1) {
        const index = y * sampleWidth + x;
        if (predicate(pixels[index])) binary[index] = 1;
      }
    }
    for (const component of connectedComponents(binary, sampleWidth, sampleHeight)) {
      const width = component.right - component.left + 1;
      const height = component.bottom - component.top + 1;
      if (
        width < 3 || height < 5 ||
        width > sampleWidth * 0.075 || height > sampleHeight * 0.07 ||
        component.pixelCount < 6
      ) continue;
      const normalized: Array<{ x: number; y: number }> = [];
      for (let y = component.top; y <= component.bottom; y += 1) {
        for (let x = component.left; x <= component.right; x += 1) {
          if (!binary[y * sampleWidth + x]) continue;
          normalized.push({
            x: (x - component.left) / Math.max(1, width - 1),
            y: (y - component.top) / Math.max(1, height - 1),
          });
        }
      }
      const shapeConfidence = backChevronConfidence(normalized, width, height);
      if (shapeConfidence < 0.72) continue;
      const centerX = (component.left + component.right + 1) / 2;
      const centerY = (component.top + component.bottom + 1) / 2;
      const expectedDistance = Math.hypot(
        centerX / sampleWidth - 0.095,
        centerY / sampleHeight - 0.083,
      );
      const positionConfidence = 1 - unit(expectedDistance / 0.1);
      const confidence = round(0.78 * shapeConfidence + 0.22 * positionConfidence);
      if (confidence >= 0.74) ranked.push({ component, confidence });
    }
  }
  ranked.sort((left, right) => right.confidence - left.confidence);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[1].confidence >= ranked[0].confidence - 0.08) return null;
  const best = ranked[0];
  const scaleX = viewport.width / sampleWidth;
  const scaleY = viewport.height / sampleHeight;
  const center = {
    x: (best.component.left + best.component.right + 1) / 2 * scaleX,
    y: (best.component.top + best.component.bottom + 1) / 2 * scaleY,
  };
  const hitWidth = Math.max(
    viewport.width * 0.075,
    (best.component.right - best.component.left + 1) * scaleX * 2.1,
  );
  const hitHeight = Math.max(
    viewport.height * 0.044,
    (best.component.bottom - best.component.top + 1) * scaleY * 1.65,
  );
  return {
    role: "navigation",
    label: "back",
    confidence: best.confidence,
    center: roundedPoint(center),
    bounds: roundedBounds({
      left: Math.max(0, center.x - hitWidth / 2),
      top: Math.max(0, center.y - hitHeight / 2),
      width: Math.min(hitWidth, viewport.width),
      height: Math.min(hitHeight, viewport.height),
    }),
    source: "local_intensity",
    edgeDensity: 0,
    localContrast: round(contrast),
    symbol: "back",
    symbolConfidence: best.confidence,
  };
}

function detectIsolatedTopSearchSymbol(
  pixels: Buffer,
  gradient: Uint16Array,
  edgeThreshold: number,
  sampleWidth: number,
  sampleHeight: number,
  viewport: ScreenHandViewport,
): VisualAffordance | null {
  const region = {
    left: Math.max(1, Math.floor(sampleWidth * 0.78)),
    right: Math.min(sampleWidth - 2, Math.ceil(sampleWidth * 0.985)),
    top: Math.max(1, Math.floor(sampleHeight * 0.055)),
    bottom: Math.min(sampleHeight - 2, Math.ceil(sampleHeight * 0.14)),
  };
  const thresholds = [...new Set([
    Math.max(48, Math.round(edgeThreshold * 0.7)),
    Math.max(72, Math.round(edgeThreshold)),
    Math.max(96, Math.round(edgeThreshold * 1.35)),
    Math.max(120, Math.round(edgeThreshold * 1.7)),
  ])];
  const ranked: Array<{
    component: PixelComponent;
    confidence: number;
    localContrast: number;
  }> = [];
  for (const threshold of thresholds) {
    const localEdges = new Uint8Array(sampleWidth * sampleHeight);
    for (let y = region.top; y <= region.bottom; y += 1) {
      for (let x = region.left; x <= region.right; x += 1) {
        const index = y * sampleWidth + x;
        if (gradient[index] >= threshold) localEdges[index] = 1;
      }
    }
    const connected = dilate(localEdges, sampleWidth, sampleHeight);
    for (const component of connectedComponents(connected, sampleWidth, sampleHeight)) {
      const width = component.right - component.left + 1;
      const height = component.bottom - component.top + 1;
      if (
        width < 6 || height < 6 ||
        width > sampleWidth * 0.12 || height > sampleHeight * 0.075
      ) continue;
      const normalized: Array<{ x: number; y: number }> = [];
      for (let y = component.top; y <= component.bottom; y += 1) {
        for (let x = component.left; x <= component.right; x += 1) {
          if (!localEdges[y * sampleWidth + x]) continue;
          normalized.push({
            x: (x - component.left) / Math.max(1, width - 1),
            y: (y - component.top) / Math.max(1, height - 1),
          });
        }
      }
      const shapeConfidence = searchSymbolConfidence(normalized, width, height);
      if (shapeConfidence < 0.78) continue;
      const centerX = (component.left + component.right + 1) / 2;
      const centerY = (component.top + component.bottom + 1) / 2;
      const expectedDistance = Math.hypot(
        centerX / sampleWidth - 0.93,
        centerY / sampleHeight - 0.083,
      );
      const positionConfidence = 1 - unit(expectedDistance / 0.12);
      ranked.push({
        component,
        confidence: round(0.84 * shapeConfidence + 0.16 * positionConfidence),
        localContrast: componentContrast(
          pixels,
          sampleWidth,
          sampleHeight,
          component,
        ),
      });
    }
  }
  ranked.sort((left, right) => right.confidence - left.confidence);
  if (!ranked.length) return null;
  const distinct = ranked.filter((candidate, index) =>
    index === 0 || Math.hypot(
      candidate.component.left - ranked[0].component.left,
      candidate.component.top - ranked[0].component.top,
    ) > 3
  );
  if (distinct[1] && distinct[1].confidence >= distinct[0].confidence - 0.08) {
    return null;
  }
  const best = ranked[0];
  const scaleX = viewport.width / sampleWidth;
  const scaleY = viewport.height / sampleHeight;
  const center = {
    x: (best.component.left + best.component.right + 1) / 2 * scaleX,
    y: (best.component.top + best.component.bottom + 1) / 2 * scaleY,
  };
  const hitWidth = Math.max(
    viewport.width * 0.075,
    (best.component.right - best.component.left + 1) * scaleX * 1.45,
  );
  const hitHeight = Math.max(
    viewport.height * 0.044,
    (best.component.bottom - best.component.top + 1) * scaleY * 1.45,
  );
  return {
    role: "navigation",
    label: "search",
    confidence: best.confidence,
    center: roundedPoint(center),
    bounds: roundedBounds({
      left: Math.max(0, center.x - hitWidth / 2),
      top: Math.max(0, center.y - hitHeight / 2),
      width: Math.min(hitWidth, viewport.width),
      height: Math.min(hitHeight, viewport.height),
    }),
    source: "local_edges",
    edgeDensity: 0,
    localContrast: round(best.localContrast),
    symbol: "search",
    symbolConfidence: best.confidence,
  };
}

function detectRadialTopSearchSymbol(
  pixels: Buffer,
  gradient: Uint16Array,
  sampleWidth: number,
  sampleHeight: number,
  viewport: ScreenHandViewport,
): VisualAffordance | null {
  const ranked: Array<{
    x: number;
    y: number;
    radius: number;
    confidence: number;
  }> = [];
  const minimumX = Math.round(sampleWidth * 0.84);
  const maximumX = Math.round(sampleWidth * 0.96);
  const minimumY = Math.round(sampleHeight * 0.064);
  const maximumY = Math.round(sampleHeight * 0.115);
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      for (let radius = 3; radius <= 7; radius += 1) {
        const shape = radialSearchConfidence(
          pixels,
          gradient,
          sampleWidth,
          sampleHeight,
          x,
          y,
          radius,
        );
        if (shape < 0.78) continue;
        const expectedDistance = Math.hypot(
          x / sampleWidth - 0.92,
          y / sampleHeight - 0.078,
        );
        const positionConfidence = 1 - unit(expectedDistance / 0.12);
        ranked.push({
          x,
          y,
          radius,
          confidence: round(0.88 * shape + 0.12 * positionConfidence),
        });
      }
    }
  }
  ranked.sort((left, right) => right.confidence - left.confidence);
  if (!ranked.length) return null;
  const best = ranked[0];
  const alternative = ranked.find((candidate) =>
    Math.hypot(candidate.x - best.x, candidate.y - best.y) >
      Math.max(5, candidate.radius, best.radius) * 2
  );
  if (alternative && alternative.confidence >= best.confidence - 0.06) return null;
  const scaleX = viewport.width / sampleWidth;
  const scaleY = viewport.height / sampleHeight;
  const center = {
    x: (best.x + best.radius * 0.24) * scaleX,
    y: (best.y + best.radius * 0.24) * scaleY,
  };
  const hitWidth = Math.max(viewport.width * 0.075, best.radius * 3.2 * scaleX);
  const hitHeight = Math.max(viewport.height * 0.044, best.radius * 3.2 * scaleY);
  return {
    role: "navigation",
    label: "search",
    confidence: best.confidence,
    center: roundedPoint(center),
    bounds: roundedBounds({
      left: Math.max(0, center.x - hitWidth / 2),
      top: Math.max(0, center.y - hitHeight / 2),
      width: Math.min(hitWidth, viewport.width),
      height: Math.min(hitHeight, viewport.height),
    }),
    source: "local_edges",
    edgeDensity: 0,
    localContrast: 0,
    symbol: "search",
    symbolConfidence: best.confidence,
  };
}

function radialSearchConfidence(
  pixels: Buffer,
  gradient: Uint16Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
) {
  const ring = Array.from({ length: 16 }, (_, index) => {
    const angle = index / 16 * Math.PI * 2;
    return localGradientMaximum(
      gradient,
      width,
      height,
      centerX + Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius,
    );
  });
  const handle = [0.82, 1.02, 1.22, 1.42, 1.62].map((distance) =>
    localGradientMaximum(
      gradient,
      width,
      height,
      centerX + radius * distance / Math.SQRT2,
      centerY + radius * distance / Math.SQRT2,
    )
  );
  const opposite = [0.92, 1.18, 1.44, 1.7].map((distance) =>
    localGradientMaximum(
      gradient,
      width,
      height,
      centerX - radius * distance / Math.SQRT2,
      centerY - radius * distance / Math.SQRT2,
    )
  );
  const inner = [
    [0, 0], [-0.25, 0], [0.25, 0], [0, -0.25], [0, 0.25],
  ].map(([offsetX, offsetY]) => localGradientMaximum(
    gradient,
    width,
    height,
    centerX + radius * offsetX,
    centerY + radius * offsetY,
    0,
  ));
  const intensityRing = Array.from({ length: 16 }, (_, index) => {
    const angle = index / 16 * Math.PI * 2;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    return {
      maximum: localPixelMaximum(pixels, width, height, x, y),
      minimum: localPixelMinimum(pixels, width, height, x, y),
    };
  });
  const intensityHandle = [0.82, 1.02, 1.22, 1.42, 1.62].map((distance) => {
    const x = centerX + radius * distance / Math.SQRT2;
    const y = centerY + radius * distance / Math.SQRT2;
    return {
      maximum: localPixelMaximum(pixels, width, height, x, y),
      minimum: localPixelMinimum(pixels, width, height, x, y),
    };
  });
  const ringCoverage = ring.filter((value) => value >= 58).length / ring.length;
  const handleCoverage = handle.filter((value) => value >= 58).length / handle.length;
  const ringScore = average(ring.map((value) => unit((value - 36) / 190)));
  const handleScore = average(handle.map((value) => unit((value - 36) / 190)));
  const oppositeScore = average(opposite.map((value) => unit((value - 36) / 190)));
  const innerScore = average(inner.map((value) => unit((value - 28) / 160)));
  const innerIntensity = average([
    [0, 0], [-0.25, 0], [0.25, 0], [0, -0.25], [0, 0.25],
  ].map(([offsetX, offsetY]) => pixels[
    Math.round(centerY + radius * offsetY) * width +
    Math.round(centerX + radius * offsetX)
  ]));
  const brightContrast = Math.min(
    average(intensityRing.map((value) => value.maximum)),
    average(intensityHandle.map((value) => value.maximum)),
  ) - innerIntensity;
  const darkContrast = innerIntensity - Math.max(
    average(intensityRing.map((value) => value.minimum)),
    average(intensityHandle.map((value) => value.minimum)),
  );
  const polarityContrast = Math.max(brightContrast, darkContrast);
  const intensityScore = unit((polarityContrast - 10) / 50);
  if (
    ringCoverage < 0.625 || handleCoverage < 0.6 ||
    ringScore < 0.34 || handleScore < 0.3 ||
    polarityContrast < 14
  ) return 0;
  const directionScore = unit((handleScore - oppositeScore + 0.08) / 0.32);
  const evidence =
    0.36 * ringScore + 0.2 * ringCoverage +
    0.2 * handleScore + 0.1 * handleCoverage +
    0.1 * directionScore + 0.1 * intensityScore - 0.08 * innerScore;
  return round(0.72 + 0.27 * unit((evidence - 0.46) / 0.34));
}

function localPixelMaximum(
  pixels: Buffer,
  width: number,
  height: number,
  xValue: number,
  yValue: number,
  neighborhood = 1,
) {
  const centerX = Math.round(xValue);
  const centerY = Math.round(yValue);
  let maximum = 0;
  for (let offsetY = -neighborhood; offsetY <= neighborhood; offsetY += 1) {
    const y = centerY + offsetY;
    if (y < 0 || y >= height) continue;
    for (let offsetX = -neighborhood; offsetX <= neighborhood; offsetX += 1) {
      const x = centerX + offsetX;
      if (x < 0 || x >= width) continue;
      maximum = Math.max(maximum, pixels[y * width + x]);
    }
  }
  return maximum;
}

function localPixelMinimum(
  pixels: Buffer,
  width: number,
  height: number,
  xValue: number,
  yValue: number,
  neighborhood = 1,
) {
  const centerX = Math.round(xValue);
  const centerY = Math.round(yValue);
  let minimum = 255;
  for (let offsetY = -neighborhood; offsetY <= neighborhood; offsetY += 1) {
    const y = centerY + offsetY;
    if (y < 0 || y >= height) continue;
    for (let offsetX = -neighborhood; offsetX <= neighborhood; offsetX += 1) {
      const x = centerX + offsetX;
      if (x < 0 || x >= width) continue;
      minimum = Math.min(minimum, pixels[y * width + x]);
    }
  }
  return minimum;
}

function localGradientMaximum(
  gradient: Uint16Array,
  width: number,
  height: number,
  xValue: number,
  yValue: number,
  neighborhood = 1,
) {
  const centerX = Math.round(xValue);
  const centerY = Math.round(yValue);
  let maximum = 0;
  for (let offsetY = -neighborhood; offsetY <= neighborhood; offsetY += 1) {
    const y = centerY + offsetY;
    if (y < 1 || y >= height - 1) continue;
    for (let offsetX = -neighborhood; offsetX <= neighborhood; offsetX += 1) {
      const x = centerX + offsetX;
      if (x < 1 || x >= width - 1) continue;
      maximum = Math.max(maximum, gradient[y * width + x]);
    }
  }
  return maximum;
}

function backChevronConfidence(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number,
) {
  if (height / width < 1.05 || height / width > 4.2) return 0;
  const top = points.filter((point) => point.y <= 0.34);
  const middle = points.filter((point) => point.y >= 0.4 && point.y <= 0.6);
  const bottom = points.filter((point) => point.y >= 0.66);
  if (top.length < 2 || middle.length < 2 || bottom.length < 2) return 0;
  const topX = average(top.map((point) => point.x));
  const middleX = average(middle.map((point) => point.x));
  const bottomX = average(bottom.map((point) => point.x));
  const minimumSlope = Math.min(topX - middleX, bottomX - middleX);
  if (minimumSlope < 0.1 || Math.abs(topX - bottomX) > 0.42) return 0;
  const slopeScore = unit((minimumSlope - 0.1) / 0.18);
  const symmetryScore = 1 - unit(Math.abs(topX - bottomX) / 0.42);
  const directionScore = unit(minimumSlope / 0.28);
  const aspectScore = 1 - unit(Math.abs(height / width - 1.8) / 2.1);
  return round(
    0.42 * slopeScore + 0.25 * symmetryScore +
    0.18 * directionScore + 0.15 * aspectScore,
  );
}

function closeSymbolConfidence(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number,
) {
  const aspect = width / height;
  if (aspect < 0.58 || aspect > 1.72) return 0;
  const top = points.filter((point) => point.y <= 0.3);
  const middle = points.filter((point) => point.y >= 0.38 && point.y <= 0.62);
  const bottom = points.filter((point) => point.y >= 0.7);
  if (top.length < 3 || middle.length < 2 || bottom.length < 3) return 0;
  const topSpan = pointSpan(top, "x");
  const middleSpan = pointSpan(middle, "x");
  const bottomSpan = pointSpan(bottom, "x");
  if (topSpan < 0.58 || bottomSpan < 0.58 || middleSpan > 0.68) return 0;
  const diagonalCoverage = ratioWithin(points, (point) => Math.min(
    Math.abs(point.x - point.y),
    Math.abs(point.x - (1 - point.y)),
  ) <= 0.2);
  const centerBalance = 1 - unit((
    Math.abs(average(top.map((point) => point.x)) - 0.5) +
    Math.abs(average(bottom.map((point) => point.x)) - 0.5)
  ) / 0.52);
  return round(
    0.44 * unit((diagonalCoverage - 0.58) / 0.36) +
    0.28 * unit((Math.min(topSpan, bottomSpan) - 0.58) / 0.34) +
    0.18 * centerBalance +
    0.1 * (1 - unit(Math.abs(aspect - 1) / 0.72)),
  );
}

function addSymbolConfidence(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number,
) {
  const aspect = width / height;
  if (aspect < 0.58 || aspect > 1.72) return 0;
  const horizontal = points.filter((point) => Math.abs(point.y - 0.5) <= 0.25);
  const vertical = points.filter((point) => Math.abs(point.x - 0.5) <= 0.25);
  if (horizontal.length < 3 || vertical.length < 3) return 0;
  const horizontalSpan = pointSpan(horizontal, "x");
  const verticalSpan = pointSpan(vertical, "y");
  const centerCoverage = ratioWithin(points, (point) =>
    Math.abs(point.x - 0.5) <= 0.25 && Math.abs(point.y - 0.5) <= 0.25
  );
  const diagonalCoverage = ratioWithin(points, (point) => Math.min(
    Math.abs(point.x - point.y),
    Math.abs(point.x - (1 - point.y)),
  ) <= 0.16);
  if (
    horizontalSpan < 0.58 || verticalSpan < 0.58 ||
    centerCoverage < 0.08 || diagonalCoverage > 0.72
  ) return 0;
  return round(
    0.34 * unit((horizontalSpan - 0.58) / 0.42) +
    0.34 * unit((verticalSpan - 0.58) / 0.42) +
    0.17 * unit((centerCoverage - 0.08) / 0.22) +
    0.15 * (1 - unit(Math.abs(aspect - 1) / 0.72)),
  );
}

function searchSymbolConfidence(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number,
) {
  const aspect = width / height;
  if (aspect < 0.62 || aspect > 1.62 || points.length < 14) return 0;
  const center = { x: 0.37, y: 0.37 };
  const radial = points.map((point) => ({
    point,
    radius: Math.hypot(point.x - center.x, point.y - center.y),
  }));
  const ring = radial.filter(({ radius }) => radius >= 0.22 && radius <= 0.52);
  const inner = radial.filter(({ radius }) => radius < 0.17);
  const quadrants = [0, 0, 0, 0];
  for (const { point } of ring) {
    const horizontal = point.x >= center.x ? 1 : 0;
    const vertical = point.y >= center.y ? 1 : 0;
    quadrants[vertical * 2 + horizontal] += 1;
  }
  const occupiedQuadrants = quadrants.filter((count) => count >= 2).length;
  const tail = points.filter((point) =>
    point.x >= 0.62 && point.y >= 0.62 && Math.abs(point.x - point.y) <= 0.2
  );
  const tailExtent = tail.length
    ? Math.max(...tail.map((point) => Math.min(point.x, point.y)))
    : 0;
  const tailSpan = tail.length
    ? tailExtent - Math.min(...tail.map((point) => Math.min(point.x, point.y)))
    : 0;
  const opposingCornerRatio = points.filter((point) =>
    point.x >= 0.7 && point.y <= 0.3 ||
    point.x <= 0.3 && point.y >= 0.7
  ).length / points.length;
  const ringRatio = ring.length / points.length;
  const innerRatio = inner.length / points.length;
  const tailRatio = tail.length / points.length;
  if (
    occupiedQuadrants < 4 || ringRatio < 0.42 || innerRatio > 0.16 ||
    tail.length < 3 || tailExtent < 0.82 || tailSpan < 0.19 ||
    tailRatio > 0.42 || opposingCornerRatio > 0.16
  ) return 0;
  const evidence =
    0.32 * unit((ringRatio - 0.42) / 0.34) +
    0.22 * (1 - unit(innerRatio / 0.16)) +
    0.18 * unit((tailExtent - 0.84) / 0.16) +
    0.16 * unit((tailRatio - 0.04) / 0.2) +
    0.12 * (1 - unit(Math.abs(aspect - 1) / 0.62));
  return round(0.78 + 0.21 * unit((evidence - 0.35) / 0.4));
}

function pointSpan(
  points: Array<{ x: number; y: number }>,
  axis: "x" | "y",
) {
  const values = points.map((point) => point[axis]);
  return Math.max(...values) - Math.min(...values);
}

function ratioWithin(
  points: Array<{ x: number; y: number }>,
  predicate: (point: { x: number; y: number }) => boolean,
) {
  return points.filter(predicate).length / Math.max(1, points.length);
}

function perimeterCoverage(
  edges: Uint8Array,
  width: number,
  component: PixelComponent,
) {
  const horizontal = (yStart: number, yEnd: number) => {
    let occupied = 0;
    for (let x = component.left; x <= component.right; x += 1) {
      let found = false;
      for (let y = yStart; y <= yEnd; y += 1) {
        if (edges[y * width + x]) found = true;
      }
      if (found) occupied += 1;
    }
    return occupied / Math.max(1, component.right - component.left + 1);
  };
  const vertical = (xStart: number, xEnd: number) => {
    let occupied = 0;
    for (let y = component.top; y <= component.bottom; y += 1) {
      let found = false;
      for (let x = xStart; x <= xEnd; x += 1) {
        if (edges[y * width + x]) found = true;
      }
      if (found) occupied += 1;
    }
    return occupied / Math.max(1, component.bottom - component.top + 1);
  };
  const band = 1;
  return (
    horizontal(component.top, Math.min(component.bottom, component.top + band)) +
    horizontal(Math.max(component.top, component.bottom - band), component.bottom) +
    vertical(component.left, Math.min(component.right, component.left + band)) +
    vertical(Math.max(component.left, component.right - band), component.right)
  ) / 4;
}

function componentContrast(
  pixels: Buffer,
  width: number,
  height: number,
  component: PixelComponent,
) {
  const inset = Math.max(1, Math.floor(Math.min(
    component.right - component.left + 1,
    component.bottom - component.top + 1,
  ) * 0.18));
  const inside = meanRegion(pixels, width, height, {
    left: component.left + inset,
    right: component.right - inset,
    top: component.top + inset,
    bottom: component.bottom - inset,
  });
  const expanded = {
    left: component.left - 3,
    right: component.right + 3,
    top: component.top - 3,
    bottom: component.bottom + 3,
  };
  const outer = meanRing(pixels, width, height, component, expanded);
  return Math.abs(inside - outer);
}

function meanRegion(
  pixels: Buffer,
  width: number,
  height: number,
  region: { left: number; right: number; top: number; bottom: number },
) {
  const left = Math.max(0, Math.min(width - 1, region.left));
  const right = Math.max(left, Math.min(width - 1, region.right));
  const top = Math.max(0, Math.min(height - 1, region.top));
  const bottom = Math.max(top, Math.min(height - 1, region.bottom));
  let total = 0;
  let count = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      total += pixels[y * width + x];
      count += 1;
    }
  }
  return count ? total / count : 0;
}

function meanRing(
  pixels: Buffer,
  width: number,
  height: number,
  inner: PixelComponent,
  outer: { left: number; right: number; top: number; bottom: number },
) {
  let total = 0;
  let count = 0;
  const left = Math.max(0, outer.left);
  const right = Math.min(width - 1, outer.right);
  const top = Math.max(0, outer.top);
  const bottom = Math.min(height - 1, outer.bottom);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (
        x >= inner.left && x <= inner.right &&
        y >= inner.top && y <= inner.bottom
      ) continue;
      total += pixels[y * width + x];
      count += 1;
    }
  }
  return count ? total / count : 0;
}

function overlapsExcludedText(
  bounds: VisualAffordance["bounds"],
  excluded: VisualAffordanceDetectorOptions["excludeBounds"],
) {
  const candidateArea = bounds.width * bounds.height;
  return excluded?.some((other) => {
    const overlap = intersectionArea(bounds, other);
    if (!overlap) return false;
    const similarHeight = bounds.height <= other.height * 1.8;
    return overlap / Math.max(1, candidateArea) >= 0.42 ||
      (similarHeight && overlap / Math.max(1, other.width * other.height) >= 0.72);
  }) ?? false;
}

function appendSpecialCandidate(
  candidates: VisualAffordance[],
  candidate: VisualAffordance,
  excluded: VisualAffordanceDetectorOptions["excludeBounds"],
) {
  if (overlapsExcludedText(candidate.bounds, excluded)) return;
  const conflictingSymbol = candidates.some((existing) =>
    existing.symbol !== undefined &&
    existing.symbol !== candidate.symbol &&
    candidatesShareHitRegion(existing, candidate)
  );
  if (!conflictingSymbol) candidates.push(candidate);
}

function candidatesShareHitRegion(
  left: VisualAffordance,
  right: VisualAffordance,
) {
  const overlap = intersectionArea(left.bounds, right.bounds);
  const smallerArea = Math.min(
    left.bounds.width * left.bounds.height,
    right.bounds.width * right.bounds.height,
  );
  return overlap / Math.max(1, smallerArea) >= 0.56 ||
    Math.hypot(left.center.x - right.center.x, left.center.y - right.center.y) <=
      Math.min(
        left.bounds.width,
        left.bounds.height,
        right.bounds.width,
        right.bounds.height,
      ) * 0.25;
}

function suppressOverlappingCandidates(candidates: VisualAffordance[]) {
  const selected: VisualAffordance[] = [];
  for (const candidate of candidates.sort((left, right) =>
    (right.symbolConfidence ?? 0) - (left.symbolConfidence ?? 0) ||
    right.confidence - left.confidence ||
    right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height
  )) {
    const duplicate = selected.some((existing) =>
      candidatesShareHitRegion(existing, candidate)
    );
    if (!duplicate) selected.push(candidate);
  }
  return selected.sort((left, right) =>
    left.center.y - right.center.y || left.center.x - right.center.x
  );
}

function affordanceLabel(
  role: VisualAffordanceRole,
  center: ScreenHandPoint,
  viewport: ScreenHandViewport,
) {
  const vertical = center.y < viewport.height * 0.34
    ? "top"
    : center.y > viewport.height * 0.66
      ? "bottom"
      : "middle";
  const horizontal = center.x < viewport.width * 0.34
    ? "left"
    : center.x > viewport.width * 0.66
      ? "right"
      : "center";
  return `unlabeled ${vertical}-${horizontal} ${role}`;
}

function intersectionArea(
  left: { left: number; top: number; width: number; height: number },
  right: { left: number; top: number; width: number; height: number },
) {
  const overlapWidth = Math.max(
    0,
    Math.min(left.left + left.width, right.left + right.width) -
      Math.max(left.left, right.left),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.top + left.height, right.top + right.height) -
      Math.max(left.top, right.top),
  );
  return overlapWidth * overlapHeight;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value))));
}

function roundedPoint(point: ScreenHandPoint) {
  return { x: round(point.x), y: round(point.y) };
}

function roundedBounds(bounds: VisualAffordance["bounds"]) {
  return {
    left: round(bounds.left),
    top: round(bounds.top),
    width: round(bounds.width),
    height: round(bounds.height),
  };
}

function unit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

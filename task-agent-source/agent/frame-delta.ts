export type VisualChangeRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
  score: number;
};

export type FrameDeltaAnalysis = {
  changeRatio: number | null;
  changeKind: "first" | "stable" | "minor" | "major";
  regions: VisualChangeRegion[];
  changedAreaRatio: number;
};

export type FrameDeltaOptions = {
  sampleWidth?: number;
  sampleHeight?: number;
  tileColumns?: number;
  tileRows?: number;
  stableDifferenceThreshold?: number;
  majorDifferenceThreshold?: number;
  tileDifferenceThreshold?: number;
  expansionTiles?: number;
};

/**
 * Converts a tiny grayscale frame fingerprint into a small set of logical
 * screen regions. This is deliberately deterministic and model-free: it only
 * decides where semantics may have changed, never what a control means.
 */
export function analyzeFrameDelta(
  previous: Buffer | null,
  current: Buffer,
  viewport: { width: number; height: number },
  options: FrameDeltaOptions = {},
): FrameDeltaAnalysis {
  const sampleWidth = boundedInteger(options.sampleWidth, 8, 512, 48);
  const sampleHeight = boundedInteger(options.sampleHeight, 8, 512, 80);
  const stableThreshold = boundedRatio(options.stableDifferenceThreshold, 0.012);
  const majorThreshold = boundedRatio(options.majorDifferenceThreshold, 0.08);
  if (!previous || previous.length !== current.length || current.length !== sampleWidth * sampleHeight) {
    return {
      changeRatio: previous ? 1 : null,
      changeKind: previous ? "major" : "first",
      regions: [fullRegion(viewport, previous ? 1 : 0)],
      changedAreaRatio: 1,
    };
  }

  const differences = Buffer.allocUnsafe(current.length);
  let total = 0;
  for (let index = 0; index < current.length; index += 1) {
    const difference = Math.abs(current[index] - previous[index]);
    differences[index] = difference;
    total += difference;
  }
  const changeRatio = total / current.length / 255;
  if (changeRatio <= stableThreshold) {
    return { changeRatio, changeKind: "stable", regions: [], changedAreaRatio: 0 };
  }

  const changeKind = changeRatio <= majorThreshold ? "minor" : "major";
  const columns = boundedInteger(options.tileColumns, 1, sampleWidth, 6);
  const rows = boundedInteger(options.tileRows, 1, sampleHeight, 10);
  const tileThreshold = boundedRatio(
    options.tileDifferenceThreshold,
    Math.max(0.035, stableThreshold * 2.5),
  );
  const tiles = changedTiles(
    differences,
    sampleWidth,
    sampleHeight,
    columns,
    rows,
    tileThreshold,
  );
  if (!tiles.size) {
    return {
      changeRatio,
      changeKind,
      regions: [fullRegion(viewport, changeRatio)],
      changedAreaRatio: 1,
    };
  }
  const expansion = boundedInteger(options.expansionTiles, 0, 4, 1);
  const components = connectedComponents(tiles, columns, rows)
    .map((component) => componentRegion(
      component,
      columns,
      rows,
      viewport,
      expansion,
    ));
  const regions = mergeRegions(components, viewport)
    .sort((left, right) => right.score - left.score || left.top - right.top)
    .slice(0, 6);
  const changedAreaRatio = unionAreaRatio(regions, viewport);
  return { changeRatio, changeKind, regions, changedAreaRatio };
}

function changedTiles(
  differences: Buffer,
  sampleWidth: number,
  sampleHeight: number,
  columns: number,
  rows: number,
  threshold: number,
) {
  const result = new Map<number, number>();
  for (let row = 0; row < rows; row += 1) {
    const top = Math.floor(row * sampleHeight / rows);
    const bottom = Math.floor((row + 1) * sampleHeight / rows);
    for (let column = 0; column < columns; column += 1) {
      const left = Math.floor(column * sampleWidth / columns);
      const right = Math.floor((column + 1) * sampleWidth / columns);
      let total = 0;
      let count = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          total += differences[y * sampleWidth + x];
          count += 1;
        }
      }
      const score = count ? total / count / 255 : 0;
      if (score >= threshold) result.set(row * columns + column, score);
    }
  }
  return result;
}

function connectedComponents(
  tiles: Map<number, number>,
  columns: number,
  rows: number,
) {
  const pending = new Set(tiles.keys());
  const result: Array<Array<{ column: number; row: number; score: number }>> = [];
  while (pending.size) {
    const first = pending.values().next().value as number;
    pending.delete(first);
    const queue = [first];
    const component: Array<{ column: number; row: number; score: number }> = [];
    while (queue.length) {
      const index = queue.shift()!;
      const row = Math.floor(index / columns);
      const column = index % columns;
      component.push({ column, row, score: tiles.get(index) ?? 0 });
      for (const [nextColumn, nextRow] of [
        [column - 1, row], [column + 1, row], [column, row - 1], [column, row + 1],
      ]) {
        if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
        const next = nextRow * columns + nextColumn;
        if (!pending.delete(next)) continue;
        queue.push(next);
      }
    }
    result.push(component);
  }
  return result;
}

function componentRegion(
  component: Array<{ column: number; row: number; score: number }>,
  columns: number,
  rows: number,
  viewport: { width: number; height: number },
  expansion: number,
): VisualChangeRegion {
  const leftTile = Math.max(0, Math.min(...component.map((tile) => tile.column)) - expansion);
  const rightTile = Math.min(columns, Math.max(...component.map((tile) => tile.column)) + 1 + expansion);
  const topTile = Math.max(0, Math.min(...component.map((tile) => tile.row)) - expansion);
  const bottomTile = Math.min(rows, Math.max(...component.map((tile) => tile.row)) + 1 + expansion);
  const left = Math.floor(leftTile * viewport.width / columns);
  const top = Math.floor(topTile * viewport.height / rows);
  const right = Math.ceil(rightTile * viewport.width / columns);
  const bottom = Math.ceil(bottomTile * viewport.height / rows);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    score: round(Math.max(...component.map((tile) => tile.score))),
  };
}

function mergeRegions(
  input: VisualChangeRegion[],
  viewport: { width: number; height: number },
) {
  const regions = input.map((region) => ({ ...region }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < regions.length; rightIndex += 1) {
        if (!regionsTouch(regions[leftIndex], regions[rightIndex])) continue;
        regions[leftIndex] = enclosingRegion(regions[leftIndex], regions[rightIndex], viewport);
        regions.splice(rightIndex, 1);
        changed = true;
        break outer;
      }
    }
  }
  return regions;
}

function regionsTouch(left: VisualChangeRegion, right: VisualChangeRegion) {
  return left.left <= right.left + right.width &&
    right.left <= left.left + left.width &&
    left.top <= right.top + right.height &&
    right.top <= left.top + left.height;
}

function enclosingRegion(
  left: VisualChangeRegion,
  right: VisualChangeRegion,
  viewport: { width: number; height: number },
): VisualChangeRegion {
  const x1 = Math.max(0, Math.min(left.left, right.left));
  const y1 = Math.max(0, Math.min(left.top, right.top));
  const x2 = Math.min(viewport.width, Math.max(left.left + left.width, right.left + right.width));
  const y2 = Math.min(viewport.height, Math.max(left.top + left.height, right.top + right.height));
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1, score: Math.max(left.score, right.score) };
}

function unionAreaRatio(
  regions: VisualChangeRegion[],
  viewport: { width: number; height: number },
) {
  const area = regions.reduce((sum, region) => sum + region.width * region.height, 0);
  return round(Math.min(1, area / Math.max(1, viewport.width * viewport.height)));
}

function fullRegion(viewport: { width: number; height: number }, score: number): VisualChangeRegion {
  return { left: 0, top: 0, width: viewport.width, height: viewport.height, score: round(score) };
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function boundedRatio(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 1
    ? Number(value)
    : fallback;
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

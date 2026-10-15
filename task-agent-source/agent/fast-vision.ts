import type { VisionOcrResult, VisionTextItem } from "./vision-ocr";

type PointerPoint = { x: number; y: number };

export type FastHomeAppMatch = {
  appName: string;
  recognizedLabel: string;
  point: PointerPoint;
  confidence: number;
  homeLabelCount: number;
};

const knownHomeLabels = new Set([
  "telegram", "gemini", "x", "reddit", "poe", "perplexity", "gmail",
  "google", "outlook", "googlephotos", "photos", "passwords", "doji",
  "anyconnect", "capcut", "剪映", "rednote", "alipay", "支付宝", "wechat",
  "微信", "wise", "v2box", "bounty", "games", "preview", "snapchat",
]);

const aliases = new Map<string, string[]>([
  ["telegram", ["telegram"]],
  ["googlephotos", ["googlephotos", "photos"]],
  ["photos", ["googlephotos", "photos"]],
  ["passwords", ["passwords", "密码"]],
  ["wechat", ["wechat", "微信"]],
  ["微信", ["wechat", "微信"]],
  ["alipay", ["alipay", "支付宝"]],
  ["支付宝", ["alipay", "支付宝"]],
  ["rednote", ["rednote", "小红书"]],
  ["小红书", ["rednote", "小红书"]],
]);

export function requestedHomeApp(goal: string): string | null {
  const compact = goal.normalize("NFKC").trim();
  // This fast path accepts only one complete launch instruction. Substring
  // matching used to extract "打开扬声器" from a full phone-call goal and
  // silently discard dial, speaker, wait, and hang-up steps.
  const chinese = compact.match(
    /^(?:请(?:帮我)?|帮我)?(?:打开|启动|进入)\s*([A-Za-z0-9][A-Za-z0-9 .+_-]{0,40}?|[\p{Script=Han}]{1,12}?)(?:\s*(?:应用|App|app))?(?:\s*[，,]?\s*(?:并)?\s*(?:等待|等到)(?:(?:该|这个)?(?:应用|界面))?(?:打开|出现|加载完成|就绪)?)?\s*[。.!]?$/u,
  );
  if (chinese?.[1]) return chinese[1].trim();
  const english = compact.match(
    /^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?([a-z0-9][a-z0-9 .+_-]{0,40}?)(?:\s+(?:app|application))?(?:\s*,?\s*(?:and\s+)?wait(?:\s+for\s+(?:it|the\s+(?:app|screen))\s+to\s+(?:open|load))?)?\s*[.!]?$/i,
  );
  return english?.[1]?.trim() || null;
}

export function locateHomeApp(
  appName: string,
  ocr: VisionOcrResult,
  logicalSize: { width: number; height: number },
): FastHomeAppMatch | null {
  const normalizedItems = ocr.items.map((item) => ({
    item,
    normalized: normalizeLabel(item.text),
  }));
  const homeLabelCount = new Set(
    normalizedItems
      .map(({ normalized }) => normalized)
      .map(knownHomeLabel)
      .filter((label): label is string => Boolean(label)),
  ).size;
  if (homeLabelCount < 4) return null;

  const requested = normalizeLabel(appName);
  const accepted = new Set(aliases.get(requested) ?? [requested]);
  const candidate = normalizedItems
    .filter(({ item, normalized }) =>
      item.confidence >= 0.35 && [...accepted].some(
        (label) => normalized === label || labelsAreNearMatch(normalized, label),
      )
    )
    .sort((left, right) => right.item.confidence - left.item.confidence)[0];
  if (!candidate) return null;

  const scaleX = logicalSize.width / ocr.imageWidth;
  const scaleY = logicalSize.height / ocr.imageHeight;
  const iconOffset = logicalSize.height * 0.054;
  return {
    appName,
    recognizedLabel: candidate.item.text,
    point: {
      x: clamp(candidate.item.centerX * scaleX, 0, logicalSize.width),
      y: clamp(candidate.item.centerY * scaleY - iconOffset, 0, logicalSize.height),
    },
    confidence: candidate.item.confidence,
    homeLabelCount,
  };
}

export function homeScreenLabelCount(ocr: VisionOcrResult) {
  return new Set(
    ocr.items
      .map((item) => normalizeLabel(item.text))
      .map(knownHomeLabel)
      .filter((label): label is string => Boolean(label)),
  ).size;
}

export function ocrTextSample(ocr: VisionOcrResult, maximum = 8) {
  return ocr.items
    .filter((item: VisionTextItem) => item.confidence >= 0.35)
    .slice(0, maximum)
    .map((item) => item.text)
    .join(" · ");
}

function normalizeLabel(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function labelsAreNearMatch(left: string, right: string) {
  if (left.length < 5 || right.length < 5 || Math.abs(left.length - right.length) > 1) {
    return false;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] <= 1;
}

function knownHomeLabel(label: string) {
  if (knownHomeLabels.has(label)) return label;
  return [...knownHomeLabels].find((known) => labelsAreNearMatch(label, known)) ?? null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

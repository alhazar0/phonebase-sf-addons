import type { VisionOcrResult } from "./vision-ocr";

type PointerPoint = { x: number; y: number };

export type FastSwipeIntent = {
  name: "scroll down" | "scroll up" | "swipe left" | "swipe right";
  start: PointerPoint;
  end: PointerPoint;
};

export type FastTextInputIntent = { field: string; text: string };

export function requestedTextInput(goal: string): FastTextInputIntent | null {
  const chinese = goal.match(
    /在\s*[“"']?([^“”"'，。]{1,30}?)(?:输入框|文本框|字段)(?:中|里)?\s*(?:输入|键入)\s*[“"']?([^”"'，。]{1,60})/u,
  );
  if (chinese?.[1] && chinese[2]) {
    return { field: chinese[1].trim(), text: chinese[2].trim() };
  }
  const search = goal.match(
    /在\s*(?:搜索框|搜索栏)(?:中|里)?\s*(?:输入|键入)\s*[“"']?([^”"'，。]{1,60})/u,
  );
  if (search?.[1]) return { field: "Search", text: search[1].trim() };
  const english = goal.match(
    /\btype\s+["']?(.{1,60}?)["']?\s+into\s+(?:the\s+)?["']?(.{1,30}?)["']?(?:\s+(?:field|box))?(?:[,.]|$)/i,
  );
  if (english?.[1] && english[2]) {
    return { field: english[2].trim(), text: english[1].trim() };
  }
  return null;
}

export function requestedClickTarget(goal: string) {
  const quoted = goal.match(
    /(?:点击|轻触|点按|tap|click|press)\s*(?:屏幕)?\s*(?:the\s+)?[“"]([^”"]{1,32})[”"]/iu,
  );
  if (quoted?.[1]) return quoted[1].trim();
  const chinese = goal.match(
    /(?:点击|轻触|点按)\s*(?:屏幕)?\s*(?:(?:左上角|右上角|左下角|右下角)(?:的)?)?\s*[“"']?([^，。,“”"']{1,32})/u,
  );
  if (chinese?.[1]) {
    return chinese[1]
      .replace(/(?:按钮|图标|控件|输入框|文本框)(?:以|来)?(?:关闭|打开)?.*$/u, "")
      .trim();
  }
  const english = goal.match(
    /\b(?:tap|click|press)\s+(?:the\s+)?(?:top[- ](?:left|right)\s+)?["']?([a-z0-9][a-z0-9 .+_-]{0,31}?)(?=["']?(?:\s+(?:button|icon|to|and)|[,.]|$))/i,
  );
  return english?.[1]?.trim() || null;
}

export function requestsTopLeftClose(goal: string) {
  const normalized = goal.normalize("NFKC").toLocaleLowerCase("en-US");
  const mentionsClose = /(?:关闭|退出|close|dismiss)/u.test(normalized);
  const mentionsTopLeft = /(?:左上角|top[- ]left)/u.test(normalized);
  const mentionsX = /(?:\bx\b|×|叉号)/u.test(normalized);
  return mentionsClose && mentionsTopLeft && mentionsX;
}

export function requestedSwipe(goal: string, size: { width: number; height: number }): FastSwipeIntent | null {
  const normalized = goal.normalize("NFKC").toLocaleLowerCase("en-US");
  const centerX = size.width * 0.5;
  const centerY = size.height * 0.52;
  if (/(?:向下滚动|往下滚动|scroll down)/u.test(normalized)) {
    return {
      name: "scroll down",
      start: { x: centerX, y: size.height * 0.74 },
      end: { x: centerX, y: size.height * 0.28 },
    };
  }
  if (/(?:向上滚动|往上滚动|scroll up)/u.test(normalized)) {
    return {
      name: "scroll up",
      start: { x: centerX, y: size.height * 0.28 },
      end: { x: centerX, y: size.height * 0.74 },
    };
  }
  if (/(?:向左滑|swipe left)/u.test(normalized)) {
    return {
      name: "swipe left",
      start: { x: size.width * 0.76, y: centerY },
      end: { x: size.width * 0.24, y: centerY },
    };
  }
  if (/(?:向右滑|swipe right)/u.test(normalized)) {
    return {
      name: "swipe right",
      start: { x: size.width * 0.24, y: centerY },
      end: { x: size.width * 0.76, y: centerY },
    };
  }
  return null;
}

export function locateVisibleText(
  target: string,
  ocr: VisionOcrResult,
  logicalSize: { width: number; height: number },
) {
  const requested = normalize(target);
  if (requested.length < 2) return null;
  const candidates = ocr.items
    .map((item) => ({
      item,
      normalized: normalize(item.text),
      tokenMatch: normalizedTokens(item.text).includes(requested),
    }))
    .filter(({ item, normalized, tokenMatch }) =>
      item.confidence >= 0.4 &&
      (normalized === requested ||
        tokenMatch ||
        (requested.length >= 4 && normalized.includes(requested)))
    )
    .sort((left, right) => {
      const exactLeft = left.normalized === requested ? 1 : 0;
      const exactRight = right.normalized === requested ? 1 : 0;
      const tokenLeft = left.tokenMatch ? 1 : 0;
      const tokenRight = right.tokenMatch ? 1 : 0;
      return exactRight - exactLeft || tokenRight - tokenLeft ||
        right.item.confidence - left.item.confidence;
    });
  const selected = candidates[0]?.item;
  if (!selected) return null;
  return {
    recognizedLabel: selected.text,
    confidence: selected.confidence,
    point: {
      x: selected.centerX * logicalSize.width / ocr.imageWidth,
      y: selected.centerY * logicalSize.height / ocr.imageHeight,
    },
  };
}

export function visionTextSignature(ocr: VisionOcrResult) {
  return new Set(
    ocr.items
      .filter((item) => item.confidence >= 0.35)
      .map((item) => normalize(item.text))
      .filter((item) => item.length >= 2),
  );
}

export function signaturesDiffer(left: Set<string>, right: Set<string>) {
  if (!left.size && !right.size) return false;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return union > 0 && intersection / union < 0.82;
}

export function looksLikeIosKeyboard(ocr: VisionOcrResult) {
  return iosKeyboardOcrEvidence(ocr).visible;
}

export function iosKeyboardOcrEvidence(ocr: VisionOcrResult) {
  const bottom = ocr.items.filter(
    (item) => item.centerY / ocr.imageHeight >= 0.54 && item.confidence >= 0.3,
  );
  const singleKeys = bottom.filter((item) => /^[a-z]$/i.test(item.text.trim())).length;
  const normalized = bottom.map((item) => normalize(item.text));
  const shortKeyItems = bottom.filter((item) => item.text.trim().length <= 5);
  const uniqueLetters = new Set(
    shortKeyItems.flatMap((item) => item.text.toLocaleLowerCase("en-US").match(/[a-z]/g) ?? []),
  ).size;
  const hasNumericKey = normalized.some((item) => item.includes("123"));
  const hasDotCom = normalized.some((item) => item.includes("com"));
  return {
    visible: singleKeys >= 6 ||
    (shortKeyItems.length >= 6 && uniqueLetters >= 7) ||
    (hasNumericKey && hasDotCom && shortKeyItems.length >= 4),
    bottomItems: bottom.length,
    singleKeys,
    shortKeyItems: shortKeyItems.length,
    uniqueLetters,
    hasNumericKey,
    hasDotCom,
  };
}

export function keyboardUsesNonLatinInput(ocr: VisionOcrResult) {
  const candidates = ocr.items
    .filter((item) =>
      item.centerY / ocr.imageHeight >= 0.55 &&
      item.centerY / ocr.imageHeight <= 0.72 &&
      item.confidence >= 0.3
    );
  const strongScriptLetters = candidates.flatMap((item) =>
    item.text.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/gu,
    ) ?? []
  ).length;
  if (strongScriptLetters >= 2) return true;

  // Fast OCR occasionally reads white Latin keys as low-confidence Cyrillic
  // (for example `y i` as `у и`). A real non-Latin keyboard produces several
  // coherent, high-confidence letters; one noisy glyph must not trigger a
  // physical language-switch action.
  const otherNonLatinLetters = candidates
    .filter((item) => item.confidence >= 0.65)
    .flatMap((item) => item.text.match(/\p{Letter}/gu) ?? [])
    .filter((character) => !/\p{Script=Latin}/u.test(character)).length;
  return otherNonLatinLetters >= 4;
}

export function iosKeyboardShiftActive(ocr: VisionOcrResult): boolean | null {
  const letters = ocr.items
    .filter((item) =>
      item.centerY / ocr.imageHeight >= 0.65 &&
      item.confidence >= 0.3
    )
    .flatMap((item) => item.text.match(/[A-Za-z]/g) ?? []);
  const uppercase = letters.filter((letter) => letter === letter.toUpperCase()).length;
  const lowercase = letters.length - uppercase;
  if (uppercase >= 6 && uppercase >= lowercase * 1.5) return true;
  if (lowercase >= 6 && lowercase >= uppercase * 1.5) return false;
  return null;
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function normalizedTokens(value: string) {
  return (value.normalize("NFKC").match(/[\p{Letter}\p{Number}]+/gu) ?? [])
    .map(normalize)
    .filter(Boolean);
}

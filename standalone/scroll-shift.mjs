// Measure how far a scroll actually moved the screen.
//
// A wheel notch has no fixed meaning across applications: browsers scroll three
// text lines, some lists scroll one row, image viewers scroll a fixed pixel
// amount. The tool can therefore only ask for a direction plus an estimated
// amount; comparing the before/after screenshots tells the model what really
// happened ("moved about 80% of a screen") instead of leaving it to guess.
//
// The estimate is conservative on purpose. Dynamic content (video, clocks,
// animations) lowers confidence, and the caller then says nothing rather than
// reporting a wrong distance.
import { decodePng } from "./image-scale.mjs";

/** Analysis width; enough rows to match, small enough to stay cheap. */
const ANALYSIS_WIDTH = 120;
/** Below this score separation the match is noise; report nothing. */
const MIN_CONFIDENCE = 0.25;
/** Overlap below this fraction of the frame cannot produce a trustworthy match. */
const MIN_OVERLAP = 0.15;

/**
 * Estimate the vertical screen shift between two captures.
 * @param {Buffer|Uint8Array} beforePng capture before the scroll
 * @param {Buffer|Uint8Array} afterPng capture after the scroll
 * @returns {{ratio: number, confidence: number, shiftPixels: number}|null}
 *          ratio > 0 means the page scrolled down (content moved up); null when
 *          the pair cannot be compared or the match is not trustworthy.
 */
export function estimateVerticalShift(beforePng, afterPng) {
  let before;
  let after;
  try {
    before = decodePng(beforePng);
    after = decodePng(afterPng);
  } catch {
    return null;
  }
  if (before.width !== after.width || before.height !== after.height) return null;

  const width = Math.min(ANALYSIS_WIDTH, before.width);
  if (width < 8 || before.height < 16) return null;
  const height = Math.max(8, Math.round(before.height * (width / before.width)));
  const beforeGray = toGray(before, width, height);
  const afterGray = toGray(after, width, height);

  const maxShift = Math.max(4, Math.round(height * (1 - MIN_OVERLAP)));
  const scores = [];
  let best = { dy: 0, score: Number.POSITIVE_INFINITY };
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    const score = meanAbsoluteDifference(beforeGray, afterGray, width, height, dy);
    if (score === null) continue;
    scores.push(score);
    if (score < best.score) best = { dy, score };
  }
  if (scores.length < 8 || !Number.isFinite(best.score)) return null;

  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  // Every shift matches perfectly: the frames are identical (or the picture is
  // a flat color). That is zero movement, not a failed measurement; returning
  // null here would make the visual settle check wait until its deadline.
  if (average <= 0) return { ratio: 0, confidence: 1, shiftPixels: 0 };
  const confidence = Math.min(1, Math.max(0, (average - best.score) / average));
  if (confidence < MIN_CONFIDENCE) return null;

  // before row y was found at after row y+dy. dy < 0 means content moved up,
  // which is a downward scroll; positive ratio = scrolled down.
  // "+ 0" turns -0 into 0 so callers can compare with strict equality.
  const ratio = Math.max(-1, Math.min(1, -best.dy / height)) + 0;
  return { ratio, confidence, shiftPixels: Math.abs(best.dy) };
}

/** Desired fraction of the viewport for each semantic amount. */
const DESIRED_RATIO = { page: 0.75, half: 0.4 };

/**
 * Whether a scroll fell far short and deserves one supplement.
 * Deliberately conservative: no measurement, low confidence, or a screen that
 * barely moved (end of content, or an app that ignores the wheel) never
 * triggers a second scroll. A wrong supplement overshoots the target.
 * @param {string} amount "page" or "half"
 * @param {{ratio: number, confidence: number}|null} shift measured result
 * @returns {boolean}
 */
export function shouldSupplementScroll(amount, shift) {
  const desired = DESIRED_RATIO[String(amount)];
  if (!desired || !shift || typeof shift.ratio !== "number") return false;
  if (shift.confidence < 0.4) return false;
  const measured = Math.abs(shift.ratio);
  if (measured < 0.06) return false;
  return measured < desired * 0.5;
}

/**
 * Extra notches so the combined movement approaches the requested amount.
 * @param {string} amount "page" or "half"
 * @param {number} requested notches of the first scroll
 * @param {{ratio: number}|null} shift measured result of the first scroll
 * @returns {number} 0 when nothing should be added, otherwise 1..requested
 */
export function supplementNotches(amount, requested, shift) {
  const desired = DESIRED_RATIO[String(amount)] ?? 0.75;
  const measured = Math.min(Math.abs(shift?.ratio ?? 0), desired);
  const missing = Math.max(0, desired - measured);
  if (missing <= 0) return 0;
  const extra = Math.round((missing / desired) * requested);
  return Math.min(Math.max(1, extra), Math.max(1, requested));
}

/** One-line measurement for the tool result; "" when the shift is unusable. */
export function scrollShiftNote(shift, direction) {
  if (!shift || typeof shift.ratio !== "number") return "";
  const magnitude = Math.abs(shift.ratio);
  if (magnitude < 0.08) return "；实测画面几乎没有位移（可能已到边界）";
  const expected = direction === "up" ? -1 : 1;
  const reversed = Math.sign(shift.ratio) !== expected;
  return `；实测位移约 ${Math.round(magnitude * 100)}% 屏${reversed ? "（方向与请求相反）" : ""}`;
}

function toGray(image, width, height) {
  const out = new Uint8Array(width * height);
  const stepX = image.width / width;
  const stepY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * stepY));
    const rowOffset = sourceY * image.width;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * stepX));
      const offset = (rowOffset + sourceX) * 4;
      const blue = image.bgra[offset];
      const green = image.bgra[offset + 1];
      const red = image.bgra[offset + 2];
      out[y * width + x] = (red * 38 + green * 75 + blue * 15) >> 7;
    }
  }
  return out;
}

function meanAbsoluteDifference(before, after, width, height, dy) {
  const startY = Math.max(0, -dy);
  const endY = Math.min(height, height - dy);
  const rows = endY - startY;
  if (rows < Math.max(4, Math.round(height * MIN_OVERLAP))) return null;
  let sum = 0;
  for (let y = startY; y < endY; y += 1) {
    const rowBefore = y * width;
    const rowAfter = (y + dy) * width;
    for (let x = 0; x < width; x += 1) {
      const delta = before[rowBefore + x] - after[rowAfter + x];
      sum += delta < 0 ? -delta : delta;
    }
  }
  return sum / (rows * width);
}

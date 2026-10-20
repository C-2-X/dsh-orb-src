// Image downsampling for model input.
//
// The default is now the original capture size (maxEdge 0) because downscaling
// makes small icons harder to locate. Downsampling remains available through
// agent.imageMaxEdge (1280/1568 trades accuracy for vision tokens); normalized
// 0-1000 coordinates are resolution independent, so it never changes a click
// mapping. Inline images above 10 MB are rejected by the API, so 4K captures may
// still need a cap.
//
// Zero new dependencies: PNG decode uses Node's zlib, re-encode reuses the
// backend's encodeBgraPng.
import { inflateSync } from "node:zlib";
import { o as encodeBgraPng } from "../dist/computer-use/backend-xLwiz83E.js";

const PNG_SIGNATURE = 0x89504e47;

/** Read width/height from the IHDR without inflating anything. */
export function readPngSize(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== PNG_SIGNATURE) throw new Error("dsh-orb: 不是 PNG 数据");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Decode a non-interlaced 8-bit PNG into BGRA bytes.
 * @returns {{ width: number, height: number, bgra: Buffer }}
 */
export function decodePng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== PNG_SIGNATURE) throw new Error("dsh-orb: 不是 PNG 数据");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
      sawHeader = true;
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = dataStart + length + 4;
  }
  if (!sawHeader || !sawEnd) throw new Error("dsh-orb: PNG 结构不完整");
  if (bitDepth !== 8) throw new Error(`dsh-orb: 只支持 8 位深度 PNG（收到 ${bitDepth}）`);
  if (interlace !== 0) throw new Error("dsh-orb: 不支持隔行 PNG");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`dsh-orb: 不支持的颜色类型 ${colorType}`);
  if (width <= 0 || height <= 0) throw new Error("dsh-orb: PNG 尺寸非法");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error("dsh-orb: PNG 像素数据不完整");
  const bgra = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const source = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = source[x];
      if (filter === 1) value = value + a;
      else if (filter === 2) value = value + b;
      else if (filter === 3) value = value + ((a + b) >> 1);
      else if (filter === 4) value = value + paethPredictor(a, b, c);
      else if (filter !== 0) throw new Error(`dsh-orb: 未知 PNG 过滤器 ${filter}`);
      current[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const p = (y * width + x) * 4;
      if (channels === 4) {
        bgra[p] = current[s + 2];
        bgra[p + 1] = current[s + 1];
        bgra[p + 2] = current[s];
        bgra[p + 3] = current[s + 3];
      } else if (channels === 3) {
        bgra[p] = current[s + 2];
        bgra[p + 1] = current[s + 1];
        bgra[p + 2] = current[s];
        bgra[p + 3] = 255;
      } else if (channels === 2) {
        bgra[p] = current[s];
        bgra[p + 1] = current[s];
        bgra[p + 2] = current[s];
        bgra[p + 3] = current[s + 1];
      } else {
        bgra[p] = current[s];
        bgra[p + 1] = current[s];
        bgra[p + 2] = current[s];
        bgra[p + 3] = 255;
      }
    }
    previous.set(current);
  }
  return { width, height, bgra };
}

/** Box-filter (area average) downscale of BGRA bytes; no-op when already small. */
export function downscaleBgra(bgra, width, height, maxEdge) {
  const longEdge = Math.max(width, height);
  if (!(longEdge > maxEdge)) return { width, height, bgra };
  const ratio = maxEdge / longEdge;
  const targetWidth = Math.max(1, Math.round(width * ratio));
  const targetHeight = Math.max(1, Math.round(height * ratio));
  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = Math.floor((ty * height) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = Math.floor((tx * width) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / targetWidth));
      let b = 0;
      let g = 0;
      let r = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        let s = (y * width + x0) * 4;
        for (let x = x0; x < x1; x += 1, s += 4) {
          b += bgra[s];
          g += bgra[s + 1];
          r += bgra[s + 2];
          a += bgra[s + 3];
          n += 1;
        }
      }
      const p = (ty * targetWidth + tx) * 4;
      out[p] = Math.round(b / n);
      out[p + 1] = Math.round(g / n);
      out[p + 2] = Math.round(r / n);
      out[p + 3] = Math.round(a / n);
    }
  }
  return { width: targetWidth, height: targetHeight, bgra: out };
}

/**
 * Crop a normalized region (0-1000, center + size) and upscale it by an integer
 * factor. Used by the `zoom` tool so small text or controls become readable
 * without another full-screen capture.
 * @param {Buffer} pngBuffer source PNG
 * @param {{x: number, y: number, width: number, height: number}} region normalized center and span
 * @param {number} [factor] 1-4 nearest-neighbor upscale
 * @returns {{png: Buffer, width: number, height: number, crop: object}}
 */
export function cropAndScalePng(pngBuffer, region, factor = 2) {
  const decoded = decodePng(pngBuffer);
  const scale = Math.min(4, Math.max(1, Math.floor(Number(factor) || 1)));
  const centerX = clampUnit(Number(region?.x ?? 500) / 1000);
  const centerY = clampUnit(Number(region?.y ?? 500) / 1000);
  const spanX = clampUnit(Number(region?.width ?? 300) / 1000);
  const spanY = clampUnit(Number(region?.height ?? 300) / 1000);
  const left = Math.max(0, Math.min(decoded.width - 1, Math.round((centerX - spanX / 2) * decoded.width)));
  const top = Math.max(0, Math.min(decoded.height - 1, Math.round((centerY - spanY / 2) * decoded.height)));
  const right = Math.max(left + 1, Math.min(decoded.width, Math.round((centerX + spanX / 2) * decoded.width)));
  const bottom = Math.max(top + 1, Math.min(decoded.height, Math.round((centerY + spanY / 2) * decoded.height)));
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  const outWidth = cropWidth * scale;
  const outHeight = cropHeight * scale;
  const out = Buffer.alloc(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    const sourceY = top + Math.min(cropHeight - 1, Math.floor(y / scale));
    const sourceRow = sourceY * decoded.width;
    for (let x = 0; x < outWidth; x += 1) {
      const sourceX = left + Math.min(cropWidth - 1, Math.floor(x / scale));
      const source = (sourceRow + sourceX) * 4;
      const target = (y * outWidth + x) * 4;
      out[target] = decoded.bgra[source];
      out[target + 1] = decoded.bgra[source + 1];
      out[target + 2] = decoded.bgra[source + 2];
      out[target + 3] = decoded.bgra[source + 3];
    }
  }
  return {
    png: encodeBgraPng(outWidth, outHeight, out, false),
    width: outWidth,
    height: outHeight,
    crop: { left, top, width: cropWidth, height: cropHeight }
  };
}

function clampUnit(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Average color of a normalized region, for the `check` tool.
 * @param {Buffer} pngBuffer source PNG
 * @param {{x: number, y: number, width: number, height: number}} region normalized center and span
 * @returns {{r: number, g: number, b: number, hex: string, samples: number}}
 */
export function sampleAverageColor(pngBuffer, region) {
  const decoded = decodePng(pngBuffer);
  const centerX = clampUnit(Number(region?.x ?? 500) / 1000) * decoded.width;
  const centerY = clampUnit(Number(region?.y ?? 500) / 1000) * decoded.height;
  const halfWidth = Math.max(1, (clampUnit(Number(region?.width ?? 20) / 1000) * decoded.width) / 2);
  const halfHeight = Math.max(1, (clampUnit(Number(region?.height ?? 20) / 1000) * decoded.height) / 2);
  const left = Math.max(0, Math.floor(centerX - halfWidth));
  const right = Math.min(decoded.width - 1, Math.ceil(centerX + halfWidth));
  const top = Math.max(0, Math.floor(centerY - halfHeight));
  const bottom = Math.min(decoded.height - 1, Math.ceil(centerY + halfHeight));
  const stepX = Math.max(1, Math.floor((right - left + 1) / 32));
  const stepY = Math.max(1, Math.floor((bottom - top + 1) / 32));
  let blue = 0;
  let green = 0;
  let red = 0;
  let samples = 0;
  for (let y = top; y <= bottom; y += stepY) {
    const row = y * decoded.width;
    for (let x = left; x <= right; x += stepX) {
      const offset = (row + x) * 4;
      blue += decoded.bgra[offset];
      green += decoded.bgra[offset + 1];
      red += decoded.bgra[offset + 2];
      samples += 1;
    }
  }
  if (samples === 0) return { r: 0, g: 0, b: 0, hex: "#000000", samples: 0 };
  const r = Math.round(red / samples);
  const g = Math.round(green / samples);
  const b = Math.round(blue / samples);
  return { r, g, b, hex: `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`, samples };
}

/**
 * Downscale a PNG so its long edge is at most maxEdge.
 * @param {Buffer} pngBuffer original PNG
 * @param {number} maxEdge long-edge cap; <= 0 disables scaling
 * @returns {{ png: Buffer, width: number, height: number, scaled: boolean, originalWidth: number, originalHeight: number }}
 */
export function scalePngForModel(pngBuffer, maxEdge) {
  const original = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer);
  const size = readPngSize(original);
  if (!(maxEdge > 0) || Math.max(size.width, size.height) <= maxEdge) {
    return { png: original, width: size.width, height: size.height, scaled: false, originalWidth: size.width, originalHeight: size.height };
  }
  const decoded = decodePng(original);
  const scaled = downscaleBgra(decoded.bgra, decoded.width, decoded.height, maxEdge);
  return {
    png: encodeBgraPng(scaled.width, scaled.height, scaled.bgra, false),
    width: scaled.width,
    height: scaled.height,
    scaled: true,
    originalWidth: decoded.width,
    originalHeight: decoded.height
  };
}

/** Target dimensions for a capture of the given size under maxEdge (no decoding). */
export function targetSizeFor(width, height, maxEdge) {
  if (!(maxEdge > 0) || Math.max(width, height) <= maxEdge) return { width, height, scaled: false };
  const ratio = maxEdge / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true
  };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

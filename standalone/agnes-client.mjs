import { abortableDelay, stoppedError, throwIfAborted } from "./abort.mjs";
import { scalePngForModel } from "./image-scale.mjs";

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;

/**
 * Call the Chat Completions endpoint.
 * @param {object} config
 * @param {Array} messages
 * @param {Array} tools
 * @param {{ signal?: AbortSignal }} [options] external cancel signal, merged with the request timeout
 */
export async function createChatCompletion(config, messages, tools, options = {}) {
  const apiKey = config.agnes.apiKey.trim();
  if (apiKey === "") throw new Error("Agnes API Key 为空，请先在 standalone.config.json 或页面配置中填写。");
  const signal = options.signal;
  throwIfAborted(signal);
  const url = chatCompletionsUrl(config.agnes.baseURL);
  const body = {
    model: config.agnes.model,
    messages,
    tools,
    tool_choice: "auto",
    max_tokens: config.agnes.maxTokens,
    temperature: config.agnes.temperature,
    stream: false
  };
  // agnes-3.0/2.5 support thinking through chat_template_kwargs. The explicit
  // value in chatTemplateKwargs wins, so a user can still turn it off per model.
  const templateKwargs = { ...(config.agnes.chatTemplateKwargs ?? {}) };
  if (config.agnes.thinking === true && templateKwargs.enable_thinking === undefined) {
    templateKwargs.enable_thinking = true;
  }
  if (hasKeys(templateKwargs)) body.chat_template_kwargs = templateKwargs;
  // "none" lets runTask force a wrap-up summary when the turn budget is gone.
  if (typeof options.toolChoice === "string" && options.toolChoice !== "") body.tool_choice = options.toolChoice;
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: requestSignal
      });
    } catch (error) {
      if (signal?.aborted) throw stoppedError();
      lastError = new Error(`Agnes 网络请求失败：${describe(error)}`);
      if (attempt >= MAX_ATTEMPTS) throw lastError;
      await abortableDelay(backoffMs(attempt), signal);
      continue;
    }
    const payload = await readJsonSafe(response);
    if (!response.ok) {
      if (signal?.aborted) throw stoppedError();
      const message = (extractErrorMessage(payload) ?? `Agnes 请求失败: HTTP ${response.status}`)
        + inlineImageHint(config.agnes.model, messages, response.status);
      lastError = new Error(message);
      if (!isRetryableStatus(response.status) || attempt >= MAX_ATTEMPTS) throw lastError;
      await abortableDelay(backoffMs(attempt), signal);
      continue;
    }
    const choice = payload?.choices?.[0];
    if (!choice?.message) throw new Error("Agnes 响应缺少 choices[0].message。");
    return {
      id: typeof payload.id === "string" ? payload.id : "",
      message: choice.message,
      finishReason: choice.finish_reason ?? "",
      usage: payload.usage ?? null,
      raw: payload
    };
  }
  throw lastError ?? new Error("Agnes 请求失败。");
}

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
/** Long-edge cap for inline screenshots; 0 uploads the original size. */
export const DEFAULT_IMAGE_MAX_EDGE = 0;

/**
 * Build the inline image block for a model message.
 * @param {{ data: Buffer|Uint8Array, mediaType?: string }} image capture
 * @param {{ maxEdge?: number }} [options] long-edge cap; <= 0 disables downsampling
 */
export function createImageBlock(image, options = {}) {
  if (!image || image.data === undefined || image.data === null) {
    throw new Error("截图数据为空，无法构造图像输入。");
  }
  const original = Buffer.from(image.data);
  if (original.length === 0) throw new Error("截图数据为空，无法构造图像输入。");
  if (original.length > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(
      `截图约 ${(original.length / 1024 / 1024).toFixed(1)} MB，超过 10 MB 内联上限；` +
      "请把 agent.imageInputFormat 改为 \"url\" 并用 agent.publicBaseUrl 提供公网截图地址。"
    );
  }
  const mediaType = normalizeImageMediaType(image.mediaType, original);
  let bytes = original;
  const maxEdge = typeof options.maxEdge === "number" ? options.maxEdge : DEFAULT_IMAGE_MAX_EDGE;
  if (maxEdge > 0) {
    try {
      bytes = scalePngForModel(original, maxEdge).png;
    } catch {
      bytes = original; // a format we cannot decode goes out untouched
    }
  }
  return {
    type: "image_url",
    image_url: {
      url: `data:${mediaType};base64,${bytes.toString("base64")}`
    }
  };
}

/**
 * agnes-2.5-flash's docs only list public image URLs. When an inline data: URL
 * request fails with a client error, explain how to switch to URL mode instead
 * of leaving the user with a bare 400.
 * @param {string} model model id
 * @param {Array} messages chat messages
 * @param {number} status HTTP status
 * @returns {string} "" when the hint does not apply
 */
export function inlineImageHint(model, messages, status) {
  if (status !== 400 && status !== 415 && status !== 422) return "";
  if (!String(model ?? "").trim().toLowerCase().startsWith("agnes-2.5-flash")) return "";
  const hasInline = Array.isArray(messages) && messages.some((message) =>
    Array.isArray(message?.content) &&
    message.content.some((part) => part?.type === "image_url" && String(part.image_url?.url ?? "").startsWith("data:"))
  );
  return hasInline
    ? "；agnes-2.5-flash 官方文档只列了公开 URL 图片，内联 base64 可能不被接受：请把 agent.imageInputFormat 改为 \"url\" 并配置 agent.publicBaseUrl。"
    : "";
}

export function imageExtension(mediaType) {
  const value = typeof mediaType === "string" ? mediaType.trim().toLowerCase() : "";
  if (value === "image/jpeg" || value === "image/jpg") return ".jpg";
  if (value === "image/webp") return ".webp";
  if (value === "image/gif") return ".gif";
  return ".png";
}

function normalizeImageMediaType(declared, bytes) {
  const detected = detectImageMediaType(bytes);
  if (detected !== "") return detected;
  const value = typeof declared === "string" ? declared.trim().toLowerCase() : "";
  if (value === "image/jpg") return "image/jpeg";
  if (/^image\/(png|jpeg|webp|gif)$/.test(value)) return value;
  throw new Error("无法识别截图格式，只支持 PNG/JPEG/WebP/GIF。");
}

function detectImageMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function chatCompletionsUrl(baseURL) {
  const base = String(baseURL ?? "").trim().replace(/\/+$/, "");
  if (base === "") throw new Error("Agnes Base URL 为空。");
  const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    throw new Error(`Agnes Base URL 不是合法的 http/https 地址：${base}`);
  }
  return url;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function extractErrorMessage(payload) {
  if (typeof payload?.error === "string" && payload.error !== "") return payload.error;
  if (typeof payload?.message === "string" && payload.message !== "") return payload.message;
  if (typeof payload?.error?.message === "string" && payload.error.message !== "") return payload.error.message;
  return null;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function backoffMs(attempt) {
  return Math.min(8000, 500 * 2 ** (attempt - 1));
}

function describe(error) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "请求超时";
    return error.message;
  }
  return String(error);
}

function hasKeys(value) {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

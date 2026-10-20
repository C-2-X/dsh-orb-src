// Minimal Chrome DevTools Protocol client for browser tasks.
//
// The desktop agent clicks pixels; for web pages that is fragile. CDP lets it
// navigate, read text, and click elements by selector, which is both faster and
// more accurate. It is opt-in (agent.browserBackend: "cdp") because it requires
// Chrome/Edge started with --remote-debugging-port and only controls that
// browser profile.
//
// Security: loopback hosts only. No arbitrary JS eval tool is exposed; every
// operation goes through a fixed method below.
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TEXT = 8000;

/** Loopback-only CDP host, or throw. */
export function normalizeCdpHost(host) {
  const value = String(host ?? "127.0.0.1").trim().toLowerCase();
  if (value === "127.0.0.1" || value === "localhost" || value === "::1") return value;
  throw new Error("CDP host 只允许本机（127.0.0.1 / localhost / ::1）。");
}

export function clampCdpPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("CDP 端口必须是 1-65535 的整数。");
  return value;
}

/** Page targets from http://host:port/json/list. */
export async function listBrowserTargets(config, options = {}) {
  const host = normalizeCdpHost(config.agent.cdpHost);
  const port = clampCdpPort(config.agent.cdpPort);
  const dialHost = host === "::1" ? "[::1]" : host;
  let response;
  try {
    response = await fetch(`http://${dialHost}:${port}/json/list`, { signal: options.signal });
  } catch (error) {
    throw new Error(`无法连接 Chrome 调试端口 ${host}:${port}：${error instanceof Error ? error.message : String(error)}。请用 --remote-debugging-port=${port} 启动 Chrome。`);
  }
  if (!response.ok) throw new Error(`Chrome 调试端口返回 HTTP ${response.status}。`);
  const targets = await response.json();
  return (Array.isArray(targets) ? targets : []).filter((target) =>
    target && target.type === "page" && typeof target.webSocketDebuggerUrl === "string"
  );
}

/** Pick one page target: by id, else the first non-devtools page. */
export function pickTarget(targets, targetId = "") {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) throw new Error("浏览器里没有可用的页面，请先打开一个标签页。");
  if (targetId !== "") {
    const found = list.find((target) => target.id === targetId);
    if (!found) throw new Error(`找不到页面 ${targetId}。`);
    return found;
  }
  return list.find((target) => !String(target.url ?? "").startsWith("devtools://")) ?? list[0];
}

/**
 * Open a CDP websocket to one target and run `task` with `{ send, target }`.
 * @param {object} config normalized config
 * @param {{ targetId?: string, signal?: AbortSignal }} options
 * @param {(context: {send: Function, target: object}) => Promise<any>} task
 */
export async function withCdp(config, options = {}, task) {
  const targets = await listBrowserTargets(config, options);
  const target = pickTarget(targets, options.targetId);
  if (typeof WebSocket !== "function") throw new Error("当前 Node 没有全局 WebSocket，无法使用 CDP。");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`CDP 错误：${message.error.message ?? "未知"}`));
    else entry.resolve(message.result ?? {});
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 Chrome 调试端口超时。")), DEFAULT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("无法连接 Chrome 调试端口，请确认 Chrome 已用 --remote-debugging-port 启动。"));
    }, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP ${method} 超时。`));
    }, DEFAULT_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    return await task({ send, target });
  } finally {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP 连接已关闭。"));
    }
    pending.clear();
    socket.close();
  }
}

/** Runtime.evaluate with a value result. */
export async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "未知错误";
    throw new Error(`页面脚本失败：${String(detail).slice(0, 300)}`);
  }
  return result.result?.value;
}

/** Navigate and give the page a moment to settle. */
export async function navigate(send, url) {
  await send("Page.enable");
  const result = await send("Page.navigate", { url });
  if (result.errorText) throw new Error(`导航失败：${result.errorText}`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  return result;
}

export async function readPageText(send) {
  const text = await evaluate(send, "document.body ? document.body.innerText : \"\"");
  return String(text ?? "").slice(0, MAX_TEXT);
}

export async function clickElement(send, selector) {
  const safe = JSON.stringify(String(selector));
  const ok = await evaluate(send, `
    (() => {
      const el = document.querySelector(${safe});
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    })()
  `);
  if (ok !== true) throw new Error(`找不到元素：${selector}`);
}

export async function typeIntoElement(send, selector, text) {
  const safeSelector = JSON.stringify(String(selector));
  const safeText = JSON.stringify(String(text));
  const ok = await evaluate(send, `
    (() => {
      const el = document.querySelector(${safeSelector});
      if (!el) return false;
      el.focus();
      el.value = ${safeText};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  if (ok !== true) throw new Error(`找不到元素：${selector}`);
}

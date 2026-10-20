import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir, unlink } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, sanitizeConfig, updateConfig, defaultConfigPath } from "./config.mjs";
import { observeDesktop, readCapture, toolDefinitionsFor } from "./agent.mjs";
import { createTaskRunner } from "./task-runner.mjs";
import { clearTaskRecords, countTaskRecords, rememberTask } from "./memory.mjs";
import { recordTaskTrace } from "./trace.mjs";
import { startOrbHost } from "./orb-host.mjs";
import { MODELS } from "./models.mjs";
import {
  capturePathsOf,
  clearSessionSnapshots,
  deleteSessionSnapshot,
  formatSessionContext,
  loadSessionSnapshots,
  readSessionSnapshot
} from "./session-store.mjs";

const appHtmlPath = fileURLToPath(new URL("./web/index.html", import.meta.url));
const appIconPath = fileURLToPath(new URL("../assets/orb.ico", import.meta.url));

export async function startStandaloneServer(options = {}) {
  const configPath = options.configPath ?? resolveConfigPath();
  const bootConfig = await loadConfig(configPath);
  const runner = createTaskRunner({
    configPath,
    onTaskDone: (entry) => rememberTask(configPath, entry),
    onTaskEnd: (entry) => recordTaskTrace(configPath, entry)
  });
  let orb = null;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const config = await loadConfig(configPath);
      if (req.method === "GET" && url.pathname === "/") {
        const html = await readFile(appHtmlPath, "utf8");
        send(res, 200, html, "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        const icon = await readFile(appIconPath);
        send(res, 200, icon, "image/x-icon");
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          platform: process.platform,
          running: runner.running,
          configPath,
          hasApiKey: config.agnes.apiKey.trim() !== "",
          orbEnabled: Boolean(orb?.enabled),
          lastError: runner.status.lastError
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, {
          ...runner.status,
          orb: orb?.status ?? null
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/tools") {
        sendJson(res, 200, { tools: toolDefinitionsFor(config) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/models") {
        sendJson(res, 200, { models: MODELS });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const snapshots = await loadSessionSnapshots(config.agent.sessionFile);
        snapshots.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
        sendJson(res, 200, {
          sessions: snapshots.map((snapshot) => ({
            sessionId: snapshot.sessionId,
            title: typeof snapshot.title === "string" && snapshot.title !== "" ? snapshot.title : "未命名对话",
            updatedAt: snapshot.updatedAt ?? "",
            captures: capturePathsOf(snapshot).length
          }))
        });
        return;
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        const result = await deleteSessionSnapshot(config.agent.sessionFile, id);
        const captures = await deleteCaptureFiles(config.agent.captureDir, result.capturePaths);
        sendJson(res, 200, { ok: true, deleted: result.deleted, captures });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/clear") {
        const result = await clearSessionSnapshots(config.agent.sessionFile);
        const captures = await clearCaptureDir(config.agent.captureDir);
        void orb?.refresh?.();
        sendJson(res, 200, { ok: true, sessions: result.count, captures });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const memoryCount = await countTaskRecords(config.agent.memoryFile);
        sendJson(res, 200, {
          configPath,
          memoryCount,
          config: sanitizeConfig(config)
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/config") {
        const patch = await readJsonBody(req);
        const clearMemory = patch?.clearMemory === true;
        const normalizedPatch = normalizeConfigPatch(patch);
        const next = await updateConfig(normalizedPatch, configPath);
        const memoryCleared = clearMemory ? await clearTaskRecords(next.agent.memoryFile) : null;
        void orb?.refresh?.();
        sendJson(res, 200, {
          ok: true,
          configPath,
          memoryCleared,
          config: sanitizeConfig(next)
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/observe") {
        const observation = await observeDesktop(config, { note: "手动观察请求。" });
        sendJson(res, 200, {
          ok: true,
          foreground: observation.foreground,
          capturePath: observation.capture?.filePath ?? null,
          captureUrl: observation.capture?.urlPath ?? null
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        if (runner.running) {
          sendJson(res, 409, { error: "当前已有任务在运行，请稍后再试。" });
          return;
        }
        const body = await readJsonBody(req);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (prompt === "") {
          sendJson(res, 400, { error: "prompt 不能为空。" });
          return;
        }
        try {
          const maxTurns = typeof body.maxTurns === "number" ? body.maxTurns : undefined;
          // Session-level resume: the caller passes the id of a stored session
          // and its text blocks are injected as background, not as new messages.
          const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
          let resumeContext = "";
          if (sessionId !== "") {
            const snapshot = await readSessionSnapshot(config.agent.sessionFile, sessionId).catch(() => null);
            if (snapshot) resumeContext = formatSessionContext(snapshot);
          }
          if (body.queue === true) {
            // Queued runs return immediately; the result lands in /api/status
            // (lastResult) and in the task events, not in this response.
            if (runner.status.queued >= 20) {
              sendJson(res, 429, { error: "队列已满（20 个任务），请稍后再试。" });
              return;
            }
            runner.run(prompt, { maxTurns, resumeContext, queue: true }).catch(() => {});
            sendJson(res, 202, { ok: true, queued: true, position: runner.status.queued });
            return;
          }
          const result = await runner.run(prompt, { maxTurns, resumeContext });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, error?.statusCode === 409 ? 409 : 500, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        const stopped = runner.abort();
        sendJson(res, 200, { ok: true, stopped });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/task/persistent") {
        if (runner.running) {
          sendJson(res, 409, { error: "当前已有任务在运行，请稍后再试。" });
          return;
        }
        const body = await readJsonBody(req);
        const goal = typeof body.goal === "string" ? body.goal.trim() : "";
        if (goal === "") {
          sendJson(res, 400, { error: "goal 不能为空。" });
          return;
        }
        try {
          const result = await runner.runPersistent(goal, {
            intervalMs: typeof body.intervalMs === "number" ? body.intervalMs : undefined,
            maxDurationMs: typeof body.maxDurationMs === "number" ? body.maxDurationMs : undefined
          });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, error?.statusCode === 409 ? 409 : 500, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/captures/")) {
        const fileName = decodeURIComponent(url.pathname.slice("/captures/".length));
        const capture = await readCapture(config, fileName);
        send(res, 200, capture.data, mimeOf(fileName));
        return;
      }
      sendJson(res, 404, { error: "not-found" });
    } catch (error) {
      if (isEnoent(error)) {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { error: "请求体不是合法 JSON。" });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  const listenPort = options.port ?? bootConfig.server.port;
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(listenPort, bootConfig.server.host, () => resolveListen());
  });
  const address = server.address();
  const host = typeof address === "object" && address ? address.address : bootConfig.server.host;
  const port = typeof address === "object" && address ? address.port : listenPort;
  const serverUrl = `http://${host === "::" ? "127.0.0.1" : host}:${port}`;
  const autoOpenConsole = (options.openConsoleOnMissingKey ?? process.env.DSH_ORB_OPEN_CONSOLE_ON_MISSING_KEY === "1") &&
    process.env.DSH_ORB_NO_BROWSER !== "1" &&
    bootConfig.agnes.apiKey.trim() === "";
  if (autoOpenConsole) openBrowser(serverUrl);
  if (options.startOrb !== false && process.env.DSH_ORB_NO_HELPER !== "1") {
    try {
      orb = await startOrbHost({
        projectRoot: fileURLToPath(new URL("..", import.meta.url)),
        webPort: port,
        taskRunner: runner,
        getConfig: () => loadConfig(configPath),
        setModel: (model) => updateConfig({ agnes: { model } }, configPath),
        openSettings: () => openBrowser(`http://127.0.0.1:${port}/`),
        log: (line) => console.error(line)
      });
      if (!orb.enabled) console.error(`[orb] ${orb.reason}`);
    } catch (error) {
      console.error(`[orb] ${error instanceof Error ? error.message : String(error)}`);
      orb = null;
    }
  }
  server.once("close", () => {
    void orb?.close?.();
  });
  return {
    server,
    url: serverUrl,
    configPath,
    orb
  };
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function resolveConfigPath() {
  const cli = process.argv.find((value) => value.startsWith("--config="));
  if (cli) return cli.slice("--config=".length);
  if (typeof process.env.DSH_ORB_STANDALONE_CONFIG === "string" && process.env.DSH_ORB_STANDALONE_CONFIG !== "") {
    return process.env.DSH_ORB_STANDALONE_CONFIG;
  }
  return defaultConfigPath();
}

function normalizeConfigPatch(patch) {
  const next = typeof patch === "object" && patch !== null ? structuredClone(patch) : {};
  const clearApiKey = next.clearApiKey === true;
  delete next.clearApiKey;
  delete next.clearMemory;
  if (clearApiKey) {
    next.agnes = { ...(next.agnes ?? {}), apiKey: "" };
    return next;
  }
  if (typeof next?.agnes?.apiKey === "string" && next.agnes.apiKey.trim() === "") {
    delete next.agnes.apiKey;
  }
  return next;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.trim() === "") return {};
  return JSON.parse(body);
}

/** Delete only files inside the configured capture directory. */
async function deleteCaptureFiles(captureDir, paths) {
  if (typeof captureDir !== "string" || captureDir === "" || !Array.isArray(paths)) return 0;
  const root = resolve(captureDir);
  let deleted = 0;
  for (const path of paths) {
    const target = resolve(String(path));
    if (target === root || !target.startsWith(root + sep)) continue;
    try {
      await unlink(target);
      deleted += 1;
    } catch {}
  }
  return deleted;
}

/** Remove every regular file in the capture directory; subdirectories are left alone. */
async function clearCaptureDir(captureDir) {
  if (typeof captureDir !== "string" || captureDir === "") return 0;
  const root = resolve(captureDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      await unlink(join(root, entry.name));
      deleted += 1;
    } catch {}
  }
  return deleted;
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

function send(res, status, body, contentType) {
  const data = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Cache-Control": "no-store"
  });
  res.end(data);
}

function isEnoent(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function mimeOf(fileName) {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

if (isMain()) {
  startStandaloneServer().then((started) => {
    const { url, configPath, orb } = started;
    console.log(`dsh-orb standalone 已启动: ${url}`);
    console.log(`配置文件: ${configPath}`);
    if (orb?.enabled) {
      console.log(`悬浮球: 已启动（Electron pid ${orb.status.pid ?? "?"}）`);
      console.log("右键悬浮球 → 设置，可打开 API Key 配置页。");
    } else if (orb) {
      console.log(`悬浮球: 未启动（${orb.reason}）`);
    }
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      try {
        await orb?.close?.();
      } finally {
        started.server.closeAllConnections?.();
        started.server.close();
        process.exit(0);
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isMain() {
  if (process.argv[1] === undefined) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
}

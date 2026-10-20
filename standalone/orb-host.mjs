// Standalone host adapter for the dsh-orb floating window.
//
// The source floating ball is an Electron process (dist/helper/lib/main.js).
// It expects an NDJSON host socket. This module owns that socket, launches the
// helper with the local Electron runtime, and bridges it to the standalone
// Agnes agent loop. The web console remains the settings/API-key editor.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSessionContext, listSessionSummaries, readSessionSnapshot, saveSessionSnapshot } from "./session-store.mjs";
import { catalogGroups } from "./models.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(moduleDir, "..");

export function findElectronRuntime(options = {}) {
  const root = options.projectRoot ?? defaultRoot;
  const candidates = [];
  if (typeof process.env.DSH_ORB_ELECTRON === "string" && process.env.DSH_ORB_ELECTRON !== "") {
    candidates.push(process.env.DSH_ORB_ELECTRON);
  }
  if (process.platform === "win32") {
    candidates.push(join(homedir(), ".dsh", "dsh-orb", "electron-runtime", "electron.exe"));
    if (typeof process.env.LOCALAPPDATA === "string" && process.env.LOCALAPPDATA !== "") {
      candidates.push(join(process.env.LOCALAPPDATA, "dsh-orb", "electron-runtime", "electron.exe"));
    }
    candidates.push(join(root, "electron-runtime", "electron.exe"));
  } else if (process.platform === "darwin") {
    candidates.push(join(homedir(), ".dsh", "dsh-orb", "electron-runtime", "Electron.app", "Contents", "MacOS", "Electron"));
    candidates.push(join(root, "electron-runtime", "Electron.app", "Contents", "MacOS", "Electron"));
  } else {
    candidates.push(join(homedir(), ".dsh", "dsh-orb", "electron-runtime", "electron"));
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Launch the real floating window and bridge it to the standalone agent.
 *
 * options:
 *   projectRoot   dsh-orb-src root (default: parent of standalone/)
 *   webPort       local web console port
 *   taskRunner    the shared task runner: run/abort/onEvent/running; drives the
 *                 ball's blocks, status text, and 中途停止 in real time
 *   getConfig     async () => config, used for the model catalog
 *   openSettings  () => void, opens the web console
 *   log           optional (line) => void
 *   electronPath  override, otherwise DSH_ORB_ELECTRON / local runtime
 */
export async function startOrbHost(options = {}) {
  const root = options.projectRoot ?? defaultRoot;
  const helperPath = options.helperPath ?? join(root, "dist", "helper", "lib", "main.js");
  const log = typeof options.log === "function" ? options.log : function (line) { console.error(line); };
  // spawnHelper:false opens the bridge without Electron. Offline self-test uses
  // it to exercise history/open/new against a fake ball socket.
  const headless = options.spawnHelper === false;
  if (!headless && !existsSync(helperPath)) {
    return { enabled: false, reason: "未找到源悬浮窗 dist/helper/lib/main.js。", helperPath: helperPath };
  }
  const electronPath = headless ? "" : (options.electronPath ?? findElectronRuntime({ projectRoot: root }));
  if (!headless && !electronPath) {
    return {
      enabled: false,
      reason: "未找到 Electron 运行时。请设置 DSH_ORB_ELECTRON 指向 electron.exe。",
      helperPath: helperPath
    };
  }

  const token = typeof options.token === "string" && options.token !== "" ? options.token : randomBytes(24).toString("hex");
  const taskRunner = options.taskRunner ?? null;
  const sockets = new Set();
  let client = null;
  let closing = false;
  let child = null;
  let spawnError = "";
  let serial = 0;
  let sessionId = newSessionId();
  // Blocks of the current session, kept so a finished task can be snapshotted
  // and replayed from the history panel. sessionDirty avoids rewriting an
  // unchanged snapshot just because the user opened it.
  let sessionBlocks = [];
  let sessionDirty = false;
  // Observation frame: the helper draws a glowing border around the observed
  // window. Bounds are inflated so the stroke stays outside the window bitmap.
  let frameEnabled = true;
  let frameSerial = 0;
  let model = "agnes-3.0-flash";

  const tcp = createServer(function (socket) {
    sockets.add(socket);
    let buffer = "";
    let authed = false;
    socket.setEncoding("utf8");
    socket.on("data", function (chunk) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        let record;
        try {
          record = JSON.parse(part);
        } catch {
          continue;
        }
        if (!authed) {
          if (record?.type !== "hello" || record?.token !== token) {
            socket.destroy();
            return;
          }
          authed = true;
          if (client && client !== socket) client.destroy();
          client = socket;
          void pushState();
          continue;
        }
        void handleMessage(record);
      }
    });
    socket.on("error", function () {});
    socket.on("close", function () {
      sockets.delete(socket);
      if (client === socket) client = null;
    });
  });

  try {
    await new Promise(function (resolveListen, reject) {
      tcp.once("error", reject);
      tcp.listen(0, "127.0.0.1", function () { resolveListen(); });
    });
  } catch (error) {
    return { enabled: false, reason: "无法启动悬浮窗通信端口：" + messageOf(error), helperPath: helperPath };
  }

  const address = tcp.address();
  const socketPort = typeof address === "object" && address ? address.port : 0;
  const env = {
    ...process.env,
    DSH_ORB_SOCKET: "127.0.0.1:" + socketPort,
    DSH_ORB_TOKEN: token,
    DSH_ORB_WEB_PORT: options.webPort === undefined ? "" : String(options.webPort)
  };
  // A host terminal may export ELECTRON_RUN_AS_NODE=1. Electron would then run
  // as plain Node and never create the ball window.
  delete env.ELECTRON_RUN_AS_NODE;

  if (!headless) {
    try {
      const args = [];
      const debugPort = options.debugPort ?? process.env.DSH_ORB_DEBUG_PORT;
      if (debugPort) args.push("--remote-debugging-port=" + debugPort);
      args.push(helperPath);
      child = spawn(electronPath, args, {
        cwd: root,
        env: env,
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", function (line) { log("[orb] " + String(line).trimEnd()); });
      child.stderr?.on("data", function (line) { log("[orb] " + String(line).trimEnd()); });
      child.on("error", function (error) {
        spawnError = messageOf(error);
        log("[orb] Electron 启动失败：" + spawnError);
      });
      child.on("exit", function (code, signal) {
        if (closing) return;
        log("[orb] 悬浮窗进程已退出（code=" + (code ?? "null") + ", signal=" + (signal ?? "null") + "）。");
      });
      await new Promise(function (resolveSpawn, rejectSpawn) {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
    } catch (error) {
      closing = true;
      for (const socket of sockets) socket.destroy();
      tcp.close();
      return { enabled: false, reason: "Electron 启动失败：" + messageOf(error), helperPath: helperPath, electronPath: electronPath };
    }
  }

  function send(message) {
    if (!client || client.destroyed) return;
    client.write(JSON.stringify(message) + "\n");
  }

  function sendStatus(text) {
    send({ type: "status", text: text });
  }

  /** Show the helper's observation frame, or hide it with null. */
  function sendFrame(bounds) {
    if (!frameEnabled) return;
    send({ type: "observation-frame", id: "frame-" + (++frameSerial), bounds: bounds ?? null });
  }

  function inflateBounds(bounds, by) {
    return {
      x: Math.round(bounds.x - by),
      y: Math.round(bounds.y - by),
      width: Math.max(1, Math.round(bounds.width + by * 2)),
      height: Math.max(1, Math.round(bounds.height + by * 2))
    };
  }

  /** Send one transcript block and keep it for the session snapshot. */
  function sendBlock(block) {
    sessionBlocks.push(block);
    if (sessionBlocks.length > 200) sessionBlocks.splice(0, sessionBlocks.length - 200);
    sessionDirty = true;
    send(block);
  }

  async function sessionFileOf() {
    const config = await safeConfig();
    const file = config?.agent?.sessionFile;
    return typeof file === "string" && file !== "" ? file : "";
  }

  /** History rows for the ball, newest first. */
  async function historyItems() {
    const config = await safeConfig();
    const file = config?.agent?.sessionFile;
    if (typeof file !== "string" || file === "") return [];
    const limit = Number.isInteger(config.agent.sessionHistoryLimit) ? config.agent.sessionHistoryLimit : 20;
    try {
      return await listSessionSummaries(file, limit);
    } catch {
      return [];
    }
  }

  /** Snapshot one session. Failures are non-fatal: history is best effort. */
  async function persistSession(id = sessionId, blocks = sessionBlocks) {
    if (blocks.length === 0 || !sessionDirty) return;
    const file = await sessionFileOf();
    if (file === "") return;
    try {
      await saveSessionSnapshot(file, { sessionId: id, blocks: blocks });
      sessionDirty = false;
    } catch {}
  }

  function catalogFor(currentModel) {
    return catalogGroups(currentModel);
  }

  async function pushState() {
    const config = await safeConfig();
    model = config?.agnes?.model || model;
    frameEnabled = config?.agent?.observationFrame !== false;
    const selection = { provider: "agnes", model: model };
    send({ type: "appearance", theme: "dark", locale: "zh" });
    send({
      type: "chrome",
      overlay: selection,
      background: selection,
      millifractionEnabled: true,
      // The source ball disables its settings entry unless a main window exists;
      // the standalone host opens the local console for both entries.
      openMain: true,
      update: null,
      catalog: catalogFor(model)
    });
    send({ type: "avatar", kind: "default" });
    send({ type: "session", sessionId: sessionId });
    send({ type: "history", items: await historyItems() });
    send({ type: "agents", items: [] });
    sendStatus("本机桌面模式 · Agnes");
  }

  async function safeConfig() {
    if (typeof options.getConfig !== "function") return null;
    try {
      return await options.getConfig();
    } catch {
      return null;
    }
  }

  async function handleMessage(record) {
    if (!record || typeof record !== "object") return;
    const type = record.type;
    if (type === "chrome-windows") return;
    if (type === "prompt") {
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (text === "") return;
      if (!taskRunner) {
        sendStatus("独立版没有配置任务执行器。");
        return;
      }
      const persistentGoal = matchPersistentGoal(text);
      if (persistentGoal !== null) {
        if (taskRunner.running) {
          sendStatus("任务运行中，暂时不能启动常驻任务，请先停止。");
          return;
        }
        if (persistentGoal === "") {
          sendStatus("请在“常驻：”后面描述监控目标，例如：常驻：监控微信并自动回复新消息。");
          return;
        }
        void taskRunner.runPersistent(persistentGoal).catch(function (error) {
          if (error?.statusCode === 409) sendStatus("上一任务仍在执行，请稍候。");
          else sendStatus("启动常驻任务失败：" + messageOf(error));
        });
        return;
      }
      // Same session: feed the previous turns back as text so "继续" does not
      // restart from zero. Images are not replayed; the model observes afresh.
      const sessionFile = await sessionFileOf();
      const snapshot = sessionFile === ""
        ? null
        : await readSessionSnapshot(sessionFile, sessionId).catch(function () { return null; });
      const resumeContext = snapshot ? formatSessionContext(snapshot) : "";
      if (taskRunner.running) {
        if (typeof taskRunner.run !== "function") {
          sendStatus("上一任务仍在执行，请稍候。");
          return;
        }
        void taskRunner.run(text, { queue: true, resumeContext })
          .then(function () {})
          .catch(function (error) { sendStatus("排队失败：" + messageOf(error)); });
        sendStatus("已加入队列（前面还有 " + (taskRunner.status?.queued ?? 1) + " 个任务）。");
        return;
      }
      void taskRunner.run(text, { resumeContext }).catch(function (error) {
        if (error?.statusCode === 409) sendStatus("上一任务仍在执行，请稍候。");
      });
      return;
    }
    if (type === "stop") {
      if (!taskRunner) {
        sendStatus("当前没有运行中的任务。");
        return;
      }
      const stopped = taskRunner.abort();
      sendStatus(stopped ? "正在停止当前任务…" : "当前没有运行中的任务。");
      return;
    }
    if (type === "new") {
      if (taskRunner?.running) {
        sendStatus("任务运行中，暂时不能新建对话。");
        return;
      }
      await persistSession();
      sessionId = newSessionId();
      sessionBlocks = [];
      sessionDirty = false;
      serial = 0;
      send({ type: "reset" });
      send({ type: "session", sessionId: sessionId });
      send({ type: "history", items: await historyItems() });
      sendStatus("新对话 · 本机桌面模式");
      return;
    }
    if (type === "history") {
      send({ type: "history", items: await historyItems() });
      return;
    }
    if (type === "open-settings" || type === "open-main") {
      if (typeof options.openSettings === "function") {
        try {
          options.openSettings();
          sendStatus("已打开设置页（API Key、模型与端口）。");
        } catch (error) {
          sendStatus("打开设置页失败：" + messageOf(error));
        }
      } else {
        sendStatus("设置页：http://127.0.0.1:" + (options.webPort ?? "") + "/");
      }
      return;
    }
    if (type === "set-overlay" || type === "set-background") {
      const nextModel = typeof record.selection?.model === "string" ? record.selection.model.trim() : "";
      if (nextModel !== "" && nextModel !== model) {
        if (typeof options.setModel === "function") {
          try {
            await options.setModel(nextModel);
            model = nextModel;
            sendStatus("已切换模型：" + nextModel);
            await pushState();
            return;
          } catch (error) {
            sendStatus("切换模型失败：" + messageOf(error));
          }
        } else {
          sendStatus("独立版未配置模型写入，模型切换请到设置页修改。");
        }
      }
      void pushState();
      return;
    }
    if (type === "disable") {
      sendStatus("独立版暂不支持从悬浮球停用；关闭控制台窗口即可退出。");
      return;
    }
    if (type === "update") {
      sendStatus("独立版不检查 dsh 插件更新。");
      return;
    }
    if (type === "permission") {
      if (typeof record.preset === "string") send({ type: "permission", preset: record.preset });
      return;
    }
    if (type === "open" || type === "agent-open") {
      const target = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
      if (target === "" || target === sessionId) {
        await pushState();
        return;
      }
      if (taskRunner?.running) {
        sendStatus("任务运行中，暂时不能切换对话。");
        return;
      }
      const file = await sessionFileOf();
      const snapshot = file === ""
        ? null
        : await readSessionSnapshot(file, target).catch(function () { return null; });
      if (!snapshot) {
        sendStatus("找不到这条历史对话。");
        return;
      }
      await persistSession();
      sessionId = snapshot.sessionId;
      sessionBlocks = Array.isArray(snapshot.blocks) ? snapshot.blocks.slice() : [];
      sessionDirty = false;
      serial = Math.max(serial, maxSerialOf(sessionBlocks));
      // Replay: reset first, then the stored blocks in order, then the session id.
      send({ type: "reset" });
      for (const block of sessionBlocks) send(block);
      send({ type: "session", sessionId: sessionId });
      send({ type: "history", items: await historyItems() });
      sendStatus("已打开历史对话 · " + (snapshot.title || "未命名对话"));
      return;
    }
    if (type === "agent-dismiss") {
      sendStatus("独立版没有待处理的后台任务卡片。");
      return;
    }
    if (type === "question-answer" || type === "question-cancel") return;
  }

  // Real-time translation of task-runner events into ball blocks. Tool blocks are
  // pushed the moment a tool finishes, not replayed after the whole task ends.
  function handleTaskEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "task-start") {
      sendFrame(null);
      sendBlock({ type: "block", key: "user-" + (++serial), kind: "user", text: event.prompt });
      send({ type: "turn", running: true });
      sendStatus("正在观察屏幕并规划步骤…");
      return;
    }
    if (event.type === "observation") {
      // Inflate by 10px so the 8px CSS stroke sits outside the window bitmap;
      // the capture is a BitBlt of the window rect and must stay frame-free.
      sendFrame(event.bounds ? inflateBounds(event.bounds, 10) : null);
      return;
    }
    if (event.type === "turn-start") {
      sendStatus("第 " + event.turn + " 轮 · 模型思考中…");
      return;
    }
    if (event.type === "tool-start") {
      sendStatus("正在执行：" + (event.name || "工具") + "…");
      return;
    }
    if (event.type === "tool-end") {
      sendBlock(toolBlockOf(event));
      return;
    }
    if (event.type === "done") {
      const result = event.result;
      const answer = typeof result?.answer === "string" && result.answer.trim() !== "" ? result.answer : "任务完成。";
      sendBlock({
        type: "block",
        key: "assistant-" + (++serial),
        kind: "assistant",
        text: answer,
        response: true,
        usage: result?.usage
      });
      if (result?.exhausted === true) {
        sendBlock({
          type: "block",
          key: "notice-" + (++serial),
          kind: "notice",
          text: "已达到轮数上限，任务未完全结束。上面是已完成的进度与后续建议。"
        });
        sendStatus("达到轮数上限 · " + (result?.turns ?? 0) + " 轮");
      } else {
        sendStatus("完成 · " + (result?.turns ?? 0) + " 轮");
      }
      void persistSession();
      sendFrame(null);
      send({ type: "turn", running: false });
      return;
    }
    if (event.type === "stopped") {
      sendBlock({ type: "block", key: "notice-" + (++serial), kind: "notice", text: "任务已停止。" });
      void persistSession();
      sendStatus("已停止");
      sendFrame(null);
      send({ type: "turn", running: false });
      return;
    }
    if (event.type === "error") {
      sendBlock({
        type: "block",
        key: "notice-" + (++serial),
        kind: "notice",
        text: "执行失败：" + (event.error || "未知错误")
      });
      void persistSession();
      sendStatus("执行失败");
      sendFrame(null);
      send({ type: "turn", running: false });
      return;
    }
  }

  function toolBlockOf(event) {
    const resultText = typeof event.result === "string"
      ? event.result
      : event.error ? `工具执行失败：${String(event.error)}` : JSON.stringify(event.result ?? "");
    return {
      type: "block",
      key: "tool-" + (++serial),
      kind: "tool",
      text: event.name || "tool",
      detail: {
        args: formatArgs(event.arguments),
        result: truncate(resultText, 24000),
        isError: Boolean(event.error),
        meta: "",
        ...typeof event.capturePath === "string" && event.capturePath !== "" ? { capturePath: event.capturePath } : {}
      }
    };
  }

  if (taskRunner) taskRunner.onEvent(handleTaskEvent);

  async function refresh() {
    if (closing) return;
    await pushState();
  }

  async function close() {
    if (closing) return;
    await persistSession();
    closing = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise(function (resolveClose) { tcp.close(function () { resolveClose(); }); });
    await killChild(child);
  }

  return {
    enabled: true,
    helperPath: helperPath,
    electronPath: electronPath,
    socketPort: socketPort,
    child: child,
    refresh: refresh,
    close: close,
    get status() {
      return {
        enabled: true,
        running: !closing && !spawnError && child?.exitCode === null,
        helperPath: helperPath,
        electronPath: electronPath,
        pid: child?.pid ?? null,
        socketPort: socketPort,
        busy: Boolean(taskRunner?.running)
      };
    }
  };
}

function newSessionId() {
  return "standalone-" + Date.now().toString(36);
}

/** Highest block-key suffix in a replayed session, so new keys never collide. */
function maxSerialOf(blocks) {
  let max = 0;
  for (const block of blocks) {
    const match = /-(\d+)$/.exec(String(block?.key ?? ""));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** "常驻：<目标>" starts a persistent watch task; anything else returns null. */
function matchPersistentGoal(text) {
  const match = /^常驻\s*[:：]\s*(.*)$/s.exec(text);
  if (!match) return null;
  return match[1].trim();
}

function formatArgs(args) {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function truncate(value, max) {
  return value.length <= max ? value : value.slice(0, max) + "…";
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function killChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32") {
    await new Promise(function (resolveKill) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.once("exit", function () { resolveKill(); });
      killer.once("error", function () { resolveKill(); });
    });
    return;
  }
  child.kill("SIGTERM");
  await new Promise(function (resolveKill) {
    const timer = setTimeout(function () {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveKill();
    }, 1500);
    child.once("exit", function () {
      clearTimeout(timer);
      resolveKill();
    });
  });
}

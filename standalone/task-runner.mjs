// Single owner of task lifecycle: the one `running` state, the AbortController
// behind 中途停止, and the event fan-out for real-time progress. HTTP, the orb
// bridge, and the CLI all face this module instead of guarding their own flags.
//
// Event stream (one sequence per task, in order):
//   task-start {prompt}
//   observation {turn, note, capturePath, captureUrl, foreground}
//   turn-start {turn}
//   tool-start {turn, name, arguments} / tool-end {turn, name, arguments, result, error}
//   done {result} | stopped | error {error}
//
// Terminal hooks: onTaskDone({prompt, result}) fires for successful tasks only
// (memory records there); onTaskEnd({kind, prompt, ok, stopped, guarded, turns,
// answer, error, durationMs}) fires for every ending (task traces land there).
import { loadConfig } from "./config.mjs";
import { runTask } from "./agent.mjs";
import { runPersistentTask } from "./persistent.mjs";

export function createTaskRunner(options = {}) {
  const runTaskFn = options.runTask ?? runTask;
  const runPersistentTaskFn = options.runPersistentTask ?? runPersistentTask;
  const configPath = options.configPath;
  const loadConfigFn = options.loadConfig ?? ((path) => loadConfig(path ?? configPath));
  const onTaskDone = typeof options.onTaskDone === "function" ? options.onTaskDone : null;
  const onTaskEnd = typeof options.onTaskEnd === "function" ? options.onTaskEnd : null;
  const listeners = new Set();
  const queue = [];
  const MAX_QUEUE = 20;
  let current = null;
  let lastResult = null;
  let lastError = "";
  let lastStopped = false;
  let lastProgress = null;

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  async function notifyDone(prompt, result) {
    if (!onTaskDone) return;
    try {
      await onTaskDone({ prompt, result });
    } catch (error) {
      console.error(`dsh-orb: 任务完成回调失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Shared terminal path: state, events, and the trace hook. */
  async function finishTask(kind, prompt, startedAt, outcome) {
    if (outcome.stopped) {
      lastResult = null;
      lastStopped = true;
      lastError = "任务已停止。";
      emit({ type: "stopped" });
    } else if (outcome.error !== undefined) {
      lastResult = null;
      lastStopped = false;
      lastError = outcome.error;
      emit({ type: "error", error: outcome.error });
    } else {
      lastResult = outcome.result;
      lastStopped = false;
      lastError = "";
      emit({ type: "done", result: outcome.result });
      await notifyDone(prompt, outcome.result);
    }
    if (onTaskEnd) {
      try {
        await onTaskEnd({
          kind,
          prompt,
          ok: outcome.result?.ok === true,
          stopped: Boolean(outcome.stopped),
          exhausted: outcome.result?.exhausted === true,
          guarded: outcome.result?.guarded ?? null,
          turns: outcome.result?.turns ?? 0,
          answer: outcome.result?.answer ?? "",
          error: outcome.error ?? "",
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        console.error(`dsh-orb: 任务轨迹回调失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function stoppedResult(prompt) {
    return {
      ok: false,
      stopped: true,
      prompt,
      turns: 0,
      answer: "",
      usage: null,
      transcript: [],
      finalObservation: null
    };
  }

  /**
   * Run one task. Rejects with a `statusCode: 409` error while another task is
   * running. A user-requested stop resolves with `{ ok: false, stopped: true }`
   * instead of throwing, so the caller that started the task can finish cleanly.
   * @param {string} prompt
   * @param {{ maxTurns?: number }} [runOptions]
   */
  async function run(prompt, runOptions = {}) {
    if (current) {
      if (runOptions.queue !== true) throw busyError();
      if (queue.length >= MAX_QUEUE) {
        const error = new Error(`队列已满（${MAX_QUEUE} 个任务），请稍后再试。`);
        error.statusCode = 429;
        throw error;
      }
      return new Promise((resolve, reject) => {
        queue.push({ prompt: String(prompt), options: { ...runOptions, queue: false }, resolve, reject });
        emit({ type: "queued", position: queue.length });
      });
    }
    const text = String(prompt);
    const startedAt = Date.now();
    const controller = new AbortController();
    current = { controller, prompt: text, startedAt, persistent: false };
    emit({ type: "task-start", prompt: text });
    try {
      const config = await loadConfigFn();
      const result = await runTaskFn(config, text, {
        maxTurns: typeof runOptions.maxTurns === "number" ? runOptions.maxTurns : undefined,
        resumeContext: typeof runOptions.resumeContext === "string" ? runOptions.resumeContext : "",
        signal: controller.signal,
        onEvent: emit
      });
      await finishTask("oneshot", text, startedAt, { result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        await finishTask("oneshot", text, startedAt, { stopped: true });
        return stoppedResult(text);
      }
      await finishTask("oneshot", text, startedAt, { error: message });
      throw error;
    } finally {
      current = null;
      drainQueue();
    }
  }

  /** Start the next queued task, if any. Called when the slot frees up. */
  function drainQueue() {
    if (current || queue.length === 0) return;
    const next = queue.shift();
    emit({ type: "queued", position: queue.length });
    run(next.prompt, next.options).then(next.resolve, next.reject);
  }

  /**
   * Run one persistent watch task (常驻任务). Same single-task slot as run():
   * a one-shot run or another persistent task gets a `statusCode: 409` error.
   * Guard trips (duration/action budget) resolve with `{ ok: false, guarded }`
   * and an explanatory answer rather than throwing.
   * @param {string} goal natural-language goal
   * @param {{ intervalMs?: number, maxDurationMs?: number }} [runOptions] per-task overrides
   */
  async function runPersistent(goal, runOptions = {}) {
    if (current) throw busyError();
    const text = String(goal).trim();
    if (text === "") throw emptyGoalError();
    const startedAt = Date.now();
    const controller = new AbortController();
    current = { controller, prompt: text, startedAt, persistent: true };
    lastProgress = null;
    emit({ type: "task-start", prompt: text });
    try {
      const config = await loadConfigFn();
      const result = await runPersistentTaskFn(config, text, {
        signal: controller.signal,
        onEvent: emit,
        intervalMs: typeof runOptions.intervalMs === "number" ? runOptions.intervalMs : undefined,
        maxDurationMs: typeof runOptions.maxDurationMs === "number" ? runOptions.maxDurationMs : undefined,
        onProgress: (progress) => { lastProgress = progress; }
      });
      await finishTask("persistent", text, startedAt, { result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        await finishTask("persistent", text, startedAt, { stopped: true });
        return stoppedResult(text);
      }
      await finishTask("persistent", text, startedAt, { error: message });
      throw error;
    } finally {
      current = null;
      lastProgress = null;
      drainQueue();
    }
  }

  /** Request a stop of the running task. Returns false when nothing is running. */
  function abort() {
    if (!current) return false;
    current.controller.abort();
    return true;
  }

  return {
    run,
    runPersistent,
    abort,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get running() {
      return current !== null;
    },
    get status() {
      return {
        running: current !== null,
        queued: queue.length,
        persistent: current?.persistent ?? false,
        prompt: current?.prompt ?? null,
        startedAt: current?.startedAt ?? null,
        progress: current?.persistent ? lastProgress : null,
        lastResult,
        lastError,
        lastStopped
      };
    }
  };
}

function busyError() {
  const error = new Error("当前已有任务在运行，请稍后再试。");
  error.statusCode = 409;
  return error;
}

function emptyGoalError() {
  const error = new Error("常驻任务目标不能为空。");
  error.statusCode = 400;
  return error;
}

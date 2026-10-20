// Abort plumbing shared by the agent loop, the model client, and the task runner.
// Node's timers/promises setTimeout does not accept a signal on every Node 22
// release this package supports, so the abort-aware sleep is implemented here.

export const STOPPED_MESSAGE = "任务已停止。";

/** Error type used for every user-requested stop. */
export function stoppedError(message = STOPPED_MESSAGE) {
  const error = new Error(message);
  error.stopped = true;
  return error;
}

/** True when the error represents a user-requested stop. */
export function isStoppedError(error) {
  return Boolean(error) && typeof error === "object" && error.stopped === true;
}

/** Throw a stopped error when the signal has already been aborted. */
export function throwIfAborted(signal, message) {
  if (signal?.aborted) throw stoppedError(message);
}

/**
 * Sleep for `ms`, resolving early is impossible but rejecting immediately when
 * `signal` aborts. Without a signal this is a plain delay.
 * @param {number} ms
 * @param {AbortSignal | null | undefined} signal
 */
export async function abortableDelay(ms, signal) {
  const wait = Number(ms);
  if (!Number.isFinite(wait) || wait <= 0) {
    throwIfAborted(signal);
    return;
  }
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    return;
  }
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, wait);
    function onAbort() {
      clearTimeout(timer);
      reject(stoppedError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

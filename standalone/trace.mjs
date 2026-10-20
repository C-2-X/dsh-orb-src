// Task trace: one JSONL line per finished task (any ending), for after-the-fact
// debugging and review. Unlike memory (which only keeps successful tasks and is
// injected back into the model), the trace keeps everything and is never sent
// to the model.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "./config.mjs";

/** Hard cap on stored trace lines; the oldest are trimmed on write. */
const MAX_TRACE_LINES = 200;

/**
 * Append one finished-task record.
 * @param {string} configPath config file path (resolves the trace file location)
 * @param {{ kind: string, prompt: string, ok: boolean, stopped: boolean,
 *           guarded: string|null, exhausted?: boolean, turns: number,
 *           answer: string, error: string, durationMs: number }} entry terminal outcome of a task
 */
export async function recordTaskTrace(configPath, entry = {}) {
  const config = await loadConfig(configPath);
  if (config.agent.traceEnabled !== true) return null;
  const file = config.agent.traceFile;
  if (typeof file !== "string" || file === "") return null;
  const record = {
    ts: new Date().toISOString(),
    kind: String(entry.kind ?? ""),
    prompt: truncate(String(entry.prompt ?? ""), 300),
    ok: entry.ok === true,
    stopped: entry.stopped === true,
    exhausted: entry.exhausted === true,
    guarded: entry.guarded ?? null,
    turns: typeof entry.turns === "number" ? entry.turns : 0,
    answer: truncate(String(entry.answer ?? ""), 400),
    error: truncate(String(entry.error ?? ""), 400),
    durationMs: typeof entry.durationMs === "number" ? entry.durationMs : 0
  };
  await mkdir(dirname(file), { recursive: true });
  let existing = [];
  try {
    existing = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = [...existing, JSON.stringify(record)].slice(-MAX_TRACE_LINES);
  await writeFile(file, `${next.join("\n")}\n`, "utf8");
  return record;
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

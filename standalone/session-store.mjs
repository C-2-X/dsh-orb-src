// Session history for the floating ball.
//
// The ball's history panel expects [{ sessionId, title }] rows and, after a
// row is clicked, replays that conversation as a stream of block messages.
// The task runner only emits live events, so orb-host keeps the blocks it sent
// per session and persists a snapshot here: one JSON line per session, newest
// line for the same session wins. Snapshots are bounded so the file cannot
// grow without limit.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** How many distinct sessions are kept; oldest snapshots fall off the front. */
const MAX_SESSIONS = 50;
/** Per-session block cap; the oldest blocks fall off the front. */
const MAX_BLOCKS_PER_SESSION = 200;
const MAX_TITLE_CHARS = 60;
const MAX_TEXT_CHARS = 4000;
const MAX_TOOL_ARGS_CHARS = 300;
const MAX_TOOL_RESULT_CHARS = 2000;

/**
 * Read every stored snapshot, oldest first. When a session appears more than
 * once the later line replaces the earlier one. Malformed lines are skipped.
 * @param {string} file sessions JSONL path
 * @returns {Promise<object[]>}
 */
export async function loadSessionSnapshots(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    if (typeof record.sessionId !== "string" || record.sessionId === "") continue;
    if (!Array.isArray(record.blocks)) continue;
    // Map keeps insertion order; a later line replaces the value in place,
    // then sorting by updatedAt below puts the newest session first.
    byId.set(record.sessionId, record);
  }
  return [...byId.values()];
}

/**
 * History rows for the ball, newest first.
 * @param {string} file sessions JSONL path
 * @param {number} [limit] max rows
 * @returns {Promise<Array<{sessionId: string, title: string}>>}
 */
export async function listSessionSummaries(file, limit = 20) {
  const snapshots = await loadSessionSnapshots(file);
  snapshots.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return snapshots.slice(0, Math.max(1, limit)).map((snapshot) => ({
    sessionId: snapshot.sessionId,
    title: typeof snapshot.title === "string" && snapshot.title !== "" ? snapshot.title : "未命名对话"
  }));
}

/**
 * One stored session, or null when it is not in the file.
 * @param {string} file sessions JSONL path
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
export async function readSessionSnapshot(file, sessionId) {
  const key = typeof sessionId === "string" ? sessionId.trim() : "";
  if (key === "") return null;
  const snapshots = await loadSessionSnapshots(file);
  return snapshots.find((snapshot) => snapshot.sessionId === key) ?? null;
}

/**
 * Persist (or replace) one session snapshot.
 * @param {string} file sessions JSONL path
 * @param {{ sessionId: string, title?: string, blocks: object[] }} snapshot
 * @returns {Promise<object|null>} the stored record, or null when there is nothing to store
 */
export async function saveSessionSnapshot(file, snapshot = {}) {
  const sessionId = typeof snapshot.sessionId === "string" ? snapshot.sessionId.trim() : "";
  if (sessionId === "") return null;
  const blocks = sanitizeBlocks(snapshot.blocks);
  if (blocks.length === 0) return null;
  const record = {
    sessionId,
    updatedAt: new Date().toISOString(),
    title: titleOf(snapshot.title, blocks),
    blocks
  };
  const existing = await loadSessionSnapshots(file);
  const next = existing.filter((item) => item.sessionId !== sessionId);
  next.push(record);
  const trimmed = next.slice(-MAX_SESSIONS);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${trimmed.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return record;
}

/**
 * Delete one session snapshot.
 * @param {string} file sessions JSONL path
 * @param {string} sessionId
 * @returns {Promise<{deleted: boolean, capturePaths: string[]}>} paths the caller may remove
 */
export async function deleteSessionSnapshot(file, sessionId) {
  const key = typeof sessionId === "string" ? sessionId.trim() : "";
  if (key === "") return { deleted: false, capturePaths: [] };
  const snapshots = await loadSessionSnapshots(file);
  const target = snapshots.find((snapshot) => snapshot.sessionId === key);
  if (target === undefined) return { deleted: false, capturePaths: [] };
  const next = snapshots.filter((snapshot) => snapshot.sessionId !== key);
  const text = next.length === 0 ? "" : `${next.map((snapshot) => JSON.stringify(snapshot)).join("\n")}\n`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return { deleted: true, capturePaths: capturePathsOf(target) };
}

/**
 * Delete every session snapshot. Returns how many records were removed so the
 * caller can report it; the caller clears the capture directory separately.
 * @param {string} file sessions JSONL path
 * @returns {Promise<{count: number}>}
 */
export async function clearSessionSnapshots(file) {
  const snapshots = await loadSessionSnapshots(file);
  await rm(file, { force: true });
  return { count: snapshots.length };
}

/** Screenshot paths referenced by one stored session. */
export function capturePathsOf(snapshot) {
  const paths = [];
  for (const block of Array.isArray(snapshot?.blocks) ? snapshot.blocks : []) {
    const path = block?.detail?.capturePath;
    if (typeof path === "string" && path !== "") paths.push(path);
  }
  return paths;
}

/**
 * Turn a stored session into a compact text context for a follow-up task.
 * This is a session-level resume (what was done), not a token-level replay of
 * messages: images are gone, tool results are reduced to their names.
 * @param {object} snapshot stored session record
 * @param {number} [maxChars] output cap
 * @returns {string}
 */
export function formatSessionContext(snapshot, maxChars = 2000) {
  if (!snapshot || !Array.isArray(snapshot.blocks)) return "";
  const lines = [];
  for (const block of snapshot.blocks.slice(-40)) {
    const text = truncate(String(block?.text ?? "").trim(), block.kind === "tool" ? 100 : 300);
    if (block.kind === "user" && text !== "") lines.push(`用户：${text}`);
    else if (block.kind === "assistant" && text !== "") lines.push(`助手：${text}`);
    else if (block.kind === "tool" && text !== "") lines.push(`工具：${text}${block.detail?.isError === true ? "（失败）" : ""}`);
    else if (block.kind === "notice" && text !== "") lines.push(`提示：${text}`);
  }
  return truncate(lines.join("\n"), maxChars);
}

/** Keep only fields the ball's renderer understands, with bounded sizes. */
function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block) => block && block.type === "block" && typeof block.kind === "string")
    .slice(-MAX_BLOCKS_PER_SESSION)
    .map((block, index) => {
      const next = {
        type: "block",
        key: typeof block.key === "string" && block.key !== "" ? block.key : `block-${index}`,
        kind: block.kind,
        text: truncate(String(block.text ?? ""), MAX_TEXT_CHARS)
      };
      if (block.response === true) next.response = true;
      if (block.detail && typeof block.detail === "object") {
        next.detail = {
          args: truncate(String(block.detail.args ?? ""), MAX_TOOL_ARGS_CHARS),
          result: truncate(String(block.detail.result ?? ""), MAX_TOOL_RESULT_CHARS),
          isError: block.detail.isError === true,
          meta: ""
        };
        if (typeof block.detail.capturePath === "string" && block.detail.capturePath !== "") {
          next.detail.capturePath = truncate(block.detail.capturePath, 500);
        }
      }
      return next;
    });
}

function titleOf(title, blocks) {
  const explicit = typeof title === "string" ? title.trim() : "";
  if (explicit !== "") return truncate(explicit, MAX_TITLE_CHARS);
  const firstUser = blocks.find((block) => block.kind === "user" && block.text.trim() !== "");
  return firstUser ? truncate(firstUser.text.trim(), MAX_TITLE_CHARS) : "未命名对话";
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

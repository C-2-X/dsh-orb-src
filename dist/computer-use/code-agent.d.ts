import { Context } from "@deepseek-ai/cordis";
//#region src/code-agent.d.ts
/** Cordis plugin name. */
declare const name = "tool-code-agent";
/** Services required at apply time. Missing Session Remote keeps the plugin pending. */
declare const inject: string[];
/** Model-visible tool that creates or continues a background Code session. */
declare const TOOL_NAME = "code_agent";
/** Model-visible tool that lists this Computer Use caller's Code sessions. */
declare const STATUS_TOOL_NAME = "code_agent_status";
/** Model-visible tool that stops one of this Computer Use caller's Code sessions. */
declare const STOP_TOOL_NAME = "code_agent_stop";
/**
 * Role text appended to every queued `code_agent` task.
 * The completion notice keeps the model task only.
 */
declare const BACKGROUND_ROLE: string;
/**
 * User message queued on the standard session.
 * @param task - trimmed model task. The completion notice quotes this text, not the role.
 * @returns the task plus {@link BACKGROUND_ROLE}.
 */
declare function queuedTaskText(task: string): string;
/**
 * Directory name derived from the user task.
 * @param task - non-empty trimmed task text.
 * @returns a filesystem-safe slug, or `task` when nothing remains.
 */
declare function slugFromTask(task: string): string;
/**
 * Unique child directory under `parent`.
 * @param parent - Computer Use session cwd.
 * @param slug - {@link slugFromTask} result.
 * @returns `join(parent, slug)` or a numeric suffix when that path exists.
 */
declare function uniqueDirectory(parent: string, slug: string): string;
/**
 * Register `code_agent`, `code_agent_status`, and `code_agent_stop` on the
 * calling Computer Use tool layer.
 * @param ctx - registration scope; `inject` must already be satisfied.
 */
declare function apply(ctx: Context): void;
//#endregion
export { BACKGROUND_ROLE, STATUS_TOOL_NAME, STOP_TOOL_NAME, TOOL_NAME, apply, inject, name, queuedTaskText, slugFromTask, uniqueDirectory };
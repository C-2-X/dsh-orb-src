//#region src/screen-owner.ts
/**
* Which Computer Use session currently owns the desktop.
*
* The ball panel shows exactly one conversation at a time, but every ball conversation stays a live
* agent: a `code_agent` completion notice wakes its caller even while the user watches another chat.
* Only the conversation the panel currently shows may touch the screen — the rest stay on the
* non-GUI tools (search, questions, further background work) so a session nobody is looking at can
* never move the mouse.
*
* The owner is published by the orb host, which is the only component that knows which session the
* panel displays. State lives on `globalThis` under a `Symbol.for` key, so the host plugin and the
* preset's tool layer — separate packages composed into one process — share one record, mirroring
* the process-global screen mutex in `gui-lock.ts`.
*
* An absent owner means unrestricted: `dsh web`, the CLI, and a ball that is switched off keep the
* full tool surface.
* @module @dsh-orb/computer-use/src/screen-owner
*/
const SCREEN_OWNER = Symbol.for("dsh-orb.screen-owner");
/**
* Agent preset of a floating ball conversation. The overlay in `cordis.patch.yml` registers it and
* the orb host creates every ball session with it, so it is what separates a ball conversation from
* the main window's chats and from the standard-preset Code sessions the ball delegates to.
*/
const BALL_PRESET = "computer-use";
/**
* Tools that operate the shared desktop: GUI input, screen capture, app activation, the clipboard,
* and the shell. Read-only environment inspection is deliberately absent — listing a directory or
* reading a file changes nothing another session could collide with.
*/
const DESKTOP_TOOLS = /* @__PURE__ */ new Set([
	"click",
	"input_text",
	"scroll",
	"hotkey",
	"wait",
	"long_wait",
	"screenshot",
	"long_press",
	"drag",
	"open_in_browser",
	"open_in_finder",
	"list_apps",
	"open_app",
	"bash",
	"pwsh"
]);
/**
* Tool-visible failure text. The model reads this as an isError result, so it carries the rule and
* the way out instead of a bare denial.
*/
const NOT_SCREEN_OWNER_MESSAGE = "Only the conversation the floating ball currently shows may operate the desktop or run commands. This session is in the background, so this tool is unavailable. Do not retry it: report what you have as text, and continue with web_search, web_fetch, ask_user_question, or code_agent if you need them.";
/** The shared record; exported so tests can observe and reset it. */
function screenOwnerState() {
	const holder = globalThis;
	holder[SCREEN_OWNER] ??= { ownerId: "" };
	return holder[SCREEN_OWNER];
}
/** Publish the session the ball panel shows; an empty string leaves every session unrestricted. */
function setScreenOwner(sessionId) {
	screenOwnerState().ownerId = typeof sessionId === "string" ? sessionId : "";
}
/** The session that currently owns the desktop, or `undefined` when nothing is restricted. */
function screenOwnerId() {
	const { ownerId } = screenOwnerState();
	return ownerId === "" ? void 0 : ownerId;
}
/** Whether this tool name reaches the shared desktop or the shell. */
function isDesktopTool(name) {
	return DESKTOP_TOOLS.has(name);
}
/**
* Denial reason for one pending call, or `undefined` when it may run.
*
* The rule is narrow on purpose: **only the floating ball's own conversations are gated, and only
* the background ones.** A ball conversation the panel currently shows owns the desktop; every other
* ball conversation may only talk. Nothing else in the process is affected — the main window's own
* chats keep their tools, and so do the standard-preset Code sessions a ball conversation delegates
* to, which need the shell to do the work they were handed.
*
* Four states are deliberately permissive, and each one is a door that must not lock:
* - no owner at all (a host without a ball),
* - a call with no agent (internal dispatch),
* - a session that is not a ball conversation (the main window, a delegated Code session),
* - the owner's own calls.
* @param agentId - calling agent id, or undefined when the call carries no agent.
* @param toolName - tool name as registered.
* @param preset - the calling session's agent preset, or undefined when it cannot be read.
* @returns the model-facing denial, or undefined to leave the call allowed.
*/
function desktopToolDenial(agentId, toolName, preset) {
	const owner = screenOwnerId();
	if (owner === void 0) return void 0;
	if (agentId === void 0 || agentId === owner) return void 0;
	if (preset !== "computer-use") return void 0;
	if (!DESKTOP_TOOLS.has(toolName)) return void 0;
	return NOT_SCREEN_OWNER_MESSAGE;
}
/**
* Agent preset of a live agent, or undefined when it cannot be read.
*
* Undefined reads as "not a ball conversation" everywhere it is consumed, so an unreadable header
* widens access instead of closing it. Locking the wrong session out of the shell is far worse than
* leaving one ball conversation ungated.
* @param agent - calling agent from the execution, if the call carried one.
* @returns the preset name, or undefined.
*/
function presetOf(agent) {
	try {
		const preset = (agent?.session?.header)?.agentPreset;
		return typeof preset === "string" && preset !== "" ? preset : void 0;
	} catch {
		return;
	}
}
//#endregion
export { presetOf as a, setScreenOwner as c, isDesktopTool as i, NOT_SCREEN_OWNER_MESSAGE as n, screenOwnerId as o, desktopToolDenial as r, screenOwnerState as s, BALL_PRESET as t };

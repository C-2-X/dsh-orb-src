import { a as presetOf$1, r as desktopToolDenial } from "./screen-owner-D3XnT8Ff.js";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
const NO_ASSISTANT = "The Code agent session ended without a final assistant message.";
/**
* Appended when another Computer Use session holds a turn at delivery time. Without it the woken
* caller would resume GUI work — possibly on a chat the user abandoned — and fight the session the
* user is watching for the mouse and keyboard.
*/
const SCREEN_BUSY_SUFFIX = "Another Computer Use chat is operating the screen right now. Report this result as text only; do not perform any GUI actions unless the user asks again in this chat.";
/**
* Start a caller-owned watch that delivers one plugin notice after the Code
* session's next idle and the Computer Use caller is idle. Does not throw;
* missing context or a disposed caller drops the notice.
* @param watch - live caller, live Code agent, and the accepted prompt.
* @returns the abort controller for this interval, or undefined when the
*   watch could not be owned.
*/
function watchCodeAgentCompletion(watch) {
	const abort = new AbortController();
	try {
		watch.caller.ctx.effect(() => {
			return () => {
				abort.abort();
			};
		});
	} catch {
		return;
	}
	try {
		watch.agents.withoutInitiator(() => {
			runWatch(watch, abort.signal);
		});
	} catch {
		abort.abort();
		return;
	}
	return abort;
}
async function runWatch(watch, signal) {
	try {
		if (await raceAbort(signal, waitUntilIntervalStarts(watch.code, watch.requestId, signal)) === "aborted") return;
		if (await raceAbort(signal, watch.code.whenIdle()) === "aborted") return;
		const userStopped = lastTurnEndedUserAborted(watch.code);
		const outcome = lastAssistantText(watch.code) ?? NO_ASSISTANT;
		if (await raceAbort(signal, watch.caller.whenIdle()) === "aborted") return;
		if (watch.agents.get(watch.caller.id) !== watch.caller) return;
		watch.caller.followup(createUserMessage({
			content: [{
				type: "text",
				text: completionNoticeText(watch.sessionId, watch.task, outcome, anotherComputerUseRunning(watch), userStopped)
			}],
			source: {
				kind: "computer-use",
				form: "notice",
				summary: boundContextSummary(userStopped ? `Code agent ${watch.sessionId} stopped by the user` : `Code agent ${watch.sessionId} finished`)
			}
		}));
	} catch (error) {
		if (signal.aborted) return;
		try {
			watch.caller.ctx.logger.warn(`code_agent: completion watch failed: ${String(error)}`);
		} catch {}
	}
}
/**
* The Code interval has started once this request's prompt is no longer queued. A running
* status is not enough: a follow-up prompt can sit in the inbox while the previous stretch
* still runs, and watching for idle then would end in the gap before it starts.
*/
function intervalHasStarted(code, requestId) {
	return !holdsPrompt(code, requestId);
}
/** Whether the accepted prompt is still parked in the inbox (queued, not started or finished). */
function holdsPrompt(code, requestId) {
	return messageHasRpc(code.inbox.nextTurn, requestId) || messageHasRpc(code.inbox.nextStep, requestId);
}
function messageHasRpc(messages, requestId) {
	return messages.some((message) => message.source.kind === "user" && "rpcId" in message.source && message.source.rpcId === requestId);
}
async function waitUntilIntervalStarts(code, requestId, signal) {
	if (intervalHasStarted(code, requestId) || signal.aborted) return;
	await new Promise((resolve) => {
		let done = false;
		let disposeStatus = () => {};
		let disposeDisposed = () => {};
		const finish = () => {
			if (done) return;
			done = true;
			disposeStatus();
			disposeDisposed();
			signal.removeEventListener("abort", finish);
			resolve();
		};
		disposeStatus = code.ctx.on("agent/status", () => {
			if (intervalHasStarted(code, requestId)) finish();
		});
		disposeDisposed = code.ctx.on("agent/disposed", finish);
		signal.addEventListener("abort", finish, { once: true });
		if (intervalHasStarted(code, requestId) || signal.aborted) finish();
	});
}
async function raceAbort(signal, work) {
	if (signal.aborted) return "aborted";
	const abort = Promise.withResolvers();
	const onAbort = () => {
		abort.resolve("aborted");
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([work.then(() => "done"), abort.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
/** Newest non-empty assistant text of the session, or undefined when none exists. */
function lastAssistantText(code) {
	const messages = code.session.deriveMessages();
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
		if (text !== "") return text;
	}
}
/**
* Whether the session's last closed turn was aborted by a user cancellation.
* The main window's stop button cancels with cause 'user' and the durable
* turn/end record carries that cause; repair-synthesized closers flatten it,
* which reads as not-user.
*/
function lastTurnEndedUserAborted(agent) {
	try {
		const events = agent.session.snapshotEvents?.() ?? [];
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = asRecord(events[index]);
			if (event?.type !== "turn/end") continue;
			const reason = asRecord(event.data)?.reason;
			if (asRecord(reason)?.kind !== "aborted") return false;
			return asRecord(asRecord(reason)?.reason)?.kind === "user";
		}
		return false;
	} catch {
		return false;
	}
}
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
/**
* Whether a Computer Use session other than the caller currently holds a turn.
* The caller's own background Code sessions are standard-preset, so they never
* count; a registry without `list` (test fakes) reads as an empty screen.
*/
function anotherComputerUseRunning(watch) {
	return (watch.agents.list?.() ?? []).some((other) => other.id !== watch.caller.id && other.status === "running" && presetOf(other) === "computer-use");
}
/** Session preset of a live agent, tolerant of test fakes that carry no header. */
function presetOf(agent) {
	return agent.session?.header?.agentPreset;
}
function completionNoticeText(sessionId, task, outcome, screenBusy, userStopped) {
	const body = userStopped ? `The user stopped background Code agent session ${sessionId} from the main window:\n${task}\n\nLast output before it stopped:\n${outcome}` : `Background Code agent session ${sessionId} finished this task:\n${task}\n\n${outcome}`;
	return `${body.length <= 4e3 ? body : `${body.slice(0, 3999)}…`}${userStopped ? "\n\nDo not restart this task and do not call code_agent for it again unless the user asks." : ""}${screenBusy ? `\n\n${SCREEN_BUSY_SUFFIX}` : ""}`;
}
//#endregion
//#region src/code-agent-registry.ts
/** Cordis service name the orb host polls the bookmarks from. */
const CODE_AGENT_REGISTRY = "codeAgentRegistry";
/** Cordis plugin name for the app-level provider row in `cordis.patch.yml`. */
const name = "computer-use-code-agent-registry";
/**
* Read at mount time to install the desktop-ownership guard.
*
* This row must declare it: cordis refuses `ctx.tools` on a context that did not inject the
* service. A throw here takes the whole plugin down, and the damage is not local — the registry is
* never provided, the host's bookmark poll finds no registry and broadcasts nothing, and the strip
* beside the ball goes empty. Declaring it also lets the row mount before or after the tools
* runtime. `mountGuard` below keeps the next failure from being this expensive.
*/
const inject = ["tools"];
/** Cap on the outcome summary one bookmark carries; the full text lives in the session. */
const BOOKMARK_OUTCOME_MAX_CHARS = 200;
/**
* One registry per host process. `code_agent`'s apply may run again (plugin
* re-apply, tests); every caller records into the same instance so the host
* always reads the live set.
*/
let shared;
function sharedCodeAgentRegistry() {
	shared ??= createCodeAgentRegistry();
	return shared;
}
/**
* Publish the process-wide registry as an app-level service.
* Inserted at the top level of the patch (never inside a preset) so the orb
* host — also top level — can read it across the preset boundary.
*/
function apply(ctx) {
	ctx.provide(CODE_AGENT_REGISTRY, sharedCodeAgentRegistry());
	mountGuard(ctx);
}
/**
* Install the one desktop-ownership guard for the process.
*
* It sits at the app level on purpose: a guard registered through a preset's context would live in
* that preset's scope layer and decide nothing for a sibling preset, and one registered per agent
* would multiply with every open conversation. From here the same guard answers for every agent,
* reading the owner the host publishes in {@link setScreenOwner}.
*
* Failure is contained on purpose. Providing the registry is this plugin's first job, and that job
* feeds the bookmark strip: losing the guard costs an unguarded desktop, while losing the registry
* silently empties the strip. So a guard that cannot be installed is reported and skipped.
* @param ctx - app-level context; `inject` must already be satisfied for the guard to register.
*/
function mountGuard(ctx) {
	try {
		ctx.effect(() => ctx.tools.guard((execution) => desktopToolDenial(execution.agent?.id, execution.name, presetOf$1(execution.agent))));
	} catch (error) {
		console.error(`dsh-orb: the desktop-ownership guard did not install: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function createCodeAgentRegistry() {
	const records = /* @__PURE__ */ new Map();
	return {
		record(entry) {
			const previous = records.get(entry.sessionId);
			if (previous !== void 0) {
				detachRecord(previous);
				if (previous.watch !== void 0 && previous.watch !== entry.watch) previous.watch.abort();
			}
			const record = {
				sessionId: entry.sessionId,
				callerId: entry.callerId,
				task: entry.task,
				cwd: entry.cwd,
				requestId: entry.requestId,
				watch: entry.watch,
				agent: entry.agent,
				startedAt: Date.now(),
				endedAt: void 0,
				state: "running",
				outcome: void 0,
				detach: void 0
			};
			records.set(entry.sessionId, record);
			subscribe(record);
			evaluate(record);
		},
		dropCaller(callerId) {
			for (const [sessionId, record] of records) {
				if (record.callerId !== callerId) continue;
				detachRecord(record);
				records.delete(sessionId);
			}
		},
		markStopped(sessionId) {
			const record = records.get(sessionId);
			if (record !== void 0) stopRecord(record);
		},
		list() {
			const items = [];
			for (const record of records.values()) {
				evaluate(record);
				items.push({
					sessionId: record.sessionId,
					callerId: record.callerId,
					task: record.task,
					cwd: record.cwd,
					startedAt: record.startedAt,
					state: record.state,
					...record.endedAt === void 0 ? {} : { endedAt: record.endedAt },
					...record.outcome === void 0 ? {} : { outcome: record.outcome }
				});
			}
			return items;
		}
	};
}
/** Fold one live status into the record's state. Queued prompts are still running. */
function evaluate(record) {
	try {
		evaluateRecord(record);
	} catch (error) {
		console.error(`dsh-orb: bookmark ${record.sessionId} could not be refreshed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function evaluateRecord(record) {
	if (record.state === "stopped") return;
	if (record.watch?.signal.aborted === true) {
		stopRecord(record);
		return;
	}
	const agent = record.agent;
	if (agent === void 0) return;
	if (agent.status === "running") {
		record.state = "running";
		return;
	}
	if (holdsPrompt(agent, record.requestId)) return;
	completeRecord(record, agent);
}
function stopRecord(record) {
	record.state = "stopped";
	record.endedAt ??= Date.now();
	detachRecord(record);
}
function completeRecord(record, agent) {
	if (lastTurnEndedUserAborted(agent)) {
		stopRecord(record);
		return;
	}
	record.state = "completed";
	record.endedAt ??= Date.now();
	record.outcome = capOutcome(lastAssistantText(agent));
	detachRecord(record);
}
function detachRecord(record) {
	record.detach?.();
	record.detach = void 0;
}
function subscribe(record) {
	detachRecord(record);
	const agent = record.agent;
	if (agent === void 0) return;
	const disposers = [];
	try {
		const off = agent.ctx.on("agent/status", () => evaluate(record));
		if (typeof off === "function") disposers.push(off);
	} catch {}
	try {
		const off = agent.ctx.on("agent/disposed", () => {
			if (record.state === "stopped") return;
			record.state = "completed";
			record.endedAt ??= Date.now();
			try {
				record.outcome = capOutcome(lastAssistantText(agent));
			} catch {}
			detachRecord(record);
		});
		if (typeof off === "function") disposers.push(off);
	} catch {}
	record.detach = () => {
		for (const off of disposers.splice(0)) off();
	};
}
function capOutcome(text) {
	const trimmed = text?.trim();
	if (trimmed === void 0 || trimmed === "") return void 0;
	return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 199)}…`;
}
//#endregion
export { inject as a, watchCodeAgentCompletion as c, createCodeAgentRegistry as i, CODE_AGENT_REGISTRY as n, name as o, apply as r, sharedCodeAgentRegistry as s, BOOKMARK_OUTCOME_MAX_CHARS as t };

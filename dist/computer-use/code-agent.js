import { c as watchCodeAgentCompletion, s as sharedCodeAgentRegistry } from "./code-agent-registry-5tmIstVY.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
//#region src/code-agent-unattended.ts
/** Custom answer when a Code agent asks a free-text question. */
const UNATTENDED_CUSTOM_ANSWER = "Stop. Return the short result you already have. Do not expand the task.";
/**
* Pick answers so a background Code agent never waits for a human.
* @param questions - the live `ask_user_question` payload.
* @returns structured answers the tool execute path accepts.
*/
function autoAnswerQuestions(questions) {
	return { answers: questions.map((question) => {
		if (question.intent?.kind === "plan-review") return {
			id: question.id,
			selected: [question.intent.approve]
		};
		const options = question.options ?? [];
		const recommended = options.find((option) => option.label.includes("(Recommended)"));
		if (recommended !== void 0) return {
			id: question.id,
			selected: [recommended.label]
		};
		if (options[0] !== void 0) return {
			id: question.id,
			selected: question.multiSelect === true ? options.map((option) => option.label) : [options[0].label]
		};
		return {
			id: question.id,
			selected: [],
			custom: UNATTENDED_CUSTOM_ANSWER
		};
	}) };
}
/**
* Prepend unattended answerers on a live Code agent once.
* @param code - the delegated standard agent.
* @param attached - agents that already carry the listeners.
*/
function attachUnattendedCodeAgent(code, attached) {
	if (attached.has(code)) return;
	attached.add(code);
	try {
		code.ctx.effect(() => {
			const offApproval = code.ctx.on("approval/request", () => Promise.resolve("allowed-once"), { prepend: true });
			const offQuestions = code.ctx.on("user-questions/request", (request) => Promise.resolve(autoAnswerQuestions(request.questions)), { prepend: true });
			return () => {
				offApproval();
				offQuestions();
				attached.delete(code);
			};
		});
	} catch {
		attached.delete(code);
	}
}
//#endregion
//#region src/select-model.ts
/**
* Official `selectModel` always writes the chosen model as the global default.
* A later `saveSelection` is queued behind that write, so the previous default is restored.
* Those settings fields are volatile, so the write does not restart plugins.
*
* Calls are serialized across every copy of this module in the process, so the ball and `code_agent`
* cannot interleave their select and restore steps. A short window still remains: official
* `selectModel` has no session-only option, so another window that creates a session between the
* official write and the restore sees the chosen model once.
*/
const QUEUE = Symbol.for("dsh-orb.select-model.queue");
function enqueue(task) {
	const holder = globalThis;
	const run = (holder[QUEUE] ?? Promise.resolve()).then(task, task);
	holder[QUEUE] = run.catch(() => void 0);
	return run;
}
/** Apply a model to one session, then put the global default back if it changed. */
function selectModelKeepDefault(ctx, request) {
	return enqueue(() => selectAndRestore(ctx, request));
}
async function selectAndRestore(ctx, request) {
	const defaults = ctx.agentDefaultModel;
	const previous = defaults?.currentSelection();
	const chosen = {
		provider: request.provider,
		model: request.model,
		...request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }
	};
	await ctx.sessionController.selectModel({
		sessionId: request.sessionId,
		...chosen
	});
	if (defaults === void 0) {
		console.error("dsh-orb: agentDefaultModel is missing; a session model may replace the global default");
		return;
	}
	if (previous === void 0 || sameSelection(previous, chosen)) return;
	await defaults.saveSelection(previous);
	console.error("dsh-orb: restored the global default model after a session-only selection");
}
function sameSelection(left, right) {
	return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
//#endregion
//#region src/code-agent.ts
/**
* Computer Use-only tools that create, continue, list, and stop first-class
* standard Sessions for one stretch of file search or file production.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/code-agent
*/
/** Cordis plugin name. */
const name = "tool-code-agent";
/** Services required at apply time. Missing Session Remote keeps the plugin pending. */
const inject = [
	"tools",
	"sessionController",
	"agentDefaultModel"
];
/** Model-visible tool that creates or continues a background Code session. */
const TOOL_NAME = "code_agent";
/** Model-visible tool that lists this Computer Use caller's Code sessions. */
const STATUS_TOOL_NAME = "code_agent_status";
/** Model-visible tool that stops one of this Computer Use caller's Code sessions. */
const STOP_TOOL_NAME = "code_agent_stop";
const DESCRIPTION = "Delegate one stretch of file search or file production to a standard-mode Code agent that appears in the desktop sidebar like a user-created session. Do the stretch in this chat when it is visible GUI or when one search or one command will answer or feed the next click. A second search that you expect will hit the point stays here. Do not call this tool for visible GUI work such as opening WeChat or clicking a button in Pages — use the GUI tools instead. Do not call this tool for a short lookup such as today's weather or current headlines — use web_search or web_fetch in this chat. Call this tool when you are still digging through files, searches, or commands, or when the user asked for a file, document, spreadsheet, or site. The last step being a click does not keep the investigation here. Omit session_id to create a new blank standard session: write a Word document, make a gobang game, write an HTML research report, or any task that is not a follow-up to a previous code_agent result. Pass session_id with the id returned by an earlier code_agent result when continuing the same artifact, for example making that Word document's font green, or another stretch of the same investigation. Do not pass a previous id when the new work is unrelated. session_id must be a session this Computer Use agent started. task is the stretch to enqueue. The call returns after the standard session accepts the message; it does not wait for that session to finish. Tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need this result; otherwise end the turn. Do not call wait, long_wait, or bash sleep to poll that session. A plugin notice arrives later when that session is idle and this session is idle; then decide again: do remaining GUI, or call code_agent with that session_id for another stretch, and tell the user the short conclusion. Do not recite a long report. Pass cwd when the user named a path or said this folder and <frontmost_folder> is present. Omit cwd to create a new subdirectory under this session's workspace. session_id cannot target this Computer Use session, a subagent child, or a non-standard session.";
/**
* Role text appended to every queued `code_agent` task.
* The completion notice keeps the model task only.
*/
const BACKGROUND_ROLE = "You are the background worker for a Computer Use session. You do not see the screen and you do not talk to the user. If this task asks for a file, document, spreadsheet, or site, produce it, reply with its path, and stop. Otherwise search or run commands only until you can answer, including a second search when the first missed the point. Reply in a few sentences with the paths or results that matter, then stop. Do not write a report or create extra files.";
const RUNNING_RESULT = "Tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need this result; otherwise end the turn.";
/**
* User message queued on the standard session.
* @param task - trimmed model task. The completion notice quotes this text, not the role.
* @returns the task plus {@link BACKGROUND_ROLE}.
*/
function queuedTaskText(task) {
	return `${task}\n\n${BACKGROUND_ROLE}`;
}
const STATUS_DESCRIPTION = "List background Code agent sessions this Computer Use agent started. Returns the count plus each task name, working directory, and running or idle status. Does not include sessions from other Computer Use chats or the main window. Stopped and finished sessions stay listed as idle so they can be continued.";
const STOP_DESCRIPTION = "Stop a background Code agent this Computer Use agent started. Cancels the current turn and drops queued follow-ups. The session stays idle so a later code_agent call with the same session_id can continue. Does not delete files. session_id is required and must be a session this Computer Use agent started.";
function requireAgent(exec) {
	if (exec.agent === void 0) throw new Error("code_agent requires a calling Computer Use session");
	return exec.agent;
}
/**
* Directory name derived from the user task.
* @param task - non-empty trimmed task text.
* @returns a filesystem-safe slug, or `task` when nothing remains.
*/
function slugFromTask(task) {
	const slug = task.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
	return slug === "" ? "task" : slug;
}
/**
* Unique child directory under `parent`.
* @param parent - Computer Use session cwd.
* @param slug - {@link slugFromTask} result.
* @returns `join(parent, slug)` or a numeric suffix when that path exists.
*/
function uniqueDirectory(parent, slug) {
	const base = join(parent, slug);
	if (!existsSync(base)) return base;
	for (let index = 2; index < 1e3; index += 1) {
		const candidate = `${base}-${index}`;
		if (!existsSync(candidate)) return candidate;
	}
	return `${base}-${randomUUID().slice(0, 8)}`;
}
/**
* Resolve a Workspace id when `directory` is already registered.
* @param ctx - Host context; `workspaceRegistry` is optional.
* @param directory - session cwd or explicit `code_agent` cwd.
* @returns the branded Workspace id, or undefined when none matches.
*/
async function workspaceIdForDirectory(ctx, directory) {
	if (directory === void 0 || directory === "") return void 0;
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0 || typeof registry.resolveByPath !== "function") return void 0;
	try {
		const id = (await registry.resolveByPath(directory))?.id;
		return id === void 0 ? void 0 : brandString(id);
	} catch {
		return;
	}
}
/**
* Prefer `workspaceId` so the new session appears under that sidebar folder.
* @param ctx - Host context; `workspaceRegistry` is optional.
* @param directory - session cwd or explicit `code_agent` cwd.
* @returns create fields that `session.create` accepts together.
*/
async function locationForCreate(ctx, directory) {
	const workspaceId = await workspaceIdForDirectory(ctx, directory);
	if (workspaceId !== void 0) return { workspaceId };
	if (directory === void 0) return {};
	return { cwd: directory };
}
function ownedBySubagent(ctx, header) {
	const parentId = header.parentSession;
	if (parentId === void 0) return false;
	const agents = ctx.get("agents");
	if (agents === void 0) return false;
	const live = agents.get(header.id);
	const parent = agents.get(parentId);
	return live !== void 0 && parent !== void 0 && agents.isOwnedBy(live.id, parent);
}
function callerDelegations(byCaller, callerId) {
	const existing = byCaller.get(callerId);
	if (existing !== void 0) return existing;
	const created = /* @__PURE__ */ new Map();
	byCaller.set(callerId, created);
	return created;
}
function rememberCaller(liveCaller, callerId, byCaller, remembered, registry) {
	if (remembered.has(liveCaller)) return;
	remembered.add(liveCaller);
	try {
		liveCaller.ctx.effect(() => {
			return () => {
				byCaller.delete(callerId);
				registry.dropCaller(callerId);
				remembered.delete(liveCaller);
			};
		});
	} catch {
		remembered.delete(liveCaller);
		byCaller.delete(callerId);
	}
}
function recordDelegation(delegations, sessionId, task, cwd, watch) {
	const existing = delegations.get(sessionId);
	if (existing === void 0) {
		delegations.set(sessionId, {
			task,
			cwd,
			watches: watch === void 0 ? [] : [watch]
		});
		return;
	}
	for (const previous of existing.watches.splice(0)) previous.abort();
	existing.task = task;
	existing.cwd = cwd;
	if (watch !== void 0) existing.watches.push(watch);
}
/**
* Register `code_agent`, `code_agent_status`, and `code_agent_stop` on the
* calling Computer Use tool layer.
* @param ctx - registration scope; `inject` must already be satisfied.
*/
function apply(ctx) {
	const byCaller = /* @__PURE__ */ new Map();
	const rememberedCallers = /* @__PURE__ */ new WeakSet();
	const unattended = /* @__PURE__ */ new WeakSet();
	const registry = sharedCodeAgentRegistry();
	ctx.tools.register(defineTool({
		name: TOOL_NAME,
		description: DESCRIPTION,
		parameters: {
			task: {
				type: "string",
				required: true,
				description: "User message to enqueue on a standard session. Required."
			},
			session_id: {
				type: "string",
				description: "Existing standard session this Computer Use agent started. Omit to create a blank session. Required when following up on the same artifact; forbidden when starting unrelated work."
			},
			cwd: {
				type: "string",
				description: "Workspace directory for a newly created session. Pass a named path or <frontmost_folder>. Omit to create a new subdirectory under this Computer Use session's cwd."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					accepted: {
						type: "boolean",
						required: true
					},
					created: {
						type: "boolean",
						required: true
					},
					session_id: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.created ? `Started a new standard session ${value.session_id}. ${RUNNING_RESULT} Pass this session_id to continue the same artifact.` : `Queued on standard session ${value.session_id}. ${RUNNING_RESULT}`
			}]
		},
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: "generic",
			title: "Code agent",
			kind: "execute",
			rawInput: {
				task: args.task,
				...args.session_id === void 0 ? {} : { session_id: args.session_id },
				...args.cwd === void 0 ? {} : { cwd: args.cwd }
			}
		}),
		async execute(args, exec) {
			const caller = requireAgent(exec);
			const task = args.task.trim();
			if (task === "") throw new Error("code_agent task must include non-whitespace text");
			if (args.session_id !== void 0 && args.session_id.trim() === "") throw new Error("code_agent session_id must be omitted or a non-empty id");
			const delegations = callerDelegations(byCaller, caller.id);
			let sessionId;
			let created = false;
			let cwd;
			if (args.session_id === void 0) {
				const directory = args.cwd !== void 0 ? args.cwd : caller.session.header.cwd === void 0 ? void 0 : uniqueDirectory(caller.session.header.cwd, slugFromTask(task));
				const location = args.cwd === void 0 && directory !== void 0 ? { cwd: directory } : await locationForCreate(ctx, directory);
				sessionId = (await ctx.sessionController.create({
					agentPreset: "standard",
					...location
				})).sessionId;
				created = true;
				cwd = directory ?? caller.session.header.cwd ?? "";
				const pref = ctx.get("orbCodeAgentModel")?.currentSelection();
				if (pref !== void 0) await selectModelKeepDefault({
					sessionController: ctx.sessionController,
					agentDefaultModel: ctx.get("agentDefaultModel")
				}, {
					sessionId,
					provider: pref.provider,
					model: pref.model,
					...pref.reasoningEffort === void 0 ? {} : { reasoningEffort: pref.reasoningEffort }
				});
			} else {
				sessionId = brandString(args.session_id);
				if (sessionId === caller.id) throw new Error("code_agent cannot target this Computer Use session");
				const known = delegations.get(sessionId);
				if (known === void 0) throw new Error(`code_agent can continue only a session this Computer Use agent started, not "${sessionId}"`);
				const header = (await ctx.sessionController.inspect(sessionId)).meta;
				if (header.origin === "subagent" || ownedBySubagent(ctx, header)) throw new Error(`code_agent cannot continue subagent session "${sessionId}"`);
				if (header.agentPreset !== "standard") throw new Error(`code_agent can continue only a standard session, not "${header.agentPreset ?? "unknown"}"`);
				if (args.cwd !== void 0 && header.cwd !== void 0 && args.cwd !== header.cwd) throw new Error(`code_agent cwd "${args.cwd}" does not match session "${sessionId}" cwd "${header.cwd}"`);
				cwd = header.cwd ?? known.cwd;
			}
			const requestId = brandString(`code-agent-${randomUUID()}`);
			await ctx.sessionController.prompt({
				requestId,
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text: queuedTaskText(task)
				}]
			}, exec.signal);
			const agents = ctx.get("agents");
			const liveCaller = agents?.get(caller.id);
			const code = agents?.get(sessionId);
			if (liveCaller !== void 0) rememberCaller(liveCaller, caller.id, byCaller, rememberedCallers, registry);
			if (code !== void 0) attachUnattendedCodeAgent(code, unattended);
			let watch;
			if (agents !== void 0 && liveCaller !== void 0 && code !== void 0) watch = watchCodeAgentCompletion({
				caller: liveCaller,
				code,
				agents,
				task,
				sessionId,
				requestId
			});
			recordDelegation(delegations, sessionId, task, cwd, watch);
			registry.record({
				sessionId,
				callerId: caller.id,
				task,
				cwd,
				requestId,
				...watch === void 0 ? {} : { watch },
				...code === void 0 ? {} : { agent: code }
			});
			return {
				accepted: true,
				created,
				session_id: sessionId
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: STATUS_TOOL_NAME,
		description: STATUS_DESCRIPTION,
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: {
						type: "integer",
						required: true
					},
					tasks: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								session_id: {
									type: "string",
									required: true
								},
								task: {
									type: "string",
									required: true
								},
								cwd: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true
								}
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.count === 0 ? "No background Code agent sessions from this Computer Use chat." : value.tasks.map((entry) => `${entry.session_id}: ${entry.status} — ${entry.task} (${entry.cwd})`).join("\n")
			}]
		},
		isConcurrencySafe: () => true,
		presentCall: () => ({
			card: "generic",
			title: "Code agent status",
			kind: "read"
		}),
		async execute(_args, exec) {
			const caller = requireAgent(exec);
			const agents = ctx.get("agents");
			const tasks = [...byCaller.get(caller.id) ?? []].map(([sessionId, entry]) => ({
				session_id: sessionId,
				task: entry.task,
				cwd: entry.cwd,
				status: agents?.get(sessionId)?.status === "running" ? "running" : "idle"
			}));
			return {
				count: tasks.length,
				tasks
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: STOP_TOOL_NAME,
		description: STOP_DESCRIPTION,
		parameters: { session_id: {
			type: "string",
			required: true,
			description: "Background Code agent session this Computer Use agent started. Required."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					accepted: {
						type: "boolean",
						required: true
					},
					session_id: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Stopped background Code agent session ${value.session_id}. The session is idle. Pass this session_id to code_agent to continue the same artifact.`
			}]
		},
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: "generic",
			title: "Stop Code agent",
			kind: "execute",
			rawInput: { session_id: args.session_id }
		}),
		async execute(args, exec) {
			const caller = requireAgent(exec);
			const sessionIdText = args.session_id.trim();
			if (sessionIdText === "") throw new Error("code_agent_stop session_id must be a non-empty id");
			const sessionId = brandString(sessionIdText);
			const known = byCaller.get(caller.id)?.get(sessionId);
			if (known === void 0) throw new Error(`code_agent_stop can stop only a session this Computer Use agent started, not "${sessionId}"`);
			for (const watch of known.watches.splice(0)) watch.abort();
			registry.markStopped(sessionId);
			ctx.get("agents")?.get(sessionId)?.cancel({ kind: "user" });
			return {
				accepted: true,
				session_id: sessionId
			};
		}
	}));
}
//#endregion
export { BACKGROUND_ROLE, STATUS_TOOL_NAME, STOP_TOOL_NAME, TOOL_NAME, apply, inject, name, queuedTaskText, slugFromTask, uniqueDirectory };

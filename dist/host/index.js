import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { cpSync, createReadStream, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { accessibilityTrusted, promptAccessibility, selectionRuntimeAvailable, startSelectionMonitor } from "../native-selection/src/index.js";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createServer } from "node:net";
import { pipeline } from "node:stream/promises";
//#region src/native-images.ts
/**
* Native images (`.node`, `.dll`, `.exe`) and the in-app update on Windows.
*
* Under the desktop's Electron runtime (Node 24.18), deleting a link to a file
* some process has mapped as a loaded image fails, and so does removing the
* directory that holds it. The desktop runs pnpm on that runtime. pnpm replaces
* an installed package by staging the new copy beside it (hard links into the
* same store files) and deleting the old directory; while any process has
* koffi's addon loaded from inside the package, both deletions fail with
* `EPERM, Permission denied: \\?\…\dsh-orb_tmp_<pid>_<thread>\node_modules`
* and the live package is left with files missing.
*
* So the host loads koffi from a copy outside the package (real files, new
* inodes, one folder per koffi version), names it in {@link KOFFI_DIR_ENV} for
* every loader in the bundle, and probes the package before an update asks pnpm
* to replace it.
*/
/** The folder whose `node_modules` holds the koffi copy every loader in the bundle uses. */
const KOFFI_DIR_ENV = "DSH_ORB_KOFFI_DIR";
/** Written last into a copy, so a folder without it is a copy that never finished. */
const READY_MARKER = ".ready";
/** Leftover staging folders younger than this may belong to an install still running. */
const STALE_STAGE_MS = 6e5;
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
	".node",
	".dll",
	".exe"
]);
/**
* Load koffi from the copy named in {@link KOFFI_DIR_ENV}, or beside `from` when there is none.
* @param from - module URL the in-package fallback resolves from.
*/
function requireKoffi(from = import.meta.url) {
	const dir = process.env[KOFFI_DIR_ENV];
	if (dir !== void 0 && dir !== "") try {
		return createRequire(join(dir, "index.js"))("koffi");
	} catch (error) {
		console.error(`dsh-orb: koffi copy unusable, loading the packaged one: ${error instanceof Error ? error.message : String(error)}`);
	}
	return createRequire(from)("koffi");
}
/**
* The installed package's root folder: `dist/host/index.js` sits two levels below it.
* In the workspace this is `packages/`, which holds no `package.json`.
*/
function ownPackageRoot(url = import.meta.url) {
	return fileURLToPath(new URL("../../", url)).replace(/[\\/]+$/, "");
}
/**
* Copy the package's koffi (and its platform prebuilds) to `cacheRoot/koffi-<version>`.
* A finished copy is reused; a copy is only ever added, never rewritten, because an
* older one may itself be mapped by a process that has not exited yet.
* @returns the folder to name in {@link KOFFI_DIR_ENV}, or undefined when the package ships no koffi.
*/
function stageKoffi(packageRoot, cacheRoot) {
	const modules = join(packageRoot, "node_modules");
	const manifest = join(modules, "koffi", "package.json");
	if (!existsSync(manifest)) return void 0;
	const version = JSON.parse(readFileSync(manifest, "utf8")).version;
	if (typeof version !== "string" || !/^[\w.+-]+$/.test(version)) return void 0;
	const target = join(cacheRoot, `koffi-${version}`);
	if (existsSync(join(target, READY_MARKER))) return target;
	const partial = `${target}.partial-${process.pid}`;
	rmSync(partial, {
		recursive: true,
		force: true
	});
	for (const entry of ["koffi", "@koromix"]) {
		const from = join(modules, entry);
		if (existsSync(from)) cpSync(from, join(partial, "node_modules", entry), {
			recursive: true,
			dereference: true
		});
	}
	writeFileSync(join(partial, READY_MARKER), "");
	try {
		renameSync(partial, target);
	} catch (error) {
		rmSync(partial, {
			recursive: true,
			force: true
		});
		if (!existsSync(join(target, READY_MARKER))) throw error;
	}
	return target;
}
/**
* Native images inside the package that some process holds mapped, which would make
* pnpm's replace fail and leave the package half deleted. Each image is hard-linked into
* a scratch folder beside the package; a folder whose removal fails holds a mapped one.
* A scratch folder that cannot be removed is named like pnpm's own staging folders, so
* {@link removeStaleStages} clears it once the mapping process is gone.
* @returns the mapped images, relative to the package root; empty when nothing blocks a replace.
*/
function mappedImages(packageRoot) {
	const images = nativeImages(packageRoot);
	if (images.length === 0) return [];
	const scratch = join(dirname(packageRoot), `${basename(packageRoot)}_tmp_probe_${process.pid}`);
	const mapped = [];
	for (const [index, image] of images.entries()) {
		const dir = join(scratch, String(index));
		try {
			mkdirSync(dir, { recursive: true });
			linkSync(join(packageRoot, image), join(dir, "image"));
		} catch {
			rmSync(dir, {
				recursive: true,
				force: true
			});
			continue;
		}
		try {
			rmSync(dir, {
				recursive: true,
				force: true
			});
		} catch (error) {
			const code = error.code;
			if (code === "EPERM" || code === "EACCES" || code === "EBUSY") mapped.push(image);
		}
	}
	try {
		rmSync(scratch, {
			recursive: true,
			force: true
		});
	} catch {}
	return mapped;
}
/** Every `.node`, `.dll`, and `.exe` file in the package tree, relative to its root. */
function nativeImages(packageRoot) {
	const found = [];
	const walk = (relative) => {
		let entries;
		try {
			entries = readdirSync(join(packageRoot, relative));
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = relative === "" ? entry : join(relative, entry);
			let stat;
			try {
				stat = lstatSync(join(packageRoot, path));
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) walk(path);
			else if (IMAGE_EXTENSIONS.has(extension(entry))) found.push(path);
		}
	};
	walk("");
	return found;
}
function extension(name) {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot).toLowerCase();
}
/**
* Remove the `<name>_tmp_*` folders failed replaces left beside the package. They hold
* hard links into the store, which the process that mapped them kept alive. Young ones
* are left alone: they may belong to an install running right now.
*/
function removeStaleStages(packageRoot, now = Date.now()) {
	const parent = dirname(packageRoot);
	if (basename(parent) !== "node_modules") return;
	const prefix = `${basename(packageRoot)}_tmp_`;
	let entries;
	try {
		entries = readdirSync(parent);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const path = join(parent, entry);
		try {
			if (now - statSync(path).mtimeMs < STALE_STAGE_MS) continue;
			rmSync(path, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
//#endregion
//#region src/tcc.ts
/**
* Screen Recording and Accessibility status for the process that actually calls screencapture and osascript.
* The desktop host is the DeepSeek Harness executable. `dsh web` is the terminal's node process.
*/
const SETTINGS_URL = {
	screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
};
/** Remembers which panes were opened so a grant that needs a relaunch is visible. */
var TccMonitor = class {
	opened = /* @__PURE__ */ new Set();
	probe;
	probeFailed = false;
	status() {
		const appName = tccAppName();
		if (process.platform !== "darwin") return {
			applicable: false,
			appName,
			screen: "granted",
			accessibility: "granted"
		};
		const probe = this.loadProbe();
		return {
			applicable: true,
			appName,
			screen: this.right("screen", probe?.screen() ?? false),
			accessibility: this.right("accessibility", probe?.accessibility() ?? false)
		};
	}
	async open(right) {
		if (process.platform !== "darwin") return;
		this.opened.add(right);
		await openExternal(SETTINGS_URL[right]);
	}
	right(right, granted) {
		if (granted) return "granted";
		return this.opened.has(right) ? "needsRelaunch" : "missing";
	}
	loadProbe() {
		if (this.probe) return this.probe;
		if (this.probeFailed) return void 0;
		try {
			this.probe = loadMacProbe();
			return this.probe;
		} catch (error) {
			this.probeFailed = true;
			console.error(`dsh-orb: TCC probe unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}
};
function isDesktopHost() {
	if (typeof process.env.DSH_DESKTOP_NODE_EXECUTABLE === "string" && process.env.DSH_DESKTOP_NODE_EXECUTABLE !== "") return true;
	return process.execPath.includes("DeepSeek Harness");
}
function tccAppName() {
	if (isDesktopHost()) return "DeepSeek Harness";
	return `${process.env.LANG ?? ""}${process.env.LC_ALL ?? ""}`.toLowerCase().includes("zh") ? "终端" : "Terminal";
}
function isTccRight(value) {
	return value === "screen" || value === "accessibility";
}
function loadMacProbe() {
	const library = requireKoffi(import.meta.url).load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
	const screen = library.func("bool CGPreflightScreenCaptureAccess()");
	const accessibility = library.func("bool AXIsProcessTrusted()");
	return {
		screen: () => screen() === true,
		accessibility: () => accessibility() === true
	};
}
function openExternal(url) {
	const command = process.platform === "win32" ? "cmd" : "open";
	const args = process.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url];
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			windowsHide: true
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`open exited ${code ?? "unknown"}`));
		});
	});
}
//#endregion
//#region src/helper-path.ts
/**
* Where the helper's files are.
* Installed `dsh-orb` keeps them next to this file: `dist/host/index.js` and `dist/helper/lib/main.js`.
* In the workspace the helper is a separate package that Node resolves by name.
*/
const require = createRequire(import.meta.url);
/** Root folder of the helper: holds `lib/`, `assets/` and the preload scripts. */
function helperRoot() {
	const assembled = fileURLToPath(new URL("../helper", import.meta.url));
	if (existsSync(join(assembled, "lib", "main.js"))) return assembled;
	return dirname(require.resolve("@dsh-orb/helper/package.json"));
}
/** Electron entry script of the helper. */
function helperMain() {
	return join(helperRoot(), "lib", "main.js");
}
/** Bundled default avatar. */
function defaultAvatarPath() {
	return join(helperRoot(), "assets", "deepseek-avatar-square.gif");
}
/** Built-in avatar GIFs. The ball loads them from disk, the settings page over the route. */
function presetAvatarDir() {
	return join(helperRoot(), "assets", "avatars");
}
//#endregion
//#region src/avatar-presets.ts
/**
* Built-in ball avatars.
* The files are animated GIFs in the helper's `assets/avatars`. The ball picks one
* by relative path (a data URL would have to carry megabytes through the socket),
* while the settings page reads the same files through the avatar route.
*/
/** Gallery order is this order. */
const AVATAR_PRESETS = [
	{
		id: "point",
		file: "point.gif"
	},
	{
		id: "rice",
		file: "rice.gif"
	},
	{
		id: "heart",
		file: "heart.gif"
	},
	{
		id: "cheer",
		file: "cheer.gif"
	},
	{
		id: "cheeks",
		file: "cheeks.gif"
	},
	{
		id: "smile",
		file: "smile.gif"
	}
];
function findAvatarPreset(id) {
	return AVATAR_PRESETS.find((preset) => preset.id === id);
}
function isAvatarPresetId(value) {
	return typeof value === "string" && findAvatarPreset(value) !== void 0;
}
/** Absolute path of a shipped preset. Unknown ids resolve to nothing, so a request cannot walk the disk. */
function avatarPresetPath(id) {
	const preset = findAvatarPreset(id);
	return preset === void 0 ? void 0 : join(presetAvatarDir(), preset.file);
}
/** Source the ball page reads, relative to the ball's own document. */
function avatarPresetSrc(id) {
	const preset = findAvatarPreset(id);
	return preset === void 0 ? void 0 : `avatars/${preset.file}`;
}
//#endregion
//#region src/preferences.ts
/**
* Profile files the ball and the settings page share.
* Names match the desktop fork so an existing profile keeps its choices.
*/
const PERMISSION_FILE = "orb-permission.json";
const MODELS_FILE = "orb-agent-models.json";
const MILLIFRACTION_FILE = "millifraction-coordinates.json";
const OBSERVATION_FRAME_FILE = "observation-frame.json";
const SELECTION_FILE = "selection-toolbar.json";
const BALL_FILE = "ball-enabled.json";
const AVATAR_FILE = "orb-avatar";
const AVATAR_META_FILE = "orb-avatar.json";
const UPDATE_FILE = "orb-update.json";
const PERMISSION_PRESETS = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
const DEFAULT_UPDATE = {
	checkedAt: 0,
	latestVersion: "",
	notifiedVersion: "",
	autoCheck: true
};
const DEFAULT_MODEL = {
	provider: "deepseek-official",
	model: "deepseek-flash",
	reasoningEffort: "max"
};
/**
* Active official profile directory.
* Desktop and `dsh web` both provide `profileContext.dir`. The process directory is the fallback.
*/
function profileDirectory(ctx) {
	const profile = ctx.get("profileContext");
	if (typeof profile === "object" && profile !== null && "dir" in profile) {
		const dir = profile.dir;
		if (typeof dir === "string" && dir !== "") return dir;
	}
	return process.cwd();
}
function isPermissionPreset(value) {
	return typeof value === "string" && PERMISSION_PRESETS.includes(value);
}
function isAgentModelSelection(value) {
	return parseSelection(value) !== void 0;
}
/** In-memory view of the profile files. Writes update the cache and the disk together. */
var ProfileStore = class {
	dir;
	permissionValue;
	permissionFallbackValue;
	modelValue;
	millifractionValue;
	observationFrameValue;
	selectionValue;
	selectionLanguage;
	ballValue;
	updateValue;
	constructor(dir) {
		this.dir = dir;
		const permission = readPermission(dir);
		this.permissionValue = permission.preset;
		this.permissionFallbackValue = permission.fallback;
		this.modelValue = readModels(dir);
		this.millifractionValue = readMillifraction(dir);
		this.observationFrameValue = readObservationFrame(dir);
		const selection = readSelection(dir);
		this.selectionValue = selection.enabled;
		this.selectionLanguage = selection.language;
		this.ballValue = readBall(dir);
		this.updateValue = readUpdate(dir);
	}
	permission() {
		return this.permissionValue;
	}
	/** True when the permission file exists but cannot be used. Missing means full access. */
	permissionFallback() {
		return this.permissionFallbackValue;
	}
	setPermission(preset) {
		this.permissionValue = preset;
		this.permissionFallbackValue = false;
		writeJson(join(this.dir, PERMISSION_FILE), { preset });
	}
	models() {
		return this.modelValue;
	}
	setOverlay(selection) {
		this.modelValue = {
			overlay: selection,
			background: this.modelValue.background
		};
		this.writeModels();
	}
	setBackground(selection) {
		this.modelValue = {
			overlay: this.modelValue.overlay,
			background: selection
		};
		this.writeModels();
	}
	millifractionEnabled() {
		return this.millifractionValue;
	}
	setMillifractionEnabled(enabled) {
		this.millifractionValue = enabled;
		writeJson(join(this.dir, MILLIFRACTION_FILE), { enabled });
	}
	/** The coloured frame around the window Computer Use works on; on unless turned off. */
	observationFrameEnabled() {
		return this.observationFrameValue;
	}
	setObservationFrameEnabled(enabled) {
		this.observationFrameValue = enabled;
		writeJson(join(this.dir, OBSERVATION_FRAME_FILE), { enabled });
	}
	/** Pixel on macOS, millifraction on Windows, unless the profile file says otherwise. */
	coordinateMode() {
		return this.millifractionValue ? "millifraction" : "pixel";
	}
	selectionEnabled() {
		return this.selectionValue;
	}
	translateLanguage() {
		return this.selectionLanguage;
	}
	setTranslateLanguage(language) {
		this.selectionLanguage = language;
		writeJson(join(this.dir, SELECTION_FILE), {
			enabled: this.selectionValue,
			translateTargetLanguage: language
		});
	}
	setSelectionEnabled(enabled) {
		this.selectionValue = enabled;
		writeJson(join(this.dir, SELECTION_FILE), {
			enabled,
			translateTargetLanguage: this.selectionLanguage
		});
	}
	/** Missing file means the ball is on. `autoStart: false` is a separate patch switch. */
	ballEnabled() {
		return this.ballValue;
	}
	setBallEnabled(enabled) {
		this.ballValue = enabled;
		writeJson(join(this.dir, BALL_FILE), { enabled });
	}
	updateRecord() {
		return this.updateValue;
	}
	setUpdateRecord(patch) {
		this.updateValue = {
			...this.updateValue,
			...patch
		};
		writeJson(join(this.dir, UPDATE_FILE), this.updateValue);
	}
	/** Bumped by every avatar change: the ball refetches on it, the settings preview re-renders on it. */
	avatarVersion() {
		for (const name of [AVATAR_META_FILE, AVATAR_FILE]) try {
			return statSync(join(this.dir, name)).mtimeMs;
		} catch {}
		return 0;
	}
	/**
	* Avatar the profile currently shows, checked against what is on disk.
	* An unknown preset id or a half-written upload falls back to the shipped GIF.
	*/
	avatarSelection() {
		const preset = record(readJson$1(join(this.dir, AVATAR_META_FILE)))?.preset;
		if (isAvatarPresetId(preset)) return {
			kind: "preset",
			id: preset
		};
		const custom = this.readAvatar();
		if (custom !== void 0) return {
			kind: "custom",
			mime: custom.mime
		};
		return { kind: "default" };
	}
	readAvatar() {
		let bytes;
		try {
			bytes = readFileSync(join(this.dir, AVATAR_FILE));
		} catch {
			return;
		}
		const sniffed = sniffAvatarMime(bytes);
		if (sniffed === void 0) return void 0;
		const declared = readAvatarMime(this.dir);
		if (declared !== void 0 && declared !== sniffed) return void 0;
		return {
			bytes,
			mime: declared ?? sniffed
		};
	}
	/** One avatar per profile: an uploaded image drops the preset pick and the other way round. */
	writeAvatar(bytes, mime) {
		writeBytes(join(this.dir, AVATAR_FILE), bytes);
		writeJson(join(this.dir, AVATAR_META_FILE), {
			kind: "custom",
			mime
		});
	}
	selectAvatarPreset(id) {
		writeJson(join(this.dir, AVATAR_META_FILE), {
			kind: "preset",
			preset: id
		});
		removeIfPresent(join(this.dir, AVATAR_FILE));
	}
	restoreAvatar() {
		for (const name of [AVATAR_FILE, AVATAR_META_FILE]) removeIfPresent(join(this.dir, name));
	}
	writeModels() {
		writeJson(join(this.dir, MODELS_FILE), {
			overlay: serializeSelection(this.modelValue.overlay),
			background: serializeSelection(this.modelValue.background)
		});
	}
};
function sniffAvatarMime(bytes) {
	if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56 && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97) return "image/gif";
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
	if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
}
function defaultMillifraction(platform = process.platform) {
	return platform === "win32";
}
function readPermission(dir) {
	let raw;
	try {
		raw = readFileSync(join(dir, PERMISSION_FILE), "utf8");
	} catch (error) {
		if (isEnoent(error)) return {
			preset: "danger-full-access",
			fallback: false
		};
		return {
			preset: "workspace-write",
			fallback: true
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			preset: "workspace-write",
			fallback: true
		};
	}
	const preset = record(parsed)?.preset;
	if (isPermissionPreset(preset)) return {
		preset,
		fallback: false
	};
	return {
		preset: "workspace-write",
		fallback: true
	};
}
function readModels(dir) {
	const value = record(readJson$1(join(dir, MODELS_FILE)));
	return {
		overlay: parseSelection(value?.overlay) ?? DEFAULT_MODEL,
		background: parseSelection(value?.background) ?? DEFAULT_MODEL
	};
}
function readMillifraction(dir) {
	const enabled = record(readJson$1(join(dir, MILLIFRACTION_FILE)))?.enabled;
	return typeof enabled === "boolean" ? enabled : defaultMillifraction();
}
function readSelection(dir) {
	return {
		enabled: false,
		language: record(readJson$1(join(dir, SELECTION_FILE)))?.translateTargetLanguage === "en" ? "en" : "zh"
	};
}
function readBall(dir) {
	const enabled = record(readJson$1(join(dir, BALL_FILE)))?.enabled;
	return typeof enabled === "boolean" ? enabled : true;
}
function readObservationFrame(dir) {
	const enabled = record(readJson$1(join(dir, OBSERVATION_FRAME_FILE)))?.enabled;
	return typeof enabled === "boolean" ? enabled : true;
}
function readAvatarMime(dir) {
	const mime = record(readJson$1(join(dir, AVATAR_META_FILE)))?.mime;
	if (mime === "image/gif" || mime === "image/png" || mime === "image/webp") return mime;
}
function readUpdate(dir) {
	const stored = record(readJson$1(join(dir, UPDATE_FILE)));
	if (stored === void 0) return DEFAULT_UPDATE;
	return {
		checkedAt: typeof stored.checkedAt === "number" && Number.isFinite(stored.checkedAt) ? stored.checkedAt : 0,
		latestVersion: typeof stored.latestVersion === "string" ? stored.latestVersion : "",
		notifiedVersion: typeof stored.notifiedVersion === "string" ? stored.notifiedVersion : "",
		autoCheck: typeof stored.autoCheck === "boolean" ? stored.autoCheck : true
	};
}
function parseSelection(value) {
	const item = record(value);
	if (item === void 0) return void 0;
	if (typeof item.provider !== "string" || item.provider === "" || item.provider.length > 200) return void 0;
	if (typeof item.model !== "string" || item.model === "" || item.model.length > 200) return void 0;
	if (item.reasoningEffort !== void 0 && (typeof item.reasoningEffort !== "string" || item.reasoningEffort === "" || item.reasoningEffort.length > 80)) return;
	return {
		provider: item.provider,
		model: item.model,
		...typeof item.reasoningEffort === "string" ? { reasoningEffort: item.reasoningEffort } : {}
	};
}
function serializeSelection(selection) {
	return {
		provider: selection.provider,
		model: selection.model,
		...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
	};
}
function readJson$1(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return;
	}
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function writeJson(file, value) {
	writeBytes(file, Buffer.from(`${JSON.stringify(value, void 0, 2)}\n`));
}
function writeBytes(file, bytes) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, bytes);
	renameSync(tmp, file);
}
function removeIfPresent(file) {
	try {
		unlinkSync(file);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}
function isEnoent(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//#endregion
//#region src/catalog.ts
/** Accept the official `modelCatalog()` object, or an empty catalog when it is missing. */
function normalizeCatalog(value) {
	const groups = asRecord$2(value)?.groups;
	if (!Array.isArray(groups)) return { groups: [] };
	const normalized = [];
	for (const group of groups) {
		const record = asRecord$2(group);
		if (record === void 0 || typeof record.id !== "string" || typeof record.name !== "string") continue;
		if (!Array.isArray(record.models)) continue;
		const models = [];
		for (const model of record.models) {
			const item = asRecord$2(model);
			if (item === void 0 || typeof item.id !== "string" || typeof item.name !== "string") continue;
			const reasoning = reasoningOf(item.reasoning);
			models.push({
				id: item.id,
				name: item.name,
				...reasoning === void 0 ? {} : { reasoning }
			});
		}
		if (models.length > 0) normalized.push({
			id: record.id,
			name: record.name,
			models
		});
	}
	return { groups: normalized };
}
function reasoningOf(value) {
	const record = asRecord$2(value);
	if (record === void 0 || !Array.isArray(record.efforts)) return void 0;
	const efforts = [];
	for (const effort of record.efforts) {
		const item = asRecord$2(effort);
		if (item === void 0 || typeof item.id !== "string" || typeof item.name !== "string") continue;
		efforts.push({
			id: item.id,
			name: item.name
		});
	}
	if (efforts.length === 0) return void 0;
	const defaultEffort = typeof record.defaultEffort === "string" && record.defaultEffort !== "" ? record.defaultEffort : void 0;
	return {
		efforts,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
function asRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
//#endregion
//#region src/routes.ts
/**
* Settings routes on the official web port.
* The main window calls these with a relative fetch, so the existing login cookie is enough.
* The helper may read only the avatar, and only with its socket token.
*/
const PREFIX = "/.dsh-orb";
const HELPER_HEADER = "x-dsh-orb-helper";
/** Mount `/.dsh-orb` and return the disposer. */
function registerOrbRoutes(deps) {
	return deps.ctx.webServer.register({
		kind: "prefix",
		path: PREFIX,
		handler: (req, res) => handle(deps, req, res).catch((error) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			const status = errorStatus(error) ?? 500;
			if (status === 500) console.error(`dsh-orb: route failed: ${error instanceof Error ? error.message : String(error)}`);
			sendJson(res, status, { error: status === 500 ? "internal-error" : errorMessage(error) });
		})
	});
}
/** A status a rejected route asked for: `readBody` sets 413, `readJson` sets 400. */
function errorStatus(error) {
	const status = error?.status;
	return typeof status === "number" && status >= 400 && status < 600 ? status : void 0;
}
function errorMessage(error) {
	return error instanceof Error && error.message !== "" ? error.message : "request-failed";
}
function orbSupported(platform = process.platform) {
	return platform === "darwin" || platform === "win32";
}
async function handle(deps, req, res) {
	const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
	if (!(path === `${PREFIX}/avatar` && req.method === "GET" && helperTokenOk(deps, req))) {
		const rejection = rejectionStatus(deps.ctx, req);
		if (rejection !== void 0) {
			res.writeHead(rejection);
			res.end();
			return;
		}
	}
	const method = req.method ?? "GET";
	if (method === "GET" && path === `${PREFIX}/settings`) {
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/models`) {
		sendJson(res, 200, await catalog(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/tcc`) {
		sendJson(res, 200, deps.tcc.status());
		return;
	}
	if (method === "GET" && path === `${PREFIX}/update`) {
		sendJson(res, 200, deps.control.updateState());
		return;
	}
	if (method === "POST" && path === `${PREFIX}/update/check`) {
		await deps.control.checkUpdate();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/update/install`) {
		const builds = stringListField(await readJson(req), "approvedBuilds");
		deps.control.installUpdate(builds);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/update/auto`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-auto-check" });
			return;
		}
		deps.control.setAutoCheck(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/jump`) {
		const target = deps.control.takeJump();
		sendJson(res, 200, {
			sessionId: target?.sessionId ?? null,
			at: target?.at ?? null
		});
		return;
	}
	if (method === "POST" && path === `${PREFIX}/jump`) {
		const sessionId = asRecord$1(await readJson(req))?.sessionId;
		if (typeof sessionId !== "string" || sessionId === "") {
			sendJson(res, 400, { error: "invalid-session" });
			return;
		}
		deps.control.confirmJump(sessionId);
		sendJson(res, 200, { ok: true });
		return;
	}
	if (method === "GET" && path === `${PREFIX}/settings-open`) {
		sendJson(res, 200, { at: deps.control.takeSettingsOpen()?.at ?? null });
		return;
	}
	if (method === "POST" && path === `${PREFIX}/settings-open`) {
		const at = asRecord$1(await readJson(req))?.at;
		if (typeof at !== "number" || !Number.isFinite(at)) {
			sendJson(res, 400, { error: "invalid-target" });
			return;
		}
		deps.control.confirmSettingsOpen(at);
		sendJson(res, 200, { ok: true });
		return;
	}
	if ((method === "GET" || method === "HEAD") && path === `${PREFIX}/avatar`) {
		await sendAvatar(deps.store, method, res);
		return;
	}
	if ((method === "GET" || method === "HEAD") && path.startsWith(`${PREFIX}/avatar/preset/`)) {
		const file = avatarPresetPath(decodeURIComponent(path.slice(`${PREFIX}/avatar/preset/`.length)));
		if (file === void 0 || !await sendFile(res, method, file, "image/gif")) {
			res.writeHead(404);
			res.end();
		}
		return;
	}
	if (!orbSupported()) {
		sendJson(res, 403, { error: "unsupported" });
		return;
	}
	if (method === "POST" && path === `${PREFIX}/overlay-model`) {
		const selection = selectionFrom(await readJson(req));
		if (selection === void 0) {
			sendJson(res, 400, { error: "invalid-model" });
			return;
		}
		await deps.control.setOverlayModel(selection);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/background-model`) {
		const selection = selectionFrom(await readJson(req));
		if (selection === void 0) {
			sendJson(res, 400, { error: "invalid-model" });
			return;
		}
		await deps.control.setBackgroundModel(selection);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/selection`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-selection" });
			return;
		}
		await deps.control.setSelectionEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/millifraction`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-millifraction" });
			return;
		}
		await deps.control.setMillifractionEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/observation-frame`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-observation-frame" });
			return;
		}
		await deps.control.setObservationFrameEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/ball`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-ball" });
			return;
		}
		await deps.control.setBallEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/avatar`) {
		const bytes = await readBody(req, 4194305).catch((error) => {
			if (error instanceof Error && error.message === "too-large") return void 0;
			throw error;
		});
		if (bytes === void 0 || bytes.length > 4194304) {
			sendJson(res, 413, { error: "too-large" });
			return;
		}
		const mime = sniffAvatarMime(bytes);
		if (mime === void 0) {
			sendJson(res, 400, { error: "invalid-type" });
			return;
		}
		deps.store.writeAvatar(bytes, mime);
		await deps.control.publishChrome();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/avatar/preset`) {
		const preset = asRecord$1(await readJson(req))?.preset;
		if (!isAvatarPresetId(preset)) {
			sendJson(res, 400, { error: "invalid-preset" });
			return;
		}
		deps.store.selectAvatarPreset(preset);
		await deps.control.publishChrome();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/avatar/restore`) {
		deps.store.restoreAvatar();
		await deps.control.publishChrome();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/tcc`) {
		const right = asRecord$1(await readJson(req))?.right;
		if (!isTccRight(right)) {
			sendJson(res, 400, { error: "invalid-tcc" });
			return;
		}
		await deps.tcc.open(right);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	res.writeHead(404);
	res.end();
}
async function snapshot(deps) {
	const models = deps.store.models();
	const version = Math.trunc(deps.store.avatarVersion());
	const selection = deps.store.avatarSelection();
	return {
		supported: orbSupported(),
		ballEnabled: deps.store.ballEnabled(),
		avatarUrl: `${PREFIX}/avatar?v=${version}`,
		avatarPresetId: selection.kind === "preset" ? selection.id : null,
		avatarPresets: AVATAR_PRESETS.map((preset) => ({
			id: preset.id,
			url: `${PREFIX}/avatar/preset/${preset.id}`
		})),
		overlay: models.overlay,
		background: models.background,
		selectionEnabled: deps.store.selectionEnabled(),
		millifractionEnabled: deps.store.millifractionEnabled(),
		observationFrameEnabled: deps.store.observationFrameEnabled(),
		tcc: deps.tcc.status(),
		helperError: deps.control.helperStatus?.() ?? "",
		helperPhase: deps.control.helperPhase?.() ?? "",
		selectionAvailable: selectionRuntimeAvailable(),
		permissionFallback: deps.store.permissionFallback(),
		update: deps.control.updateState()
	};
}
async function catalog(deps) {
	try {
		return normalizeCatalog(await deps.ctx.sessionController.modelCatalog());
	} catch (error) {
		console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`);
		return { groups: [] };
	}
}
/** The profile's avatar: a built-in preset, the uploaded bytes, or the shipped GIF. */
async function sendAvatar(store, method, res) {
	const selection = store.avatarSelection();
	if (selection.kind === "preset") {
		const file = avatarPresetPath(selection.id);
		if (file !== void 0 && await sendFile(res, method, file, "image/gif")) return;
	}
	const custom = selection.kind === "custom" ? store.readAvatar() : void 0;
	if (custom !== void 0) {
		sendImage(res, method, custom.bytes, custom.mime);
		return;
	}
	if (await sendFile(res, method, defaultAvatarPath(), "image/gif")) return;
	res.writeHead(404);
	res.end();
}
/** Reads the file and answers with the image; false means the caller still has to answer. */
async function sendFile(res, method, file, mime) {
	let body;
	try {
		body = await readFile(file);
	} catch {
		return false;
	}
	sendImage(res, method, body, mime);
	return true;
}
function sendImage(res, method, body, mime) {
	res.writeHead(200, {
		"content-type": mime,
		"cache-control": "no-store",
		"content-length": body.length
	});
	res.end(method === "HEAD" ? void 0 : body);
}
function helperTokenOk(deps, req) {
	const header = req.headers[HELPER_HEADER];
	return typeof header === "string" && deps.control.helperAuthorized(header);
}
function tokensMatch(given, expected) {
	const left = Buffer.from(given);
	const right = Buffer.from(expected);
	return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
function rejectionStatus(ctx, req) {
	if (typeof ctx.connection.admit === "function") {
		const admitted = ctx.connection.admit(req);
		if (typeof admitted === "object" && admitted !== null && "rejection" in admitted && typeof admitted.rejection === "number") return admitted.rejection;
		return;
	}
	if (typeof ctx.connection.isAuthenticated === "function") return ctx.connection.isAuthenticated(req) ? void 0 : 401;
	return 401;
}
function selectionFrom(value) {
	return isAgentModelSelection(value) ? value : void 0;
}
function booleanField(value) {
	const enabled = asRecord$1(value)?.enabled;
	return typeof enabled === "boolean" ? enabled : void 0;
}
/** Optional list of package names, absent when the field is missing or empty. */
function stringListField(value, key) {
	const list = asRecord$1(value)?.[key];
	if (!Array.isArray(list)) return void 0;
	const names = list.filter((item) => typeof item === "string" && item !== "");
	return names.length === 0 ? void 0 : names;
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
async function readJson(req) {
	const bytes = await readBody(req, 65536);
	if (bytes.length === 0) return void 0;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw Object.assign(/* @__PURE__ */ new Error("invalid-json"), { status: 400 });
	}
}
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(/* @__PURE__ */ new Error("too-large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
function asRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
//#endregion
//#region src/services.ts
/**
* Optional services Computer Use already looks up, plus the Access preset pinned on orb sessions.
*/
/**
* Publish the two model/coordinate services for the life of the plugin.
* @param ctx - host context. `provide` is called once.
* @param store - profile preferences.
*/
function installOrbServices(ctx, store) {
	ctx.provide("orbCodeAgentModel", { currentSelection: () => store.models().background });
	ctx.provide("orbCoordinateMode", { currentMode: () => store.coordinateMode() });
}
/**
* Pin the stored Access preset on Computer Use and background sessions under `dsh_orb`.
* @returns a disposer for the create listener.
*/
function watchOrbPermissions(ctx, store) {
	const dispose = ctx.on("session/created", (session) => {
		pinSession(ctx, session, store.permission());
	});
	return typeof dispose === "function" ? dispose : () => {};
}
/** Pin one already-open session when the chip or a reopen asks for it. */
function pinSessionId(ctx, sessionId, preset) {
	const session = ctx.get("sessions")?.get?.(sessionId);
	if (session) pinSession(ctx, session, preset);
}
function pinSession(ctx, session, preset) {
	if (!isOrbSession(session)) return;
	const presets = ctx.get("permissionPresets");
	if (typeof presets?.set !== "function") return;
	if (!isPermissionPreset(preset)) return;
	try {
		presets.set(session, preset);
	} catch (error) {
		console.error(`dsh-orb: permission preset failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function isOrbSession(session) {
	const preset = session.header?.agentPreset;
	const cwd = session.header?.cwd;
	if (preset !== "computer-use" && preset !== "standard" || cwd === void 0) return false;
	return isOrbWorkspace(cwd, dshHomePath("dsh_orb"));
}
function isOrbWorkspace(cwd, orbCwd) {
	const resolved = resolve(cwd);
	const orb = resolve(orbCwd);
	if (resolved === orb) return true;
	const rel = relative(orb, resolved);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
//#endregion
//#region src/appearance.ts
function describeSettings(settings) {
	const describe = settings?.describe;
	if (typeof describe !== "function") return [];
	try {
		const rows = describe.call(settings);
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}
/** Read the stored theme and locale preferences; unusable sections stay absent. */
function readAppearance(settings) {
	const appearance = {};
	for (const row of describeSettings(settings)) {
		if (row?.ns === "ui-theme") {
			const preference = row.value?.preference;
			if (preference === "light" || preference === "dark" || preference === "system") appearance.theme = preference;
		}
		if (row?.ns === "locale" && typeof row.value?.preference === "string") {
			const preference = row.value.preference;
			if (preference.length > 0 && preference.length <= 35) appearance.locale = preference;
		}
	}
	return appearance;
}
function sameAppearance(left, right) {
	return left.theme === right.theme && left.locale === right.locale;
}
/**
* Follow the live settings document: read once, then re-read whenever the
* theme or locale namespace changes. `settings/document-updated` fires for
* every namespace and describe() itself emits it, so the read is guarded
* against re-entry.
*/
function watchAppearance(ctx, onChange) {
	const settings = ctx.get("settings");
	if (typeof settings?.describe !== "function") return () => {};
	let reading = false;
	const read = () => {
		if (reading) return {};
		reading = true;
		try {
			return readAppearance(settings);
		} finally {
			reading = false;
		}
	};
	let current = read();
	onChange({ ...current });
	const detach = ctx.on("settings/document-updated", (ns) => {
		if (ns !== "ui-theme" && ns !== "locale") return;
		const next = read();
		if (sameAppearance(next, current)) return;
		current = next;
		onChange({ ...current });
	});
	return typeof detach === "function" ? detach : () => {};
}
//#endregion
//#region src/electron-runtime.ts
/**
* Locate the generic Electron binary used to open the ball.
* Official DeepSeek Harness is not a usable helper runtime: it has its own app payload and a single-instance lock.
*/
/** Matches the official app's Electron framework and the fork's desktop package. */
const ELECTRON_VERSION = "44.0.0";
const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
/** Official SHASUMS256.txt for Electron 44.0.0. The download is rejected when it disagrees. */
const PINNED_SHA256 = {
	"electron-v44.0.0-darwin-arm64.zip": "076d79742986e1b100b69ebecc691cb07368045e54c9087cef631b8622b76a80",
	"electron-v44.0.0-darwin-x64.zip": "28429e700ad68d9624aaa90b6543ffe891a48c14121fd904cd294e5edcee63ff",
	"electron-v44.0.0-linux-arm64.zip": "74b6f18bc29c0d52cf8e963c45d476800419097c6f3d53b27c5df335207e52bb",
	"electron-v44.0.0-linux-x64.zip": "d65286d812719f2b4c1a1b806a80f288a1058c89c7b058dae1e03ab25e499446",
	"electron-v44.0.0-win32-arm64.zip": "984c8f3b9ffaf3c0a3f3501c96277effc05a9f0df5a5d920b2610c09ebaf4368",
	"electron-v44.0.0-win32-x64.zip": "e61aa3bcea8152bc0730abd015e47c032d778a0ef10e2a1c78ba3c4ea47942f9"
};
/**
* Resolve the helper executable.
* `DSH_ORB_ELECTRON_PATH` wins. Otherwise use the cached official zip, downloading it once.
* @param report - optional phase callback; fires only when a download is actually needed.
* @returns absolute path to the Electron executable.
*/
async function resolveElectronBinary(report) {
	const override = process.env.DSH_ORB_ELECTRON_PATH?.trim();
	if (override) {
		await access(override);
		return override;
	}
	const dest = dshHomePath("dsh-orb", "electron-runtime");
	const binary = join(dest, binaryRelative());
	const marker = join(dest, `.complete-${ELECTRON_VERSION}`);
	if (await exists(binary) && await exists(marker)) return binary;
	await downloadRuntime(dest, binary, marker, report);
	return binary;
}
async function downloadRuntime(dest, binary, marker, report) {
	const parent = dirname(dest);
	await mkdir(parent, { recursive: true });
	await withDownloadLock(parent, async () => {
		if (await exists(binary) && await exists(marker)) return;
		const fileName = assetName();
		console.error(`dsh-orb: downloading Electron ${ELECTRON_VERSION} (${fileName})`);
		const expected = expectedHash(await fetchText("SHASUMS256.txt"), fileName);
		const stamp = randomBytes(8).toString("hex");
		const zipPath = join(parent, `.electron-${stamp}.zip`);
		const staging = join(parent, `.electron-staging-${stamp}`);
		try {
			report?.("downloading");
			await downloadVerifiedZip(fileName, expected, zipPath);
			report?.("extracting");
			await mkdir(staging, { recursive: true });
			await extractZip(zipPath, staging);
			const stagedBinary = join(staging, binaryRelative());
			if (process.platform === "darwin") await spawnChecked("/usr/bin/xattr", [
				"-dr",
				"com.apple.quarantine",
				staging
			]).catch(() => void 0);
			await chmod(stagedBinary, 493);
			await access(stagedBinary);
			await writeFile(join(staging, `.complete-${ELECTRON_VERSION}`), `${ELECTRON_VERSION}\n`);
			await replaceDirectory(staging, dest);
		} finally {
			await rm(zipPath, { force: true });
			await rm(staging, {
				recursive: true,
				force: true
			});
		}
		console.error(`dsh-orb: Electron ${ELECTRON_VERSION} is ready`);
	});
}
/**
* Take the download lock. The owner file is written in a staging directory first, and the
* directory is renamed into place: the lock only ever appears with its owner already inside,
* so a second process can never read a half-made lock. A dead owner, or one past the
* 20-minute ceiling, can be taken over.
*/
async function withDownloadLock(parent, task) {
	const lock = join(parent, "electron-runtime.download.lock");
	const deadline = Date.now() + 6e5;
	for (;;) {
		if (Date.now() > deadline) throw new Error("dsh-orb: Electron download is locked by another process");
		const staging = `${lock}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			await mkdir(staging);
			await writeFile(join(staging, "owner"), `${process.pid}\n${Date.now()}\n`);
		} catch (error) {
			await rm(staging, {
				recursive: true,
				force: true
			});
			throw error;
		}
		try {
			await rename(staging, lock);
			break;
		} catch (error) {
			await rm(staging, {
				recursive: true,
				force: true
			});
			if (!isLockTaken(error)) throw error;
			if (await lockExpired(lock)) {
				await rm(lock, {
					recursive: true,
					force: true
				});
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	try {
		await task();
	} finally {
		await rm(lock, {
			recursive: true,
			force: true
		});
	}
}
/** Codes a failed rename of the staging directory onto the lock directory answers with when the lock is held. */
function isLockTaken(error) {
	const code = error?.code;
	return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM" || code === "EACCES";
}
async function lockExpired(lock) {
	let text;
	try {
		text = await readFile(join(lock, "owner"), "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") return false;
		try {
			const info = await stat(lock);
			return Date.now() - info.mtimeMs > 3e4;
		} catch {
			return false;
		}
	}
	const [pidText, startedText] = text.split("\n");
	const pid = Number(pidText);
	const started = Number(startedText);
	if (!Number.isInteger(pid) || pid <= 0) return true;
	if (Number.isFinite(started) && Date.now() - started > 12e5) return true;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error?.code !== "EPERM";
	}
}
async function replaceDirectory(staging, dest) {
	const retired = `${dest}.retired-${randomBytes(4).toString("hex")}`;
	let moved = false;
	if (await exists(dest)) {
		await rename(dest, retired);
		moved = true;
	}
	try {
		await rename(staging, dest);
	} catch (error) {
		if (moved) await rename(retired, dest).catch(() => void 0);
		throw error;
	}
	if (moved) await rm(retired, {
		recursive: true,
		force: true
	}).catch(() => void 0);
}
function assetName() {
	const platform = process.platform;
	const arch = process.arch;
	if (platform !== "darwin" && platform !== "win32" && platform !== "linux") throw new Error(`dsh-orb: unsupported platform ${platform}`);
	if (arch !== "arm64" && arch !== "x64") throw new Error(`dsh-orb: unsupported architecture ${arch}`);
	return `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`;
}
function binaryRelative() {
	if (process.platform === "darwin") return join("Electron.app", "Contents", "MacOS", "Electron");
	if (process.platform === "win32") return "electron.exe";
	return "electron";
}
/** The hash written in source. `sums` must list the same value or the download stops. */
function expectedHash(sums, fileName) {
	const pinned = PINNED_SHA256[fileName];
	if (pinned === void 0) throw new Error(`dsh-orb: ${fileName} has no pinned Electron ${ELECTRON_VERSION} checksum`);
	if (hashFromSums(sums, fileName) !== pinned) throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum list does not match the pinned hash for ${fileName}`);
	return pinned;
}
function hashFromSums(sums, fileName) {
	for (const line of sums.split("\n")) {
		const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
		if (match?.[2] === fileName) return match[1].toLowerCase();
	}
	throw new Error(`dsh-orb: ${fileName} is missing from Electron ${ELECTRON_VERSION} checksums`);
}
const CURL_HTTPS = [
	"--proto",
	"=https",
	"--proto-redir",
	"=https"
];
/** The Windows schannel backend aborts when a revocation check cannot complete
* (common behind proxies); every download is checksum-verified anyway. Other
* TLS backends ignore the flag. */
const CURL_TLS = process.platform === "win32" ? ["--ssl-no-revoke"] : [];
/** How long a dead host may burn before curl gives up and the next source is asked. */
const CONNECT_TIMEOUT_SECONDS = "5";
/**
* Mirrors of an Electron release, in the order they are asked.
* npmmirror goes first: github.com is unreachable for a large part of the audience,
* and a silently dropped connection there would otherwise stall the first ball launch.
* Every download is checked against the compiled-in SHA-256, so the order costs no trust.
*/
function releaseUrls(path) {
	return [`https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VERSION}/${path}`, `${RELEASE_BASE}/${path}`];
}
/** First source that answers wins; a dead host costs one connect timeout, not the whole transfer. */
async function fetchText(path) {
	let lastError;
	for (const url of releaseUrls(path)) try {
		const { stdout } = await run("curl", [
			"-fsSL",
			...CURL_HTTPS,
			...CURL_TLS,
			"--connect-timeout",
			CONNECT_TIMEOUT_SECONDS,
			"--max-time",
			"60",
			url
		]);
		return stdout;
	} catch (error) {
		lastError = error;
		console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
	}
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`dsh-orb: failed to download ${path}`);
}
async function downloadVerifiedZip(fileName, expected, dest) {
	const urls = releaseUrls(fileName);
	let lastError;
	for (const url of urls) try {
		await rm(dest, { force: true });
		await run("curl", [
			"-fsSL",
			...CURL_HTTPS,
			...CURL_TLS,
			"--retry",
			"2",
			"--retry-delay",
			"1",
			"--connect-timeout",
			CONNECT_TIMEOUT_SECONDS,
			"--speed-limit",
			"100000",
			"--speed-time",
			"20",
			"--max-time",
			"300",
			"-o",
			dest,
			url
		]);
		if (!sameHash(await sha256(dest), expected)) throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum did not match SHASUMS256.txt`);
		return;
	} catch (error) {
		lastError = error;
		console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
	}
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`dsh-orb: failed to download Electron ${ELECTRON_VERSION}`);
}
function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const out = [];
		const err = [];
		child.stdout?.on("data", (chunk) => out.push(chunk));
		child.stderr?.on("data", (chunk) => err.push(chunk));
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) {
				resolve({ stdout: Buffer.concat(out).toString("utf8") });
				return;
			}
			const detail = Buffer.concat(err).toString("utf8").trim();
			reject(/* @__PURE__ */ new Error(`dsh-orb: ${command} exited ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
		});
	});
}
async function sha256(path) {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}
function sameHash(actual, expected) {
	const left = Buffer.from(actual, "hex");
	const right = Buffer.from(expected, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}
async function extractZip(zipPath, dest) {
	if (process.platform === "win32") {
		await spawnChecked("powershell.exe", [
			"-NoProfile",
			"-Command",
			`Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${dest.replaceAll("'", "''")}' -Force`
		]);
		return;
	}
	await spawnChecked(process.platform === "darwin" ? "/usr/bin/unzip" : "unzip", [
		"-q",
		"-o",
		zipPath,
		"-d",
		dest
	]);
}
function spawnChecked(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`dsh-orb: ${command} exited ${code ?? "unknown"}`));
		});
	});
}
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/open-main.ts
/**
* Focus the official desktop window, or open the local web page.
* The credentialed page address is never written to the log.
*/
/**
* Desktop uses the app's `dsh://open` protocol.
* `dsh web` has no main window, so the menu item stays disabled and this returns undefined.
* The credentialed loopback URL is never passed to `open` or `cmd`.
*/
function mainWindowTarget(_ctx, desktop = isDesktopHost()) {
	if (desktop) return "dsh://open";
}
/** Command used to focus that window. The target is never logged. */
function openCommand(target, platform = process.platform) {
	if (platform === "win32") return {
		command: "cmd",
		args: [
			"/c",
			"start",
			"",
			target
		]
	};
	return {
		command: "open",
		args: [target]
	};
}
/**
* Environment for the opener.
* The desktop host runs under `ELECTRON_RUN_AS_NODE=1`, and a child that keeps it makes
* Windows start the protocol handler in Node mode: the app never reaches its
* single-instance forwarding, so `dsh://open` silently does nothing. The helper spawn
* drops the same marker for the same reason. macOS launches through `open`, which starts
* the app from LaunchServices and never sees this environment.
* @param env - environment to copy, `process.env` by default.
* @returns a copy without the Node-mode marker.
*/
function openEnvironment(env = process.env) {
	const clean = { ...env };
	delete clean.ELECTRON_RUN_AS_NODE;
	return clean;
}
/** Focus the desktop main window. Does nothing when this host is `dsh web`. */
async function openMainWindow(ctx) {
	const target = mainWindowTarget(ctx);
	if (target === void 0) return;
	await spawnOpen(target);
}
function spawnOpen(target) {
	const { command, args } = openCommand(target);
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			windowsHide: true,
			env: openEnvironment()
		});
		child.once("error", () => {
			console.error("dsh-orb: could not open the main window");
			resolve();
		});
		child.once("exit", (code) => {
			if (code !== 0) console.error("dsh-orb: could not open the main window");
			resolve();
		});
	});
}
//#endregion
//#region src/overlay-guard.ts
/**
* Computer Use overlay cloak.
* Every capture runs inside an `overlay-capture` interval: the helper lifts the ball,
* toolbar, and observation frame out of screen captures for the interval, so the agent
* never sees its own chrome. HID bursts keep the `overlay-input` interval, which also
* holds the protection across the post-action screenshot inside the burst.
*/
const OVERLAY_GUARD_ACK_TIMEOUT_MS = 1e3;
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}
function createOverlayGuard(transport) {
	let inputDepth = 0;
	let captureDepth = 0;
	/** True between the begin the helper counted and its matching end. */
	let captureOpen = false;
	const sleep = transport.sleep ?? delay;
	return {
		async withCapture(run, signal) {
			captureDepth += 1;
			const cloaked = captureDepth === 1 && inputDepth === 0 && transport.hasHelper();
			try {
				if (cloaked) {
					const begin = transport.send({
						type: "overlay-capture",
						id: randomUUID(),
						active: true
					}, signal);
					captureOpen = true;
					await begin;
					await sleep(50);
				}
				return await run({ excludeWindowIds: transport.chromeWindowIds?.() ?? [] });
			} finally {
				captureDepth -= 1;
				if (captureDepth === 0 && captureOpen) {
					captureOpen = false;
					try {
						await transport.send({
							type: "overlay-capture",
							id: randomUUID(),
							active: false
						});
					} catch {}
				}
			}
		},
		async withInput(run) {
			inputDepth += 1;
			const outer = inputDepth === 1;
			const cloaked = outer && transport.hasHelper();
			try {
				if (outer) {
					transport.setHidInput(true);
					if (cloaked) await transport.send({
						type: "overlay-input",
						id: randomUUID(),
						active: true
					});
				}
				const value = await run();
				if (cloaked) await sleep(80);
				return value;
			} finally {
				inputDepth -= 1;
				if (inputDepth === 0) try {
					if (cloaked) try {
						await transport.send({
							type: "overlay-input",
							id: randomUUID(),
							active: false
						});
					} catch {}
				} finally {
					transport.setHidInput(false);
				}
			}
		},
		async setObservationFrame(bounds, signal) {
			if (!transport.hasHelper()) return;
			const wanted = bounds === null || transport.observationFrameEnabled?.() === false ? null : bounds;
			if (wanted !== null && signal?.aborted) {
				await transport.send({
					type: "observation-frame",
					id: randomUUID(),
					bounds: null
				});
				return;
			}
			try {
				await transport.send({
					type: "observation-frame",
					id: randomUUID(),
					bounds: wanted
				}, signal);
			} catch (error) {
				if (wanted !== null && signal?.aborted) {
					await transport.send({
						type: "observation-frame",
						id: randomUUID(),
						bounds: null
					});
					return;
				}
				throw error;
			}
		}
	};
}
const SELECTION_ACCESSIBILITY_POLL_MS = 1e3;
const SELECTION_PREAMBLE = "Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.";
function selectionSearchUrl(text) {
	return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}
function composeSelectionTranslatePrompt(text, language) {
	return `${SELECTION_PREAMBLE}\n\nTranslate the following into ${language === "en" ? "English" : "Chinese"}:\n\n${text}`;
}
/** Open a URL with the system handler. Search uses this and does not expand the ball. */
function openSystemUrl(url) {
	const command = process.platform === "win32" ? "cmd" : "open";
	const args = process.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url];
	const child = spawn(command, args, {
		stdio: "ignore",
		windowsHide: true
	});
	child.once("error", (error) => {
		console.error(`dsh-orb: open failed: ${error.message}`);
	});
	child.unref();
}
var SelectionController = class {
	host;
	startMonitor;
	monitor;
	lastText = "";
	lastAnchor = {
		x: 0,
		y: 0
	};
	lastDedupe;
	lastPid;
	restoreTimer;
	sessionRunning = false;
	hidInput = false;
	promptedAccessibility = false;
	accessibilityPoll;
	constructor(host, startMonitor = startSelectionMonitor) {
		this.host = host;
		this.startMonitor = startMonitor;
	}
	/** Start while the helper is connected and the switch is on. */
	sync() {
		if (process.platform === "linux") return;
		if (this.host.helperConnected() && this.host.enabled()) this.start();
		else this.stop();
	}
	stop() {
		this.clearAccessibilityPoll();
		this.monitor?.stop();
		this.monitor = void 0;
		if (this.restoreTimer !== void 0) {
			clearTimeout(this.restoreTimer);
			this.restoreTimer = void 0;
		}
		this.host.hide();
	}
	setLanguage(language) {
		this.host.setLanguage(language);
	}
	setSessionRunning(running) {
		this.sessionRunning = running;
		if (running) this.host.hide();
	}
	setHidInput(active) {
		this.hidInput = active;
		if (active) this.host.hide();
	}
	search() {
		if (this.lastText === "") return;
		this.host.hide();
		this.host.openExternal(selectionSearchUrl(this.lastText));
	}
	translate() {
		if (this.lastText === "") return;
		const text = composeSelectionTranslatePrompt(this.lastText, this.host.language());
		this.host.hide();
		this.host.prompt(text);
		this.scheduleRestoreFrontApp();
	}
	sendToAgent() {
		if (this.lastText === "") return;
		this.host.hide();
		this.host.attach(this.lastText);
	}
	onHelperEvent(event) {
		switch (event.type) {
			case "ready":
				this.exclude();
				return;
			case "untrusted":
				if (!this.promptedAccessibility) {
					this.promptedAccessibility = true;
					this.host.requestAccessibility();
				}
				this.watchAccessibility();
				return;
			case "mouse-down":
				this.host.pointer(event.x, event.y);
				return;
			case "key":
			case "dismiss":
				this.host.hide();
				return;
			case "mouse-up":
				this.lastAnchor = {
					x: event.x,
					y: event.y
				};
				return;
			case "selection":
				this.onSelection(event);
				return;
		}
	}
	start() {
		if (this.monitor !== void 0) return;
		const started = this.startMonitor({ onEvent: (event) => {
			this.onHelperEvent(event);
		} });
		if (started === void 0) return;
		this.monitor = started;
		this.exclude();
	}
	exclude() {
		const pids = [process.pid];
		const helper = this.host.helperPid();
		if (helper !== void 0) pids.push(helper);
		this.monitor?.setExcludePids(pids);
	}
	pausedReads() {
		return this.sessionRunning || this.hidInput || !this.host.enabled();
	}
	onSelection(event) {
		if (this.pausedReads()) return;
		const key = `${String(event.pid ?? 0)}\0${event.bundle ?? ""}\0${event.text}`;
		const now = this.host.now();
		if (this.lastDedupe !== void 0 && this.lastDedupe.key === key && now - this.lastDedupe.at < 3e3) return;
		this.lastDedupe = {
			key,
			at: now
		};
		this.lastText = event.text;
		this.lastPid = event.pid;
		if (typeof event.x === "number" && typeof event.y === "number" && Number.isFinite(event.x) && Number.isFinite(event.y)) this.lastAnchor = {
			x: event.x,
			y: event.y
		};
		this.host.show({
			text: event.text,
			x: this.lastAnchor.x,
			y: this.lastAnchor.y,
			language: this.host.language()
		});
	}
	scheduleRestoreFrontApp() {
		this.restoreFrontApp();
		if (this.restoreTimer !== void 0) clearTimeout(this.restoreTimer);
		const timer = setTimeout(() => {
			this.restoreTimer = void 0;
			this.restoreFrontApp();
		}, 80);
		timer.unref();
		this.restoreTimer = timer;
	}
	restoreFrontApp() {
		const pid = this.lastPid;
		if (pid === void 0 || pid === process.pid) return;
		this.monitor?.activatePid(pid);
	}
	watchAccessibility() {
		if (this.accessibilityPoll !== void 0) return;
		const timer = setInterval(() => {
			if (!this.host.enabled() || this.monitor === void 0) {
				this.clearAccessibilityPoll();
				return;
			}
			if (!this.host.accessibilityTrusted()) return;
			this.rearm();
		}, SELECTION_ACCESSIBILITY_POLL_MS);
		timer.unref();
		this.accessibilityPoll = timer;
	}
	rearm() {
		this.clearAccessibilityPoll();
		this.monitor?.stop();
		this.monitor = void 0;
		this.start();
	}
	clearAccessibilityPoll() {
		if (this.accessibilityPoll === void 0) return;
		clearInterval(this.accessibilityPoll);
		this.accessibilityPoll = void 0;
	}
};
function productionAccessibility() {
	return {
		requestAccessibility: () => promptAccessibility(),
		accessibilityTrusted: () => accessibilityTrusted()
	};
}
//#endregion
//#region src/screen-owner.ts
/**
* Host-side view of the process-global desktop owner.
*
* The preset's tool layer refuses GUI and shell calls from any session that is not the owner; the
* orb host is the only component that knows which conversation the ball panel shows, so it publishes
* that here. The record itself lives on `globalThis` under a `Symbol.for` key — the host package and
* `@dsh-orb/computer-use` are separate builds sharing one process, and duplicating the four lines
* that touch a symbol-keyed global is the same trade `@dsh-orb/computer-use/src/gui-lock.ts` makes
* for the screen mutex. Keep the key in step with that module.
*/
const SCREEN_OWNER = Symbol.for("dsh-orb.screen-owner");
function state() {
	const holder = globalThis;
	holder[SCREEN_OWNER] ??= { ownerId: "" };
	return holder[SCREEN_OWNER];
}
/**
* Publish the session the ball shows. Every ball conversation except this one loses GUI and shell
* access; an empty id (no ball, or the helper stopped) leaves every session unrestricted.
* @param sessionId - the displayed conversation, or undefined to lift the restriction.
*/
function publishScreenOwner(sessionId) {
	state().ownerId = typeof sessionId === "string" ? sessionId : "";
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
/** `SetForegroundWindow` is ignored unless this process received the last input; a posted Alt satisfies that. */
const VK_MENU = 18;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 2;
/** `sizeof(INPUT)` on 64-bit Windows. */
const INPUT_SIZE = 40;
const FOREGROUND_RETRY_MS = 50;
/**
* Track the last foreground window that is not the helper's own chrome.
* @param options - chrome handles, interval, and an optional native layer.
* @returns the sampler.
*/
function createForegroundMemory(options) {
	const intervalMs = options.intervalMs ?? 250;
	let native = options.native;
	let loaded = options.native !== void 0;
	let timer;
	let remembered = 0;
	function api() {
		if (loaded) return native;
		loaded = true;
		if (process.platform !== "win32") return void 0;
		try {
			native = loadWindowsForeground();
		} catch (error) {
			console.error(`dsh-orb: foreground memory unavailable: ${error instanceof Error ? error.message : String(error)}`);
			native = void 0;
		}
		return native;
	}
	function sample() {
		const host = api();
		if (host === void 0) return;
		let foreground = 0;
		try {
			foreground = host.foreground();
		} catch {
			return;
		}
		if (foreground <= 0) return;
		const chrome = options.chromeWindowIds();
		if (chrome.length === 0) return;
		if (chrome.includes(foreground)) {
			if (remembered === foreground) remembered = 0;
			return;
		}
		remembered = foreground;
	}
	return {
		start() {
			if (timer !== void 0 || api() === void 0) return;
			sample();
			const created = setInterval(sample, intervalMs);
			created.unref();
			timer = created;
		},
		stop() {
			if (timer === void 0) return;
			clearInterval(timer);
			timer = void 0;
		},
		restore() {
			const host = api();
			if (host === void 0 || remembered <= 0) return;
			try {
				if (host.foreground() === remembered) return;
				host.focus(remembered);
			} catch {}
		}
	};
}
function handleValue(value) {
	const id = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
function sleepSync$1(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** One `KEYBDINPUT` inside an `INPUT`, laid out for 64-bit Windows. */
function keyboardInput(virtualKey, down) {
	const input = Buffer.alloc(INPUT_SIZE);
	input.writeUInt32LE(INPUT_KEYBOARD, 0);
	input.writeUInt16LE(virtualKey, 8);
	input.writeUInt32LE(down ? 0 : KEYEVENTF_KEYUP, 12);
	return input;
}
function loadWindowsForeground() {
	const user32 = requireKoffi(import.meta.url).load("user32.dll");
	const getForeground = user32.func("void * __stdcall GetForegroundWindow()");
	const setForeground = user32.func("int __stdcall SetForegroundWindow(void *hWnd)");
	const isWindow = user32.func("int __stdcall IsWindow(void *hWnd)");
	const sendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)");
	function foreground() {
		return handleValue(getForeground());
	}
	function postKey(virtualKey, down) {
		sendInput(1, keyboardInput(virtualKey, down), INPUT_SIZE);
	}
	return {
		foreground,
		focus(target) {
			if (isWindow(target) === 0) return false;
			postKey(VK_MENU, true);
			try {
				setForeground(target);
				if (foreground() === target) return true;
				sleepSync$1(FOREGROUND_RETRY_MS);
				return foreground() === target;
			} finally {
				postKey(VK_MENU, false);
			}
		}
	};
}
//#endregion
//#region src/deferred-install.ts
/**
* An update that has to wait until this process exits.
* When a native image inside the package is still mapped (see `native-images.ts`),
* asking pnpm to replace the package now would fail and take the live package
* apart. The update is handed to a small detached script outside the package
* instead: it waits for this process to exit, then runs the same pnpm the
* official plugin manager uses. A status file marks the install as running so the
* next start does not load a package that is being replaced; its outcome is read
* back once the script writes one.
*/
/**
* How long a status file without an outcome is still trusted. The script runs at most three
* 15-minute pnpm attempts plus its waits (~45 minutes), so anything older cannot be live.
* The ceiling exists because the script runs pnpm as its own child: killing the script
* orphans that pnpm, which keeps replacing the package with nobody left to write an outcome.
*/
const DEFERRED_INSTALL_CEILING_MS = 282e4;
/**
* How long a job file whose owner has exited still counts as an install about to run. The
* script touches the job file every 500 ms while it waits for that exit, so a fresh job file
* means the script is in the seconds before it writes its status; a stale one means the
* script died before pnpm ever started, and nothing is being replaced.
*/
const DEFERRED_INSTALL_PENDING_MS = 3e4;
/** Folder under the profile that holds the job, the script, its log, and its outcome. */
function deferredDir(profileDir) {
	return join(profileDir, ".dsh-orb-update");
}
/**
* Write the job and start the detached script. It runs on this executable with
* `ELECTRON_RUN_AS_NODE`, so it needs no Node on PATH, and from the profile folder,
* so it holds nothing open inside the package it replaces.
*/
function scheduleInstallAfterExit(job) {
	const dir = deferredDir(job.profileDir);
	mkdirSync(dir, { recursive: true });
	rmSync(join(dir, "result.json"), { force: true });
	const jobFile = join(dir, "job.json");
	const script = join(dir, "apply.mjs");
	writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`);
	writeFileSync(script, APPLY_SCRIPT);
	spawn(process.execPath, [script, jobFile], {
		cwd: job.profileDir,
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1"
		},
		detached: true,
		stdio: "ignore",
		windowsHide: true
	}).unref();
}
/** The outcome a previous run's script left, removed once read. */
function takeDeferredOutcome(profileDir) {
	const file = join(deferredDir(profileDir), "result.json");
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return;
	}
	try {
		rmSync(file, { force: true });
	} catch (error) {
		console.error(`dsh-orb: could not clear the install outcome: ${errorDetail(error)}`);
	}
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed.spec !== "string" || typeof parsed.ok !== "boolean") return void 0;
		return {
			spec: parsed.spec,
			ok: parsed.ok,
			detail: typeof parsed.detail === "string" ? parsed.detail : ""
		};
	} catch {
		return;
	}
}
/**
* Whether the after-exit script is installing right now. The script's own status file is
* the signal: it exists while pnpm runs and is removed once the outcome is written. Before
* that file exists the script is either still waiting for its owner (the package is
* untouched, the ball may run) or in the seconds between that exit and pnpm, which
* {@link installPendingAfterExit} covers. A status whose script died is only trusted until
* the script's own ceiling passes; then the leftover is collected as a failed outcome so
* the host can start.
* @param profileDir - profile that scheduled the install.
* @returns true while a live install is running.
*/
function deferredInstallInProgress(profileDir) {
	const dir = deferredDir(profileDir);
	let raw;
	try {
		raw = readFileSync(join(dir, "status.json"), "utf8");
	} catch {
		return outcomeWritten(dir) ? false : installPendingAfterExit(dir);
	}
	if (outcomeWritten(dir)) return false;
	let status;
	try {
		status = JSON.parse(raw);
	} catch {
		status = void 0;
	}
	if (scriptAlive(Number(status?.pid))) return true;
	const started = Number(status?.startedAt);
	if (Number.isFinite(started) && Date.now() - started <= 282e4) return true;
	try {
		rmSync(join(dir, "status.json"), { force: true });
	} catch (error) {
		console.error(`dsh-orb: could not clear the stalled install status: ${errorDetail(error)}`);
		return false;
	}
	const spec = typeof status?.spec === "string" ? status.spec : "";
	try {
		writeFileSync(join(dir, "result.json"), `${JSON.stringify({
			spec,
			ok: false,
			detail: "deferred-install-stalled"
		})}\n`);
	} catch {}
	return false;
}
/**
* Whether the folder already holds an outcome for its install. The pair `status.json` /
* `result.json` is the whole state: the script writes the status first and the outcome last,
* and the outcome outlives the status file.
* @param dir - the profile's `.dsh-orb-update` folder.
* @returns true once the install has written its result.
*/
function outcomeWritten(dir) {
	try {
		return statSync(join(dir, "result.json")).isFile();
	} catch {
		return false;
	}
}
/**
* Whether a scheduled install's owner has exited, so its script is in the ~2 s before it
* writes its status file. The script touches the job file every 500 ms while it waits, so a
* fresh job file plus a dead owner is an install about to run; a stale one is a script that
* died before pnpm ever started, which replaced nothing.
* @param dir - the profile's `.dsh-orb-update` folder.
* @returns true while the install is about to touch the package.
*/
function installPendingAfterExit(dir) {
	const file = join(dir, "job.json");
	let parentPid;
	try {
		parentPid = JSON.parse(readFileSync(file, "utf8")).parentPid;
	} catch {
		return false;
	}
	const pid = Number(parentPid);
	if (!Number.isInteger(pid) || pid <= 0 || scriptAlive(pid)) return false;
	try {
		return Date.now() - statSync(file).mtimeMs <= DEFERRED_INSTALL_PENDING_MS;
	} catch {
		return false;
	}
}
/** Message of an unknown error, for the log lines that must never throw. */
function errorDetail(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The script's own `alive()`: a process that answers EPERM is running under another user. */
function scriptAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
/**
* Merge `builds` into the profile's top-level `allowBuilds` mapping, the key the shipped
* pnpm 11 reads for install-script approvals (the official plugin manager writes the same
* shape: `allowBuilds: { name: true }`). An existing `false` for an approved name is set
* back to `true` — the user just approved that build. Other keys, including the release-age
* exemption, are left exactly as they are. Unfamiliar shapes are left alone: pnpm's next
* write repairs them.
* @param text - current `pnpm-workspace.yaml`, empty when the profile has none.
* @param builds - approved package names.
* @returns the updated file, or undefined when nothing needs to change.
*/
function mergeApprovedBuilds(text, builds) {
	if (builds.length === 0) return void 0;
	const lines = text.split("\n");
	let key = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line === "allowBuilds:") {
			key = index;
			break;
		}
		if (/^allowBuilds\s*:/.test(line)) return void 0;
	}
	if (key === -1) return (text === "" || text.endsWith("\n") ? text : text + "\n") + "allowBuilds:\n" + builds.map((name) => "  " + yamlScalar(name) + ": true").join("\n") + "\n";
	const kept = [];
	const values = [];
	const at = /* @__PURE__ */ new Map();
	let indent = "  ";
	let index = key + 1;
	for (; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const written = /^([ \t]+)(\S.*?)\s*:\s*([^\s#]*)\s*(?:#.*)?$/u.exec(line);
		if (written === null) break;
		indent = written[1] ?? indent;
		at.set(unquote(written[2] ?? ""), kept.length);
		values.push(written[3] ?? "");
		kept.push(line);
	}
	let changed = false;
	const added = [];
	for (const name of builds) {
		const position = at.get(name);
		if (position === void 0) {
			added.push(indent + yamlScalar(name) + ": true");
			changed = true;
			continue;
		}
		if (values[position] === "false") {
			kept[position] = indent + yamlScalar(name) + ": true";
			changed = true;
		}
	}
	if (!changed) return void 0;
	return [
		...lines.slice(0, key + 1),
		...kept,
		...added,
		...lines.slice(index)
	].join("\n");
}
/** `@` cannot start a plain YAML scalar, so a scoped name is quoted the way pnpm writes one. */
function yamlScalar(name) {
	return name.startsWith("@") ? "'" + name.replaceAll("'", "''") + "'" : name;
}
function unquote(entry) {
	const first = entry.slice(0, 1);
	const last = entry.slice(-1);
	if ((first === "'" || first === "\"") && last === first) return entry.slice(1, -1);
	return entry;
}
/**
* The detached script. Self-contained: the package it replaces may be gone by the
* time it runs. On the desktop it uses the pnpm the app ships in `resources/runtime`
* with the environment the plugin manager gives it; elsewhere (`dsh web`) the `pnpm`
* on PATH.
* The approval helpers below are embedded as their own source, so the script and the
* tested functions cannot drift apart.
*/
const APPLY_SCRIPT = `import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

const jobFile = process.argv[2]
const dir = dirname(jobFile)
const job = JSON.parse(readFileSync(jobFile, 'utf8'))
const log = (line) => appendFileSync(join(dir, 'apply.log'), new Date().toISOString() + ' ' + line + '\\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Replace a profile file atomically: a concurrent reader never sees a half-written YAML. */
function writeAtomic(file, text) {
  const staged = file + '.dsh-orb-tmp'
  writeFileSync(staged, text)
  renameSync(staged, file)
}

${yamlScalar.toString()}

${unquote.toString()}

${mergeApprovedBuilds.toString()}

function pnpm() {
  const support = join(dirname(process.execPath), 'resources', 'runtime')
  const bundled = join(support, 'pnpm', 'bin', 'pnpm.mjs')
  if (existsSync(bundled)) {
    return {
      command: process.execPath,
      args: ['--expose-internals', bundled],
      shell: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: join(support, 'bin') + delimiter + (process.env.PATH ?? ''),
      },
    }
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return { command: 'pnpm', args: [], shell: process.platform === 'win32', env }
}

log('waiting for process ' + job.parentPid + ' to exit before installing ' + job.spec)
while (alive(job.parentPid)) {
  // Touch the job file while waiting: a start that finds a dead owner and a fresh job knows
  // pnpm is about to run, which closes the gap before status.json exists. A stale job means
  // this script died before pnpm started, so nothing was replaced.
  try { utimesSync(jobFile, new Date(), new Date()) } catch (error) { log('could not touch the job file: ' + String(error)) }
  await sleep(500)
}
await sleep(1500)

// The status file marks this install as running before pnpm touches the profile, so a start
// during the install knows not to load the package being replaced. It goes away with the
// outcome: the pair is the whole state, and neither half is ever read alone.
writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'installing', spec: job.spec, pid: process.pid, startedAt: Date.now() }) + '\\n')
try {
  const approved = job.approvedBuilds ?? []
  if (approved.length > 0) {
    const file = join(job.profileDir, 'pnpm-workspace.yaml')
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const after = mergeApprovedBuilds(before, approved)
    if (after !== undefined) writeAtomic(file, after)
    log('approved builds: ' + approved.join(', '))
  }
} catch (error) {
  log('could not write approved builds: ' + String(error))
}

const { command, args, shell, env } = pnpm()
const argv = [...args, 'add', job.spec, '--save-exact', '--registry=' + job.registry]
let ok = false
let detail = ''
for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
  const run = spawnSync(command, argv, { cwd: job.profileDir, env, shell, encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000 })
  const output = (run.stdout ?? '') + (run.stderr ?? '') + (run.error ? String(run.error) : '')
  log('attempt ' + attempt + ' exited ' + run.status + '\\n' + output)
  ok = run.status === 0
  if (!ok) {
    detail = output.split('\\n').map((line) => line.trim()).find((line) => line.includes('ERR_PNPM_')) ?? output.trim().split('\\n').pop() ?? 'pnpm failed'
    await sleep(3000)
  }
}
writeFileSync(join(dir, 'result.json'), JSON.stringify({ spec: job.spec, ok, detail: detail.slice(0, 200) }) + '\\n')
// The outcome is on disk now, so a lock on either leftover must not take the script down:
// status.json without result.json would read as a dead install, and job.json has to go or it
// reads as a pending one until its mtime ages out.
try { rmSync(join(dir, 'status.json'), { force: true }) } catch (error) { log('could not clear the status file: ' + String(error)) }
try { rmSync(jobFile, { force: true }) } catch (error) { log('could not clear the job file: ' + String(error)) }
log(ok ? 'installed ' + job.spec : 'gave up on ' + job.spec)
`;
//#endregion
//#region src/update.ts
/**
* Update check and one-click upgrade for the installed bundle.
* The check probes the package registries — npmmirror first: it mirrors npmjs
* and answers where GitHub stalls — and falls back to the repository's GitHub
* Releases when no registry knows the package. The upgrade installs
* `name@version` through the official plugin manager, asking the registry that
* answered the check first. A bare tarball URL is not an install spec: pnpm
* 11.7 records it without `integrity` and refuses it before downloading.
*/
/** The GitHub repository that publishes plugin releases, `plugin-v<version>` tags. */
const UPDATE_REPO = "mini-yifan/dsh-orb-cordis";
/** Registry sources probed before GitHub, in order. npmmirror syncs minutes after a publish. */
const REGISTRY_BASES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
/** Delay before the first automatic check: the official host needs the network at boot. */
const FIRST_CHECK_DELAY_MS = 2e4;
const PERIODIC_CHECK_MS = 216e5;
/** Answer a host without an updater gives: the settings page then hides the whole card. */
const EMPTY_UPDATE_STATE = {
	currentVersion: "",
	installedVersion: "",
	latestVersion: null,
	available: false,
	checking: false,
	updating: false,
	canUpdate: false,
	autoCheck: false,
	checkedAt: null,
	restartRequired: false,
	deferred: false,
	installing: false,
	error: null,
	pendingBuilds: []
};
/**
* Read the installed manifest.
* The path assumes the assembled layout: `dist/host/index.js` next to the package's
* `package.json`, which holds both in the profile's `node_modules/dsh-orb` and in a
* `link:`ed source checkout. Running from `packages/host/lib` finds nothing, so callers
* treat an unknown version as "no update UI".
*/
function ownPackage(url = import.meta.url) {
	let raw;
	try {
		raw = readFileSync(new URL("../../package.json", url), "utf8");
	} catch {
		return;
	}
	try {
		const manifest = JSON.parse(raw);
		if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return void 0;
		if (manifest.name === "" || manifest.version === "") return void 0;
		return {
			name: manifest.name,
			version: manifest.version
		};
	} catch {
		return;
	}
}
/** Order two dotted versions. A prerelease sorts below the release it precedes. */
function compareVersions(left, right) {
	const a = splitVersion(left);
	const b = splitVersion(right);
	for (let index = 0; index < Math.max(a.main.length, b.main.length); index += 1) {
		const one = a.main[index] ?? 0;
		const other = b.main[index] ?? 0;
		if (one !== other) return one < other ? -1 : 1;
	}
	if (a.pre === b.pre) return 0;
	if (a.pre === "") return 1;
	if (b.pre === "") return -1;
	return comparePrerelease(a.pre, b.pre);
}
function isPluginManager(value) {
	return typeof value === "object" && value !== null && typeof value.installBundle === "function";
}
/**
* Checks the repository's latest release and runs the official installer.
* Every failure stays inside this class: the update path must never break the ball.
*/
var UpdateChecker = class {
	store;
	deps;
	own;
	installed;
	latest;
	checking = false;
	updating = false;
	error = null;
	pendingBuilds = [];
	restartRequired = false;
	/** Version handed to the after-exit install; offering it again would only queue it twice. */
	deferred = null;
	/** The after-exit script is running right now (its status file says so). */
	installing = false;
	timer;
	interval;
	/** The registry base that answered the last check; GitHub is the fallback when none did. */
	source;
	constructor(deps) {
		this.deps = deps;
		this.store = deps.store;
		this.own = "own" in deps ? deps.own : ownPackage();
		this.installed = this.own?.version ?? "";
		this.latest = this.store.updateRecord().latestVersion || null;
		this.installing = deferredInstallInProgress(this.store.dir);
		this.adoptDeferredOutcome();
	}
	/**
	* Read the outcome an after-exit install left, and refresh whether one is still running.
	* Called once at construction and again by a start that waited for the install to finish.
	*/
	adoptDeferredOutcome() {
		const outcome = takeDeferredOutcome(this.store.dir);
		this.installing = deferredInstallInProgress(this.store.dir);
		if (outcome !== void 0 && !outcome.ok) this.error = outcome.detail === "" ? "deferred-install-failed" : outcome.detail;
	}
	/**
	* Whether the after-exit script is installing right now, re-read so a state can never
	* latch: the outcome and the status file are written back to back, and a host that reads
	* between them would otherwise hide the update card for the rest of the session.
	* @returns true while a live install is running.
	*/
	installInProgress() {
		this.installing = deferredInstallInProgress(this.store.dir);
		return this.installing;
	}
	state() {
		const latest = this.latest;
		const installed = this.installed;
		const installing = this.installInProgress();
		return {
			currentVersion: this.own?.version ?? "",
			installedVersion: installed,
			latestVersion: latest,
			available: this.available(),
			checking: this.checking,
			updating: this.updating,
			canUpdate: this.own !== void 0 && isPluginManager(this.deps.manager()),
			autoCheck: this.store.updateRecord().autoCheck,
			checkedAt: this.store.updateRecord().checkedAt || null,
			restartRequired: this.restartRequired,
			deferred: this.deferred !== null,
			installing,
			error: this.error,
			pendingBuilds: [...this.pendingBuilds]
		};
	}
	/** Version waiting to be installed, when the check found one. */
	availableVersion() {
		return this.available() ? this.latest : null;
	}
	/** Schedule the automatic checks and return the disposer. */
	start() {
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.check();
		}, FIRST_CHECK_DELAY_MS);
		this.timer.unref();
		this.interval = setInterval(() => {
			this.check();
		}, PERIODIC_CHECK_MS);
		this.interval.unref();
		return () => {
			if (this.timer !== void 0) clearTimeout(this.timer);
			if (this.interval !== void 0) clearInterval(this.interval);
			this.timer = void 0;
			this.interval = void 0;
		};
	}
	/**
	* Ask the repository's latest release for the newest published version.
	* The automatic call is throttled by {@link AUTO_CHECK_INTERVAL_MS}; `/update/check` is not.
	*/
	async check(manual = false) {
		if (this.checking || this.updating || this.own === void 0) return;
		const record = this.store.updateRecord();
		if (!manual && !record.autoCheck) return;
		if (!manual && Date.now() - record.checkedAt < 36e5) return;
		this.checking = true;
		try {
			const latest = await this.fetch();
			if (latest === null) {
				this.error = null;
				this.store.setUpdateRecord({ checkedAt: Date.now() });
				return;
			}
			if (latest === void 0) {
				this.error = "network";
				return;
			}
			this.latest = latest;
			this.error = null;
			const announce = compareVersions(latest, this.installed) > 0 && record.notifiedVersion !== latest;
			this.store.setUpdateRecord({
				checkedAt: Date.now(),
				latestVersion: latest,
				...announce ? { notifiedVersion: latest } : {}
			});
			if (announce) this.deps.notify(latest);
		} finally {
			this.checking = false;
		}
	}
	/**
	* Install the version the check found through the official plugin manager.
	* The spec is `name@version` and the registry is the one that answered the
	* check, so pnpm resolves registry metadata — including `dist.integrity` —
	* instead of a bare tarball URL. The manager owns the profile lock, the
	* download and the manifest restore; an already-installed bundle is replaced
	* and the result says the restart carries the new code.
	*
	* On Windows a package whose native addon is loaded cannot be replaced: pnpm
	* fails with EPERM after it has already deleted part of the live package.
	* When the probe finds such an addon, or pnpm fails that way anyway, the
	* install waits for the app to quit instead (see `deferred-install.ts`).
	*/
	async install(approvedBuilds) {
		const version = this.availableVersion();
		const manager = this.deps.manager();
		if (version === null || this.updating || !isPluginManager(manager) || this.own === void 0) return;
		this.updating = true;
		this.error = null;
		this.pendingBuilds = [];
		try {
			exemptReleaseAge(this.store.dir, this.own.name);
			const spec = installSpec(version, this.own.name);
			const registry = installRegistry(this.source);
			if (this.lockedImages().length > 0) {
				this.deferUntilExit(version, spec, registry, approvedBuilds ?? []);
				return;
			}
			const result = await manager.installBundle(spec, {
				requestId: `dsh-orb-update-${Date.now()}`,
				registry,
				...approvedBuilds === void 0 ? {} : { approvedBuilds }
			});
			if (result.application === "failed" && isLockedFileFailure(result.error)) {
				this.deferUntilExit(version, spec, registry, approvedBuilds ?? []);
				return;
			}
			if (result.application === "failed") {
				this.error = reportedInstallError(result.error);
				this.pendingBuilds = result.pendingBuilds === void 0 ? [] : [...result.pendingBuilds];
				if (this.pendingBuilds.length > 0) this.error = "build-blocked";
				return;
			}
			this.installed = version;
			this.latest = version;
			this.restartRequired = compareVersions(version, this.own.version) !== 0;
			this.store.setUpdateRecord({
				latestVersion: version,
				notifiedVersion: version,
				checkedAt: Date.now()
			});
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.updating = false;
		}
	}
	setAutoCheck(enabled) {
		this.store.setUpdateRecord({ autoCheck: enabled });
	}
	available() {
		return this.own !== void 0 && this.latest !== null && this.latest !== this.deferred && !this.installInProgress() && compareVersions(this.latest, this.installed) > 0;
	}
	lockedImages() {
		if (this.deps.mappedImages !== void 0) return this.deps.mappedImages();
		if (process.platform !== "win32" || this.own === void 0) return [];
		if (ownPackage(import.meta.url)?.name !== this.own.name) return [];
		try {
			return mappedImages(ownPackageRoot(import.meta.url));
		} catch {
			return [];
		}
	}
	deferUntilExit(version, spec, registry, approvedBuilds) {
		const job = {
			profileDir: this.store.dir,
			spec,
			registry,
			parentPid: process.pid,
			approvedBuilds
		};
		try {
			(this.deps.deferInstall ?? scheduleInstallAfterExit)(job);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			return;
		}
		this.deferred = version;
		this.restartRequired = true;
	}
	async fetch() {
		const own = this.own;
		if (own === void 0) return void 0;
		if (this.deps.fetchLatest !== void 0) return this.deps.fetchLatest(own.name);
		const forced = process.env.DSH_ORB_UPDATE_LATEST?.trim();
		if (forced !== void 0 && forced !== "") return forced;
		this.source = void 0;
		for (const base of registryBases()) {
			const body = await curlText(`${base}/${own.name}/latest`);
			if (body === void 0 || body === "") continue;
			const version = versionFromRegistry(body);
			if (version === void 0) continue;
			this.source = base;
			return version;
		}
		const body = await curlText(`${apiBase()}/releases/latest`);
		if (body === void 0) return void 0;
		return versionFromRelease(body) ?? null;
	}
};
/** The API base the check asks; `DSH_ORB_UPDATE_API` re-points it (tests, mirrors). */
function apiBase() {
	const configured = process.env.DSH_ORB_UPDATE_API?.trim();
	if (configured !== void 0 && configured !== "") return configured.replace(/\/+$/, "");
	return `https://api.github.com/repos/${UPDATE_REPO}`;
}
/** The registry sources the check probes; `DSH_ORB_UPDATE_REGISTRIES` re-points them (tests, mirrors). */
function registryBases() {
	const configured = process.env.DSH_ORB_UPDATE_REGISTRIES?.trim();
	if (configured === void 0 || configured === "") return [...REGISTRY_BASES];
	return configured.split(",").map((base) => base.trim().replace(/\/+$/, "")).filter((base) => base !== "");
}
/** The version a registry's dist-tag document names: `{"version":"0.2.0"}`. */
function versionFromRegistry(body) {
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed.version !== "string") return void 0;
		const version = parsed.version.trim().replace(/^v/, "");
		return version === "" ? void 0 : version;
	} catch {
		return;
	}
}
/**
* The spec the installer receives.
* `name@version` makes pnpm read `dist.integrity` from registry metadata.
* pnpm 11.7 (the version the official client bundles) rejects a bare tarball
* URL whose lockfile entry has no integrity, before it downloads the file
* (`ERR_PNPM_MISSING_TARBALL_INTEGRITY`). `DSH_ORB_UPDATE_URL` overrides the
* whole spec (tests, staged releases).
*/
function installSpec(version, name) {
	const overridden = process.env.DSH_ORB_UPDATE_URL?.trim();
	if (overridden !== void 0 && overridden !== "") return overridden;
	return `${name}@${version.trim().replace(/^v/, "")}`;
}
/**
* Registry the manager should ask first: the one that answered the check, or
* the primary mirror when this process has not checked yet. The manager still
* falls through to its own list when this registry is one of them.
*/
function installRegistry(source) {
	return source ?? REGISTRY_BASES[0] ?? "https://registry.npmmirror.com";
}
/**
* Text for a failed install. A specific manager code (incompatible version,
* and so on) wins. `operation-error` is the manager's wrapper around a pnpm
* failure, so the card shows the `ERR_PNPM_*` line from the diagnostic instead
* of that wrapper.
*/
function reportedInstallError(error) {
	const code = error?.code;
	const lines = error?.diagnostic?.split("\n").map((line) => line.trim()).filter((line) => line !== "") ?? [];
	if (code !== void 0 && code !== "" && code !== "operation-error") return code;
	const detail = lines.find((line) => line.includes("ERR_PNPM_")) ?? lines[0];
	if (detail !== void 0 && detail !== "") return detail.slice(0, 200);
	return code === void 0 || code === "" ? "operation-error" : code;
}
/** A pnpm failure from replacing a package whose files Windows keeps locked. */
function isLockedFileFailure(error) {
	const text = `${error?.code ?? ""}\n${error?.diagnostic ?? ""}`;
	return /ERR_PNPM_EPERM|ERR_PNPM_EBUSY|\bEPERM\b|\bEBUSY\b/.test(text);
}
/**
* Record the package as an explicit exemption from pnpm's minimum-release-age
* gate. pnpm v11 defaults `minimumReleaseAge` to 24 hours, so a registry-named
* resolution silently settles for an older version while a fresh release waits
* out the cutoff (observed 2026-10-06: `dsh-orb` resolved to 0.1.1 everywhere
* the hour after 0.1.2 shipped), and the manager's install pipeline verifies the
* lockfile against the gate before pnpm's own auto-exemption can apply. The
* entry is the bare package name — pnpm grants it to every version, and unlike
* exact `name@version` entries it passes the lockfile verification path
* reliably (observed: versioned entries still failed verification). The write
* puts that name first among its own rules, because pnpm honours only the first
* one (see `withReleaseAgeExclusion`).
*
* Called twice: once when the plugin starts, so the profile reads correctly
* whatever route installed the version (pnpm's own auto-exemption appends a
* `name@version` rule that an older rule shadows), and once before an update
* installs. Best-effort: an unreadable or unexpected file skips the write, and
* the caller proceeds on pnpm's own defaults.
*/
function exemptReleaseAge(profileDir, name) {
	const file = join(profileDir, "pnpm-workspace.yaml");
	let next;
	try {
		next = withReleaseAgeExclusion(readFileSync(file, "utf8"), name);
	} catch {
		return;
	}
	if (next === void 0) return;
	try {
		writeProfileFile(file, next);
	} catch (error) {
		console.error(`dsh-orb: could not write the release-age exemption into ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
* Replace a profile file atomically. The after-exit install script writes the same
* `pnpm-workspace.yaml` (its build approvals), and a plain write would let a concurrent
* reader — or pnpm itself — see a truncated document.
*
* Windows refuses to replace a file another process is holding — pnpm itself, OneDrive, a
* scanner — with EPERM/EACCES/EBUSY, and the holder is normally gone within a moment, so the
* rename is retried. The staged file never survives a failure: leaving it behind would put a
* second copy of the profile's workspace file next to the real one.
* @param file - absolute path of the profile file.
* @param text - complete new contents.
*/
function writeProfileFile(file, text) {
	const staged = `${file}.dsh-orb-tmp`;
	writeFileSync(staged, text);
	try {
		renameWithRetry(staged, file);
	} catch (error) {
		rmSync(staged, { force: true });
		throw error;
	}
}
/** Attempts, and the pause before each one, for a rename the system may be refusing for now. */
const PROFILE_RENAME_ATTEMPTS = 5;
const PROFILE_RENAME_BACKOFF_MS = 50;
/**
* Rename with a short retry, for the destinations Windows can refuse while another process
* holds them. Exported so the retry can be exercised without a real lock.
* @param from - staged path.
* @param to - destination path.
* @param rename - the rename to perform; tests inject one that refuses.
* @throws the last rename error once every attempt is used.
*/
function renameWithRetry(from, to, rename = renameSync) {
	for (let attempt = 1;; attempt += 1) try {
		rename(from, to);
		return;
	} catch (error) {
		if (attempt >= PROFILE_RENAME_ATTEMPTS) throw error;
		sleepSync(PROFILE_RENAME_BACKOFF_MS * attempt);
	}
}
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** The package an exemption entry names, with any version or version union dropped. */
function excludedPackageName(entry) {
	const at = entry.startsWith("@") ? entry.indexOf("@", 1) : entry.indexOf("@");
	return at === -1 ? entry : entry.slice(0, at);
}
/**
* Write the package's exemption as the first entry of the profile's
* `minimumReleaseAgeExclude` block, replacing whatever rules the file already
* carried for the same name.
*
* pnpm's `evaluateVersionPolicy` returns at the FIRST rule whose package name
* matches, so a rule only counts when nothing of the same name precedes it
* (pnpm #732). Appending the bare name — what this used to do — is therefore
* dead the moment any `name@version` rule sits earlier, and pnpm appends such a
* rule for every young version it installs, so the file grows one shadowing
* entry per release. The result is a profile where the package is not actually
* exempt: `pnpm remove` re-resolves the young dependency, produces a
* resolution-policy violation, and aborts with
* `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` (its remove path never wires
* the violation callback), which blocks uninstalling ANY other plugin until the
* version ages past the cutoff.
*
* A bare name exempts every version, so the same-name `name@version` rules a
* profile collected are dropped instead of being left to shadow it later, and
* the bare entry is written first. Other packages' lines keep their order and
* spelling. Returns the new text, or undefined when the file already reads that
* way or is not the block list pnpm writes.
*/
function withReleaseAgeExclusion(text, name) {
	if (name === "") return void 0;
	const lines = text.split("\n");
	let key = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line === "minimumReleaseAgeExclude:") {
			key = index;
			break;
		}
		if (/^minimumReleaseAgeExclude\s*:/.test(line)) return void 0;
	}
	const entry = name.startsWith("@") ? `'${name.replaceAll("'", "''")}'` : name;
	if (key === -1) return `${text === "" || text.endsWith("\n") ? text : `${text}\n`}minimumReleaseAgeExclude:\n  - ${entry}\n`;
	const kept = [];
	let indent;
	let seen = 0;
	let bareFirst = false;
	let index = key + 1;
	for (; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const written = /^([ \t]+)-[ \t]+\S/.exec(line);
		if (written === null) break;
		indent ??= written[1];
		const body = line.slice(line.indexOf("-") + 1).trim().replace(/^['"]|['"]$/g, "");
		if (excludedPackageName(body) === name) {
			if (seen === 0) bareFirst = body === name;
			seen += 1;
			indent = written[1] ?? indent;
			continue;
		}
		kept.push(line);
	}
	if (bareFirst && seen === 1) return void 0;
	const updated = [
		...lines.slice(0, key + 1),
		`${indent ?? "  "}- ${entry}`,
		...kept,
		...lines.slice(index)
	].join("\n");
	return updated === text ? void 0 : updated;
}
/** The version a release names: `plugin-v0.2.0` → `0.2.0`. */
function versionFromRelease(body) {
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed.tag_name !== "string") return void 0;
		const version = parsed.tag_name.trim().replace(/^plugin-v/, "");
		return version === "" ? void 0 : version;
	} catch {
		return;
	}
}
function splitVersion(value) {
	const trimmed = value.trim().replace(/^v/, "");
	const dash = trimmed.indexOf("-");
	const head = dash === -1 ? trimmed : trimmed.slice(0, dash);
	const pre = dash === -1 ? "" : trimmed.slice(dash + 1);
	return {
		main: head.split(".").map((part) => {
			const parsed = Number.parseInt(part, 10);
			return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
		}),
		pre
	};
}
function comparePrerelease(left, right) {
	const a = left.split(".");
	const b = right.split(".");
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const one = a[index];
		const other = b[index];
		if (one === void 0) return -1;
		if (other === void 0) return 1;
		if (one === other) continue;
		const oneNumber = /^\d+$/.test(one) ? Number.parseInt(one, 10) : void 0;
		const otherNumber = /^\d+$/.test(other) ? Number.parseInt(other, 10) : void 0;
		if (oneNumber !== void 0 && otherNumber !== void 0) return oneNumber < otherNumber ? -1 : 1;
		if (oneNumber !== void 0) return -1;
		if (otherNumber !== void 0) return 1;
		return one < other ? -1 : 1;
	}
	return 0;
}
/**
* Fetch a plain-text body. HTTPS answers are pinned to https end to end; a
* plain-http address (the local mock) keeps its scheme so the loopback works.
* Resolves `''` when the server answers 404, `undefined` when the transfer
* fails or answers with another non-2xx status.
*/
async function curlText(url) {
	const proto = url.startsWith("https://") ? [
		"--proto",
		"=https",
		"--proto-redir",
		"=https"
	] : [];
	const tls = process.platform === "win32" ? ["--ssl-no-revoke"] : [];
	return new Promise((resolve) => {
		const child = spawn("curl", [
			"-sSL",
			...proto,
			...tls,
			"--connect-timeout",
			"5",
			"--max-time",
			"15",
			"-w",
			"\n%{http_code}",
			url
		], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const out = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.resume();
		child.once("error", () => {
			resolve(void 0);
		});
		child.once("exit", (code) => {
			if (code !== 0) return resolve(void 0);
			const text = Buffer.concat(out).toString("utf8");
			const cut = text.lastIndexOf("\n");
			const status = cut === -1 ? "" : text.slice(cut + 1).trim();
			const body = cut === -1 ? "" : text.slice(0, cut);
			if (status === "404") return resolve("");
			resolve(status.startsWith("2") ? body : void 0);
		});
	});
}
//#endregion
//#region src/orb.ts
/**
* NDJSON control plane for the ball, plus the Computer Use session it talks to.
* The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
*/
/** Cordis service name of {@link AgentBookmarkRegistry}. */
const CODE_AGENT_REGISTRY = "codeAgentRegistry";
/**
* Backoff before the first-run runtime download is retried; the last entry is
* the self-heal attempt. One dropped connection must not cost the user the ball
* until they find the toggle.
*/
const RUNTIME_RETRY_DELAYS_MS = [
	5e3,
	3e4,
	12e4
];
/** Same shape for a helper that exits right after launch; the last entry self-heals. */
const HELPER_RETRY_DELAYS_MS = [
	500,
	2e3,
	1e4,
	3e5
];
/** Strip poll cadence; the helper ticks elapsed clocks itself. */
const AGENT_POLL_MS = 1e3;
/** How long a ball-initiated main-window target (session jump, settings) stays valid: long enough for a cold app launch. */
const MAIN_WINDOW_TARGET_TTL_MS = 3e4;
/** Caller conversations cycle through this many attribution colors. */
const AGENT_COLOR_COUNT = 4;
/** One host lifetime of the ball: socket, helper process, and one Computer Use session. */
var OrbRuntime = class {
	ctx;
	store;
	token = randomBytes(32).toString("hex");
	sessionFile = dshHomePath("dsh-orb", "floating-session.json");
	server;
	port = 0;
	sockets = /* @__PURE__ */ new Set();
	buffers = /* @__PURE__ */ new Map();
	blocks = /* @__PURE__ */ new Map();
	blockOrder = [];
	pending;
	questionBody;
	turnRunning = false;
	turnInterrupted = false;
	/** Bumped every time a turn starts; stopTurn uses it to spot a turn that replaced its own. */
	turnEpoch = 0;
	child;
	binary = "";
	failures = 0;
	halted = false;
	generation = 0;
	replaying = false;
	workspaceTask;
	retry;
	opening = false;
	pendingStart = false;
	helperError;
	/** 'downloading'/'extracting' while the helper runtime is prepared; '' otherwise. */
	runtimePhase = "";
	runtimeRetries = 0;
	userData = "";
	/** Newer version waiting to be installed, or null once none is known. */
	updateAvailable = null;
	idleWarned = false;
	sessionId;
	sessionError;
	creating;
	watermark = 0;
	missingLogged = false;
	timer;
	giveUp;
	agentTimer;
	lastAgentsPayload = "";
	/**
	* Sessions whose *finished* bookmark the user clicked away. A running stretch is never in here:
	* a click during the run only jumps to the session, so the completion still raises an unread
	* bookmark. {@link agentItems} drops the id the moment that session runs again, which is what
	* gives a continued session a fresh unread bookmark for its next stretch.
	*/
	readAgentIds = /* @__PURE__ */ new Set();
	jumpTarget;
	/** One-shot "open the ball's own settings page" request for the main window's client plugin. */
	settingsTarget;
	callerColors = /* @__PURE__ */ new Map();
	callerTitles;
	callerTitlesTask;
	dirty = /* @__PURE__ */ new Set();
	dirtyTimer;
	/** Chunk frames carry no turn/step; only the attempt's start frame does. */
	attemptPositions = /* @__PURE__ */ new Map();
	lastAttemptByStep = /* @__PURE__ */ new Map();
	/** Transient block keys one streaming step created, in creation order. */
	stepBlocks = /* @__PURE__ */ new Map();
	liveStep;
	orphanFrameLogged = false;
	/** Keys of the newest settled assistant message: the turn's final answer so far. */
	responseKeys = [];
	helperPid;
	appearance = {};
	/** Set by the plugin entry; the settings routes and the ball menu both drive it. */
	updater;
	overlayWaiters = /* @__PURE__ */ new Map();
	/** Chrome window ids each helper reported, keyed by its socket. */
	chromeWindows = /* @__PURE__ */ new Map();
	tcc;
	selection;
	overlay = createOverlayGuard({
		hasHelper: () => this.sockets.size > 0,
		send: (message, signal) => this.waitAck(message, signal),
		setHidInput: (active) => {
			this.selection.setHidInput(active);
		},
		chromeWindowIds: () => this.chromeWindowIds(),
		observationFrameEnabled: () => this.store.observationFrameEnabled()
	});
	/**
	* Windows only. Clicking the ball makes it the system foreground window, so the window
	* the user was actually working in is remembered and handed back on submit.
	*/
	foreground = createForegroundMemory({ chromeWindowIds: () => this.chromeWindowIds() });
	constructor(ctx, store, options = {}) {
		this.ctx = ctx;
		this.store = store;
		this.tcc = options.tcc ?? new TccMonitor();
		const access = productionAccessibility();
		this.selection = new SelectionController({
			enabled: () => this.store.selectionEnabled(),
			language: () => this.store.translateLanguage(),
			setLanguage: (language) => {
				this.store.setTranslateLanguage(language);
				this.broadcast({
					type: "selection-language",
					language
				});
			},
			helperConnected: () => this.sockets.size > 0,
			helperPid: () => this.helperPid,
			show: (payload) => {
				this.broadcast({
					type: "selection",
					...payload
				});
			},
			hide: () => {
				this.broadcast({ type: "selection-hide" });
			},
			pointer: (x, y) => {
				this.broadcast({
					type: "selection-pointer",
					x,
					y
				});
			},
			attach: (text) => {
				this.broadcast({
					type: "selection-attach",
					text
				});
			},
			prompt: (text) => {
				this.onPrompt(text);
			},
			openExternal: (url) => {
				openSystemUrl(url);
			},
			requestAccessibility: () => access.requestAccessibility(),
			accessibilityTrusted: () => access.accessibilityTrusted(),
			now: () => Date.now()
		}, options.startMonitor);
		ctx.provide("computerUseOverlayGuard", this.overlay);
		this.listenAssistantStream();
	}
	/**
	* Follow the loop's process-local assistant stream so text, thinking, and tool
	* calls reach the ball while the model is still producing them. The durable
	* log only records the settled message, which is what the 400 ms poll sees.
	*/
	listenAssistantStream() {
		try {
			this.ctx.on("agent/assistant-stream", (payload) => this.onAssistantStream(payload), { global: true });
		} catch (error) {
			console.error(`dsh-orb: assistant stream unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	onAssistantStream(payload) {
		if (this.sessionId === void 0) return;
		const record = asRecord(payload);
		if (asRecord(asRecord(record?.agent)?.session)?.id !== this.sessionId) return;
		const frame = asRecord(record?.frame);
		if (!frame) return;
		const attemptId = typeof frame.attemptId === "string" ? frame.attemptId : "";
		if (frame.type === "start") {
			if (attemptId === "") return;
			const turn = numberOf(frame.turn);
			const step = numberOf(frame.step);
			this.attemptPositions.set(attemptId, {
				turn,
				step
			});
			const stepKey = `${turn}:${step}`;
			const previous = this.lastAttemptByStep.get(stepKey);
			this.lastAttemptByStep.set(stepKey, attemptId);
			if (previous !== void 0 && previous !== attemptId) {
				this.attemptPositions.delete(previous);
				this.rewindLiveStep(turn, step);
			}
			return;
		}
		if (frame.type === "end") {
			this.attemptPositions.delete(attemptId);
			return;
		}
		if (frame.type !== "chunk") return;
		const position = this.attemptPositions.get(attemptId);
		if (position === void 0) {
			if (!this.orphanFrameLogged) {
				this.orphanFrameLogged = true;
				console.error("dsh-orb: assistant stream chunk arrived without its start frame");
			}
			return;
		}
		if (!asRecord(frame.chunk)) return;
		this.onChunk({
			turn: position.turn,
			step: position.step,
			chunk: frame.chunk
		});
	}
	/** A new attempt supersedes the dead one: drop its transient blocks so the retry streams into a clean slate. */
	rewindLiveStep(turn, step) {
		const tracked = this.stepBlocks.get(`${turn}:${step}`);
		if (!tracked) return;
		this.stepBlocks.delete(`${turn}:${step}`);
		for (const key of tracked) this.dropBlock(key);
	}
	/** Open the socket, prepare a session, and spawn the helper. A halted ball can start again. */
	async start() {
		if (process.platform === "linux") return;
		this.halted = false;
		this.failures = 0;
		this.helperError = void 0;
		this.runtimePhase = "";
		if (this.child !== void 0 && this.child.exitCode === null && this.child.signalCode === null && this.server) return;
		if (this.retry) clearTimeout(this.retry);
		this.retry = void 0;
		if (this.opening) {
			this.generation += 1;
			this.pendingStart = true;
			return;
		}
		this.opening = true;
		this.generation += 1;
		const generation = this.generation;
		try {
			await this.begin(generation);
		} finally {
			this.opening = false;
			if (this.pendingStart) {
				this.pendingStart = false;
				if (!this.halted) await this.start();
			}
		}
	}
	/** Short code the settings page can show after the helper gives up. */
	helperStatus() {
		return this.helperError ?? "";
	}
	/** What the runtime preparation is busy with, for the settings page's waiting line. */
	helperPhase() {
		return this.runtimePhase;
	}
	/**
	* The first-run runtime download retried with backoff. While attempts remain
	* the phase stays on screen; only a spent budget surfaces the failure.
	*/
	async beginRuntime(generation) {
		try {
			this.binary = await resolveElectronBinary((phase) => {
				this.runtimePhase = phase;
			});
			this.runtimePhase = "";
			this.runtimeRetries = 0;
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: ${message}`);
			this.runtimeRetries += 1;
			const delay = RUNTIME_RETRY_DELAYS_MS[this.runtimeRetries - 1];
			if (delay !== void 0 && !this.halted && generation === this.generation) {
				this.runtimePhase = "downloading";
				console.error(`dsh-orb: retrying the runtime download in ${Math.round(delay / 1e3)}s`);
				this.retry = setTimeout(() => {
					this.retry = void 0;
					this.start().catch((error) => {
						console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
					});
				}, delay);
				this.retry.unref();
				return false;
			}
			this.runtimePhase = "";
			this.helperError = "runtime-download";
			this.server?.close();
			this.server = void 0;
			return false;
		}
	}
	async begin(generation) {
		if (!this.server) await this.listen();
		if (this.halted || generation !== this.generation) {
			this.server?.close();
			this.server = void 0;
			return;
		}
		console.error(`dsh-orb: helper socket 127.0.0.1:${this.port}`);
		this.startPolls();
		const sessionTask = this.ensureSession().catch((error) => {
			this.sessionError = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: session setup failed: ${this.sessionError}`);
		});
		if (!await this.beginRuntime(generation)) return;
		await sessionTask;
		if (this.halted || generation !== this.generation) return;
		this.userData = helperDataDirectory(this.store.dir);
		await mkdir(this.userData, { recursive: true });
		this.launch();
	}
	/**
	* Open the control socket without spawning the helper.
	* {@link start} listens and then launches the helper process.
	*/
	async bind() {
		if (!this.server) await this.listen();
		this.startPolls();
		return {
			port: this.port,
			token: this.token
		};
	}
	/** Stop the helper and the socket. Settings can call {@link start} again. */
	halt() {
		this.generation += 1;
		this.halted = true;
		this.pendingStart = false;
		this.runtimePhase = "";
		if (this.retry) clearTimeout(this.retry);
		this.retry = void 0;
		this.stopWatch();
		this.stopAgentPoll();
		this.clearDirty();
		this.handQuestionBack();
		this.server?.close();
		this.server = void 0;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.buffers.clear();
		this.chromeWindows.clear();
		this.helperPid = void 0;
		this.overlayWaiters.clear();
		this.jumpTarget = void 0;
		this.settingsTarget = void 0;
		this.selection.stop();
		this.foreground.stop();
		this.killChild();
		publishScreenOwner(void 0);
	}
	/** Claim questions for this orb session. Register this while the plugin fiber is active. */
	attachQuestions() {
		try {
			const dispose = this.ctx.on("user-questions/request", (request, next) => this.onQuestion(request, next), { prepend: true });
			return typeof dispose === "function" ? dispose : () => {};
		} catch (error) {
			console.error(`dsh-orb: question listener failed: ${error instanceof Error ? error.message : String(error)}`);
			return () => {};
		}
	}
	async listen() {
		const server = createServer((socket) => {
			this.handle(socket);
		});
		this.server = server;
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("dsh-orb: helper socket has no port");
		this.port = address.port;
	}
	handle(socket) {
		socket.setEncoding("utf8");
		let authed = false;
		const timer = setTimeout(() => {
			if (!authed) socket.destroy();
		}, 3e3);
		timer.unref();
		socket.on("data", (chunk) => {
			const next = `${this.buffers.get(socket) ?? ""}${chunk}`;
			if (next.length > 1e6) {
				socket.destroy();
				return;
			}
			const parts = next.split("\n");
			this.buffers.set(socket, parts.pop() ?? "");
			for (const part of parts) {
				if (!part.trim()) continue;
				let message;
				try {
					message = JSON.parse(part);
				} catch {
					socket.destroy();
					return;
				}
				if (!authed) {
					if (!this.helloOk(message)) {
						socket.destroy();
						return;
					}
					authed = true;
					clearTimeout(timer);
					this.accept(socket, message);
					continue;
				}
				if (isPrompt(message)) this.onPrompt(message.text);
				else if (isQuestionAnswer(message)) this.onQuestionAnswer(message.id, message.answers);
				else if (isQuestionCancel(message)) this.onQuestionCancel(message.id);
				else this.onControl(message, socket);
			}
		});
		socket.on("close", () => {
			this.sockets.delete(socket);
			this.buffers.delete(socket);
			this.chromeWindows.delete(socket);
			if (this.sockets.size === 0) {
				this.handQuestionBack();
				this.helperPid = void 0;
				this.selection.stop();
				this.foreground.stop();
			}
		});
		socket.on("error", () => {
			socket.destroy();
		});
	}
	helloOk(message) {
		if (typeof message !== "object" || message === null) return false;
		const record = message;
		if (record.type !== "hello" || typeof record.token !== "string") return false;
		const given = Buffer.from(record.token);
		const expected = Buffer.from(this.token);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}
	accept(socket, hello) {
		const pid = asRecord(hello)?.pid;
		if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) this.helperPid = pid;
		this.sockets.add(socket);
		if (this.sessionId) this.send(socket, {
			type: "session",
			sessionId: this.sessionId
		});
		if (this.blockOrder.length === 0 && this.sessionId) {
			this.replaying = true;
			this.drain();
			this.replaying = false;
		} else for (const key of this.blockOrder) {
			const block = this.blocks.get(key);
			if (block) this.send(socket, block);
		}
		this.send(socket, {
			type: "turn",
			running: this.turnRunning
		});
		if (Object.keys(this.appearance).length > 0) this.send(socket, {
			type: "appearance",
			...this.appearance
		});
		if (this.pending) this.send(socket, this.questionPayload(this.pending.id));
		this.publishChrome();
		this.selection.sync();
		this.foreground.start();
		this.pollAgents(true);
	}
	async onPrompt(text) {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.turnInterrupted = false;
		this.block(`user:${randomUUID()}`, "user", trimmed, false, "set");
		this.beginTurn();
		if (this.sessionError && !this.sessionId) {
			this.turnRunning = false;
			this.selection.setSessionRunning(false);
			this.broadcast({
				type: "turn",
				running: false
			});
			this.status(this.sessionError);
			return;
		}
		try {
			this.foreground.restore();
			const sessionId = await this.ensureSession();
			if (!this.timer) this.syncWatermark();
			this.watch();
			await this.ctx.sessionController.prompt({
				requestId: randomUUID(),
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text: trimmed
				}],
				clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
			}, new AbortController().signal);
			this.drain();
		} catch (error) {
			this.finishTurn();
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: prompt failed: ${message}`);
			this.status(message);
		}
	}
	async ensureSession() {
		if (this.sessionId) return this.sessionId;
		this.creating ??= this.createSession().finally(() => {
			this.creating = void 0;
		});
		return this.creating;
	}
	async createSession() {
		const workspaceId = await this.workspaceId();
		const saved = await readSavedSession(this.sessionFile);
		if (saved !== void 0) {
			if (await this.openConversation(saved)) return this.adopt(saved);
			console.error("dsh-orb: saved session cannot be opened; creating a new one");
			await rm(this.sessionFile, { force: true });
		}
		const session = await this.ctx.sessionController.create({
			workspaceId,
			agentPreset: "computer-use"
		});
		return this.adopt(session.sessionId);
	}
	/**
	* Make one stored or already-live conversation current, keeping its identity.
	*
	* `sessionController.create` cannot open a conversation that has any history. Since dsh 0.2.1 a
	* named Session is reused only while it is still blank; one that has started a turn "stays
	* unchanged, and a new Session is created instead" — which is how clicking a history row used to
	* land the ball in an empty untitled chat. `resolveAgent` is the documented resolve-or-resume
	* entry: it keeps a live Agent, resumes a cold one, and re-mounts the preset the Session recorded.
	*/
	async openConversation(sessionId) {
		try {
			const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
			if ("error" in resolved) {
				const reason = resolved.error instanceof Error ? resolved.error.message : JSON.stringify(resolved.error);
				console.error(`dsh-orb: session ${sessionId} cannot be opened: ${reason}`);
				return false;
			}
			return true;
		} catch (error) {
			console.error(`dsh-orb: session ${sessionId} cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
	workspaceId() {
		this.workspaceTask ??= this.createWorkspace().catch((error) => {
			this.workspaceTask = void 0;
			throw error;
		});
		return this.workspaceTask;
	}
	async createWorkspace() {
		const workspace = dshHomePath("dsh_orb");
		await mkdir(workspace, { recursive: true });
		return (await this.ctx.workspaceController.create({ path: workspace })).workspace.workspaceId;
	}
	async adopt(sessionId) {
		const id = await this.remember(sessionId);
		await this.applyOverlayQuiet(id);
		pinSessionId(this.ctx, id, this.store.permission());
		return id;
	}
	async remember(sessionId) {
		this.sessionId = sessionId;
		this.sessionError = void 0;
		publishScreenOwner(sessionId);
		try {
			await mkdir(dirname(this.sessionFile), { recursive: true });
			await writeFile(this.sessionFile, `${JSON.stringify({ sessionId })}\n`);
		} catch (error) {
			console.error(`dsh-orb: could not save session id: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.broadcast({
			type: "session",
			sessionId
		});
		console.error(`dsh-orb: session ${sessionId}`);
		return sessionId;
	}
	syncWatermark() {
		if (!this.sessionId) return;
		const session = this.ctx.sessions.get(this.sessionId);
		if (!session) return;
		for (const event of session.snapshotEvents()) {
			const seq = Number(event.seq);
			if (seq > this.watermark) this.watermark = seq;
		}
	}
	watch() {
		if (!this.timer) this.timer = setInterval(() => this.drain(), 400);
		this.armIdle();
	}
	/** Warn after 3 quiet minutes, but keep polling until the session goes idle. */
	armIdle() {
		if (this.giveUp) clearTimeout(this.giveUp);
		this.giveUp = setTimeout(() => {
			if (!this.turnRunning) return;
			if (this.pending) {
				this.armIdle();
				return;
			}
			if (!this.idleWarned) {
				this.idleWarned = true;
				this.status("等待超时");
			}
		}, 18e4);
	}
	stopWatch() {
		if (this.timer) clearInterval(this.timer);
		this.timer = void 0;
		if (this.giveUp) clearTimeout(this.giveUp);
		this.giveUp = void 0;
	}
	drain() {
		if (!this.sessionId) return;
		const session = this.ctx.sessions.get(this.sessionId);
		if (!session) {
			if (!this.missingLogged) {
				this.missingLogged = true;
				console.error("dsh-orb: session is not in the store yet");
			}
			return;
		}
		this.missingLogged = false;
		let fresh = false;
		try {
			for (const event of session.snapshotEvents()) {
				const seq = Number(event.seq);
				if (seq <= this.watermark) continue;
				this.watermark = seq;
				fresh = true;
				this.consume(event.type, event.data, seq);
			}
		} catch (error) {
			console.error(`dsh-orb: transcript read failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (fresh && this.turnRunning) {
			this.idleWarned = false;
			this.armIdle();
		}
	}
	consume(type, data, seq) {
		if (type === "user/message") {
			const record = asRecord(data);
			const sourceKind = asRecord(record?.source)?.kind;
			if (sourceKind === "user" || sourceKind === void 0) {
				if (!this.replaying) return;
				const text = userText(data);
				if (!text.trim()) return;
				this.block(`user:${seq}`, "user", text, false, "set");
				return;
			}
			const text = stripNoticeGuards(textOf(record?.content));
			if (!isCompletionNotice(text)) return;
			this.block(`notice:${seq}`, "notice", text, false, "set");
			return;
		}
		if (type === "turn/start") {
			if (this.turnRunning) return;
			this.turnInterrupted = false;
			this.beginTurn();
			this.armIdle();
			return;
		}
		if (type === "assistant/chunk") {
			this.onChunk(data);
			return;
		}
		if (type === "assistant/message") {
			this.onAssistant(data);
			return;
		}
		if (type === "tool/call") {
			const name = toolName(data);
			if (!name) return;
			const id = callId(data);
			const existing = id ? void 0 : this.runningTool(name);
			const key = id ? `tool:${id}` : existing ?? `tool:${seq}`;
			this.block(key, "tool", name, false, "set", { args: clip(toolArguments(data), 4e3) });
			return;
		}
		if (type === "tool/result") {
			this.onToolResult(data);
			return;
		}
		if (type === "turn/end") this.finishTurn();
	}
	/** Join a settled result to its call by id, carrying error state and meta. */
	onToolResult(data) {
		const record = asRecord(data);
		if (!record) return;
		const id = callId(record);
		const message = asRecord(record.message);
		const callIdValue = id || (message ? callIdValueOf(message) : "");
		if (!callIdValue) return;
		const key = `tool:${callIdValue}`;
		const existing = this.blocks.get(key);
		const name = existing?.kind === "tool" ? existing.text : toolName(record) || "";
		const content = Array.isArray(message?.content) ? message?.content : [];
		const error = asRecord(record.error);
		const detail = {
			args: existing?.detail?.args ?? "",
			result: clip(resultText(content, error ?? void 0), 8e3),
			isError: message?.isError === true,
			...error === void 0 ? {} : { error: {
				name: typeof error.name === "string" ? error.name : "Error",
				code: typeof error.code === "string" ? error.code : "unknown",
				...typeof error.reason === "string" ? { reason: clip(error.reason, 2e3) } : {}
			} },
			meta: clip(jsonText(record.meta), 12e3),
			cwd: this.sessionCwd()
		};
		this.block(key, "tool", name, false, "set", detail);
	}
	sessionCwd() {
		if (!this.sessionId) return "";
		return this.ctx.sessions.get(this.sessionId)?.header?.cwd ?? "";
	}
	onChunk(data) {
		const record = asRecord(data);
		const chunk = asRecord(record?.chunk);
		if (!record || !chunk) return;
		const turn = numberOf(record.turn);
		const step = numberOf(record.step);
		const index = numberOf(chunk.index);
		const key = `b:${turn}:${step}:${index}`;
		this.liveStep = `${turn}:${step}`;
		try {
			if (chunk.type === "text-delta" && typeof chunk.text === "string") {
				this.block(key, "assistant", chunk.text, true, "append");
				return;
			}
			if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
				this.block(key, "reasoning", chunk.text, true, "append");
				return;
			}
			if (chunk.type === "tool-call-delta") {
				const name = typeof chunk.name === "string" ? chunk.name : "";
				if (!name) return;
				const id = typeof chunk.id === "string" ? chunk.id : "";
				const delta = typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "";
				const toolKey = id ? `tool:${id}` : `b:${turn}:${step}:${index}`;
				const previous = this.blocks.get(toolKey);
				this.block(toolKey, "tool", name, true, "set", { args: clip(`${previous?.detail?.args ?? ""}${delta}`, 4e3) });
				return;
			}
			if (chunk.type === "block-end") this.applyContent(key, chunk.block, false);
		} finally {
			this.liveStep = void 0;
		}
	}
	/**
	* Settle one assistant message like Harness settleAssistant: the transient
	* streamed blocks are consumed in place (kind + order) and whatever the
	* message did not claim is dropped, so no stale copy can survive the fold.
	*/
	onAssistant(data) {
		const record = asRecord(data);
		if (!record) return;
		const turn = numberOf(record.turn);
		const step = numberOf(record.step);
		const usage = readUsage(record.usage);
		const previous = this.responseKeys;
		this.responseKeys = [];
		for (const key of previous) {
			const item = this.blocks.get(key);
			if (item?.response === true) this.block(key, item.kind, item.text, false, "set");
		}
		if (record.interrupted === true) this.turnInterrupted = true;
		const content = asRecord(record.message)?.content;
		const parts = typeof content === "string" ? [{
			type: "text",
			text: content
		}] : Array.isArray(content) ? content : [];
		const transient = this.stepBlocks.get(`${turn}:${step}`) ?? [];
		this.stepBlocks.delete(`${turn}:${step}`);
		const writtenKeys = [];
		let cursor = 0;
		for (const [index, part] of parts.entries()) {
			const wanted = partKind(asRecord(part));
			let key;
			if (wanted !== void 0) while (cursor < transient.length) {
				const candidate = transient[cursor];
				cursor += 1;
				if (this.blocks.get(candidate)?.kind === wanted) {
					key = candidate;
					break;
				}
				this.dropBlock(candidate);
			}
			key ??= `b:${turn}:${step}:${index}`;
			const written = this.applyContent(key, part, false);
			if (written === void 0 || written !== key) this.dropBlock(key);
			if (written !== void 0) writtenKeys.push(written);
		}
		while (cursor < transient.length) {
			this.dropBlock(transient[cursor]);
			cursor += 1;
		}
		this.responseKeys = writtenKeys;
		if (usage !== void 0) {
			const last = [...writtenKeys].reverse().find((key) => this.blocks.get(key)?.kind === "assistant");
			const settled = last === void 0 ? void 0 : this.blocks.get(last);
			if (last !== void 0 && settled) this.block(last, settled.kind, settled.text, false, "set", void 0, usage);
		}
	}
	/** Remove one block everywhere: map, order, and the ball's DOM. */
	dropBlock(key) {
		if (!this.blocks.delete(key)) return;
		const at = this.blockOrder.indexOf(key);
		if (at >= 0) this.blockOrder.splice(at, 1);
		this.dirty.delete(key);
		this.publish({
			type: "block-drop",
			key
		});
	}
	/** Write one content part. Returns the key it landed on, or `undefined` when the part is skipped. */
	applyContent(key, part, running) {
		const block = asRecord(part);
		if (!block) return void 0;
		if ((block.type === "text" || block.type === "reasoning" || block.type === "thinking") && typeof block.text === "string") {
			if (!block.text.trim()) return void 0;
			const kind = block.type === "text" ? "assistant" : "reasoning";
			this.block(key, kind, block.text, running, "set");
			return key;
		}
		if (block.type !== "tool-call" && block.type !== "tool_use") return void 0;
		const name = typeof block.name === "string" ? block.name : "";
		if (!name) return void 0;
		const id = typeof block.id === "string" ? block.id : typeof block.callId === "string" ? block.callId : "";
		const toolKey = id ? `tool:${id}` : key;
		this.block(toolKey, "tool", name, running, "set", { args: clip(typeof block.arguments === "string" ? block.arguments : "", 4e3) });
		return toolKey;
	}
	runningTool(name) {
		for (const key of this.blockOrder) {
			const block = this.blocks.get(key);
			if (block?.kind === "tool" && block.text === name && block.running) return key;
		}
	}
	/**
	* Start (or adopt) a turn. The epoch is what lets stopTurn tell whether its await
	* still owns the turn it was asked to cancel.
	*/
	beginTurn() {
		this.turnEpoch += 1;
		this.turnRunning = true;
		this.selection.setSessionRunning(true);
		this.broadcast({
			type: "turn",
			running: true
		});
	}
	finishTurn() {
		this.turnRunning = false;
		this.idleWarned = false;
		this.selection.setSessionRunning(false);
		for (const key of [...this.blockOrder]) if (this.blocks.get(key)?.running) this.settleBlock(key);
		this.stepBlocks.clear();
		this.lastAttemptByStep.clear();
		for (const key of [...this.responseKeys]) {
			const item = this.blocks.get(key);
			if (item) this.block(key, item.kind, item.text, false, "set");
		}
		this.responseKeys = [];
		this.broadcast({
			type: "turn",
			running: false,
			...this.turnInterrupted ? { interrupted: true } : {}
		});
		this.turnInterrupted = false;
		if (this.giveUp !== void 0) {
			clearTimeout(this.giveUp);
			this.giveUp = void 0;
		}
		const reply = [...this.blockOrder].reverse().map((key) => this.blocks.get(key)).find((item) => item?.kind === "assistant");
		console.error(`dsh-orb: turn done reply=${reply?.text.length ?? 0}`);
	}
	/** Flip one leftover running block to settled, bypassing the empty-text guard in {@link block}. */
	settleBlock(key) {
		const previous = this.blocks.get(key);
		if (!previous) return;
		const message = {
			...previous,
			running: false,
			...this.turnInterrupted && previous.kind === "assistant" ? { interrupted: true } : {}
		};
		this.blocks.set(key, message);
		this.dirty.delete(key);
		this.publish(message);
	}
	block(key, kind, text, running, mode, detail, usage) {
		const previous = this.blocks.get(key);
		const previousText = previous?.text ?? "";
		const next = clip(mode === "append" ? `${previousText}${text}` : text, 2e4);
		if (!next.trim() && kind !== "tool") return;
		const mergedDetail = detail === void 0 ? previous?.detail : {
			args: detail.args ?? previous?.detail?.args ?? "",
			result: detail.result ?? previous?.detail?.result ?? "",
			isError: detail.isError ?? previous?.detail?.isError ?? false,
			error: detail.error ?? previous?.detail?.error,
			meta: detail.meta ?? previous?.detail?.meta ?? "",
			cwd: detail.cwd ?? previous?.detail?.cwd ?? ""
		};
		const merged = mergedDetail === void 0 ? void 0 : {
			...mergedDetail,
			...mergedDetail.error === void 0 ? {} : { error: mergedDetail.error }
		};
		const mergedUsage = usage === void 0 ? previous?.usage : usage;
		const message = {
			type: "block",
			key,
			kind,
			text: next,
			running,
			...this.turnInterrupted && kind === "assistant" && !running ? { interrupted: true } : {},
			...this.responseKeys.includes(key) ? { response: true } : {},
			...merged === void 0 ? {} : { detail: merged },
			...mergedUsage === void 0 ? {} : { usage: mergedUsage }
		};
		if (!this.blocks.has(key)) {
			this.blockOrder.push(key);
			if (this.liveStep !== void 0) {
				const tracked = this.stepBlocks.get(this.liveStep);
				if (tracked) tracked.push(key);
				else this.stepBlocks.set(this.liveStep, [key]);
			}
			while (this.blockOrder.length > 200) {
				const oldest = this.blockOrder[0];
				if (oldest === void 0) break;
				if (!this.blocks.has(oldest)) {
					this.blockOrder.shift();
					continue;
				}
				this.dropBlock(oldest);
			}
		}
		this.blocks.set(key, message);
		if (running) {
			this.dirty.add(key);
			this.dirtyTimer ??= setTimeout(() => this.flushDirty(), 60);
			return;
		}
		this.dirty.delete(key);
		this.publish(message);
	}
	/** Broadcast with global FIFO: pending coalesced updates go out before anything newer. */
	publish(message) {
		this.flushDirty();
		this.broadcast(message);
	}
	/** Coalesce per-token running-block updates; settled blocks always go out immediately. */
	flushDirty() {
		this.dirtyTimer = void 0;
		const keys = [...this.dirty];
		this.dirty.clear();
		for (const key of keys) {
			const message = this.blocks.get(key);
			if (message) this.broadcast(message);
		}
	}
	clearDirty() {
		if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
		this.dirtyTimer = void 0;
		this.dirty.clear();
	}
	status(text) {
		this.broadcast({
			type: "status",
			text: clip(text, 500)
		});
	}
	onQuestion(request, next) {
		const agentId = typeof request.agent?.id === "string" ? request.agent.id : "";
		const questions = sanitizeQuestions(request.questions);
		if (this.sockets.size === 0 || !this.sessionId || agentId !== this.sessionId || this.pending || questions.length === 0) {
			if (this.sessionId && agentId === this.sessionId) console.error(`dsh-orb: question deferred sockets=${this.sockets.size} pending=${this.pending !== void 0} count=${questions.length}`);
			return next();
		}
		console.error(`dsh-orb: question card ${questions.length}`);
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.pending = {
				id,
				resolve,
				reject,
				next
			};
			this.questionBody = questions;
			this.broadcast(this.questionPayload(id));
			const signal = request.signal;
			const onAbort = () => {
				this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED", id);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	onQuestionAnswer(id, answers) {
		const pending = this.pending;
		if (!pending || pending.id !== id) return;
		const parsed = parseAnswers(answers);
		if (!parsed) {
			this.broadcast({
				type: "question-error",
				id,
				text: "答案无效"
			});
			return;
		}
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id
		});
		console.error("dsh-orb: question answered");
		pending.resolve(parsed);
	}
	onQuestionCancel(id) {
		this.failQuestion("the user cancelled ask_user_question", "ASK_CANCELLED", id);
	}
	/** The ball is gone, so the main window can answer. Abort and cancel still reject. */
	handQuestionBack() {
		const pending = this.pending;
		if (!pending) return;
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id: pending.id
		});
		console.error("dsh-orb: question returned to the main window");
		pending.next().then(pending.resolve, pending.reject);
	}
	failQuestion(message, code, id = this.pending?.id) {
		const pending = this.pending;
		if (!pending || pending.id !== id) return;
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id
		});
		console.error(`dsh-orb: question ${code}`);
		pending.reject(questionError(message, code));
	}
	questionPayload(id) {
		return {
			type: "question",
			id,
			questions: this.questionBody ?? []
		};
	}
	broadcast(message) {
		for (const socket of this.sockets) this.send(socket, message);
	}
	/**
	* Every chrome handle the connected helpers reported.
	* The Windows observation walk skips these, so the ball never becomes the window the
	* agent believes the user is working in. Empty on macOS, where the ball is a
	* non-activating panel and the helper reports nothing.
	*/
	chromeWindowIds() {
		const ids = [];
		for (const reported of this.chromeWindows.values()) for (const id of reported) if (!ids.includes(id)) ids.push(id);
		return ids;
	}
	send(socket, message) {
		try {
			socket.write(`${JSON.stringify(message)}\n`);
		} catch {
			socket.destroy();
		}
	}
	launch() {
		if (this.halted || !this.binary) return;
		const generation = this.generation;
		const userData = this.userData || helperDataDirectory(this.store.dir);
		const env = {
			...process.env,
			DSH_ORB_TOKEN: this.token,
			DSH_ORB_SOCKET: `127.0.0.1:${this.port}`,
			DSH_ORB_WEB_PORT: String(this.ctx.webServer.port),
			...Object.keys(this.appearance).length > 0 ? { DSH_ORB_APPEARANCE: JSON.stringify(this.appearance) } : {}
		};
		delete env.ELECTRON_RUN_AS_NODE;
		const child = spawn(this.binary, [`--user-data-dir=${userData}`, helperMain()], {
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		console.error(`dsh-orb: helper started pid ${child.pid ?? "unknown"}`);
		setTimeout(() => {
			if (this.child === child) this.failures = 0;
		}, 6e4).unref();
		const token = this.token;
		const log = (chunk) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim() || line.includes(token) || /token=|api[_-]?key|authorization/i.test(line)) continue;
				console.error(`dsh-orb helper: ${line}`);
			}
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", log);
		child.stderr?.on("data", log);
		let settled = false;
		const fail = (reason) => {
			if (settled || this.halted || generation !== this.generation) return;
			settled = true;
			if (this.child === child) this.child = void 0;
			this.failures += 1;
			const delay = HELPER_RETRY_DELAYS_MS[this.failures - 1];
			if (delay === void 0) {
				this.helperError = "helper-exited";
				console.error("dsh-orb: helper exited too many times; ball stays hidden");
				return;
			}
			console.error(`dsh-orb: helper exited (${reason}); retry ${this.failures}`);
			this.retry = setTimeout(() => this.launch(), delay);
			this.retry.unref();
		};
		child.once("error", (error) => fail(error.message));
		child.once("exit", (code, signal) => fail(String(code ?? signal)));
	}
	killChild() {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		const pid = child.pid;
		if (pid === void 0) return;
		setTimeout(() => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}, 1e3).unref();
	}
	/** True when the helper presented this socket token. */
	helperAuthorized(token) {
		return tokensMatch(token, this.token);
	}
	/** Push permission, both models, the catalog, and the avatar version to the ball. */
	async publishChrome() {
		const models = this.store.models();
		let catalog = { groups: [] };
		try {
			catalog = normalizeCatalog(await this.ctx.sessionController.modelCatalog());
		} catch (error) {
			console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.broadcast({
			type: "permission",
			preset: this.store.permission()
		});
		this.broadcast({
			type: "chrome",
			overlay: models.overlay,
			background: models.background,
			millifractionEnabled: this.store.millifractionEnabled(),
			openMain: isDesktopHost(),
			update: this.updateAvailable,
			catalog
		});
		this.broadcast(avatarMessage(this.store));
	}
	/**
	* Remember the version the check found and tell the ball.
	* The menu row and the status line both come from this; the settings page reads the checker.
	*/
	setUpdateAvailable(version) {
		if (this.updateAvailable === version) return;
		this.updateAvailable = version;
		if (version !== null) this.broadcast({
			type: "update",
			state: "available",
			version
		});
		this.publishChrome();
	}
	/**
	* Store the theme/locale preferences the ball mirrors and push them to a
	* connected helper. The raw preference travels; the helper resolves
	* `system` and an absent locale against its own environment.
	*/
	setAppearance(appearance) {
		const next = {
			...appearance.theme === void 0 ? {} : { theme: appearance.theme },
			...appearance.locale === void 0 ? {} : { locale: appearance.locale }
		};
		this.appearance = next;
		if (Object.keys(next).length > 0) this.broadcast({
			type: "appearance",
			...next
		});
	}
	async setOverlayModel(selection) {
		this.store.setOverlay(selection);
		if (this.sessionId) await this.applyOverlayQuiet(this.sessionId);
		await this.publishChrome();
	}
	async setBackgroundModel(selection) {
		this.store.setBackground(selection);
		await this.publishChrome();
	}
	async setSelectionEnabled(enabled) {
		this.store.setSelectionEnabled(enabled);
		this.selection.sync();
		await this.publishChrome();
	}
	async setMillifractionEnabled(enabled) {
		if (this.store.millifractionEnabled() === enabled) return;
		this.store.setMillifractionEnabled(enabled);
		if (this.sessionId) await this.newSession();
		else await this.publishChrome();
	}
	/** The observation ribbon. Turning it off takes any live frame down at once. */
	async setObservationFrameEnabled(enabled) {
		if (this.store.observationFrameEnabled() === enabled) return;
		this.store.setObservationFrameEnabled(enabled);
		if (!enabled) await this.overlay.setObservationFrame(null);
	}
	async setBallEnabled(enabled) {
		this.store.setBallEnabled(enabled);
		if (process.platform === "linux") return;
		if (enabled) {
			this.runtimeRetries = 0;
			this.start().catch((error) => {
				console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
			});
			return;
		}
		this.halt();
	}
	/** Take the checker the plugin entry owns. Without one the settings page hides its update card. */
	useUpdater(updater) {
		this.updater = updater;
		this.setUpdateAvailable(updater.availableVersion());
	}
	updateState() {
		return this.updater?.state() ?? EMPTY_UPDATE_STATE;
	}
	async checkUpdate() {
		await this.updater?.check(true);
		this.setUpdateAvailable(this.updater?.availableVersion() ?? null);
	}
	/**
	* Start the upgrade and return at once; the settings page polls {@link updateState}.
	* The ball hears the outcome through the same status line every other action uses.
	*/
	installUpdate(approvedBuilds) {
		const updater = this.updater;
		if (updater === void 0) return;
		const version = updater.availableVersion();
		if (version === null) return;
		this.run("update", async () => {
			this.broadcast({
				type: "update",
				state: "starting",
				version
			});
			await updater.install(approvedBuilds);
			const state = updater.state();
			this.setUpdateAvailable(updater.availableVersion());
			if (state.error !== null) {
				this.broadcast({
					type: "update",
					state: "failed",
					version,
					reason: state.pendingBuilds.length > 0 ? "build-blocked" : state.error
				});
				return;
			}
			this.broadcast({
				type: "update",
				state: state.deferred ? "deferred" : "done",
				version,
				restart: state.restartRequired
			});
		});
	}
	setAutoCheck(enabled) {
		this.updater?.setAutoCheck(enabled);
	}
	onControl(message, socket) {
		const record = asRecord(message);
		if (!record || typeof record.type !== "string") return;
		if (record.type === "chrome-windows") {
			this.chromeWindows.set(socket, readWindowIds(record.ids));
			return;
		}
		if (record.type === "overlay-ack" && typeof record.id === "string") {
			this.overlayWaiters.get(record.id)?.();
			this.overlayWaiters.delete(record.id);
			return;
		}
		if (record.type === "selection-action" && typeof record.action === "string") {
			this.onSelectionAction(record);
			return;
		}
		if (record.type === "history") {
			this.run("history", () => this.sendHistory());
			return;
		}
		if (record.type === "open" && typeof record.sessionId === "string") {
			this.run("open", () => this.openSession(record.sessionId));
			return;
		}
		if (record.type === "agent-open" && typeof record.sessionId === "string") {
			this.run("agent-open", () => this.openAgent(record.sessionId));
			return;
		}
		if (record.type === "agent-dismiss" && typeof record.sessionId === "string") {
			this.run("agent-dismiss", () => this.dismissAgent(record.sessionId));
			return;
		}
		if (record.type === "new") {
			this.run("new", () => this.newSession());
			return;
		}
		const preset = record.preset;
		if (record.type === "permission" && isPermissionPreset(preset)) {
			this.run("permission", () => this.setPermission(preset));
			return;
		}
		if (record.type === "stop") {
			this.run("stop", () => this.stopTurn());
			return;
		}
		if (record.type === "menu") {
			this.run("menu", () => this.publishChrome());
			return;
		}
		const selection = record.selection;
		if (record.type === "set-overlay" && isAgentModelSelection(selection)) {
			this.run("overlay-model", () => this.setOverlayModel(selection));
			return;
		}
		if (record.type === "set-background" && isAgentModelSelection(selection)) {
			this.run("background-model", () => this.setBackgroundModel(selection));
			return;
		}
		if (record.type === "set-selection" && typeof record.enabled === "boolean") {
			this.run("selection", () => this.setSelectionEnabled(record.enabled === true));
			return;
		}
		if (record.type === "set-millifraction" && typeof record.enabled === "boolean") {
			this.run("millifraction", () => this.setMillifractionEnabled(record.enabled === true));
			return;
		}
		if (record.type === "disable") {
			this.run("disable", () => this.setBallEnabled(false));
			return;
		}
		if (record.type === "update") {
			this.installUpdate();
			return;
		}
		if (record.type === "open-main") {
			this.run("open-main", () => this.openMain());
			return;
		}
		if (record.type === "open-settings") {
			this.run("open-settings", () => this.openSettings());
			return;
		}
		if (record.type === "tcc") {
			this.broadcast({
				type: "tcc",
				status: this.tcc.status()
			});
			return;
		}
		if (record.type === "tcc-open" && isTccRight(record.right)) {
			const right = record.right;
			this.run("tcc", async () => {
				await this.tcc.open(right);
				this.broadcast({
					type: "tcc",
					status: this.tcc.status()
				});
			});
		}
	}
	/** Keep a failed ball action inside this plugin. An unhandled rejection exits the official host. */
	run(label, task) {
		task().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: ${label} failed: ${message}`);
			this.status(message);
		});
	}
	async setPermission(preset) {
		this.store.setPermission(preset);
		if (this.sessionId) pinSessionId(this.ctx, this.sessionId, preset);
		await this.publishChrome();
	}
	async stopTurn() {
		const sessionId = this.sessionId;
		if (!sessionId || !this.turnRunning) return;
		const epoch = this.turnEpoch;
		try {
			await this.ctx.sessionController.cancel({ sessionId });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: cancel failed: ${message}`);
			this.status(message);
			return;
		}
		if (this.turnEpoch !== epoch || this.sessionId !== sessionId) return;
		this.drain();
		this.finishTurn();
	}
	async newSession() {
		this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED");
		const session = await this.ctx.sessionController.create({
			workspaceId: await this.workspaceId(),
			agentPreset: "computer-use"
		});
		await this.adopt(session.sessionId);
		this.resetTranscript();
		await this.publishChrome();
	}
	async openSession(sessionId) {
		if (!sessionId.startsWith("session-") || sessionId.length > 80) return;
		const row = (await this.historyRecords()).find((item) => item.sessionId === sessionId);
		if (!row) return;
		this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED");
		if (!await this.openConversation(sessionId)) return;
		await this.adopt(sessionId);
		this.resetTranscript();
		this.replaying = true;
		this.drain();
		this.replaying = false;
		if (row.running) {
			this.beginTurn();
			this.watch();
		}
	}
	async sendHistory() {
		const current = this.sessionId;
		const items = (await this.historyRecords()).slice(0, 40).map((row) => ({
			sessionId: row.sessionId,
			title: row.title,
			current: row.sessionId === current
		}));
		this.broadcast({
			type: "history",
			items
		});
	}
	async historyRecords() {
		try {
			const listed = await this.ctx.sessionController.list({}, AbortSignal.timeout(15e3));
			const rows = Array.isArray(listed) ? listed : listed.items ?? [];
			const orb = resolve(dshHomePath("dsh_orb"));
			const items = [];
			for (const row of rows) {
				const record = asRecord(row);
				if (!record || !isHistoryRow(record, orb) || typeof record.sessionId !== "string") continue;
				const title = projection(record, "title");
				items.push({
					sessionId: record.sessionId,
					title: typeof title === "string" ? title.slice(0, 200) : "",
					running: record.running === true
				});
			}
			return items;
		} catch (error) {
			console.error(`dsh-orb: history failed: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}
	resetTranscript() {
		this.blocks.clear();
		this.blockOrder.length = 0;
		this.watermark = 0;
		this.turnRunning = false;
		this.attemptPositions.clear();
		this.lastAttemptByStep.clear();
		this.stepBlocks.clear();
		this.liveStep = void 0;
		this.responseKeys = [];
		this.clearDirty();
		this.selection.setSessionRunning(false);
		this.broadcast({ type: "reset" });
		this.broadcast({
			type: "turn",
			running: false
		});
	}
	onSelectionAction(record) {
		if (record.action === "search") this.selection.search();
		else if (record.action === "translate") this.selection.translate();
		else if (record.action === "send") this.selection.sendToAgent();
		else if (record.action === "language" && (record.language === "zh" || record.language === "en")) this.selection.setLanguage(record.language);
	}
	waitAck(message, signal) {
		if (this.sockets.size === 0) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.overlayWaiters.delete(message.id);
				if (error === void 0) resolve();
				else reject(error);
			};
			const timer = setTimeout(() => {
				finish(/* @__PURE__ */ new Error("dsh-orb: overlay ack timed out"));
			}, OVERLAY_GUARD_ACK_TIMEOUT_MS);
			timer.unref();
			const onAbort = () => {
				finish(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("dsh-orb: overlay ack aborted"));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.overlayWaiters.set(message.id, () => {
				finish(void 0);
			});
			this.broadcast(message);
		});
	}
	async applyOverlayQuiet(sessionId) {
		const selection = this.store.models().overlay;
		try {
			await selectModelKeepDefault(this.ctx, {
				sessionId,
				provider: selection.provider,
				model: selection.model,
				...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
			});
		} catch (error) {
			console.error(`dsh-orb: overlay model failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async openMain() {
		if (!isDesktopHost()) return;
		await openMainWindow(this.ctx);
	}
	/**
	* The ball's "open floating-ball settings" click: arm the request the main window's
	* client plugin polls for, then bring that window forward. The window may be closed —
	* the target outlives the launch (`MAIN_WINDOW_TARGET_TTL_MS`) so a cold start still
	* lands on the settings page.
	*/
	async openSettings() {
		this.settingsTarget = { at: Date.now() };
		await this.openMain();
	}
	startAgentPoll() {
		if (this.agentTimer) return;
		this.agentTimer = setInterval(() => this.pollAgents(), AGENT_POLL_MS);
	}
	/**
	* The always-on polls: the bookmark registry, and the transcript drain. The
	* latter runs for the whole helper lifetime, not just during ball-initiated
	* turns — completion notices can wake the session into a new turn at any time.
	*/
	startPolls() {
		this.startAgentPoll();
		this.watch();
	}
	stopAgentPoll() {
		if (this.agentTimer) clearInterval(this.agentTimer);
		this.agentTimer = void 0;
		this.lastAgentsPayload = "";
	}
	/**
	* Poll the code-agent bookmark registry and push the strip on change.
	* The registry is provided by the preset's code-agent plugin; without it
	* (preset not mounted) the strip simply stays empty.
	*/
	pollAgents(force = false) {
		if (this.sockets.size === 0) return;
		const registry = this.agentRegistry();
		if (registry === void 0) return;
		let items;
		try {
			items = this.agentItems(registry);
		} catch (error) {
			console.error(`dsh-orb: agent bookmarks failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		this.refreshCallerTitles();
		const payload = JSON.stringify(items);
		if (!force && payload === this.lastAgentsPayload) return;
		this.lastAgentsPayload = payload;
		this.broadcast({
			type: "agents",
			items
		});
	}
	agentRegistry() {
		try {
			const registry = this.ctx.get(CODE_AGENT_REGISTRY);
			return registry !== void 0 && typeof registry.list === "function" ? registry : void 0;
		} catch {
			return;
		}
	}
	/** Running first (oldest start at the top), finished after (newest first); read ones dropped. */
	agentItems(registry) {
		const bookmarks = registry.list();
		for (const bookmark of bookmarks) if (bookmark.state === "running") this.readAgentIds.delete(bookmark.sessionId);
		const visible = bookmarks.filter((bookmark) => bookmark.state === "running" || !this.readAgentIds.has(bookmark.sessionId));
		visible.sort((left, right) => {
			const leftRunning = left.state === "running";
			if (leftRunning !== (right.state === "running")) return leftRunning ? -1 : 1;
			if (leftRunning) return left.startedAt - right.startedAt;
			return (right.endedAt ?? 0) - (left.endedAt ?? 0);
		});
		const titles = this.callerTitles?.byId;
		return visible.map((bookmark) => ({
			sessionId: bookmark.sessionId,
			callerId: bookmark.callerId,
			task: bookmark.task,
			cwd: bookmark.cwd,
			startedAt: bookmark.startedAt,
			state: bookmark.state,
			colorIndex: this.callerColor(bookmark.callerId),
			callerTitle: titles?.get(bookmark.callerId) ?? "",
			unread: bookmark.state !== "running" && !this.readAgentIds.has(bookmark.sessionId),
			...bookmark.endedAt === void 0 ? {} : { endedAt: bookmark.endedAt },
			...bookmark.outcome === void 0 ? {} : { outcome: bookmark.outcome }
		}));
	}
	callerColor(callerId) {
		let index = this.callerColors.get(callerId);
		if (index === void 0) {
			index = this.callerColors.size % AGENT_COLOR_COUNT;
			this.callerColors.set(callerId, index);
		}
		return index;
	}
	/** Caller conversation titles for the tooltips, refreshed at most every 10 seconds. */
	refreshCallerTitles() {
		if (this.callerTitles !== void 0 && Date.now() - this.callerTitles.at < 1e4) return;
		this.callerTitlesTask ??= this.historyRecords().then((rows) => {
			const byId = /* @__PURE__ */ new Map();
			for (const row of rows) if (row.title !== "") byId.set(row.sessionId, row.title);
			this.callerTitles = {
				at: Date.now(),
				byId
			};
		}).catch(() => {}).finally(() => {
			this.callerTitlesTask = void 0;
		});
	}
	/** One-shot jump target for the main window's client plugin. `null` once consumed or expired. */
	takeJump() {
		const target = this.jumpTarget;
		if (target === void 0) return null;
		if (Date.now() - target.at > MAIN_WINDOW_TARGET_TTL_MS) {
			this.jumpTarget = void 0;
			return null;
		}
		return {
			sessionId: target.sessionId,
			at: target.at
		};
	}
	confirmJump(sessionId) {
		if (this.jumpTarget?.sessionId === sessionId) this.jumpTarget = void 0;
	}
	/**
	* The armed floating-ball-settings request, for the main window's client plugin.
	* `null` once confirmed or expired; reading it does not consume it, so a window that
	* cannot open the section yet retries instead of losing the click.
	*/
	takeSettingsOpen() {
		const target = this.settingsTarget;
		if (target === void 0) return null;
		if (Date.now() - target.at > MAIN_WINDOW_TARGET_TTL_MS) {
			this.settingsTarget = void 0;
			return null;
		}
		return { at: target.at };
	}
	confirmSettingsOpen(at) {
		if (this.settingsTarget?.at === at) this.settingsTarget = void 0;
	}
	/**
	* A bookmark click: arm the main window's jump and focus the main window.
	*
	* Only a finished bookmark is consumed. Clicking one that is still running is a plain jump —
	* no matter how often it happens — so the completion that follows still raises an unread
	* bookmark with its outcome.
	*/
	async openAgent(sessionId) {
		if (!sessionId.startsWith("session-") || sessionId.length > 80) return;
		const state = this.bookmarkState(sessionId);
		if (state !== void 0 && state !== "running") {
			this.readAgentIds.add(sessionId);
			this.pollAgents(true);
		}
		this.jumpTarget = {
			sessionId,
			at: Date.now()
		};
		await this.openMain();
	}
	/**
	* Live state of one bookmark, or undefined when no record answers for it (already dropped, or the
	* registry is unavailable). A click falls back to a plain jump in that case.
	*/
	bookmarkState(sessionId) {
		try {
			return this.agentRegistry()?.list().find((bookmark) => bookmark.sessionId === sessionId)?.state;
		} catch {
			return;
		}
	}
	/**
	* The chip's dismiss control: retire a finished bookmark on the spot, without the main-window
	* jump {@link openAgent} performs — the whole point is not having to look at that session.
	*
	* A running stretch has no dismiss control and is refused here too: while it runs the chip is the
	* only trace of the task, and stopping it stays `code_agent_stop`'s job.
	*/
	async dismissAgent(sessionId) {
		if (!sessionId.startsWith("session-") || sessionId.length > 80) return;
		const state = this.bookmarkState(sessionId);
		if (state === void 0 || state === "running") return;
		if (this.readAgentIds.has(sessionId)) return;
		this.readAgentIds.add(sessionId);
		this.pollAgents(true);
	}
};
/** Per-profile Chromium data so desktop and `dsh web` do not share one lock. */
function helperDataDirectory(profileDir) {
	const id = createHash("sha256").update(profileDir).digest("hex").slice(0, 16);
	return dshHomePath("dsh-orb", "helper-data", id);
}
function isPrompt(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	return record.type === "prompt" && typeof record.text === "string" && record.text.length <= 8e3;
}
/**
* Chrome window ids from one helper's `chrome-windows` report.
* A malformed payload yields no ids, which is the pre-report behaviour: the observation
* walk simply excludes nothing.
*/
function readWindowIds(value) {
	if (!Array.isArray(value) || value.length > 16) return [];
	const ids = [];
	for (const entry of value) {
		if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) return [];
		if (!ids.includes(entry)) ids.push(entry);
	}
	return ids;
}
async function readSavedSession(file) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (typeof parsed.sessionId === "string" && parsed.sessionId.startsWith("session-")) return parsed.sessionId;
	} catch {}
}
function toolName(data) {
	if (typeof data !== "object" || data === null) return "";
	const name = data.name;
	return typeof name === "string" ? name : "";
}
/**
* Avatar descriptor for the ball. A preset travels as the relative asset path, so the
* ball reads it off disk: pushing megabytes of GIF through the socket as a data URL
* would stall every chrome publish.
*/
function avatarMessage(store) {
	const version = Math.trunc(store.avatarVersion());
	const selection = store.avatarSelection();
	if (selection.kind === "preset") {
		const src = avatarPresetSrc(selection.id);
		if (src !== void 0) return {
			type: "avatar",
			kind: "preset",
			src,
			version
		};
	}
	return {
		type: "avatar",
		kind: selection.kind === "custom" ? "custom" : "default",
		version
	};
}
function toolArguments(data) {
	if (typeof data !== "object" || data === null) return "";
	const args = data.arguments;
	return typeof args === "string" ? args : "";
}
function callIdValueOf(data) {
	const record = asRecord(data);
	if (!record) return "";
	const id = record.toolCallId ?? record.callId ?? record.id;
	return typeof id === "string" ? id : "";
}
/** Flatten result content blocks to display text (tool-call-model resultText). */
function resultText(content, error) {
	const parts = [];
	if (Array.isArray(content)) for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "text" && typeof record.text === "string") parts.push(record.text);
		else parts.push(JSON.stringify(block, null, 2));
	}
	if (parts.length === 0 && error !== void 0) parts.push(`${typeof error.name === "string" ? error.name : "Error"}: ${typeof error.code === "string" ? error.code : "unknown"}`);
	return parts.join("\n");
}
function jsonText(value) {
	if (value === void 0 || value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
function isQuestionAnswer(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	return record.type === "question-answer" && typeof record.id === "string";
}
function isQuestionCancel(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	return record.type === "question-cancel" && typeof record.id === "string";
}
function isHistoryRow(record, orb) {
	if (record.origin === "subagent") return false;
	if (typeof record.cwd !== "string" || resolve(record.cwd) !== orb) return false;
	const preset = projection(record, "agentPreset");
	return preset === void 0 || preset === "computer-use";
}
function projection(record, key) {
	return asRecord(asRecord(record.projections)?.values)?.[key];
}
function userText(data) {
	const record = asRecord(data);
	if (!record) return "";
	const source = asRecord(record.source);
	if (source && source.kind !== void 0 && source.kind !== "user") return "";
	return textOf(record.content);
}
/**
* Model-facing tails the code_agent completion notices append; the ball shows
* notices to the user, so the instructions come off. Unknown tails stay.
*/
const NOTICE_GUARDS = ["Another Computer Use chat is operating the screen right now. Report this result as text only; do not perform any GUI actions unless the user asks again in this chat.", "Do not restart this task and do not call code_agent for it again unless the user asks."];
/** Only the code_agent completion report becomes a card; the prefix is ours to define. */
function isCompletionNotice(text) {
	return text.startsWith("Background Code agent session ") || text.startsWith("The user stopped background Code agent session ");
}
function stripNoticeGuards(text) {
	let shown = text;
	for (const guard of NOTICE_GUARDS) while (shown.endsWith(guard)) shown = shown.slice(0, shown.length - guard.length).replace(/\n+$/, "");
	return shown;
}
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) {
		const block = asRecord(part);
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function numberOf(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** Validate the provider token-usage payload of an `assistant/message` event. */
function readUsage(value) {
	const record = asRecord(value);
	if (!record) return void 0;
	const count = (raw) => {
		const number = typeof raw === "number" ? raw : NaN;
		return Number.isFinite(number) && number >= 0 ? number : void 0;
	};
	const inputTokens = count(record.inputTokens);
	const outputTokens = count(record.outputTokens);
	if (inputTokens === void 0 || outputTokens === void 0) return void 0;
	return {
		inputTokens,
		outputTokens,
		...count(record.totalTokens) === void 0 ? {} : { totalTokens: count(record.totalTokens) },
		...count(record.cacheReadTokens) === void 0 ? {} : { cacheReadTokens: count(record.cacheReadTokens) },
		...count(record.cacheWriteTokens) === void 0 ? {} : { cacheWriteTokens: count(record.cacheWriteTokens) },
		...count(record.reasoningTokens) === void 0 ? {} : { reasoningTokens: count(record.reasoningTokens) }
	};
}
function partKind(part) {
	if (!part) return void 0;
	if (part.type === "text") return "assistant";
	if (part.type === "reasoning" || part.type === "thinking") return "reasoning";
	if (part.type === "tool-call" || part.type === "tool_use") return "tool";
}
function callId(data) {
	const record = asRecord(data);
	if (!record) return "";
	if (typeof record.id === "string") return record.id;
	if (typeof record.callId === "string") return record.callId;
	if (typeof record.toolCallId === "string") return record.toolCallId;
	const call = asRecord(record.call);
	return typeof call?.id === "string" ? call.id : "";
}
function bounded(value, max) {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : "";
}
function sanitizeQuestions(value) {
	if (!Array.isArray(value)) return [];
	const questions = [];
	for (const item of value.slice(0, 20)) {
		const record = asRecord(item);
		if (!record) continue;
		const id = bounded(record.id, 200);
		const question = bounded(record.question, 4e3);
		if (!id || !question) continue;
		const options = [];
		if (Array.isArray(record.options)) for (const option of record.options.slice(0, 20)) {
			const entry = asRecord(option);
			const label = entry ? bounded(entry.label, 500) : "";
			if (!label) continue;
			const description = entry ? bounded(entry.description, 2e3) : "";
			options.push(description ? {
				label,
				description
			} : { label });
		}
		const detail = bounded(record.detail, 8e3);
		const header = bounded(record.header, 200);
		questions.push({
			id,
			question,
			...detail ? { detail } : {},
			...header ? { header } : {},
			...options.length > 0 ? { options } : {},
			...record.multiSelect === true ? { multiSelect: true } : {}
		});
	}
	return questions;
}
function parseAnswers(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > 20) return void 0;
	const answers = [];
	for (const item of value) {
		const record = asRecord(item);
		if (!record || typeof record.id !== "string" || record.id.length > 200) return void 0;
		if (!Array.isArray(record.selected) || record.selected.length > 20) return void 0;
		const selected = [];
		for (const label of record.selected) {
			if (typeof label !== "string" || label.length > 4e3) return void 0;
			selected.push(label);
		}
		if (record.custom !== void 0 && (typeof record.custom !== "string" || record.custom.length > 4e3)) return void 0;
		const custom = typeof record.custom === "string" ? record.custom : "";
		answers.push({
			id: record.id,
			selected,
			...custom ? { custom } : {}
		});
	}
	return { answers };
}
function questionError(message, code) {
	const error = new Error(message);
	error.name = "UserQuestionError";
	return Object.assign(error, { code });
}
function clip(text, max) {
	return text.length <= max ? text : text.slice(0, max);
}
//#endregion
//#region src/index.ts
/**
* Host-side Orb plugin.
* The ball is a separate Electron process. This plugin owns the socket, the preferences, and the Computer Use session.
*/
/** Cordis plugin name. */
const name = "orb-host";
/** Official services this plugin reads. Missing ones keep it pending. */
const inject = [
	"webServer",
	"connection",
	"sessionController",
	"workspaceController",
	"sessions",
	"agentDefaultModel"
];
/**
* Register preferences, Computer Use services, and settings routes, then start the ball.
* Linux never starts the helper. `autoStart: false` and `ball-enabled.json` leave Computer Use in the main window.
* @param ctx - host services named in {@link inject}.
* @param config - patch config. `autoStart: false` skips the helper until settings turn it back on.
*/
function apply(ctx, config = {}) {
	logWebPort(ctx);
	const own = ownPackage();
	const profile = profileDirectory(ctx);
	const installing = deferredInstallInProgress(profile);
	if (installing) console.error("dsh-orb: an update install is running; the ball waits for it to finish");
	else if (process.platform === "win32" && own !== void 0) stageNativeImages();
	const store = new ProfileStore(profile);
	if (own !== void 0 && !installing) exemptReleaseAge(store.dir, own.name);
	const tcc = new TccMonitor();
	const runtime = new OrbRuntime(ctx, store, { tcc });
	installOrbServices(ctx, store);
	const updater = new UpdateChecker({
		store,
		manager: () => ctx.get("pluginManager"),
		notify: (version) => {
			runtime.setUpdateAvailable(version);
		}
	});
	runtime.useUpdater(updater);
	console.error(`dsh-orb: profile ${store.dir}`);
	console.error(`dsh-orb: version ${updater.state().currentVersion || "unknown"}`);
	ctx.effect(() => {
		const detachQuestions = runtime.attachQuestions();
		const detachPermissions = watchOrbPermissions(ctx, store);
		const detachRoutes = registerOrbRoutes({
			ctx,
			store,
			tcc,
			control: runtime
		});
		const detachAppearance = watchAppearance(ctx, (appearance) => {
			runtime.setAppearance(appearance);
		});
		const detachUpdates = updater.start();
		const start = process.platform !== "linux" && config.autoStart !== false && store.ballEnabled();
		let cancelled = false;
		if (installing) waitForInstall(store.dir, () => cancelled).then(() => {
			if (cancelled) return;
			updater.adoptDeferredOutcome();
			if (own !== void 0) exemptReleaseAge(store.dir, own.name);
			if (process.platform === "win32" && own !== void 0) stageNativeImages();
			if (!start) return;
			return runtime.start();
		}).catch((error) => {
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		});
		else if (start) runtime.start().catch((error) => {
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		});
		return () => {
			cancelled = true;
			detachQuestions();
			detachPermissions();
			detachRoutes();
			detachAppearance();
			detachUpdates();
			runtime.halt();
		};
	});
}
/**
* Wait for the after-exit install to write its outcome, at most as long as the script itself
* can run. A status file past that ceiling is collected as a failed outcome by
* {@link deferredInstallInProgress}, so the wait always ends.
* @param profileDir - profile that scheduled the install.
* @param cancelled - true once the plugin was disposed; the wait then stops without starting.
*/
async function waitForInstall(profileDir, cancelled) {
	const deadline = Date.now() + DEFERRED_INSTALL_CEILING_MS;
	while (!cancelled() && Date.now() < deadline && deferredInstallInProgress(profileDir)) await new Promise((resolve) => setTimeout(resolve, 1e3));
}
/** Point every koffi loader at a copy outside the package and clear what failed updates left. */
function stageNativeImages() {
	const root = ownPackageRoot();
	try {
		const dir = stageKoffi(root, dshHomePath("dsh-orb", "native"));
		if (dir !== void 0) process.env[KOFFI_DIR_ENV] = dir;
	} catch (error) {
		console.error(`dsh-orb: koffi stays in the package: ${error instanceof Error ? error.message : String(error)}`);
	}
	removeStaleStages(root);
}
/** Print the loopback port. The authenticated URL contains credentials, so it is never logged. */
function logWebPort(ctx) {
	const port = ctx.webServer.port;
	try {
		const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`);
		const hostname = new URL(authed).hostname;
		if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") console.error("dsh-orb: authenticated URL is not loopback");
	} catch {
		console.error("dsh-orb: authenticated URL is unavailable");
	}
	console.error(`dsh-orb: host web port ${port}`);
}
//#endregion
export { apply, inject, name };

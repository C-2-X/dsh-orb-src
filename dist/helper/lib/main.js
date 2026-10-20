import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeTheme, screen, shell } from "electron";
import { request } from "node:http";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
//#region src/avatar.ts
/**
* Avatar messages from the host.
* The host owns what the avatar is; the helper only turns that into something the
* ball page can load: a relative asset path, the uploaded bytes, or nothing (the
* GIF that ships with the page).
*/
/** `kind: 'preset'` sources: a plain relative GIF path, never a URL scheme or a parent hop. */
const PRESET_SRC = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9_-]+)*\.gif$/;
function readAvatarChoice(record) {
	if (record.kind === "preset" && typeof record.src === "string" && PRESET_SRC.test(record.src)) return {
		kind: "preset",
		src: record.src
	};
	const version = typeof record.version === "number" && Number.isFinite(record.version) ? Math.trunc(record.version) : 0;
	if (record.kind === "custom" && version > 0) return {
		kind: "custom",
		version
	};
	return { kind: "default" };
}
//#endregion
//#region src/chrome-windows.ts
/**
* One native window id from an Electron handle buffer.
* A Windows `HWND` is pointer sized. The host compares this value against the ids its own
* `EnumWindows` walk produces, which are the same pointer values as JS numbers.
* @param handle - buffer from `getNativeWindowHandle`.
* @returns the id, or undefined when the buffer is too small or holds no usable id.
*/
function windowIdFromHandle(handle) {
	const id = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.length >= 4 ? handle.readUInt32LE(0) : NaN;
	if (!Number.isSafeInteger(id) || id <= 0) return void 0;
	return id;
}
/**
* Ids for the helper's chrome windows, for the host's capture exclusion list.
* @param windows - ball, selection toolbar, and observation frame; any may be missing.
* @param platform - the helper's `process.platform`.
* @returns unique ids, empty on every platform other than Windows.
*/
function collectChromeWindowIds(windows, platform) {
	if (platform !== "win32") return [];
	const ids = [];
	for (const window of windows) {
		if (window === void 0) continue;
		let id;
		try {
			id = windowIdFromHandle(window.getNativeWindowHandle());
		} catch {
			id = void 0;
		}
		if (id !== void 0 && !ids.includes(id)) ids.push(id);
	}
	return ids;
}
const PANEL_SIZE = {
	width: 320,
	height: 420
};
const PANEL_WINDOW_SIZE = {
	width: PANEL_SIZE.width + 24,
	height: PANEL_SIZE.height + 24
};
const BELOW_CENTER = .08;
const DOCK_DRAG_OFF = Math.round(24);
function clamp$1(value, min, max) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
function collapsedWindowBounds(ball) {
	return {
		x: ball.x - 12,
		y: ball.y - 12,
		width: 96,
		height: 96
	};
}
/**
* Chromium turns a DIP window size into device pixels with an enclosing rect, then
* converts back the same way. Whenever `size * scaleFactor` is not an integer
* (120% is 115.2), a 96px ball window reads back 97. The panel is hundreds of
* pixels larger, so a few DIP still cannot be the panel. 150% keeps 96 exactly
* (`96 * 1.5 = 144`) but still pulls a window that would hang past the screen
* back inside, which the dock decision handles separately.
*/
const BALL_WINDOW_SLOP = 4;
function isCollapsed(bounds) {
	return bounds.width <= 100 && bounds.height <= 100;
}
/** The full ball window, as drawn by a collapsed ball or a slide still in flight. */
function drawsBall(bounds) {
	return Math.abs(bounds.width - 96) <= BALL_WINDOW_SLOP && Math.abs(bounds.height - 96) <= BALL_WINDOW_SLOP;
}
function clampWindowOrigin(value, workOrigin, workSize, windowSize) {
	return clamp$1(value, workOrigin - 12, workOrigin + workSize - windowSize + 12);
}
/**
* Which outer display edge the ball reaches on release; contact within
* {@link DOCK_OVERLAP} docks. An edge that touches another display is a seam,
* not a place to dock.
*/
function dockSideForBallOrigin(ball, bounds, displays = []) {
	const leftGap = bounds.x - ball.x;
	const rightGap = ball.x + 72 - (bounds.x + bounds.width);
	let side;
	if (leftGap >= rightGap && leftGap >= -3) side = "left";
	else if (rightGap > leftGap && rightGap >= -3) side = "right";
	if (side === void 0 || edgeTouchesDisplay(side, bounds, displays)) return void 0;
	return side;
}
function edgeTouchesDisplay(side, bounds, displays) {
	const edge = side === "left" ? bounds.x : bounds.x + bounds.width;
	for (const other of displays) {
		if (sameRect(other, bounds)) continue;
		const otherEdge = side === "left" ? other.x + other.width : other.x;
		if (Math.abs(otherEdge - edge) > 8) continue;
		const top = Math.max(bounds.y, other.y);
		if (Math.min(bounds.y + bounds.height, other.y + other.height) > top) return true;
	}
	return false;
}
function sameRect(left, right) {
	return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
/**
* Hittable strip for a docked tab, flush with a work-area edge: a side taskbar lives outside
* the work area, so a tab on the display bounds would sit under it.
*/
function dockedTabBounds(side, ballY, workArea) {
	const y = clamp$1(Math.round(ballY - 8), workArea.y, workArea.y + workArea.height - 88);
	return {
		x: side === "left" ? workArea.x : workArea.x + workArea.width - 34,
		y,
		width: 34,
		height: 88
	};
}
/** Panel growth that keeps the expanded overlay on the open side of the ball. */
function expandDirection(ball, workArea) {
	return {
		horizontal: ball.x + 36 - workArea.x > workArea.width / 2 ? "left" : "right",
		vertical: ball.y - workArea.y < PANEL_SIZE.height - 72 ? "down" : "up"
	};
}
/** Ball top-left recovered from an expanded window and its growth direction. */
function ballOriginFromWindow(bounds, direction) {
	return {
		x: direction.horizontal === "left" ? bounds.x + bounds.width - 12 - 72 : bounds.x + 12,
		y: direction.vertical === "up" ? bounds.y + bounds.height - 12 - 72 : bounds.y + 12
	};
}
/** Keep a 72px ball fully inside a work area. */
function clampedBallOrigin(ball, workArea) {
	return {
		x: clamp$1(ball.x, workArea.x, workArea.x + workArea.width - 72),
		y: clamp$1(ball.y, workArea.y, workArea.y + workArea.height - 72)
	};
}
/** Collapsed origin on the work-area right edge, slightly below vertical center. */
function defaultFloatingBallOrigin(workArea) {
	const x = workArea.x + workArea.width - 72;
	const y = workArea.y + (workArea.height - 72) / 2 + workArea.height * BELOW_CENTER;
	return clampedBallOrigin({
		x: Math.round(x),
		y: Math.round(y)
	}, workArea);
}
function overlayBoundsFromBall(ball, direction, stripWidth = 0) {
	return {
		x: direction.horizontal === "left" ? ball.x - (PANEL_SIZE.width - 72) - 12 - stripWidth : ball.x - 12,
		y: direction.vertical === "up" ? ball.y - (PANEL_SIZE.height - 72) - 12 : ball.y - 12,
		width: PANEL_WINDOW_SIZE.width + stripWidth,
		height: PANEL_WINDOW_SIZE.height
	};
}
function expandedOverlayBounds(ball, workArea, stripWidth = 0) {
	const direction = expandDirection(ball, workArea);
	const unclamped = overlayBoundsFromBall(ball, direction, stripWidth);
	return {
		x: clampWindowOrigin(unclamped.x, workArea.x, workArea.width, unclamped.width),
		y: clampWindowOrigin(unclamped.y, workArea.y, workArea.height, unclamped.height),
		width: unclamped.width,
		height: unclamped.height,
		...direction
	};
}
function clampBallY(ballY, bounds) {
	return clamp$1(Math.round(ballY), bounds.y, bounds.y + bounds.height - 72);
}
function offScreenBallOrigin(side, ballY, bounds) {
	const y = clampBallY(ballY, bounds);
	return {
		x: side === "left" ? bounds.x - 72 - 2 : bounds.x + bounds.width + 2,
		y
	};
}
/** Ball origin of a slide-in, inside the work area: side taskbars live outside it. */
function insideBallOrigin(side, ballY, display) {
	return {
		x: side === "left" ? display.workArea.x + 5 : display.workArea.x + display.workArea.width - 72 - 5,
		y: clamp$1(Math.round(ballY), display.workArea.y, display.workArea.y + display.workArea.height - 72)
	};
}
function staysDocked(side, cursorX, bounds) {
	if (side === "right") return cursorX >= bounds.x + bounds.width - DOCK_DRAG_OFF;
	return cursorX <= bounds.x + DOCK_DRAG_OFF;
}
function easeInOutCubic(t) {
	return t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
function easeOutCubic(t) {
	return 1 - (1 - t) ** 3;
}
function lerpRect(start, end, t) {
	return {
		x: Math.round(start.x + (end.x - start.x) * t),
		y: Math.round(start.y + (end.y - start.y) * t),
		width: Math.round(start.width + (end.width - start.width) * t),
		height: Math.round(start.height + (end.height - start.height) * t)
	};
}
/** Initial collapsed window, including the transparent chrome around the ball. */
function initialWindowBounds(workArea) {
	return collapsedWindowBounds(defaultFloatingBallOrigin(workArea));
}
/**
* Owns expand direction and dock state for one overlay window.
* Dock is committed on pointer-up, not while the ball is still moving.
*/
var FloatingPlacement = class {
	window;
	displayAt;
	displayBounds;
	direction = {
		horizontal: "left",
		vertical: "up"
	};
	docked;
	stripWidth = 0;
	anim = 0;
	/** Cursor offset inside the ball, recorded at press and kept for the whole gesture. */
	grab;
	/** Set once the renderer reports that the gesture passed the drag threshold. */
	dragging = false;
	/**
	* Ball origin last requested. The OS read-back is not a safe dock input on
	* Windows once the scale is above 100%: the window is kept inside the monitor,
	* so the 12px transparent chrome leaves the ball a chrome-width short of the
	* edge it was aimed at.
	*/
	placedOrigin;
	constructor(window, displayAt, displayBounds = () => []) {
		this.window = window;
		this.displayAt = displayAt;
		this.displayBounds = displayBounds;
	}
	/** Ball origin of a collapsed window, from the window bounds the OS applied. */
	collapsedBallOrigin() {
		const bounds = this.window.getBounds();
		return {
			x: bounds.x + 12,
			y: bounds.y + 12
		};
	}
	/** Resize between the ball and the panel while keeping the ball origin fixed. */
	setExpanded(expanded) {
		this.anim += 1;
		const bounds = this.window.getBounds();
		const display = this.displayAt(center(bounds));
		if (expanded) {
			const origin = this.currentBallOrigin();
			this.docked = void 0;
			const next = expandedOverlayBounds(origin, display.workArea, this.stripWidth);
			this.direction = {
				horizontal: next.horizontal,
				vertical: next.vertical
			};
			this.window.setBounds({
				x: next.x,
				y: next.y,
				width: next.width,
				height: next.height
			});
			return {
				expanded: true,
				...this.direction,
				docked: void 0,
				strip: this.stripWidth
			};
		}
		if (this.docked) {
			this.applyTab(this.docked.side, this.docked.y, display.workArea);
			return {
				expanded: false,
				...this.direction,
				docked: this.docked.side,
				strip: this.stripWidth
			};
		}
		const origin = clampedBallOrigin(this.currentBallOrigin(), display.workArea);
		this.window.setBounds(collapsedWindowBounds(origin));
		return {
			expanded: false,
			...this.direction,
			docked: void 0,
			strip: this.stripWidth
		};
	}
	/**
	* Reserve (or free) bookmark-strip width on the far edge. While expanded the
	* window re-bounds immediately around the fixed ball origin; while collapsed
	* the value is stored for the next expand.
	*/
	setStrip(width) {
		const next = Math.max(0, Math.round(width));
		if (next === this.stripWidth) return {
			expanded: !isCollapsed(this.window.getBounds()) && !this.docked,
			...this.direction,
			docked: this.docked?.side,
			strip: this.stripWidth
		};
		this.stripWidth = next;
		const bounds = this.window.getBounds();
		if (!isCollapsed(bounds) && !this.docked) {
			const display = this.displayAt(center(bounds));
			const nextBounds = expandedOverlayBounds(this.currentBallOrigin(), display.workArea, this.stripWidth);
			this.direction = {
				horizontal: nextBounds.horizontal,
				vertical: nextBounds.vertical
			};
			this.window.setBounds({
				x: nextBounds.x,
				y: nextBounds.y,
				width: nextBounds.width,
				height: nextBounds.height
			});
		}
		return {
			expanded: !isCollapsed(this.window.getBounds()) && !this.docked,
			...this.direction,
			docked: this.docked?.side,
			strip: this.stripWidth
		};
	}
	/**
	* Move so the 72px ball origin follows `(x, y)`.
	* A collapsed ball may hang past a display edge. Dock is committed by {@link clamp}.
	*/
	move(x, y, canDock = true) {
		const origin = {
			x: Math.round(x),
			y: Math.round(y)
		};
		this.placedOrigin = origin;
		if (!isCollapsed(this.window.getBounds()) && this.docked === void 0) {
			const direction = this.direction;
			this.window.setBounds(overlayBoundsFromBall(origin, direction, this.stripWidth));
			return { docked: void 0 };
		}
		if (!canDock) {
			this.docked = void 0;
			this.anim += 1;
			this.window.setBounds(collapsedWindowBounds(origin));
			return { docked: void 0 };
		}
		const display = this.displayAt(origin);
		if (this.docked && staysDocked(this.docked.side, origin.x, display.bounds)) {
			this.applyTab(this.docked.side, this.docked.y, display.workArea);
			return { docked: this.docked.side };
		}
		this.docked = void 0;
		this.anim += 1;
		this.window.setBounds(collapsedWindowBounds(origin));
		return { docked: void 0 };
	}
	/**
	* Pointer pressed on the ball. The grab offset comes from the OS cursor and the
	* ball origin the window really has, both in the DIP space `setBounds` uses, so
	* the drag never reads a renderer-side window position.
	*/
	press(cursor) {
		this.stopSlideOff();
		const origin = this.currentBallOrigin();
		this.grab = {
			x: cursor.x - origin.x,
			y: cursor.y - origin.y
		};
		this.dragging = false;
	}
	/** The gesture passed the drag threshold; from here the ball follows the cursor. */
	beginDrag() {
		this.dragging = this.grab !== void 0;
	}
	/**
	* Follow the cursor. Stateless on purpose: the target is always cursor minus grab,
	* so the window moving cannot feed back into the next target.
	*/
	dragTo(cursor, canDock = true) {
		if (!this.dragging || this.grab === void 0) return { docked: this.docked?.side };
		return this.move(cursor.x - this.grab.x, cursor.y - this.grab.y, canDock);
	}
	/**
	* Release. The ball is placed under the cursor, then docked on a side edge or
	* pulled back into the work area. The result is the full layout the page must
	* show, including the panel direction when a running panel re-anchored.
	*/
	async endDrag(cursor, canDock = true) {
		const grab = this.grab;
		const dragging = this.dragging;
		this.grab = void 0;
		this.dragging = false;
		if (grab === void 0 || !dragging) return this.expandState();
		this.move(cursor.x - grab.x, cursor.y - grab.y, canDock);
		return this.clamp(canDock);
	}
	/**
	* Pull a free ball inside the work area, or dock it when it reaches a side edge.
	* The decision uses the origin the drag requested. The window the OS actually
	* applied can sit short of that on a scaled Windows display.
	*/
	async clamp(canDock = true) {
		const bounds = this.window.getBounds();
		const display = this.displayAt(center(bounds));
		if (this.docked) {
			this.applyTab(this.docked.side, this.docked.y, display.workArea);
			return this.expandState();
		}
		if (isCollapsed(bounds)) {
			const origin = this.placedOrigin ?? this.collapsedBallOrigin();
			if (canDock) {
				const side = dockSideForBallOrigin(origin, display.bounds, this.displayBounds());
				if (side) return this.snap(side, origin.y, display);
			}
			this.window.setBounds(collapsedWindowBounds(clampedBallOrigin(origin, display.workArea)));
			return this.expandState();
		}
		return this.setExpanded(true);
	}
	/** Slide the ball back on screen from a docked tab. */
	async unsnap() {
		if (!this.docked) return { docked: void 0 };
		const display = this.displayAt(center(this.window.getBounds()));
		const start = offScreenBallOrigin(this.docked.side, this.docked.y, display.bounds);
		const end = insideBallOrigin(this.docked.side, this.docked.y, display);
		this.docked = void 0;
		this.window.setBounds(collapsedWindowBounds(start));
		await this.animate(collapsedWindowBounds(end), 300, easeOutCubic);
		return { docked: void 0 };
	}
	/** Stop a slide-off that still draws the ball window; the ball stays free where it is. */
	stopSlideOff() {
		if (this.docked && drawsBall(this.window.getBounds())) {
			this.docked = void 0;
			this.anim += 1;
		}
	}
	currentBallOrigin() {
		const bounds = this.window.getBounds();
		if (this.docked && !drawsBall(bounds)) return insideBallOrigin(this.docked.side, this.docked.y, this.displayAt(center(bounds)));
		if (isCollapsed(bounds)) return this.collapsedBallOrigin();
		return ballOriginFromWindow(bounds, this.direction);
	}
	applyTab(side, ballY, workArea) {
		const y = clampBallY(ballY, workArea);
		this.docked = {
			side,
			y
		};
		this.anim += 1;
		this.window.setBounds(dockedTabBounds(side, y, workArea));
	}
	async snap(side, ballY, display) {
		const y = clampBallY(ballY, display.workArea);
		this.docked = {
			side,
			y
		};
		await this.animate(collapsedWindowBounds(offScreenBallOrigin(side, y, display.bounds)), 250, easeInOutCubic);
		if (!this.docked || this.docked.side !== side) return this.expandState();
		this.window.setBounds(dockedTabBounds(side, y, display.workArea));
		return this.expandState();
	}
	/** The layout as the window stands now, in the shape the page applies. */
	expandState() {
		return {
			expanded: !isCollapsed(this.window.getBounds()) && this.docked === void 0,
			...this.direction,
			docked: this.docked?.side,
			strip: this.stripWidth
		};
	}
	animate(end, durationMs, ease) {
		const generation = ++this.anim;
		const start = this.window.getBounds();
		if (durationMs <= 0) {
			this.window.setBounds(end);
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const t0 = Date.now();
			const tick = () => {
				if (generation !== this.anim) {
					resolve();
					return;
				}
				const t = Math.min(1, (Date.now() - t0) / durationMs);
				this.window.setBounds(lerpRect(start, end, ease(t)));
				if (t < 1) {
					setTimeout(tick, 16);
					return;
				}
				resolve();
			};
			setTimeout(tick, 16);
		});
	}
};
function center(bounds) {
	return {
		x: bounds.x + bounds.width / 2,
		y: bounds.y + bounds.height / 2
	};
}
//#endregion
//#region src/model-menu.ts
const CURRENT_MODEL_MARK = "✓ ";
/** Provider headers, model rows, and effort radios. An empty catalog is one disabled row. */
function modelMenuItems(catalog, current, onSelect, labels) {
	const groups = catalog?.groups ?? [];
	if (groups.length === 0) return [{
		label: labels.empty,
		enabled: false
	}];
	const items = [];
	for (const group of groups) {
		items.push({
			label: group.name,
			enabled: false
		});
		for (const model of group.models) items.push(modelItem(group.id, model, current, onSelect, labels.defaultEffort));
	}
	return items;
}
function modelItem(provider, model, current, onSelect, defaultEffortLabel) {
	const selected = current.provider === provider && current.model === model.id;
	const efforts = effortItems(provider, model, current, onSelect, defaultEffortLabel);
	if (efforts === void 0) return {
		label: model.name,
		type: "checkbox",
		checked: selected,
		click: () => {
			onSelect({
				provider,
				model: model.id
			});
		}
	};
	return {
		label: selected ? `${CURRENT_MODEL_MARK}${model.name}` : model.name,
		submenu: efforts
	};
}
function effortItems(provider, model, current, onSelect, defaultEffortLabel) {
	const reasoning = model.reasoning;
	if (reasoning === void 0) return void 0;
	const selected = current.provider === provider && current.model === model.id;
	const effective = selected ? current.reasoningEffort ?? reasoning.defaultEffort : void 0;
	const items = [];
	if (reasoning.defaultEffort === void 0) items.push({
		label: defaultEffortLabel,
		type: "radio",
		checked: selected && current.reasoningEffort === void 0,
		click: () => {
			onSelect({
				provider,
				model: model.id
			});
		}
	});
	for (const effort of reasoning.efforts) items.push({
		label: effort.name,
		type: "radio",
		checked: effective === effort.id,
		click: () => {
			onSelect({
				provider,
				model: model.id,
				reasoningEffort: effort.id
			});
		}
	});
	return items.length === 0 ? void 0 : items;
}
//#endregion
//#region src/menu.ts
/** Right-click menu for the ball. Model rows come from the host catalog. */
/** Labels and actions for the ball menu. The selection toolbar is disabled (buggy) and has no entry here. */
function contextMenuTemplate(state, zh, actions) {
	const labels = {
		empty: zh ? "没有可用的模型。" : "No models available.",
		defaultEffort: zh ? "默认" : "Default"
	};
	return [
		{
			label: zh ? "打开主窗口" : "Open Main Window",
			enabled: state.openMain,
			click: () => {
				actions.openMain();
			}
		},
		{
			label: zh ? "打开悬浮球设置" : "Open floating-ball settings",
			enabled: state.openMain,
			click: () => {
				actions.openSettings();
			}
		},
		{
			label: zh ? "悬浮球 Agent 模型" : "Floating-ball Agent model",
			submenu: modelMenuItems(state.catalog, state.overlay, actions.setOverlay, labels)
		},
		{
			label: zh ? "后台 Agent 模型" : "Background Agent model",
			submenu: modelMenuItems(state.catalog, state.background, actions.setBackground, labels)
		},
		{
			label: zh ? "千分比坐标" : "Millifraction coordinates",
			type: "checkbox",
			checked: state.millifractionEnabled,
			click: (item) => {
				actions.setMillifraction(item.checked);
			}
		},
		...typeof state.update === "string" && state.update !== "" ? [{
			label: zh ? `更新到 ${state.update}` : `Update to ${state.update}`,
			click: () => {
				actions.update();
			}
		}] : [],
		{ type: "separator" },
		{
			label: zh ? "停用悬浮球" : "Disable floating ball",
			click: () => {
				actions.disable();
			}
		}
	];
}
/**
* Fire a cloak ack. Input begin waits {@link OVERLAY_GUARD_INPUT_APPLY_MS} after
* click-through was applied — the ack arriving is the host's signal that posted
* HID events may start. Every other transition acks immediately.
*/
function scheduleCloakAck(ack, mode, action) {
	if (mode !== "input" || action !== "begin") {
		ack();
		return;
	}
	setTimeout(ack, 80).unref();
}
/**
* Create the cloak. `clickThroughWindow` is the ball: it receives
* `setIgnoreMouseEvents`/`blur` on input-count crossings, chrome windows do not.
*/
function createAgentCloak(entries, clickThroughWindow) {
	const counts = {
		capture: 0,
		input: 0
	};
	let clickThrough = false;
	function sync() {
		const active = counts.capture > 0 || counts.input > 0;
		for (const entry of entries) {
			const window = entry.window();
			if (window === void 0 || window.isDestroyed()) continue;
			window.setContentProtection(active || entry.resting);
		}
		const next = counts.input > 0;
		if (next === clickThrough) return;
		clickThrough = next;
		const ball = clickThroughWindow?.();
		if (ball === void 0 || ball.isDestroyed()) return;
		if (next) {
			ball.setIgnoreMouseEvents(true, { forward: false });
			ball.blur();
			return;
		}
		ball.setIgnoreMouseEvents(false);
	}
	return {
		begin(mode) {
			counts[mode] += 1;
			sync();
		},
		end(mode) {
			counts[mode] = Math.max(0, counts[mode] - 1);
			sync();
		},
		reset() {
			counts.capture = 0;
			counts.input = 0;
			sync();
		}
	};
}
//#endregion
//#region src/overlay-geometry.ts
/** Toolbar and observation-frame placement. No Electron import, so tests can run the same math. */
const SELECTION_TOOLBAR_SIZE = {
	width: 280,
	height: 46
};
function clamp(value, min, max) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
/** Toolbar sits just below the mouse-up point and stays inside the work area. */
function selectionToolbarBounds(anchor, size = SELECTION_TOOLBAR_SIZE, workArea) {
	return {
		x: clamp(anchor.x, workArea.x, workArea.x + workArea.width - size.width),
		y: clamp(anchor.y + 8, workArea.y, workArea.y + workArea.height - size.height),
		width: size.width,
		height: size.height
	};
}
/**
* Grow the toolbar window for the language menu.
* The menu hangs below the bar when it fits, and above when it would leave the work area.
*/
function selectionToolbarMenuBounds(barOrigin, contentSize, workArea) {
	const width = Math.max(1, Math.round(contentSize.width));
	const height = Math.max(1, Math.round(contentSize.height));
	const x = clamp(barOrigin.x, workArea.x, workArea.x + workArea.width - width);
	if (barOrigin.y + height <= workArea.y + workArea.height || height <= SELECTION_TOOLBAR_SIZE.height) return {
		x,
		y: clamp(barOrigin.y, workArea.y, workArea.y + workArea.height - height),
		width,
		height
	};
	return {
		x,
		y: clamp(barOrigin.y + SELECTION_TOOLBAR_SIZE.height - height, workArea.y, workArea.y + workArea.height - height),
		width,
		height
	};
}
function intersectRects(area, clip) {
	const x = Math.max(area.x, clip.x);
	const y = Math.max(area.y, clip.y);
	const right = Math.min(area.x + area.width, clip.x + clip.width);
	const bottom = Math.min(area.y + area.height, clip.y + clip.height);
	const width = right - x;
	const height = bottom - y;
	if (width >= 1 && height >= 1) return {
		x,
		y,
		width,
		height
	};
	return {
		x: clamp(area.x, clip.x, clip.x + clip.width - 1),
		y: clamp(area.y, clip.y, clip.y + clip.height - 1),
		width: 1,
		height: 1
	};
}
function edgePadding(inset) {
	return {
		glow: Math.max(0, Math.max(0, Math.round(inset)) - 8),
		stroke: 8
	};
}
/** Body glow and frame stroke that keep the inner hole on the observation rectangle. */
function observationFramePadding(region, bounds) {
	const left = edgePadding(region.x - bounds.x);
	const top = edgePadding(region.y - bounds.y);
	const right = edgePadding(bounds.x + bounds.width - (region.x + region.width));
	const bottom = edgePadding(bounds.y + bounds.height - (region.y + region.height));
	return {
		glow: {
			top: top.glow,
			right: right.glow,
			bottom: bottom.glow,
			left: left.glow
		},
		stroke: {
			top: top.stroke,
			right: right.stroke,
			bottom: bottom.stroke,
			left: left.stroke
		}
	};
}
/** Inflate the observation rectangle by the stroke and glow, then clip to the work area. */
function observationFramePlacement(region, workArea) {
	const bounds = intersectRects({
		x: Math.round(region.x - 36),
		y: Math.round(region.y - 36),
		width: Math.max(1, Math.round(region.width + 72)),
		height: Math.max(1, Math.round(region.height + 72))
	}, workArea);
	const padding = observationFramePadding(region, bounds);
	return {
		bounds,
		glow: padding.glow,
		stroke: padding.stroke
	};
}
function observationFrameCssScript(glow, stroke) {
	return `(() => { const root = document.documentElement.style; ${[
		["--glow-top", glow.top],
		["--glow-right", glow.right],
		["--glow-bottom", glow.bottom],
		["--glow-left", glow.left],
		["--stroke-top", stroke.top],
		["--stroke-right", stroke.right],
		["--stroke-bottom", stroke.bottom],
		["--stroke-left", stroke.left]
	].map(([name, value]) => `root.setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${String(value)}px`)});`).join("")} })()`;
}
function pointInRect(point, bounds) {
	return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}
//#endregion
//#region src/overlays.ts
/**
* Selection toolbar and observation frame.
* Agent chrome rests captureable; the refcounted cloak below lifts it out of
* captures while a Computer Use capture or HID interval is active.
*/
function denyWindowPermissions(created) {
	created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
		callback(false);
	});
}
async function attachOverlays(deps) {
	const toolbar = openToolbar(fileURLToPath(new URL("../selection-preload.cjs", import.meta.url)));
	const frame = openFrame();
	let barOrigin = {
		x: 0,
		y: 0
	};
	let language = "zh";
	toolbar.webContents.on("did-finish-load", () => {
		toolbar.webContents.send("orb:selection-state", { language });
	});
	ipcMain.handle("orb:selection-size", (event, size) => {
		if (!fromToolbar(event, toolbar) || !isSize(size) || toolbar.isDestroyed()) return { menuAbove: false };
		const work = workAreaOf(barOrigin);
		const bounds = selectionToolbarMenuBounds(barOrigin, size, work);
		toolbar.setBounds(bounds);
		return { menuAbove: bounds.y < barOrigin.y };
	});
	ipcMain.on("orb:selection-action", (event, payload) => {
		if (!fromToolbar(event, toolbar)) return;
		if (typeof payload !== "object" || payload === null) return;
		const record = payload;
		if (record.action !== "search" && record.action !== "translate" && record.action !== "send" && record.action !== "language") return;
		deps.write({
			type: "selection-action",
			action: record.action,
			...record.language === "zh" || record.language === "en" ? { language: record.language } : {}
		});
	});
	await Promise.all([toolbar.loadFile(fileURLToPath(new URL("../assets/selection-toolbar.html", import.meta.url))), frame.loadFile(fileURLToPath(new URL("../assets/observation-frame.html", import.meta.url)))]);
	function ack(id) {
		if (typeof id === "string") deps.write({
			type: "overlay-ack",
			id
		});
	}
	function hideToolbar() {
		if (!toolbar.isDestroyed() && toolbar.isVisible()) toolbar.hide();
	}
	/**
	* The refcounted cloak from ./cloak.ts. Chrome windows rest captureable; each
	* `overlay-capture`/`overlay-input` interval lifts them out of screen captures,
	* and the observation frame keeps its Windows resting protection (it stays
	* visible around the observed region between captures).
	*/
	const cloak = createAgentCloak([
		{
			window: () => deps.ball(),
			resting: false
		},
		{
			window: () => toolbar,
			resting: false
		},
		{
			window: () => frame,
			resting: process.platform === "win32"
		}
	], () => deps.ball());
	function raiseChrome() {
		if (!frame.isDestroyed()) frame.setAlwaysOnTop(true, "floating");
		if (!toolbar.isDestroyed()) toolbar.setAlwaysOnTop(true, "screen-saver");
		const ball = deps.ball();
		if (ball && !ball.isDestroyed()) ball.setAlwaysOnTop(true, "screen-saver");
	}
	return {
		/** Mirror the ball's theme and UI language onto the selection toolbar. */
		appearance(payload) {
			if (!toolbar.isDestroyed()) toolbar.webContents.send("orb:appearance", payload);
		},
		chromeWindows() {
			return [toolbar, frame];
		},
		deliver(message) {
			if (typeof message !== "object" || message === null) return false;
			const record = message;
			if (record.type === "selection") {
				if (typeof record.x !== "number" || typeof record.y !== "number") return true;
				language = record.language === "en" ? "en" : "zh";
				const work = workAreaOf({
					x: record.x,
					y: record.y
				});
				const bounds = selectionToolbarBounds({
					x: record.x,
					y: record.y
				}, SELECTION_TOOLBAR_SIZE, work);
				barOrigin = {
					x: bounds.x,
					y: bounds.y
				};
				if (!toolbar.isDestroyed()) {
					toolbar.setBounds(bounds);
					toolbar.showInactive();
					toolbar.webContents.send("orb:selection-state", { language });
					raiseChrome();
				}
				return true;
			}
			if (record.type === "selection-hide") {
				hideToolbar();
				return true;
			}
			if (record.type === "selection-pointer") {
				if (typeof record.x !== "number" || typeof record.y !== "number") return true;
				if (toolbar.isDestroyed() || !toolbar.isVisible() || !pointInRect({
					x: record.x,
					y: record.y
				}, toolbar.getBounds())) hideToolbar();
				return true;
			}
			if (record.type === "selection-language") {
				language = record.language === "en" ? "en" : "zh";
				if (!toolbar.isDestroyed()) toolbar.webContents.send("orb:selection-state", { language });
				return true;
			}
			if (record.type === "selection-attach") {
				const ball = deps.ball();
				if (ball && !ball.isDestroyed() && typeof record.text === "string") {
					ball.webContents.send("orb:attach", record.text);
					ball.showInactive();
				}
				hideToolbar();
				return true;
			}
			if (record.type === "overlay-capture") {
				if (record.active === false) cloak.end("capture");
				else cloak.begin("capture");
				ack(record.id);
				return true;
			}
			if (record.type === "overlay-input") {
				const begin = record.active === true;
				if (begin) hideToolbar();
				if (begin) cloak.begin("input");
				else cloak.end("input");
				scheduleCloakAck(() => ack(record.id), "input", begin ? "begin" : "end");
				return true;
			}
			if (record.type === "observation-frame") {
				showFrame(frame, record.bounds);
				raiseChrome();
				ack(record.id);
				return true;
			}
			return false;
		}
	};
}
function showFrame(frame, bounds) {
	if (frame.isDestroyed()) return;
	const region = readRect(bounds);
	if (region === void 0) {
		frame.hide();
		return;
	}
	const dip = toDip(region);
	const placement = observationFramePlacement(dip, workAreaOf({
		x: dip.x + dip.width / 2,
		y: dip.y + dip.height / 2
	}));
	frame.setBounds(placement.bounds);
	frame.webContents.executeJavaScript(observationFrameCssScript(placement.glow, placement.stroke)).catch(() => {});
	frame.showInactive();
}
function toDip(region) {
	if (process.platform !== "win32") return region;
	const dip = screen.screenToDipRect(null, {
		x: Math.round(region.x),
		y: Math.round(region.y),
		width: Math.round(region.width),
		height: Math.round(region.height)
	});
	return {
		x: dip.x,
		y: dip.y,
		width: dip.width,
		height: dip.height
	};
}
function workAreaOf(point) {
	const area = screen.getDisplayNearestPoint({
		x: Math.round(point.x),
		y: Math.round(point.y)
	}).workArea;
	return {
		x: area.x,
		y: area.y,
		width: area.width,
		height: area.height
	};
}
function readRect(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (typeof record.x !== "number" || typeof record.y !== "number" || typeof record.width !== "number" || typeof record.height !== "number") return;
	if (![
		record.x,
		record.y,
		record.width,
		record.height
	].every(Number.isFinite)) return void 0;
	if (record.width < 1 || record.height < 1) return void 0;
	return {
		x: record.x,
		y: record.y,
		width: record.width,
		height: record.height
	};
}
function fromToolbar(event, toolbar) {
	if (toolbar.isDestroyed()) return false;
	return event.sender === toolbar.webContents;
}
function isSize(value) {
	if (typeof value !== "object" || value === null) return false;
	const size = value;
	return typeof size.width === "number" && typeof size.height === "number" && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0 && size.width < 2e3 && size.height < 2e3;
}
function openToolbar(preload) {
	const created = new BrowserWindow({
		width: SELECTION_TOOLBAR_SIZE.width,
		height: SELECTION_TOOLBAR_SIZE.height,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		focusable: false,
		show: false,
		hasShadow: true,
		backgroundColor: "#00000000",
		roundedCorners: false,
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			preload,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	protect(created, "screen-saver");
	denyWindowPermissions(created);
	return created;
}
function openFrame() {
	const created = new BrowserWindow({
		width: 32,
		height: 32,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		focusable: false,
		show: false,
		hasShadow: false,
		backgroundColor: "#00000000",
		roundedCorners: false,
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	protect(created, "floating");
	if (process.platform === "win32") created.setContentProtection(true);
	denyWindowPermissions(created);
	created.setIgnoreMouseEvents(true, { forward: true });
	return created;
}
function protect(created, level) {
	created.setAlwaysOnTop(true, level);
	if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true
	});
	created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	created.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
}
//#endregion
//#region src/main.ts
/**
* Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
*/
const socketAddress = process.env.DSH_ORB_SOCKET ?? "";
const token = process.env.DSH_ORB_TOKEN ?? "";
const webPort = process.env.DSH_ORB_WEB_PORT ?? "";
const defaultSelection = {
	provider: "deepseek-official",
	model: "deepseek-flash",
	reasoningEffort: "max"
};
let chrome = {
	overlay: defaultSelection,
	background: defaultSelection,
	millifractionEnabled: false,
	openMain: false,
	catalog: { groups: [] },
	update: null
};
let avatarToken = 0;
let appearance = readAppearanceEnv();
process.title = "dsh-orb-helper";
if (!socketAddress || !token) {
	console.error("dsh-orb helper: socket environment is missing");
	process.exit(1);
}
if (process.platform === "darwin") app.setActivationPolicy?.("accessory");
let win;
let tccWait;
let overlays;
let placement;
let live;
let quitting = false;
let buffer = "";
/** Last bookmark payload, re-sent when the page reloads without a socket reconnect. */
let lastAgentItems = [];
app.on("before-quit", () => {
	quitting = true;
	live?.destroy();
});
app.on("window-all-closed", () => {
	app.quit();
});
app.whenReady().then(async () => {
	if (process.platform === "darwin") app.dock?.hide();
	win = openWindow();
	try {
		overlays = await attachOverlays({
			ball: () => win,
			write
		});
	} catch (error) {
		console.error(`dsh-orb helper: overlays did not open: ${error instanceof Error ? error.message : String(error)}`);
	}
	placement = new FloatingPlacement(win, (point) => {
		const display = screen.getDisplayNearestPoint({
			x: Math.round(point.x),
			y: Math.round(point.y)
		});
		return {
			bounds: display.bounds,
			workArea: display.workArea
		};
	}, () => screen.getAllDisplays().map((display) => display.bounds));
	win.webContents.on("did-finish-load", () => {
		if (win && !win.isVisible()) win.showInactive();
		pushAppearance();
		if (win && !win.isDestroyed()) {
			applyStrip(lastAgentItems.length > 0);
			if (lastAgentItems.length > 0) win.webContents.send("orb:agents", lastAgentItems);
		}
	});
	nativeTheme.on("updated", () => {
		pushAppearance();
	});
	applyAppearance();
	await win.loadFile(fileURLToPath(new URL("../assets/floating.html", import.meta.url)));
	connect(0);
});
ipcMain.handle("orb:expand", (event, expanded) => {
	if (!fromBall(event) || !placement || typeof expanded !== "boolean") return {
		expanded: false,
		horizontal: "left",
		vertical: "up",
		docked: void 0,
		strip: 0
	};
	return placement.setExpanded(expanded);
});
/**
* The page's own geometry sync. Chips are rendered from the page's list while the reserved
* strip width lives here, so a state message missed across a page load would leave the
* panel over them. Re-applying the reservation from this side heals that in one round trip.
*/
ipcMain.handle("orb:sync-strip", (event) => {
	if (!fromBall(event) || !placement) return {
		expanded: false,
		horizontal: "left",
		vertical: "up",
		docked: void 0,
		strip: 0
	};
	return placement.setStrip(lastAgentItems.length > 0 ? 208 : 0);
});
ipcMain.on("orb:drag-press", (event) => {
	if (!fromBall(event) || !placement) return;
	placement.press(cursorPoint());
});
ipcMain.on("orb:drag-begin", (event) => {
	if (!fromBall(event) || !placement) return;
	placement.beginDrag();
});
ipcMain.on("orb:drag-move", (event, canDock) => {
	if (!fromBall(event) || !placement) return;
	placement.dragTo(cursorPoint(), canDock !== false);
});
ipcMain.handle("orb:drag-end", async (event, canDock) => {
	if (!fromBall(event) || !placement) return { docked: void 0 };
	const cursor = cursorPoint();
	const result = await placement.endDrag(cursor, canDock !== false);
	logDockDiagnostics(cursor, result);
	return result;
});
function cursorPoint() {
	const point = screen.getCursorScreenPoint();
	return {
		x: point.x,
		y: point.y
	};
}
ipcMain.handle("orb:unsnap", async (event) => {
	if (!fromBall(event) || !placement) return { docked: void 0 };
	return placement.unsnap();
});
ipcMain.on("orb:prompt", (event, text) => {
	if (!fromBall(event)) return;
	write({
		type: "prompt",
		text
	});
});
ipcMain.on("orb:question-answer", (event, payload) => {
	if (!fromBall(event)) return;
	if (typeof payload !== "object" || payload === null) return;
	const record = payload;
	write({
		type: "question-answer",
		id: record.id,
		answers: record.answers
	});
});
ipcMain.on("orb:question-cancel", (event, id) => {
	if (!fromBall(event)) return;
	write({
		type: "question-cancel",
		id
	});
});
ipcMain.on("orb:history", (event) => {
	if (!fromBall(event)) return;
	write({ type: "history" });
});
ipcMain.on("orb:open", (event, sessionId) => {
	if (!fromBall(event)) return;
	if (typeof sessionId === "string") write({
		type: "open",
		sessionId
	});
});
ipcMain.on("orb:agent-open", (event, sessionId) => {
	if (!fromBall(event)) return;
	if (typeof sessionId === "string") write({
		type: "agent-open",
		sessionId
	});
});
ipcMain.on("orb:agent-dismiss", (event, sessionId) => {
	if (!fromBall(event)) return;
	if (typeof sessionId === "string") write({
		type: "agent-dismiss",
		sessionId
	});
});
ipcMain.on("orb:new", (event) => {
	if (!fromBall(event)) return;
	write({ type: "new" });
});
ipcMain.on("orb:permission", (event, preset) => {
	if (!fromBall(event)) return;
	if (typeof preset === "string") write({
		type: "permission",
		preset
	});
});
ipcMain.on("orb:stop", (event) => {
	if (!fromBall(event)) return;
	write({ type: "stop" });
});
ipcMain.on("orb:copy", (event, text) => {
	if (!fromBall(event)) return;
	if (typeof text !== "string" || text.length > 1e6) return;
	clipboard.writeText(text);
});
ipcMain.handle("orb:menu", async (event) => {
	if (!fromBall(event) || !win) return;
	write({ type: "menu" });
	await showMenu(win);
});
ipcMain.on("orb:open-external", (event, url) => {
	if (!fromBall(event)) return;
	if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 4e3) return;
	shell.openExternal(url);
});
ipcMain.handle("orb:tcc-status", (event) => {
	if (!fromBall(event)) return tccUnavailable();
	return askTcc({ type: "tcc" });
});
ipcMain.handle("orb:tcc-open", (event, right) => {
	if (!fromBall(event)) return tccUnavailable();
	if (right !== "screen" && right !== "accessibility") return tccUnavailable();
	return askTcc({
		type: "tcc-open",
		right
	});
});
function openWindow() {
	const bounds = initialWindowBounds(screen.getPrimaryDisplay().workArea);
	const created = new BrowserWindow({
		title: "dsh-orb",
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		movable: true,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		hasShadow: false,
		focusable: true,
		show: false,
		backgroundColor: "#00000000",
		roundedCorners: false,
		...process.platform === "win32" ? { thickFrame: false } : {},
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			preload: fileURLToPath(new URL("../preload.cjs", import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	denyWindowPermissions(created);
	created.setAlwaysOnTop(true, "screen-saver");
	if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true
	});
	created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	created.webContents.on("context-menu", (event, params) => {
		if (params?.isEditable || params?.hasSelection) return;
		event.preventDefault();
		write({ type: "menu" });
		setTimeout(() => {
			showMenu(created);
		}, 30);
	});
	created.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
	created.on("closed", () => {
		if (!quitting) app.quit();
	});
	created.once("ready-to-show", () => {
		created.showInactive();
		const shown = created.getBounds();
		console.error(`dsh-orb helper: ball ${shown.x},${shown.y} ${shown.width}x${shown.height}`);
	});
	return created;
}
function connect(attempt) {
	if (quitting) return;
	const colon = socketAddress.lastIndexOf(":");
	const host = socketAddress.slice(0, colon);
	const port = Number(socketAddress.slice(colon + 1));
	const socket = createConnection({
		host,
		port
	});
	socket.setEncoding("utf8");
	let opened = false;
	socket.on("connect", () => {
		opened = true;
		live = socket;
		buffer = "";
		socket.write(`${JSON.stringify({
			type: "hello",
			token,
			pid: process.pid
		})}\n`);
		const ids = chromeWindowIds();
		if (ids.length > 0) write({
			type: "chrome-windows",
			ids
		});
	});
	socket.on("data", (chunk) => {
		buffer += chunk;
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			if (!part.trim()) continue;
			let message;
			try {
				message = JSON.parse(part);
			} catch {
				continue;
			}
			deliver(message);
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		if (live === socket) live = void 0;
		if (quitting) return;
		if (opened) {
			app.quit();
			return;
		}
		if (attempt >= 30) {
			console.error("dsh-orb helper: host socket did not open");
			app.exit(1);
			return;
		}
		setTimeout(() => connect(attempt + 1), 300);
	});
}
function deliver(message) {
	if (overlays?.deliver(message)) return;
	if (typeof message !== "object" || message === null || !win) return;
	const record = message;
	if (record.type === "session") {
		win.webContents.send("orb:session", record.sessionId);
		return;
	}
	if (record.type === "block") {
		win.webContents.send("orb:block", message);
		return;
	}
	if (record.type === "block-drop") {
		win.webContents.send("orb:block-drop", record.key);
		return;
	}
	if (record.type === "turn") {
		win.webContents.send("orb:turn", message);
		return;
	}
	if (record.type === "status") {
		win.webContents.send("orb:status", record.text);
		return;
	}
	if (record.type === "update") {
		const text = updateStatusText(record, menuZh());
		if (text !== "") win.webContents.send("orb:status", text);
		return;
	}
	if (record.type === "question") {
		win.webContents.send("orb:question", message);
		return;
	}
	if (record.type === "question-clear") {
		win.webContents.send("orb:question-clear", record.id);
		return;
	}
	if (record.type === "question-error") {
		win.webContents.send("orb:question-error", message);
		return;
	}
	if (record.type === "permission") {
		win.webContents.send("orb:permission", record.preset);
		return;
	}
	if (record.type === "history") {
		win.webContents.send("orb:history", record.items);
		return;
	}
	if (record.type === "agents") {
		const items = record.items;
		lastAgentItems = Array.isArray(items) ? items : [];
		win.webContents.send("orb:agents", lastAgentItems);
		applyStrip(lastAgentItems.length > 0);
		return;
	}
	if (record.type === "reset") {
		win.webContents.send("orb:reset");
		return;
	}
	if (record.type === "chrome") {
		chrome = readChrome(record);
		return;
	}
	if (record.type === "appearance") {
		const next = readAppearanceMessage(message);
		if (next.theme !== void 0) appearance.theme = next.theme;
		if (next.locale !== void 0) appearance.locale = next.locale;
		applyAppearance();
		return;
	}
	if (record.type === "avatar") {
		loadAvatar(readAvatarChoice(record));
		return;
	}
	if (record.type === "tcc") {
		const wait = tccWait;
		tccWait = void 0;
		wait?.(record.status);
	}
}
/** Ball plus overlays: the windows the host must skip when it picks an observation window. */
function chromeWindowIds() {
	return collectChromeWindowIds([win, ...overlays?.chromeWindows() ?? []], process.platform);
}
/**
* The bookmark strip lives beside the panel inside one transparent window, so
* the window widens while bookmarks exist and shrinks back when they clear.
* The renderer learns the applied geometry through `orb:expand-state`.
*/
function applyStrip(present) {
	if (!placement) return;
	const state = placement.setStrip(present ? 208 : 0);
	if (win && !win.isDestroyed()) win.webContents.send("orb:expand-state", state);
}
function fromBall(event) {
	if (!win || win.isDestroyed()) return false;
	return event.sender === win.webContents;
}
function tccUnavailable() {
	return {
		applicable: false,
		appName: "",
		screen: "granted",
		accessibility: "granted"
	};
}
function askTcc(message) {
	const previous = tccWait;
	tccWait = void 0;
	previous?.(tccUnavailable());
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (tccWait !== finish) return;
			tccWait = void 0;
			resolve(tccUnavailable());
		}, 3e3);
		const finish = (status) => {
			clearTimeout(timer);
			resolve(status ?? tccUnavailable());
		};
		tccWait = finish;
		write(message);
	});
}
function write(message) {
	if (!live) return;
	live.write(`${JSON.stringify(message)}\n`);
}
/**
* Docking diagnostics, off unless `DSH_ORB_DOCK_DEBUG` is set. One stderr line per
* drag release: the cursor the drag ended on, the window bounds the OS applied,
* every display with its scaleFactor, and the decision. A machine that will not
* dock reports here, which is the only way to diagnose a display/DPI layout we
* cannot reproduce.
*/
function logDockDiagnostics(cursor, result) {
	if (process.env.DSH_ORB_DOCK_DEBUG !== "1") return;
	if (!win || win.isDestroyed()) return;
	const displays = screen.getAllDisplays().map((display) => ({
		bounds: display.bounds,
		workArea: display.workArea,
		scaleFactor: display.scaleFactor
	}));
	console.error(`[orb-dock] ${JSON.stringify({
		electron: process.versions.electron,
		cursor,
		window: win.getBounds(),
		displays,
		docked: result.docked ?? null
	})}`);
}
function zhLocale() {
	return (app.getLocale?.() ?? process.env.LANG ?? "").toLowerCase().startsWith("zh");
}
/** Appearance seed from the host: the preferences as of helper launch. */
function readAppearanceEnv() {
	const raw = process.env.DSH_ORB_APPEARANCE;
	if (typeof raw !== "string" || raw.length > 200) return {};
	try {
		return readAppearanceMessage(JSON.parse(raw));
	} catch {
		return {};
	}
}
function themeSourceOr(value, fallback) {
	return value === "light" || value === "dark" || value === "system" ? value : fallback;
}
/** Accept only well-formed preference fields; anything else keeps the current value. */
function readAppearanceMessage(value) {
	if (typeof value !== "object" || value === null) return {};
	const record = value;
	const theme = themeSourceOr(record.theme, void 0);
	return {
		...theme === void 0 ? {} : { theme },
		...typeof record.locale === "string" && record.locale.length > 0 && record.locale.length <= 35 ? { locale: record.locale } : {}
	};
}
/**
* The UI language the ball mirrors: an explicit Host locale that names one of
* the shipped languages wins, otherwise follow the system like the web client
* falls back to its browser detection.
*/
function uiLanguage() {
	const preference = typeof appearance.locale === "string" ? appearance.locale.toLowerCase() : "";
	if (preference.startsWith("zh")) return "zh";
	if (preference.startsWith("en")) return "en";
	return zhLocale() ? "zh" : "en";
}
/** Menu and dialog copy follow the mirrored language, not the raw system locale. */
function menuZh() {
	return uiLanguage() === "zh";
}
/** Point the helper's theme at the stored preference and push the resolved state. */
function applyAppearance() {
	nativeTheme.themeSource = appearance.theme ?? "system";
	pushAppearance();
}
function pushAppearance() {
	const payload = {
		dark: nativeTheme.shouldUseDarkColors,
		locale: uiLanguage()
	};
	if (win && !win.isDestroyed()) win.webContents.send("orb:appearance", payload);
	overlays?.appearance(payload);
}
function readChrome(value) {
	const record = value;
	return {
		overlay: selectionOr(record.overlay, chrome.overlay),
		background: selectionOr(record.background, chrome.background),
		millifractionEnabled: record.millifractionEnabled === true,
		openMain: record.openMain === true,
		update: typeof record.update === "string" && record.update !== "" ? record.update : null,
		catalog: record.catalog ?? { groups: [] }
	};
}
function selectionOr(value, fallback) {
	if (!value || typeof value.provider !== "string" || typeof value.model !== "string") return fallback;
	return value;
}
async function showMenu(window) {
	const template = contextMenuTemplate(chrome, menuZh(), {
		openMain: () => {
			write({ type: "open-main" });
		},
		openSettings: () => {
			write({ type: "open-settings" });
		},
		setOverlay: (selection) => {
			write({
				type: "set-overlay",
				selection
			});
		},
		setBackground: (selection) => {
			write({
				type: "set-background",
				selection
			});
		},
		setMillifraction: (enabled) => {
			confirmMillifraction(window, enabled);
		},
		update: () => {
			write({ type: "update" });
		},
		disable: () => {
			write({ type: "disable" });
		}
	});
	Menu.buildFromTemplate(template).popup({ window });
}
/** One line for the ball's status area: the update runs in the host, the ball only narrates it. */
function updateStatusText(message, zh) {
	const version = typeof message.version === "string" ? message.version : "";
	if (message.state === "available") return zh ? `发现新版本 ${version}，右键球可更新` : `Version ${version} is available — right-click the ball to update`;
	if (message.state === "starting") return zh ? `正在更新到 ${version}…` : `Updating to ${version}…`;
	if (message.state === "done") return zh ? `已更新到 ${version}，重启 DeepSeek Harness 后生效` : `Updated to ${version} — restart DeepSeek Harness to apply it`;
	if (message.state === "deferred") return zh ? `${version} 将在退出 DeepSeek Harness 后自动安装，请退出后再重新打开` : `${version} installs once DeepSeek Harness quits — quit it, then reopen it`;
	if (message.state === "failed") return zh ? `更新失败：${updateFailureText(message.reason, true)}` : `Update failed: ${updateFailureText(message.reason, false)}`;
	return "";
}
function updateFailureText(reason, zh) {
	if (reason === "build-blocked") return zh ? "安装脚本未获授权，请在设置页允许后重试" : "install scripts need approval — allow them in settings and retry";
	if (reason === "incompatible-version") return zh ? "当前 Harness 版本与新版不兼容" : "the new version is incompatible with this Harness build";
	if (typeof reason === "string" && reason !== "") return reason;
	return zh ? "未知错误" : "unknown error";
}
async function confirmMillifraction(window, enabled) {
	if (enabled === chrome.millifractionEnabled) return;
	const zh = menuZh();
	const { response } = await dialog.showMessageBox(window, {
		type: "question",
		message: zh ? "新编码只在新对话中生效。" : "The new encoding takes effect in a new conversation.",
		detail: zh ? "当前对话不变，仍可从历史记录打开。取消不写入、不新建。" : "The current conversation stays unchanged and remains in History. Cancel leaves the default and this chat as they are.",
		buttons: zh ? ["取消", "新建对话"] : ["Cancel", "Create new conversation"],
		defaultId: 1,
		cancelId: 0,
		noLink: true
	});
	if (response !== 1) return;
	write({
		type: "set-millifraction",
		enabled
	});
}
async function loadAvatar(choice) {
	const tokenId = ++avatarToken;
	if (!win) return;
	if (choice.kind === "preset") {
		win.webContents.send("orb:avatar", choice.src);
		return;
	}
	if (choice.kind === "default") {
		win.webContents.send("orb:avatar", "");
		return;
	}
	const image = await fetchAvatar(choice.version);
	if (tokenId !== avatarToken || !win || !image) return;
	win.webContents.send("orb:avatar", `data:${image.mime};base64,${image.body.toString("base64")}`);
}
function fetchAvatar(version) {
	const port = Number(webPort);
	if (!Number.isInteger(port) || port <= 0 || !token) return Promise.resolve(void 0);
	return new Promise((resolve) => {
		const req = request({
			hostname: "127.0.0.1",
			port,
			path: `/.dsh-orb/avatar?v=${Math.trunc(version)}`,
			method: "GET",
			headers: { "x-dsh-orb-helper": token }
		}, (res) => {
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > 45e5) {
					req.destroy();
					resolve(void 0);
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (res.statusCode !== 200) {
					resolve(void 0);
					return;
				}
				resolve({
					mime: (typeof res.headers["content-type"] === "string" ? res.headers["content-type"].split(";")[0] : "image/gif") ?? "image/gif",
					body: Buffer.concat(chunks)
				});
			});
		});
		req.setTimeout(5e3, () => {
			req.destroy();
			resolve(void 0);
		});
		req.on("error", () => resolve(void 0));
		req.end();
	});
}
//#endregion
export {};

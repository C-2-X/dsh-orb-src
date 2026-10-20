import { a as clipboardRestoreIncomplete, o as encodeBgraPng, s as appOwnerPid } from "./backend-xLwiz83E.js";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
//#region src/app-match.ts
/**
* `open_app` name matching.
* Exact process base names win over titles. A title matches whole, from a word boundary, or
* as one separator-delimited segment: a bare substring match would activate an unrelated
* window ("source code" for "code"), while a prefix-only rule would miss the way Windows
* names a document window after its app ("Document1 - Word" for "Word").
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/app-match
*/
/**
* Separators Windows titles put between the document and the app name. Both sides must be
* spaced, so `main.rs` stays one segment and never splits into `main` + `rs`.
*/
const TITLE_SEPARATORS = /\s[-–—|:]\s/u;
/**
* Pick the window `wanted` refers to, in z-order.
* @param windows - visible top-level windows, front to back.
* @param wanted - model-supplied app name.
* @returns the index of the match, or undefined when nothing matches.
*/
function selectAppWindow(windows, wanted) {
	const name = wanted.trim().toLowerCase();
	if (name === "") return void 0;
	const exact = windows.findIndex((window) => window.appName.toLowerCase() === name);
	if (exact >= 0) return exact;
	const titled = windows.findIndex((window) => titleMatches(window.title.toLowerCase(), name));
	return titled >= 0 ? titled : void 0;
}
/**
* Title equals `wanted`, starts with it at a word boundary, or carries it as one
* separator-delimited segment.
* @param title - lowercased window title.
* @param wanted - lowercased app name the model asked for.
* @returns true when the title names that app.
*/
function titleMatches(title, wanted) {
	if (title === wanted) return true;
	if (title.startsWith(wanted) && !/[a-z0-9_]/u.test(title.charAt(wanted.length))) return true;
	return title.split(TITLE_SEPARATORS).some((segment) => {
		const text = segment.trim();
		if (text === wanted) return true;
		return text.endsWith(` ${wanted}`);
	});
}
//#endregion
//#region src/koffi.ts
/**
* koffi, loaded from the copy the Orb host names in `DSH_ORB_KOFFI_DIR`, outside the
* installed package: on Windows a loaded addon inside the package blocks the next
* update from replacing it. Without that copy, koffi resolves beside this file.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/koffi
*/
function requireKoffi() {
	const dir = process.env.DSH_ORB_KOFFI_DIR;
	if (dir !== void 0 && dir !== "") try {
		return createRequire(join(dir, "index.js"))("koffi");
	} catch {}
	return createRequire(import.meta.url)("koffi");
}
const koffi = requireKoffi();
/**
* Reverse the row order of a tightly packed raster in place.
* `GetDIBits` returns bottom-up rows; every cursor and capture plane is used top-down.
* @param pixels - raster to reverse, mutated in place.
* @param rowBytes - bytes per row.
* @param height - number of rows.
*/
function flipRows(pixels, rowBytes, height) {
	if (rowBytes <= 0 || height <= 1) return;
	const scratch = Buffer.alloc(rowBytes);
	for (let top = 0, bottom = height - 1; top < bottom; top += 1, bottom -= 1) {
		const topAt = top * rowBytes;
		const bottomAt = bottom * rowBytes;
		pixels.copy(scratch, 0, topAt, topAt + rowBytes);
		pixels.copy(pixels, topAt, bottomAt, bottomAt + rowBytes);
		scratch.copy(pixels, bottomAt, 0, rowBytes);
	}
}
/**
* Where the cursor bitmap lands inside a capture region.
* The pointer is measured against the region grown by `margin`; a pointer farther out
* returns undefined and the capture is left as `BitBlt` produced it.
* @param pointer - pointer position in physical screen pixels.
* @param hotspot - cursor hotspot inside its bitmap.
* @param size - cursor bitmap size.
* @param bounds - capture region in physical screen pixels.
* @param margin - slack outside the region, {@link CURSOR_EDGE_MARGIN} by default.
* @returns the capture-local top-left, or undefined when the cursor must not be drawn.
*/
function cursorDrawPlacement(pointer, hotspot, size, bounds, margin = 12) {
	if (size.width <= 0 || size.height <= 0) return void 0;
	if (![
		pointer.x,
		pointer.y,
		hotspot.x,
		hotspot.y,
		margin,
		bounds.x,
		bounds.y,
		bounds.width,
		bounds.height
	].every(Number.isFinite)) return void 0;
	if (pointer.x < bounds.x - margin || pointer.x > bounds.x + bounds.width + margin) return void 0;
	if (pointer.y < bounds.y - margin || pointer.y > bounds.y + bounds.height + margin) return void 0;
	return {
		x: Math.round(pointer.x - bounds.x - hotspot.x),
		y: Math.round(pointer.y - bounds.y - hotspot.y)
	};
}
/**
* Resolve a cursor bitmap to top-down BGRA with a usable alpha channel.
* A colour plane that carries alpha is used as it is. A legacy cursor whose colour
* plane is fully transparent falls back to the AND mask: a white mask pixel keeps the
* destination, a black one paints the colour plane.
* @param cursor - bitmap from `GetIconInfo`.
* @returns top-down BGRA pixels, `width * height * 4` bytes.
*/
function resolveCursorAlpha(cursor) {
	const { width, height, color, mask } = cursor;
	const pixels = width * height;
	if (pixels <= 0) return Buffer.alloc(0);
	let hasAlpha = false;
	for (let index = 3; index < pixels * 4; index += 4) if ((color[index] ?? 0) !== 0) {
		hasAlpha = true;
		break;
	}
	if (hasAlpha || mask === void 0) return color;
	const out = Buffer.alloc(pixels * 4);
	for (let at = 0; at < pixels * 4; at += 4) {
		if ((mask[at] ?? 0) !== 0) continue;
		out[at] = color[at] ?? 0;
		out[at + 1] = color[at + 1] ?? 0;
		out[at + 2] = color[at + 2] ?? 0;
		out[at + 3] = 255;
	}
	return out;
}
/**
* Alpha-blend one cursor bitmap into a BGRA raster. Pixels outside the target are clipped.
* @param target - destination BGRA pixels, top-down, mutated in place.
* @param targetWidth - destination width.
* @param targetHeight - destination height.
* @param cursor - top-down BGRA cursor pixels with a resolved alpha channel.
* @param cursorWidth - cursor width.
* @param cursorHeight - cursor height.
* @param at - capture-local top-left for the cursor.
*/
function compositeCursor(target, targetWidth, targetHeight, cursor, cursorWidth, cursorHeight, at) {
	if (targetWidth <= 0 || targetHeight <= 0 || cursorWidth <= 0 || cursorHeight <= 0) return;
	for (let row = 0; row < cursorHeight; row += 1) {
		const y = at.y + row;
		if (y < 0 || y >= targetHeight) continue;
		for (let column = 0; column < cursorWidth; column += 1) {
			const x = at.x + column;
			if (x < 0 || x >= targetWidth) continue;
			const source = (row * cursorWidth + column) * 4;
			const alpha = cursor[source + 3] ?? 0;
			if (alpha === 0) continue;
			const destination = (y * targetWidth + x) * 4;
			if (alpha === 255) {
				target[destination] = cursor[source] ?? 0;
				target[destination + 1] = cursor[source + 1] ?? 0;
				target[destination + 2] = cursor[source + 2] ?? 0;
				target[destination + 3] = 255;
				continue;
			}
			const opacity = alpha / 255;
			for (let channel = 0; channel < 3; channel += 1) {
				const under = target[destination + channel] ?? 0;
				const over = cursor[source + channel] ?? 0;
				target[destination + channel] = Math.round(under * (1 - opacity) + over * opacity);
			}
			target[destination + 3] = 255;
		}
	}
}
//#endregion
//#region src/windows-native.ts
/**
* Win32 capture and input used by {@link createWindowsDesktopBackend}.
* Loaded only on Windows, and only when a method runs without injected operations.
* Each coordinate-bearing call sets this thread to per-monitor DPI awareness so
* window rectangles, `BitBlt`, and `SendInput` share physical pixels, then restores
* the previous awareness. `.agents/notes/implemented/architecture/2026-09-23-windows-computer-use-per-monitor-dpi.md`
* owns that decision.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/windows-native
*/
const SRCCOPY = 13369376;
const MOUSEEVENTF_LEFTDOWN = 2;
const MOUSEEVENTF_LEFTUP = 4;
const MOUSEEVENTF_RIGHTDOWN = 8;
const MOUSEEVENTF_RIGHTUP = 16;
const MOUSEEVENTF_WHEEL = 2048;
const MOUSEEVENTF_ABSOLUTE = 32768;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 1;
const KEYEVENTF_KEYUP = 2;
const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 2;
/** Integrity RID of a normal, unelevated process (`S-1-16-8192`). */
const MEDIUM_INTEGRITY_RID = 8192;
/**
* Bytes a clipboard snapshot may copy across all its formats. A 4K screenshot's CF_DIB is
* tens of megabytes, and the snapshot runs on every `input_text`, so the budget keeps a
* single paste from materializing an unbounded amount of memory. Formats that do not fit
* are left out; the plain-text entry is taken first.
*/
const CLIPBOARD_SNAPSHOT_LIMIT_BYTES = 16777216;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const PROCESS_QUERY_LIMITED_INFORMATION = 4096;
const TOKEN_QUERY = 8;
const TokenIntegrityLevel = 25;
const SW_SHOWNORMAL = 1;
const SW_RESTORE = 9;
const GW_OWNER = 4;
/** `GetAncestor` flag: the root (top-level) window of a child. */
const GA_ROOT = 2;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 2147483648;
const WS_EX_TOOLWINDOW = 128;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const MONITOR_DEFAULTTONEAREST = 2;
const MDT_EFFECTIVE_DPI = 0;
const VK_MENU = 18;
/** `CURSORINFO.flags` bit set while the pointer is drawn. */
const CURSOR_SHOWING = 1;
/** Per-monitor v2, then per-monitor. `SetThreadDpiAwarenessContext` returns NULL when the context is unsupported. */
const DPI_PER_MONITOR_V2 = -4;
const DPI_PER_MONITOR = -3;
const FOREGROUND_RETRY_MS = 50;
koffi.struct("DSH_CU_RECT", {
	left: "int32",
	top: "int32",
	right: "int32",
	bottom: "int32"
});
const POINT = koffi.struct("DSH_CU_POINT", {
	x: "int32",
	y: "int32"
});
koffi.struct("DSH_CU_BITMAPINFOHEADER", {
	biSize: "uint32",
	biWidth: "int32",
	biHeight: "int32",
	biPlanes: "uint16",
	biBitCount: "uint16",
	biCompression: "uint32",
	biSizeImage: "uint32",
	biXPelsPerMeter: "int32",
	biYPelsPerMeter: "int32",
	biClrUsed: "uint32",
	biClrImportant: "uint32"
});
const MOUSEINPUT = koffi.struct("DSH_CU_MOUSEINPUT", {
	dx: "int32",
	dy: "int32",
	mouseData: "uint32",
	dwFlags: "uint32",
	time: "uint32",
	dwExtraInfo: "uintptr"
});
const KEYBDINPUT = koffi.struct("DSH_CU_KEYBDINPUT", {
	wVk: "uint16",
	wScan: "uint16",
	dwFlags: "uint32",
	time: "uint32",
	dwExtraInfo: "uintptr"
});
const INPUT_UNION = koffi.union("DSH_CU_INPUT_UNION", {
	mi: MOUSEINPUT,
	ki: KEYBDINPUT
});
const INPUT = koffi.struct("DSH_CU_INPUT", {
	type: "uint32",
	u: INPUT_UNION
});
const CURSORINFO = koffi.struct("DSH_CU_CURSORINFO", {
	cbSize: "uint32",
	flags: "uint32",
	hCursor: "void *",
	ptScreenPos: POINT
});
const ICONINFO = koffi.struct("DSH_CU_ICONINFO", {
	fIcon: "int32",
	xHotspot: "uint32",
	yHotspot: "uint32",
	hbmMask: "void *",
	hbmColor: "void *"
});
/** `tagBITMAP`; only `bmWidth` and `bmHeight` are read. */
const BITMAP = koffi.struct("DSH_CU_BITMAP", {
	bmType: "int32",
	bmWidth: "int32",
	bmHeight: "int32",
	bmWidthBytes: "int32",
	bmPlanes: "uint16",
	bmBitsPixel: "uint16",
	bmBits: "void *"
});
function isNull(value) {
	return value === null || value === void 0 || value === 0 || value === 0n;
}
function dpiContext(value) {
	if (typeof value === "bigint") return value === 0n ? void 0 : value;
	if (typeof value === "number" && value !== 0) return value;
}
function hwndId(value) {
	const id = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : NaN;
	if (!Number.isSafeInteger(id) || id === 0) return void 0;
	return id;
}
function low32(value) {
	if (typeof value === "bigint") return Number(BigInt.asIntN(32, value));
	if (typeof value === "number" && Number.isFinite(value)) return value | 0;
	return 0;
}
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function bind(libraries) {
	const { user32, gdi32, kernel32, shell32, advapi32, dwmapi } = libraries;
	const enumProc = koffi.proto("int __stdcall DshCuEnumWindowsProc(void *hwnd, intptr lParam)");
	const childProc = koffi.proto("int __stdcall DshCuEnumChildProc(void *hwnd, intptr lParam)");
	let setThreadDpi;
	try {
		setThreadDpi = user32.func("intptr __stdcall SetThreadDpiAwarenessContext(intptr dpiContext)");
	} catch {
		setThreadDpi = void 0;
	}
	let getDpiForMonitor;
	try {
		getDpiForMonitor = koffi.load("shcore.dll").func("int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)");
	} catch {
		getDpiForMonitor = void 0;
	}
	return {
		GetForegroundWindow: user32.func("void * __stdcall GetForegroundWindow()"),
		GetWindowRect: user32.func("int __stdcall GetWindowRect(void *hWnd, _Out_ DSH_CU_RECT *lpRect)"),
		GetWindowTextLengthW: user32.func("int __stdcall GetWindowTextLengthW(void *hWnd)"),
		GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)"),
		GetWindowThreadProcessId: user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)"),
		IsWindowVisible: user32.func("int __stdcall IsWindowVisible(void *hWnd)"),
		IsIconic: user32.func("int __stdcall IsIconic(void *hWnd)"),
		EnumWindows: user32.func("int __stdcall EnumWindows(DshCuEnumWindowsProc *lpEnumFunc, intptr lParam)"),
		EnumChildWindows: user32.func("int __stdcall EnumChildWindows(void *hWndParent, DshCuEnumChildProc *lpEnumFunc, intptr lParam)"),
		GetClassNameW: user32.func("int __stdcall GetClassNameW(void *hWnd, uint16_t *lpClassName, int nMaxCount)"),
		GetWindow: user32.func("void * __stdcall GetWindow(void *hWnd, uint32 uCmd)"),
		GetAncestor: user32.func("void * __stdcall GetAncestor(void *hwnd, uint32 gaFlags)"),
		GetWindowLongPtrW: user32.func("intptr __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)"),
		ShowWindow: user32.func("int __stdcall ShowWindow(void *hWnd, int nCmdShow)"),
		SetForegroundWindow: user32.func("int __stdcall SetForegroundWindow(void *hWnd)"),
		MonitorFromWindow: user32.func("void * __stdcall MonitorFromWindow(void *hwnd, uint32 dwFlags)"),
		GetMonitorInfoW: user32.func("int __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ uint8_t *lpmi)"),
		GetSystemMetrics: user32.func("int __stdcall GetSystemMetrics(int nIndex)"),
		GetCursorPos: user32.func("int __stdcall GetCursorPos(_Out_ DSH_CU_POINT *lpPoint)"),
		SetCursorPos: user32.func("int __stdcall SetCursorPos(int X, int Y)"),
		WindowFromPoint: user32.func("void * __stdcall WindowFromPoint(DSH_CU_POINT point)"),
		GetCursorInfo: user32.func("int __stdcall GetCursorInfo(_Inout_ uint8_t *pci)"),
		GetIconInfo: user32.func("int __stdcall GetIconInfo(void *hIcon, _Out_ uint8_t *piconinfo)"),
		SetThreadDpiAwarenessContext: setThreadDpi,
		GetDpiForMonitor: getDpiForMonitor,
		GetDC: user32.func("void * __stdcall GetDC(void *hWnd)"),
		ReleaseDC: user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)"),
		CreateCompatibleDC: gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)"),
		CreateCompatibleBitmap: gdi32.func("void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)"),
		SelectObject: gdi32.func("void * __stdcall SelectObject(void *hdc, void *h)"),
		BitBlt: gdi32.func("int __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)"),
		GetDIBits: gdi32.func("int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, _Out_ uint8_t *lpvBits, _Inout_ DSH_CU_BITMAPINFOHEADER *lpbmi, uint32 usage)"),
		DeleteObject: gdi32.func("int __stdcall DeleteObject(void *ho)"),
		DeleteDC: gdi32.func("int __stdcall DeleteDC(void *hdc)"),
		GetObjectW: gdi32.func("int __stdcall GetObjectW(void *h, int c, _Out_ uint8_t *pv)"),
		SendInput: user32.func("uint32 __stdcall SendInput(uint32 cInputs, DSH_CU_INPUT *pInputs, int cbSize)"),
		OpenClipboard: user32.func("int __stdcall OpenClipboard(void *hWndNewOwner)"),
		EmptyClipboard: user32.func("int __stdcall EmptyClipboard()"),
		SetClipboardData: user32.func("void * __stdcall SetClipboardData(uint32 uFormat, void *hMem)"),
		CloseClipboard: user32.func("int __stdcall CloseClipboard()"),
		GetClipboardData: user32.func("void * __stdcall GetClipboardData(uint32 uFormat)"),
		EnumClipboardFormats: user32.func("uint32 __stdcall EnumClipboardFormats(uint32 format)"),
		GlobalAlloc: kernel32.func("void * __stdcall GlobalAlloc(uint32 uFlags, uintptr dwBytes)"),
		GlobalLock: kernel32.func("void * __stdcall GlobalLock(void *hMem)"),
		GlobalUnlock: kernel32.func("int __stdcall GlobalUnlock(void *hMem)"),
		GlobalSize: kernel32.func("uintptr __stdcall GlobalSize(void *hMem)"),
		GlobalFree: kernel32.func("void * __stdcall GlobalFree(void *hMem)"),
		RtlMoveMemory: kernel32.func("void __stdcall RtlMoveMemory(void *Destination, void *Source, uintptr Length)"),
		OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)"),
		CloseHandle: kernel32.func("int __stdcall CloseHandle(void *hObject)"),
		QueryFullProcessImageNameW: kernel32.func("int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)"),
		OpenProcessToken: advapi32.func("int __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)"),
		GetTokenInformation: advapi32.func("int __stdcall GetTokenInformation(void *TokenHandle, int TokenInformationClass, _Out_ uint8_t *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)"),
		GetSidSubAuthorityCount: advapi32.func("uint8_t * __stdcall GetSidSubAuthorityCount(void *pSid)"),
		GetSidSubAuthority: advapi32.func("uint32 * __stdcall GetSidSubAuthority(void *pSid, uint32 nSubAuthority)"),
		ShellExecuteW: shell32.func("intptr __stdcall ShellExecuteW(void *hwnd, str16 lpOperation, str16 lpFile, str16 lpParameters, str16 lpDirectory, int nShowCmd)"),
		DwmGetWindowAttribute: dwmapi.func("int __stdcall DwmGetWindowAttribute(void *hwnd, uint32 dwAttribute, _Out_ uint8_t *pvAttribute, uint32 cbAttribute)"),
		enumProc,
		childProc
	};
}
function windowText(api, hwnd) {
	const length = api.GetWindowTextLengthW(hwnd);
	if (length <= 0) return "";
	const buffer = Buffer.alloc((length + 1) * 2);
	api.GetWindowTextW(hwnd, buffer, length + 1);
	return buffer.toString("utf16le", 0, length * 2);
}
function classNameOf(api, hwnd) {
	const buffer = Buffer.alloc(512);
	const length = api.GetClassNameW(hwnd, buffer, 256);
	if (length <= 0) return "";
	return buffer.toString("utf16le", 0, length * 2);
}
function pidOf(api, hwnd) {
	const pid = [0];
	api.GetWindowThreadProcessId(hwnd, pid);
	return pid[0] ?? 0;
}
function processBaseName(api, pid) {
	if (pid === 0) return void 0;
	const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
	if (isNull(handle)) return void 0;
	try {
		const chars = Buffer.alloc(2048);
		const size = [1024];
		if (api.QueryFullProcessImageNameW(handle, 0, chars, size) === 0) return void 0;
		const count = size[0] ?? 0;
		const full = chars.toString("utf16le", 0, count * 2);
		return (full.split(/[\\/]/u).at(-1) ?? full).replace(/\.exe$/iu, "");
	} finally {
		api.CloseHandle(handle);
	}
}
function integrityRid(api, pid) {
	try {
		return integrityRidUnchecked(api, pid);
	} catch {
		return;
	}
}
let warnedUnknownSelf = false;
/** Say once that the elevation check fell back to the unelevated default. */
function warnUnknownSelfIntegrity() {
	if (warnedUnknownSelf) return;
	warnedUnknownSelf = true;
	console.error("computer-use: this process integrity level cannot be read; assuming unelevated");
}
function integrityRidUnchecked(api, pid) {
	const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
	if (isNull(handle)) return void 0;
	const token = [null];
	try {
		if (api.OpenProcessToken(handle, TOKEN_QUERY, token) === 0) return void 0;
		const tokenHandle = token[0];
		try {
			const needed = [0];
			api.GetTokenInformation(tokenHandle, TokenIntegrityLevel, null, 0, needed);
			const size = needed[0] ?? 0;
			if (size < 8) return void 0;
			const info = Buffer.alloc(size);
			if (api.GetTokenInformation(tokenHandle, TokenIntegrityLevel, info, size, needed) === 0) return void 0;
			const sid = info.readBigUInt64LE(0);
			const countPtr = api.GetSidSubAuthorityCount(sid);
			const count = koffi.decode(countPtr, "uint8");
			if (count < 1) return void 0;
			const ridPtr = api.GetSidSubAuthority(sid, count - 1);
			return koffi.decode(ridPtr, "uint32");
		} finally {
			api.CloseHandle(tokenHandle);
		}
	} finally {
		api.CloseHandle(handle);
	}
}
function explorerFolder(hwnd) {
	const script = `
$shell = New-Object -ComObject Shell.Application
foreach ($window in @($shell.Windows())) {
  if ([int64]$window.HWND -eq ${String(hwnd)}) {
    $window.Document.Folder.Self.Path
    break
  }
}
`;
	try {
		const path = execFileSync("powershell.exe", [
			"-NoProfile",
			"-Command",
			script
		], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 2e3
		}).trim();
		return path === "" ? void 0 : path;
	} catch {
		return;
	}
}
function sendMouse(api, flags, x, y, data = 0) {
	const absolute = (flags & MOUSEEVENTF_ABSOLUTE) !== 0;
	const left = api.GetSystemMetrics(SM_XVIRTUALSCREEN);
	const top = api.GetSystemMetrics(SM_YVIRTUALSCREEN);
	const width = Math.max(1, api.GetSystemMetrics(SM_CXVIRTUALSCREEN));
	const height = Math.max(1, api.GetSystemMetrics(SM_CYVIRTUALSCREEN));
	const input = {
		type: INPUT_MOUSE,
		u: { mi: {
			dx: absolute ? Math.round((x - left) * 65535 / Math.max(1, width - 1)) : x,
			dy: absolute ? Math.round((y - top) * 65535 / Math.max(1, height - 1)) : y,
			mouseData: data >>> 0,
			dwFlags: flags,
			time: 0,
			dwExtraInfo: 0
		} }
	};
	if (api.SendInput(1, [input], INPUT.size) !== 1) throw new Error("computer-use: pointer input failed");
}
function postKey(api, virtualKey, down, extended) {
	const input = {
		type: INPUT_KEYBOARD,
		u: { ki: {
			wVk: virtualKey,
			wScan: 0,
			dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0),
			time: 0,
			dwExtraInfo: 0
		} }
	};
	if (api.SendInput(1, [input], INPUT.size) !== 1) throw new Error("computer-use: keyboard input failed");
}
function withClipboard(api, write) {
	if (api.OpenClipboard(null) === 0) throw new Error("computer-use: OpenClipboard failed");
	try {
		write();
	} finally {
		api.CloseClipboard();
	}
}
function enumTopLevel(api) {
	const hwnds = [];
	const callback = koffi.register((hwnd) => {
		hwnds.push(hwnd);
		return 1;
	}, koffi.pointer(api.enumProc));
	try {
		api.EnumWindows(callback, 0);
	} finally {
		koffi.unregister(callback);
	}
	return hwnds;
}
function coreWindowPid(api, hwnd) {
	let found = 0;
	const callback = koffi.register((child) => {
		if (classNameOf(api, child) !== "Windows.UI.Core.CoreWindow") return 1;
		found = pidOf(api, child);
		return 0;
	}, koffi.pointer(api.childProc));
	try {
		api.EnumChildWindows(hwnd, callback, 0);
	} finally {
		koffi.unregister(callback);
	}
	return found === 0 ? void 0 : found;
}
function frameOf(api, hwnd) {
	const extended = Buffer.alloc(16);
	if (api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, extended, 16) === 0) {
		const left = extended.readInt32LE(0);
		const top = extended.readInt32LE(4);
		const right = extended.readInt32LE(8);
		const bottom = extended.readInt32LE(12);
		return {
			x: left,
			y: top,
			width: right - left,
			height: bottom - top
		};
	}
	const rect = {
		left: 0,
		top: 0,
		right: 0,
		bottom: 0
	};
	if (api.GetWindowRect(hwnd, rect) === 0) return void 0;
	return {
		x: rect.left,
		y: rect.top,
		width: rect.right - rect.left,
		height: rect.bottom - rect.top
	};
}
function cloaked(api, hwnd) {
	const flag = Buffer.alloc(4);
	if (api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, flag, 4) !== 0) return false;
	return flag.readUInt32LE(0) !== 0;
}
function bitmapSize(api, bitmap) {
	const info = Buffer.alloc(BITMAP.size);
	if (api.GetObjectW(bitmap, BITMAP.size, info) === 0) return void 0;
	const decoded = koffi.decode(info, BITMAP);
	if (decoded.bmWidth <= 0 || decoded.bmHeight <= 0) return void 0;
	return {
		width: decoded.bmWidth,
		height: decoded.bmHeight
	};
}
/** Read one bitmap as top-down 32-bit BGRA. `GetDIBits` converts depth and row order for us. */
function bitmapPixels(api, dc, bitmap, size) {
	const rowBytes = size.width * 4;
	const pixels = Buffer.alloc(rowBytes * size.height);
	const header = {
		biSize: 40,
		biWidth: size.width,
		biHeight: size.height,
		biPlanes: 1,
		biBitCount: 32,
		biCompression: 0,
		biSizeImage: pixels.length,
		biXPelsPerMeter: 0,
		biYPelsPerMeter: 0,
		biClrUsed: 0,
		biClrImportant: 0
	};
	if (api.GetDIBits(dc, bitmap, 0, size.height, pixels, header, 0) === 0) return void 0;
	flipRows(pixels, rowBytes, size.height);
	return pixels;
}
/**
* The system pointer as Win32 reports it.
* `GetIconInfo` hands over two bitmaps the caller owns; the shared cursor handle is not ours to free.
* @returns position, hotspot, and bitmaps, or undefined when no pointer is drawn.
*/
function readCursor(api) {
	const info = Buffer.alloc(CURSORINFO.size);
	info.writeUInt32LE(CURSORINFO.size, 0);
	if (api.GetCursorInfo(info) === 0) return void 0;
	const cursor = koffi.decode(info, CURSORINFO);
	if ((cursor.flags & CURSOR_SHOWING) === 0 || isNull(cursor.hCursor)) return void 0;
	const icon = Buffer.alloc(ICONINFO.size);
	if (api.GetIconInfo(cursor.hCursor, icon) === 0) return void 0;
	const decoded = koffi.decode(icon, ICONINFO);
	return {
		pointer: {
			x: cursor.ptScreenPos.x,
			y: cursor.ptScreenPos.y
		},
		hotspot: {
			x: decoded.xHotspot,
			y: decoded.yHotspot
		},
		color: decoded.hbmColor,
		mask: decoded.hbmMask
	};
}
/**
* Draw the system pointer into one capture raster.
* `BitBlt` copies the desktop without the cursor layer, so the agent cannot see where its
* clicks land. macOS gets the same pointer baked in by `screencapture -x -C`.
* @param bounds - capture region in physical pixels, matching the raster origin.
*/
function drawCursor(api, dc, pixels, width, height, bounds) {
	const cursor = readCursor(api);
	if (cursor === void 0) return;
	try {
		const size = bitmapSize(api, cursor.color);
		if (size === void 0) return;
		const placement = cursorDrawPlacement(cursor.pointer, cursor.hotspot, size, bounds);
		if (placement === void 0) return;
		const color = bitmapPixels(api, dc, cursor.color, size);
		if (color === void 0) return;
		const mask = isNull(cursor.mask) ? void 0 : bitmapPixels(api, dc, cursor.mask, size);
		compositeCursor(pixels, width, height, resolveCursorAlpha({
			width: size.width,
			height: size.height,
			color,
			...mask === void 0 ? {} : { mask }
		}), size.width, size.height, placement);
	} finally {
		if (!isNull(cursor.color)) api.DeleteObject(cursor.color);
		if (!isNull(cursor.mask)) api.DeleteObject(cursor.mask);
	}
}
function monitorOf(api, hwnd, fallback) {
	const handle = api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
	if (isNull(handle)) return {
		monitor: fallback,
		dpi: 96
	};
	const info = Buffer.alloc(40);
	info.writeUInt32LE(40, 0);
	if (api.GetMonitorInfoW(handle, info) === 0) return {
		monitor: fallback,
		dpi: 96
	};
	const left = info.readInt32LE(4);
	const top = info.readInt32LE(8);
	const right = info.readInt32LE(12);
	const bottom = info.readInt32LE(16);
	const monitor = {
		x: left,
		y: top,
		width: right - left,
		height: bottom - top
	};
	const readDpi = api.GetDpiForMonitor;
	if (readDpi === void 0) return {
		monitor,
		dpi: 96
	};
	const dpiX = [0];
	if (readDpi(handle, MDT_EFFECTIVE_DPI, dpiX, [0]) !== 0) return {
		monitor,
		dpi: 96
	};
	const dpi = dpiX[0] ?? 0;
	return {
		monitor,
		dpi: dpi > 0 ? dpi : 96
	};
}
function stylesOf(api, hwnd) {
	const style = low32(api.GetWindowLongPtrW(hwnd, GWL_STYLE));
	const extended = low32(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	return {
		popup: (style & WS_POPUP) !== 0,
		toolWindow: (extended & WS_EX_TOOLWINDOW) !== 0
	};
}
function cachedAppName(api, cache, pid) {
	const cached = cache.get(pid);
	if (cached !== void 0) return cached;
	const name = processBaseName(api, pid) ?? "unknown";
	cache.set(pid, name);
	return name;
}
/**
* Win32 operations for the production Windows backend.
* @returns operations that capture and post input on this machine.
*/
function createProductionWindowsOps() {
	if (process.arch === "x64" && INPUT.size !== 40) throw new Error(`computer-use: INPUT size ${String(INPUT.size)} is not 40`);
	if (process.arch === "x64" && (CURSORINFO.size !== 24 || ICONINFO.size !== 32 || BITMAP.size !== 32)) throw new Error("computer-use: cursor structs are not laid out for x64");
	const api = bind({
		user32: koffi.load("user32.dll"),
		gdi32: koffi.load("gdi32.dll"),
		kernel32: koffi.load("kernel32.dll"),
		shell32: koffi.load("shell32.dll"),
		advapi32: koffi.load("advapi32.dll"),
		dwmapi: koffi.load("dwmapi.dll")
	});
	const selfRid = integrityRid(api, process.pid);
	function perMonitor(fn) {
		const set = api.SetThreadDpiAwarenessContext;
		if (set === void 0) return fn();
		const restore = dpiContext(set(DPI_PER_MONITOR_V2)) ?? dpiContext(set(DPI_PER_MONITOR));
		if (restore === void 0) return fn();
		try {
			return fn();
		} finally {
			set(restore);
		}
	}
	function placePointer(x, y) {
		sendMouse(api, 49153, x, y);
		const pos = {
			x: 0,
			y: 0
		};
		if (api.GetCursorPos(pos) === 0 || pos.x !== x || pos.y !== y) {
			if (api.SetCursorPos(x, y) === 0) throw new Error("computer-use: pointer input failed");
		}
	}
	function listWindows() {
		return perMonitor(() => {
			const names = /* @__PURE__ */ new Map();
			const windows = [];
			for (const hwnd of enumTopLevel(api)) {
				const id = hwndId(hwnd);
				if (id === void 0) continue;
				const frame = frameOf(api, hwnd);
				if (frame === void 0) continue;
				const className = classNameOf(api, hwnd);
				const pid = pidOf(api, hwnd);
				const appPid = appOwnerPid(className, pid, () => coreWindowPid(api, hwnd));
				const styles = stylesOf(api, hwnd);
				const display = monitorOf(api, hwnd, frame);
				windows.push({
					hwnd: id,
					pid: appPid,
					ownerHwnd: hwndId(api.GetWindow(hwnd, GW_OWNER)) ?? 0,
					className,
					appName: cachedAppName(api, names, appPid),
					title: windowText(api, hwnd),
					visible: api.IsWindowVisible(hwnd) !== 0,
					iconic: api.IsIconic(hwnd) !== 0,
					cloaked: cloaked(api, hwnd),
					toolWindow: styles.toolWindow,
					popup: styles.popup,
					frame,
					monitor: display.monitor,
					monitorDpi: display.dpi
				});
			}
			return {
				foregroundHwnd: hwndId(api.GetForegroundWindow()) ?? 0,
				windows
			};
		});
	}
	function isForeground(hwnd) {
		return hwndId(api.GetForegroundWindow()) === hwndId(hwnd);
	}
	function windowPointer(id) {
		if (!Number.isSafeInteger(id) || id <= 0) return void 0;
		for (const hwnd of enumTopLevel(api)) if (hwndId(hwnd) === id) return hwnd;
	}
	/**
	* `SetForegroundWindow` is ignored unless this process received the last input.
	* A posted Alt transition satisfies that, then the key is released.
	* @param target - top-level HWND pointer from `EnumWindows`.
	* @returns false when `target` is still not foreground after one retry.
	*/
	function becomeForeground(target) {
		if (api.IsIconic(target) !== 0) api.ShowWindow(target, SW_RESTORE);
		postKey(api, VK_MENU, true, false);
		try {
			api.SetForegroundWindow(target);
			if (!isForeground(target)) {
				sleepSync(FOREGROUND_RETRY_MS);
				if (!isForeground(target)) return false;
			}
			return true;
		} finally {
			postKey(api, VK_MENU, false, false);
		}
	}
	return {
		listWindows,
		capturePng(bounds) {
			return perMonitor(() => {
				const width = Math.max(1, Math.round(bounds.width));
				const height = Math.max(1, Math.round(bounds.height));
				const originX = Math.round(bounds.x);
				const originY = Math.round(bounds.y);
				const region = {
					x: originX,
					y: originY,
					width,
					height
				};
				const screenDc = api.GetDC(null);
				if (isNull(screenDc)) throw new Error("computer-use: screen capture failed");
				const memory = api.CreateCompatibleDC(screenDc);
				const bitmap = api.CreateCompatibleBitmap(screenDc, width, height);
				const previous = api.SelectObject(memory, bitmap);
				try {
					if (api.BitBlt(memory, 0, 0, width, height, screenDc, originX, originY, SRCCOPY) === 0) throw new Error("computer-use: screen capture failed");
					const header = {
						biSize: 40,
						biWidth: width,
						biHeight: height,
						biPlanes: 1,
						biBitCount: 32,
						biCompression: 0,
						biSizeImage: width * height * 4,
						biXPelsPerMeter: 0,
						biYPelsPerMeter: 0,
						biClrUsed: 0,
						biClrImportant: 0
					};
					const pixels = Buffer.alloc(width * height * 4);
					if (api.GetDIBits(memory, bitmap, 0, height, pixels, header, 0) === 0) throw new Error("computer-use: screen capture failed");
					flipRows(pixels, width * 4, height);
					drawCursor(api, memory, pixels, width, height, region);
					return encodeBgraPng(width, height, pixels, false);
				} finally {
					api.SelectObject(memory, previous);
					api.DeleteObject(bitmap);
					api.DeleteDC(memory);
					api.ReleaseDC(null, screenDc);
				}
			});
		},
		targetBlocksInput(hwnd) {
			const target = windowPointer(hwnd);
			if (target === void 0) return false;
			const rid = integrityRid(api, pidOf(api, target));
			if (rid === void 0) return true;
			if (selfRid === void 0) {
				warnUnknownSelfIntegrity();
				return rid > MEDIUM_INTEGRITY_RID;
			}
			return rid > selfRid;
		},
		windowFromPoint(x, y) {
			return perMonitor(() => {
				const hit = api.WindowFromPoint({
					x,
					y
				});
				if (isNull(hit)) return 0;
				const root = api.GetAncestor(hit, GA_ROOT);
				return hwndId(isNull(root) ? hit : root) ?? 0;
			});
		},
		movePointer(x, y) {
			perMonitor(() => {
				placePointer(x, y);
			});
		},
		mouseButton(button, down) {
			const flags = button === "right" ? down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP : down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
			perMonitor(() => {
				sendMouse(api, flags, 0, 0);
			});
		},
		scrollWheel(x, y, delta) {
			perMonitor(() => {
				placePointer(x, y);
				sendMouse(api, MOUSEEVENTF_WHEEL, 0, 0, delta);
			});
		},
		key(virtualKey, down, extended = false) {
			postKey(api, virtualKey, down, extended);
		},
		saveClipboard() {
			const seen = [];
			const bytes = /* @__PURE__ */ new Map();
			withClipboard(api, () => {
				let format = 0;
				for (;;) {
					format = api.EnumClipboardFormats(format);
					if (format === 0) break;
					const handle = api.GetClipboardData(format);
					if (isNull(handle)) continue;
					const size = Number(api.GlobalSize(handle));
					if (!Number.isFinite(size) || size <= 0) continue;
					seen.push({
						format,
						size
					});
				}
				seen.sort((left, right) => Number(right.format === CF_UNICODETEXT) - Number(left.format === CF_UNICODETEXT) || left.size - right.size);
				let used = 0;
				for (const entry of seen) {
					if (used + entry.size > CLIPBOARD_SNAPSHOT_LIMIT_BYTES) continue;
					const handle = api.GetClipboardData(entry.format);
					if (isNull(handle)) continue;
					const locked = api.GlobalLock(handle);
					if (isNull(locked)) continue;
					try {
						const copy = Buffer.alloc(entry.size);
						api.RtlMoveMemory(copy, locked, entry.size);
						bytes.set(entry.format, copy);
						used += entry.size;
					} finally {
						api.GlobalUnlock(handle);
					}
				}
			});
			const entries = seen.flatMap((entry) => {
				const copy = bytes.get(entry.format);
				return copy === void 0 ? [] : [{
					format: entry.format,
					bytes: copy
				}];
			});
			const copied = new Set(entries.map((entry) => entry.format));
			return {
				entries,
				dropped: seen.filter((entry) => !copied.has(entry.format)).map((entry) => entry.format)
			};
		},
		restoreClipboard(snapshot) {
			let restored = 0;
			withClipboard(api, () => {
				api.EmptyClipboard();
				for (const entry of snapshot.entries) {
					const memory = api.GlobalAlloc(GMEM_MOVEABLE, entry.bytes.length);
					if (isNull(memory)) continue;
					const locked = api.GlobalLock(memory);
					if (isNull(locked)) {
						api.GlobalFree(memory);
						continue;
					}
					api.RtlMoveMemory(locked, entry.bytes, entry.bytes.length);
					api.GlobalUnlock(memory);
					if (isNull(api.SetClipboardData(entry.format, memory))) {
						api.GlobalFree(memory);
						continue;
					}
					restored += 1;
				}
			});
			if (clipboardRestoreIncomplete(snapshot, restored)) console.error("computer-use: the clipboard could not be fully restored after the paste");
		},
		setClipboardText(text) {
			const bytes = Buffer.from(`${text}\0`, "utf16le");
			const memory = api.GlobalAlloc(GMEM_MOVEABLE, bytes.length);
			if (isNull(memory)) throw new Error("computer-use: clipboard allocation failed");
			const locked = api.GlobalLock(memory);
			if (isNull(locked)) throw new Error("computer-use: clipboard allocation failed");
			api.RtlMoveMemory(locked, bytes, bytes.length);
			api.GlobalUnlock(memory);
			withClipboard(api, () => {
				api.EmptyClipboard();
				if (isNull(api.SetClipboardData(CF_UNICODETEXT, memory))) throw new Error("computer-use: SetClipboardData failed");
			});
		},
		copyImageFile(path) {
			const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile(${JSON.stringify(path)})
try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }
`;
			execFileSync("powershell.exe", [
				"-NoProfile",
				"-STA",
				"-Command",
				script
			], {
				windowsHide: true,
				timeout: 5e3
			});
		},
		listWindowApps() {
			const names = /* @__PURE__ */ new Set();
			for (const hwnd of enumTopLevel(api)) {
				if (api.IsWindowVisible(hwnd) === 0) continue;
				const name = processBaseName(api, pidOf(api, hwnd));
				if (name !== void 0 && name !== "") names.add(name);
			}
			return [...names];
		},
		activateApp(name) {
			return perMonitor(() => {
				const windows = enumTopLevel(api).filter((hwnd) => api.IsWindowVisible(hwnd) !== 0);
				const index = selectAppWindow(windows.map((hwnd) => ({
					appName: processBaseName(api, pidOf(api, hwnd)) ?? "",
					title: windowText(api, hwnd)
				})), name);
				const target = index === void 0 ? void 0 : windows[index];
				if (target === void 0) return false;
				if (!becomeForeground(target)) throw new Error(`computer-use: failed to activate ${name}`);
				return true;
			});
		},
		foregroundWindowId() {
			return hwndId(api.GetForegroundWindow()) ?? 0;
		},
		focusWindow(hwnd) {
			return perMonitor(() => {
				const target = windowPointer(hwnd);
				if (target === void 0) return false;
				return becomeForeground(target);
			});
		},
		windowAppName(hwnd) {
			const target = windowPointer(hwnd);
			if (target === void 0) return void 0;
			return perMonitor(() => {
				const pid = pidOf(api, target);
				return processBaseName(api, appOwnerPid(classNameOf(api, target), pid, () => coreWindowPid(api, target)));
			});
		},
		launch(target, parameters) {
			const result = Number(api.ShellExecuteW(null, "open", target, parameters ?? null, null, SW_SHOWNORMAL));
			if (!Number.isFinite(result) || result <= 32) throw new Error(`computer-use: failed to open ${target}`);
		},
		explorerFolder
	};
}
//#endregion
export { createProductionWindowsOps };

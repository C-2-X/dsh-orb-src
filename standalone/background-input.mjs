// Background input: PostMessage-based mouse/keyboard/text delivery that does not
// steal focus or move the physical cursor.
//
// Recipe (validated by the sibling dsh project dsh-computer-use-native and by
// this repo's spike-offscreen.mjs):
//   - mouse messages carry CLIENT coordinates, converted with ScreenToClient;
//     WM_MOUSEWHEEL is the exception and uses screen coordinates;
//   - messages are delivered to the DEEPEST child control under the point
//     (hit test), otherwise classic Win32 software silently drops them;
//   - keyboard/text needs AttachThreadInput so this thread shares the target
//     thread's input queue, then SetFocus on the target control;
//   - some apps reject posted input entirely (Windows 11 XAML Notepad is the
//     known case). Posted messages cannot report rejection, so the caller must
//     verify via the post-action observation: if the screen did not change, the
//     model sees it and can retry with foreground dispatch.
//
// Activate with agent.inputDispatch: "background" (default "foreground").
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(rootDir, "package.json"));
const koffi = require("koffi");

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

const POINT = koffi.struct("BG_POINT", { x: "int32", y: "int32" });

const PostMessageW = user32.func("int __stdcall PostMessageW(void *hWnd, uint32 Msg, intptr wParam, intptr lParam)");
const ChildWindowFromPoint = user32.func("void * __stdcall ChildWindowFromPoint(void *hWndParent, int X, int Y)");
const WindowFromPoint = user32.func("void * __stdcall WindowFromPoint(BG_POINT point)");
const GetAncestor = user32.func("void * __stdcall GetAncestor(void *hwnd, uint32 gaFlags)");
const ScreenToClient = user32.func("int __stdcall ScreenToClient(void *hWnd, _Out_ BG_POINT *lpPoint)");
const GA_ROOT = 2;
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, uint32 *lpdwProcessId)");
const GetCurrentThreadId = kernel32.func("uint32 __stdcall GetCurrentThreadId()");
const AttachThreadInput = user32.func("int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)");
const SetFocus = user32.func("void * __stdcall SetFocus(void *hWnd)");
const SetCursorPos = user32.func("int __stdcall SetCursorPos(int X, int Y)");
const GetCursorPos = user32.func("int __stdcall GetCursorPos(_Out_ BG_POINT *lpPoint)");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int nIndex)");
// Absolute mouse_event is DPI-virtualization proof: the 0-65535 coordinates are
// scaled against the virtual desktop, unlike SetCursorPos which takes logical
// pixels in this DPI-unaware Node process and lands 20% off at 125% scaling.
const mouse_event = user32.func("void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)");
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const SetForegroundWindow = user32.func("int __stdcall SetForegroundWindow(void *hWnd)");
const BringWindowToTop = user32.func("int __stdcall BringWindowToTop(void *hWnd)");
const ShowWindow = user32.func("int __stdcall ShowWindow(void *hWnd, int nCmdShow)");
const IsIconic = user32.func("int __stdcall IsIconic(void *hWnd)");
const SystemParametersInfoW = user32.func("int __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, void *pvParam, uint32 fWinIni)");
const SW_RESTORE = 9;
/** SPI_GETWHEELSCROLLLINES: how many text lines one wheel notch scrolls. */
const SPI_GETWHEELSCROLLLINES = 104;

const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const WM_MOUSEWHEEL = 0x020a;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WHEEL_DELTA = 120;

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b
};

function vkOf(key) {
  const name = String(key).toLowerCase();
  if (name in VK) return VK[name];
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
  return null;
}

function makeLong(low, high) {
  return ((high & 0xffff) << 16) | (low & 0xffff);
}

/** Global screen point for a 0-1000 position inside a screen observation. */
export function globalPointFor(screen, position) {
  const [fx, fy] = position;
  return {
    x: Math.round(screen.bounds.x + (fx / 1000) * screen.bounds.width),
    y: Math.round(screen.bounds.y + (fy / 1000) * screen.bounds.height)
  };
}

function clientPointOf(hwnd, point) {
  const p = { x: point.x, y: point.y };
  if (!ScreenToClient(hwnd, p)) throw new Error(`dsh-orb: ScreenToClient 失败（hwnd=${String(hwnd)}）`);
  return { x: p.x, y: p.y };
}

/** Deepest child window containing the point; the root itself as fallback. */
export function deepestChildAt(rootHwnd, clientPoint) {
  let target = rootHwnd;
  for (let depth = 0; depth < 16; depth += 1) {
    const child = ChildWindowFromPoint(target, clientPoint.x, clientPoint.y);
    if (!child || child === target) break;
    target = child;
  }
  return target;
}

/** Resolve a 0-1000 position to {target, local, global}. */
function resolveTarget(screen, position) {
  const global = globalPointFor(screen, position);
  const rootClient = clientPointOf(screen.windowId, global);
  const target = deepestChildAt(screen.windowId, rootClient);
  const local = target === screen.windowId ? rootClient : clientPointOf(target, global);
  return { target, local, global };
}

function post(hwnd, message, wParam, lParam) {
  if (!PostMessageW(hwnd, message, wParam, lParam)) {
    throw new Error(`dsh-orb: PostMessage 失败（hwnd=${String(hwnd)}, msg=0x${message.toString(16)}）`);
  }
}

export function postClick(screen, position, options = {}) {
  const { target, local } = resolveTarget(screen, position);
  const lParam = makeLong(local.x, local.y);
  const down = options.button === "right" ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
  const up = options.button === "right" ? WM_RBUTTONUP : WM_LBUTTONUP;
  // A hover message first: classic controls update their hover/hot state on
  // WM_MOUSEMOVE and may ignore a button press that arrives out of nowhere.
  post(target, WM_MOUSEMOVE, 0, lParam);
  post(target, down, 0, lParam);
  post(target, up, 0, lParam);
  return target;
}

export function postMove(screen, position) {
  const { target, local } = resolveTarget(screen, position);
  post(target, WM_MOUSEMOVE, 0, makeLong(local.x, local.y));
  return target;
}

/**
 * Foreground-mode hover: move the physical cursor without clicking. Used by the
 * `move` tool to reveal hover menus and tooltips.
 */
/**
 * Move the physical cursor without clicking. Uses absolute mouse_event
 * coordinates (0-65535 over the virtual desktop), which the system scales
 * itself; SetCursorPos would treat physical pixels as logical ones and drift by
 * the display scale on this DPI-unaware process.
 */
export function movePhysicalCursor(screen, position) {
  const global = globalPointFor(screen, position);
  moveAbsolute(global.x, global.y);
  const actual = { x: 0, y: 0 };
  if (GetCursorPos(actual) && (Math.abs(actual.x - global.x) > 2 || Math.abs(actual.y - global.y) > 2)) {
    // Fallback for environments where mouse_event is filtered; SetCursorPos is
    // exact at 100% scaling. Verify again so a DPI-shifted fallback fails loudly
    // instead of looking successful.
    const retried = { x: 0, y: 0 };
    if (!SetCursorPos(global.x, global.y) || (GetCursorPos(retried) && (Math.abs(retried.x - global.x) > 2 || Math.abs(retried.y - global.y) > 2))) {
      throw new Error(`dsh-orb: 光标移动失败（目标 ${global.x},${global.y}，实际 ${actual.x},${actual.y}）。`);
    }
  }
}

function moveAbsolute(x, y) {
  const left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const width = Math.max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
  const height = Math.max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
  const dx = Math.round((x - left) * 65535 / Math.max(1, width - 1));
  const dy = Math.round((y - top) * 65535 / Math.max(1, height - 1));
  mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy, 0, 0);
}

/**
 * Top-level window under a global screen point, or 0 when it cannot be read.
 * Used to refuse clicks that would land on a window covering the target
 * (floating IDE/chat panels are the common case in this environment).
 */
export function windowAtPoint(x, y) {
  try {
    const hit = WindowFromPoint({ x, y });
    if (!hit) return 0;
    const root = GetAncestor(hit, GA_ROOT);
    return handleValue(root || hit);
  } catch {
    return 0;
  }
}

/** Normalize a koffi window handle (BigInt, number or null) for comparison. */
function handleValue(handle) {
  if (handle === null || handle === undefined) return 0;
  const value = Number(handle);
  return Number.isFinite(value) ? value : 0;
}

/** HWND of the current foreground window, or 0 when it cannot be read. */
export function foregroundWindowHandle() {
  return handleValue(GetForegroundWindow());
}

/**
 * Lines per wheel notch from the Windows mouse settings. 0 ("scroll a page")
 * and -1 ("scroll a screen") are mapped to the common default of 3, because the
 * caller needs a notch count, not a raw policy value.
 * @returns {number} 1-10
 */
export function systemWheelScrollLines() {
  try {
    const buffer = Buffer.alloc(4);
    if (!SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, buffer, 0)) return 3;
    const value = buffer.readUInt32LE(0);
    if (value === 0 || value === 0xffffffff) return 3;
    return Math.min(10, Math.max(1, value));
  } catch {
    return 3;
  }
}

/**
 * Bring a window to the foreground before a real (SendInput) click. This is the
 * pywinauto `set_focus` recipe: restore a minimized window, then attach to the
 * foreground thread so SetForegroundWindow is allowed even when another app owns
 * the foreground lock. Returns true when the window ended up foreground; callers
 * continue anyway when it is false (UAC/elevated windows refuse focus).
 */
export function activateWindow(hwnd) {
  const target = handleValue(hwnd);
  if (target === 0) return false;
  if (handleValue(GetForegroundWindow()) === target) return true;
  try {
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  } catch {}
  const foreground = GetForegroundWindow();
  const foregroundThread = foreground ? GetWindowThreadProcessId(foreground, null) : 0;
  const targetThread = GetWindowThreadProcessId(hwnd, null);
  const attached = foregroundThread !== 0 && targetThread !== 0 && foregroundThread !== targetThread
    ? AttachThreadInput(foregroundThread, targetThread, 1) !== 0
    : false;
  try {
    BringWindowToTop(hwnd);
    const raised = SetForegroundWindow(hwnd) !== 0;
    return raised || handleValue(GetForegroundWindow()) === target;
  } finally {
    if (attached) AttachThreadInput(foregroundThread, targetThread, 0);
  }
}

export function postScroll(screen, position, notches) {
  const { target, global } = resolveTarget(screen, position);
  const delta = notches > 0 ? WHEEL_DELTA : -WHEEL_DELTA;
  // WM_MOUSEWHEEL uses SCREEN coordinates in lParam.
  post(target, WM_MOUSEWHEEL, delta, makeLong(global.x, global.y));
  return target;
}

/** Post a key combo (e.g. ["ctrl","a"]) to the target window. */
export function postKey(screen, keys) {
  const list = Array.isArray(keys) ? keys.map(String).filter(Boolean) : [];
  if (list.length === 0) throw new Error("hotkey.keys 不能为空。");
  const vks = list.map(vkOf);
  if (vks.some((vk) => vk === null)) throw new Error(`无法识别的按键：${list.filter((_, index) => vks[index] === null).join(", ")}`);
  const { target } = resolveTarget(screen, [500, 500]);
  for (const vk of vks) post(target, WM_KEYDOWN, vk, 1);
  for (const vk of [...vks].reverse()) post(target, WM_KEYUP, vk, 0xc0000001);
  return target;
}

/**
 * Post Unicode text into the focused control of the target window. Shares the
 * input queue via AttachThreadInput and focuses the hit-test target first, so
 * WM_CHAR lands in the edit control under the point.
 */
export function postText(screen, position, text) {
  const value = String(text);
  if (value === "") throw new Error("input_text.text 不能为空。");
  const { target } = resolveTarget(screen, position);
  const targetThread = GetWindowThreadProcessId(screen.windowId, null);
  const currentThread = GetCurrentThreadId();
  const attached = AttachThreadInput(currentThread, targetThread, 1) !== 0;
  try {
    SetFocus(target);
    const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    for (let index = 0; index < normalized.length; index += 1) {
      const unit = normalized.charCodeAt(index);
      if (unit === 0) continue;
      if (unit === 0x0a) {
        post(target, WM_KEYDOWN, 0x0d, 1);
        post(target, WM_KEYUP, 0x0d, 0xc0000001);
        continue;
      }
      if (unit === 0x09) {
        post(target, WM_KEYDOWN, 0x09, 1);
        post(target, WM_KEYUP, 0x09, 0xc0000001);
        continue;
      }
      post(target, WM_CHAR, unit, 1);
    }
  } finally {
    if (attached) AttachThreadInput(currentThread, targetThread, 0);
  }
  return target;
}

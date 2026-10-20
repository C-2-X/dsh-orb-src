// Feasibility spike for the offscreen watch surface (docs/proposals/persistent-watch-task.md §10).
//
// Capture: PrintWindow on a background / off-screen window (real WeChat + Notepad).
// Input:   PostMessage WM_CHAR, and AttachThreadInput + SetForegroundWindow + SendInput,
//          both into a Notepad that is moved off-screen; verified with WM_GETTEXT.
//
// Safety: NO input is ever sent to WeChat — WeChat is only captured (read-only) and
// its window is moved off-screen and restored inside a finally block. Input targets a
// freshly spawned Notepad. Screenshots are written to %TEMP%, never into the repo.
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(join(root, "package.json"));
const koffi = require("koffi");
const { o: encodeBgraPng } = await import(new URL("./dist/computer-use/backend-xLwiz83E.js", import.meta.url).href);
const { typeUnicodeText } = await import(new URL("./standalone/unicode-input.mjs", import.meta.url).href);

const user32 = koffi.load("user32.dll");
const gdi32 = koffi.load("gdi32.dll");
const kernel32 = koffi.load("kernel32.dll");

const RECT = koffi.struct("SPK_RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const POINT = koffi.struct("SPK_POINT", { x: "int32", y: "int32" });
function rect() { return { left: 0, top: 0, right: 0, bottom: 0 }; }
function point() { return { x: 0, y: 0 }; }
const BITMAPINFOHEADER = koffi.struct("SPK_BITMAPINFOHEADER", {
  biSize: "uint32", biWidth: "int32", biHeight: "int32", biPlanes: "uint16", biBitCount: "uint16",
  biCompression: "uint32", biSizeImage: "uint32", biXPelsPerMeter: "int32", biYPelsPerMeter: "int32",
  biClrUsed: "uint32", biClrImportant: "uint32"
});
const BITMAPINFO = koffi.struct("SPK_BITMAPINFO", { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array("uint32", 1) });
const SpikeEnumProc = koffi.proto("int __stdcall SpikeEnumProc(void *hWnd, intptr lParam)");

const FindWindowW = user32.func("void * __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)");
const FindWindowExW = user32.func("void * __stdcall FindWindowExW(void *hWndParent, void *hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)");
const GetWindowRect = user32.func("int __stdcall GetWindowRect(void *hWnd, _Out_ SPK_RECT *lpRect)");
const GetClassNameW = user32.func("int __stdcall GetClassNameW(void *hWnd, char16_t *lpClassName, int nMaxCount)");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void *hWnd, char16_t *lpString, int nMaxCount)");
const EnumWindows = user32.func("int __stdcall EnumWindows(SpikeEnumProc *lpEnumFunc, intptr lParam)");
const MoveWindow = user32.func("int __stdcall MoveWindow(void *hWnd, int X, int Y, int nWidth, int nHeight, int bRepaint)");
const ShowWindow = user32.func("int __stdcall ShowWindow(void *hWnd, int nCmdShow)");
const IsWindowVisible = user32.func("int __stdcall IsWindowVisible(void *hWnd)");
const IsIconic = user32.func("int __stdcall IsIconic(void *hWnd)");
const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const SetForegroundWindow = user32.func("int __stdcall SetForegroundWindow(void *hWnd)");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, uint32 *lpdwProcessId)");
const GetCurrentThreadId = kernel32.func("uint32 __stdcall GetCurrentThreadId()");
const AttachThreadInput = user32.func("int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)");
const GetCursorPos = user32.func("int __stdcall GetCursorPos(_Out_ SPK_POINT *lpPoint)");
const SetCursorPos = user32.func("int __stdcall SetCursorPos(int X, int Y)");
const GetConsoleWindow = kernel32.func("void * __stdcall GetConsoleWindow()");
const PrintWindow = user32.func("int __stdcall PrintWindow(void *hWnd, void *hdcBlt, uint32 nFlags)");
const GetDC = user32.func("void * __stdcall GetDC(void *hWnd)");
const ReleaseDC = user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)");
const SendMessageInt = user32.func("SendMessageW", "intptr", ["void *", "uint32", "intptr", "intptr"]);
const SendMessageBuf = user32.func("SendMessageW", "intptr", ["void *", "uint32", "intptr", "void *"]);
const PostMessageInt = user32.func("int __stdcall PostMessageW(void *hWnd, uint32 Msg, intptr wParam, intptr lParam)");
const mouse_event = user32.func("void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)");
const CreateCompatibleDC = gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)");
const CreateCompatibleBitmap = gdi32.func("void * __stdcall CreateCompatibleBitmap(void *hdc, int nWidth, int nHeight)");
const SelectObject = gdi32.func("void * __stdcall SelectObject(void *hdc, void *h)");
const GetDIBits = gdi32.func("int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, void *lpbv, SPK_BITMAPINFO *lpbmi, uint32 usage)");
const DeleteObject = gdi32.func("int __stdcall DeleteObject(void *hObject)");
const DeleteDC = gdi32.func("int __stdcall DeleteDC(void *hdc)");

const PW_RENDERFULLCONTENT = 0x2;
const DIB_RGB_COLORS = 0;
const WM_GETTEXT = 0x000d;
const WM_CHAR = 0x0102;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;

const out = join(tmpdir(), "dsh-orb-spike");
mkdirSync(out, { recursive: true });

function report(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${detail}`);
  return { name, ok, detail };
}

/** PrintWindow capture of any window (visible or not). Returns {width,height,png,distinctBytes}. */
function printWindowCapture(hwnd) {
  const winRect = rect();
  if (!GetWindowRect(hwnd, winRect)) throw new Error("GetWindowRect failed");
  const width = winRect.right - winRect.left;
  const height = winRect.bottom - winRect.top;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid window rect ${JSON.stringify(winRect)}`);
  }
  const hdcScreen = GetDC(null);
  try {
    const hdcMem = CreateCompatibleDC(hdcScreen);
    const hbm = CreateCompatibleBitmap(hdcScreen, width, height);
    const old = SelectObject(hdcMem, hbm);
    try {
      if (!PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT)) throw new Error("PrintWindow returned 0");
      const bgra = Buffer.alloc(width * height * 4);
      const bi = {
        bmiHeader: {
          biSize: 40, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32,
          biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0,
          biClrUsed: 0, biClrImportant: 0
        },
        bmiColors: [0]
      };
      const copied = GetDIBits(hdcMem, hbm, 0, height, bgra, bi, DIB_RGB_COLORS);
      if (copied === 0) throw new Error("GetDIBits returned 0");
      const png = encodeBgraPng(width, height, bgra, false);
      const sample = new Set();
      for (let index = 0; index < bgra.length; index += 4099) sample.add(bgra[index]);
      return { width, height, png, distinctBytes: sample.size };
    } finally {
      SelectObject(hdcMem, old);
      DeleteObject(hbm);
      DeleteDC(hdcMem);
    }
  } finally {
    ReleaseDC(null, hdcScreen);
  }
}

function getWindowText(hwnd) {
  const buf = Buffer.alloc(2048);
  const length = Number(SendMessageBuf(hwnd, WM_GETTEXT, 1024, buf));
  const count = Math.max(0, Math.min(length, 1023));
  return { length, text: buf.toString("ucs2", 0, count * 2) };
}

function findNotepadEdit(notepadHwnd) {
  for (const cls of ["Edit", "RichEditD2DPT", "RICHEDIT50W"]) {
    const edit = FindWindowExW(notepadHwnd, null, cls, null);
    if (edit) return { edit, cls };
  }
  return { edit: null, cls: "" };
}

/** Enumerate top-level windows whose class or title mentions WeChat/Weixin. */
function findWeChatWindows() {
  const found = [];
  const cb = koffi.register((hwnd) => {
    const clsBuf = Buffer.alloc(512);
    const titleBuf = Buffer.alloc(1024);
    GetClassNameW(hwnd, clsBuf, 256);
    GetWindowTextW(hwnd, titleBuf, 512);
    const cls = clsBuf.toString("ucs2").replace(/\0+$/, "");
    const title = titleBuf.toString("ucs2").replace(/\0+$/, "");
    if (/wechat|weixin/i.test(cls) || /微信|wechat/i.test(title)) {
      found.push({ hwnd, cls, title, visible: IsWindowVisible(hwnd) !== 0, iconic: IsIconic(hwnd) !== 0 });
    }
    return 1;
  }, koffi.pointer(SpikeEnumProc));
  try {
    EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return found;
}

const results = [];
const notepad = spawn("notepad.exe", { stdio: "ignore", windowsHide: true });
await new Promise((resolve) => setTimeout(resolve, 1500));
const notepadHwnd = FindWindowW("Notepad", null);
const editInfo = notepadHwnd ? findNotepadEdit(notepadHwnd) : { edit: null, cls: "" };
const consoleHwnd = GetConsoleWindow();
const prevForeground = GetForegroundWindow();
const savedCursor = point();
GetCursorPos(savedCursor);

try {
  // ---------- E0: WeChat window inventory (read-only) ----------
  const wechatWindows = findWeChatWindows();
  const wechatMain = wechatWindows.find((entry) => entry.visible && !entry.iconic && /微信|wechat|weixin/i.test(entry.title))
    ?? wechatWindows.find((entry) => entry.visible && !entry.iconic)
    ?? wechatWindows[0]
    ?? null;
  const wechatHwnd = wechatMain?.hwnd ?? null;
  report("E0 WeChat main window found", Boolean(wechatHwnd),
    wechatWindows.length === 0 ? "no WeChat-like windows" :
      wechatWindows.map((entry) => `${entry.cls}|${entry.title.slice(0, 18)}|v=${entry.visible ? 1 : 0}i=${entry.iconic ? 1 : 0}`).join(" ; "));

  // ---------- E1: PrintWindow capture of WeChat in several states ----------
  if (wechatHwnd) {
    const original = rect();
    GetWindowRect(wechatHwnd, original);
    const wasIconic = IsIconic(wechatHwnd) !== 0;
    const captureOrFail = (label) => {
      try {
        const shot = printWindowCapture(wechatHwnd);
        writeFileSync(join(out, `${label}.png`), shot.png);
        return report(`E1 ${label}`, shot.png.length > 5000 && shot.distinctBytes > 8,
          `${shot.width}x${shot.height}, ${shot.png.length} bytes, distinct=${shot.distinctBytes}`);
      } catch (error) {
        return report(`E1 ${label}`, false, String(error instanceof Error ? error.message : error));
      }
    };
    try {
      captureOrFail("a minimized as-is");
      const stateOf = () => `visible=${IsWindowVisible(wechatHwnd) !== 0} iconic=${IsIconic(wechatHwnd) !== 0}`;
      ShowWindow(wechatHwnd, 9 /* SW_RESTORE */);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      report("E1 b0 restore attempt", IsIconic(wechatHwnd) === 0, stateOf());
      ShowWindow(wechatHwnd, 4 /* SW_SHOWNOACTIVATE */);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      captureOrFail("b shown-not-activated");
      report("E1 b1 state after show", true, stateOf());
      if (consoleHwnd) SetForegroundWindow(consoleHwnd);
      await new Promise((resolve) => setTimeout(resolve, 600));
      captureOrFail("c shown but background");
      const w = original.right - original.left;
      const h = original.bottom - original.top;
      MoveWindow(wechatHwnd, -6000, 200, w, h, 1);
      await new Promise((resolve) => setTimeout(resolve, 800));
      captureOrFail("d shown off-screen");
    } finally {
      const restored = rect();
      GetWindowRect(wechatHwnd, restored);
      MoveWindow(wechatHwnd, original.left, original.top, Math.max(1, original.right - original.left), Math.max(1, original.bottom - original.top), 1);
      if (wasIconic) ShowWindow(wechatHwnd, 6 /* SW_MINIMIZE */);
      SetForegroundWindow(prevForeground);
    }
  }

  // ---------- E2: Notepad off-screen input ----------
  if (!notepadHwnd || !editInfo.edit) {
    report("E2 Notepad edit control found", false, `notepad=${Boolean(notepadHwnd)} edit=${editInfo.cls || "none"}`);
  } else {
    report("E2 Notepad edit control found", true, `class=${editInfo.cls}`);
    const original = rect();
    GetWindowRect(notepadHwnd, original);
    try {
      const w = original.right - original.left;
      const h = original.bottom - original.top;
      MoveWindow(notepadHwnd, -6000, 200, w, h, 1);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // E2a: PostMessage WM_CHAR — no focus change at all
      const sample = "PostMsg测试123";
      for (const unit of sample) PostMessageInt(editInfo.edit, WM_CHAR, unit.charCodeAt(0), 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterPost = getWindowText(editInfo.edit);
      report("E2a PostMessage WM_CHAR into off-screen edit", afterPost.text.includes(sample),
        `edit text="${afterPost.text.slice(0, 40)}"`);

      // E2b: AttachThreadInput + SetForegroundWindow + real SendInput
      const targetThread = GetWindowThreadProcessId(notepadHwnd, null);
      const currentThread = GetCurrentThreadId();
      const attached = AttachThreadInput(currentThread, targetThread, 1) !== 0;
      let foregroundReached = false;
      try {
        SetForegroundWindow(notepadHwnd);
        await new Promise((resolve) => setTimeout(resolve, 300));
        foregroundReached = GetForegroundWindow() === notepadHwnd;
        const current = rect();
        GetWindowRect(notepadHwnd, current);
        SetCursorPos(current.left + Math.round((current.right - current.left) / 2), current.top + Math.round((current.bottom - current.top) / 2));
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        await new Promise((resolve) => setTimeout(resolve, 150));
        typeUnicodeText("Attach输入OK");
        await new Promise((resolve) => setTimeout(resolve, 400));
      } finally {
        AttachThreadInput(currentThread, targetThread, 0);
      }
      const afterSend = getWindowText(editInfo.edit);
      report("E2b AttachThreadInput + SendInput into off-screen window", afterSend.text.includes("Attach输入OK"),
        `attached=${attached} foregroundReached=${foregroundReached} text="${afterSend.text.slice(0, 50)}"`);
      SetForegroundWindow(prevForeground);
      const cursor = point();
      GetCursorPos(cursor);
      report("E2c cursor restored after SendInput", cursor.x === savedCursor.x && cursor.y === savedCursor.y,
        `now=(${cursor.x},${cursor.y}) was=(${savedCursor.x},${savedCursor.y})`);

      // E3: capture the off-screen Notepad after typing — proves content is visible while off-screen
      const after = printWindowCapture(notepadHwnd);
      writeFileSync(join(out, "notepad-offscreen-typed.png"), after.png);
      report("E3 off-screen capture reflects typed content", after.png.length > 3000,
        `${after.width}x${after.height}, ${after.png.length} bytes`);
    } finally {
      MoveWindow(notepadHwnd, original.left, original.top, original.right - original.left, original.bottom - original.top, 1);
    }
  }
} finally {
  SetForegroundWindow(prevForeground);
  SetCursorPos(savedCursor.x, savedCursor.y);
  execSync("taskkill /pid " + notepad.pid + " /t /f", { stdio: "ignore" });
}

console.log("\n---- summary ----");
for (const entry of results) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}`);
console.log(`PNG evidence in ${out}`);

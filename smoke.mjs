// Standalone smoke test for the copied dsh-orb body (no dsh app needed).
// node smoke.mjs
import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(root, "package.json"));
const koffi = require("koffi");
const koffiVersion = JSON.parse(readFileSync(join(root, "node_modules/koffi/package.json"), "utf8")).version;

const user32 = koffi.load("user32.dll");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int)");
console.log("koffi", koffiVersion, "| node DPI-unaware screen:", GetSystemMetrics(0) + "x" + GetSystemMetrics(1));

const { createProductionWindowsOps } = await import(new URL("./dist/computer-use/windows-native-D-QKwZ9u.js", import.meta.url).href);
const ops = createProductionWindowsOps();

const obs = ops.listWindows();
console.log("windows:", obs.windows.length, "| foreground hwnd:", obs.foregroundHwnd);
const target = obs.windows.find((w) => w.hwnd === obs.foregroundHwnd) ?? obs.windows[0];
console.log("target:", target.appName, "|", JSON.stringify(target.title).slice(0, 70));
console.log("frame:", JSON.stringify(target.frame), "| monitor dpi:", target.monitorDpi);

const png = ops.capturePng({ x: target.frame.x, y: target.frame.y, width: target.frame.width, height: target.frame.height });
const out = join(root, "smoke-capture.png");
writeFileSync(out, png);
console.log("capture:", png.length, "bytes PNG ->", out);

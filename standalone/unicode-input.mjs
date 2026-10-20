import koffi from "koffi";

/**
 * Unicode text input through Win32 SendInput.
 *
 * The platform backend's typeText uses the clipboard (save, set, Ctrl+V, restore). A
 * clipboard restore that touches arbitrary owner formats is a native boundary: a bad
 * handle can terminate the whole process instead of raising a catchable JS error. This
 * module keeps input_text out of that boundary by posting KEYEVENTF_UNICODE events
 * directly, so no clipboard handle is opened or restored.
 */

const user32 = koffi.load("user32.dll");
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const VK_TAB = 0x09;
const VK_RETURN = 0x0d;
const INPUT_CHUNK = 64;

const MOUSEINPUT = koffi.struct("DSH_ORB_UNICODE_MOUSEINPUT", {
  dx: "int32",
  dy: "int32",
  mouseData: "uint32",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr"
});
const KEYBDINPUT = koffi.struct("DSH_ORB_UNICODE_KEYBDINPUT", {
  wVk: "uint16",
  wScan: "uint16",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr"
});
const INPUT_UNION = koffi.union("DSH_ORB_UNICODE_INPUT_UNION", {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT
});
const INPUT = koffi.struct("DSH_ORB_UNICODE_INPUT", {
  type: "uint32",
  u: INPUT_UNION
});
const SendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, DSH_ORB_UNICODE_INPUT *pInputs, int cbSize)");

if (process.arch === "x64" && INPUT.size !== 40) {
  throw new Error(`dsh-orb: INPUT size ${String(INPUT.size)} is not 40`);
}

function keyInput({ vk = 0, scan = 0, flags = 0 }) {
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: vk,
        wScan: scan,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0
      }
    }
  };
}

function unicodeInput(unit, up) {
  return keyInput({
    scan: unit,
    flags: KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0)
  });
}

function virtualKeyInput(vk, up) {
  return keyInput({ vk, flags: up ? KEYEVENTF_KEYUP : 0 });
}

/**
 * Build the SendInput batch for one string. Newlines and tabs use virtual keys because
 * KEYEVENTF_UNICODE control characters are discarded by most edit controls.
 * @param {string} text
 * @returns {object[]}
 */
export function buildUnicodeInputs(text) {
  const inputs = [];
  const value = String(text).replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) continue;
    if (unit === 0x0a) {
      inputs.push(virtualKeyInput(VK_RETURN, false), virtualKeyInput(VK_RETURN, true));
      continue;
    }
    if (unit === 0x09) {
      inputs.push(virtualKeyInput(VK_TAB, false), virtualKeyInput(VK_TAB, true));
      continue;
    }
    inputs.push(unicodeInput(unit, false), unicodeInput(unit, true));
  }
  return inputs;
}

/**
 * Split text into chunks on code-point boundaries, so a surrogate pair (emoji)
 * is never cut in half between two SendInput batches.
 * @param {string} text
 * @param {number} [size] max code points per chunk
 * @returns {string[]}
 */
export function splitTextChunks(text, size = 200) {
  const limit = Math.max(1, Math.floor(Number(size) || 0));
  const points = Array.from(String(text));
  const chunks = [];
  for (let index = 0; index < points.length; index += limit) {
    chunks.push(points.slice(index, index + limit).join(""));
  }
  return chunks;
}

/**
 * Type a string into the window that currently owns keyboard focus.
 * @param {string} text
 * @throws when SendInput is blocked (for example, the foreground window is elevated).
 */
export function typeUnicodeText(text) {
  const inputs = buildUnicodeInputs(text);
  for (let offset = 0; offset < inputs.length; offset += INPUT_CHUNK) {
    const batch = inputs.slice(offset, offset + INPUT_CHUNK);
    const sent = SendInput(batch.length, batch, INPUT.size);
    if (sent !== batch.length) {
      throw new Error(`dsh-orb: Unicode input was blocked (${String(sent)}/${String(batch.length)} events accepted); the target window may be elevated.`);
    }
  }
}

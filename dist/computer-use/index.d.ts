import z from "@deepseek-ai/schemastery";
import { ContextFormed } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { z as z$1 } from "zod";
import { ImageMediaType } from "@deepseek-ai/dsh-attachment";
import { Context } from "@deepseek-ai/cordis";
//#region src/config.d.ts
/** Loader-accepted Computer Use configuration. */
interface Config {
  /**
   * Milliseconds to wait after a GUI action before inspect and pixel capture, so open menus are listed.
   * Default: 600.
   */
  readonly postActionWaitMs?: number;
}
/** Config after defaults and load-time validation. */
interface ResolvedComputerUseConfig {
  readonly postActionWaitMs: number;
}
/** Loader schema for the Computer Use plugin. */
declare const Config: z<Config>;
/**
 * Apply defaults and reject invalid tunables at load.
 * @param config - plugin config, possibly partial.
 * @returns resolved tunables.
 */
declare function resolveComputerUseConfig(config?: Config): ResolvedComputerUseConfig;
//#endregion
//#region src/macos.d.ts
/**
 * Overlay-exclude ScreenCaptureKit JPEG capture. Desktop Host implements this over IPC.
 * @param input - region `x,y,w,h`, overlay window ids, JPEG path, and optional abort.
 */
type OverlayExcludedRegionCapture = (input: {
  readonly region: string;
  readonly excludeWindowIds: readonly number[];
  readonly output: string;
  readonly signal?: AbortSignal;
}) => Promise<void>;
//#endregion
//#region src/backend.d.ts
/** One observation surface: the overlay-skipped frontmost app's on-screen window union. */
interface ScreenInfo {
  /** Zero-based index in the backend's current surface list. Always `0` in this cut. */
  readonly index: number;
  /**
   * Logical global rectangle used for 0–1000 mapping.
   * Union of the owner window and every same-screen family window included in the shot.
   */
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Backing-store scale of the `NSScreen` that contains the window (`1` on non-retina). */
  readonly scale: number;
  /** Owner window id. CGWindowID on macOS, HWND on Windows. Omit on fake/unsupported backends. */
  readonly windowId?: number;
  /**
   * Extra window ids included in {@link bounds}.
   * CGWindowIDs on macOS, HWNDs on Windows.
   * Capture is always a screen rectangle of {@link bounds}.
   */
  readonly transientWindowIds?: readonly number[];
  /**
   * App that owns {@link windowId}, as the platform reports it.
   * Names the window when a hotkey cannot move keyboard focus to it.
   */
  readonly appName?: string;
}
/** Encoded raster returned by one window capture. */
interface CapturedScreen {
  readonly data: Uint8Array;
  readonly mediaType: ImageMediaType;
}
/**
 * OS metadata attached once per observation, after skipping overlay window ids.
 * `windowTitle` is present when the remaining window has a nonempty title.
 * `finderFolder` is present only when the remaining frontmost app is Finder.
 * `focusNote` is present when no remaining window has an owner name.
 * On Windows it is also present when the reported window is not the keyboard foreground.
 */
interface DesktopForeground {
  readonly appName: string;
  readonly windowTitle?: string;
  readonly finderFolder?: string;
  readonly focusNote?: string;
}
/** Activate a running app or launch it by display name or bundle id. */
interface OpenAppInput {
  /** Localized display name or bundle identifier. */
  readonly name: string;
}
/** Outcome of {@link DesktopBackend.openApp}. */
interface OpenAppResult {
  /** `activated` when a running process was brought forward; `launched` when the app was started. */
  readonly kind: 'activated' | 'launched';
  /** Display name or requested identifier used for the action. */
  readonly name: string;
}
/** Model-facing copy when inspect finds no remaining window after overlay skip. */
declare const FOCUS_NOTE = "Keyboard focus is not on an operable app. Click the target window first if the next step needs focus.";
/**
 * Model-facing copy when the reported Windows window is not the keyboard foreground.
 * `hotkey` brings that window forward before posting keys.
 */
declare const UNFOCUSED_WINDOW_NOTE = "Keyboard focus is on another window. hotkey brings this window forward first; click inside it if focus must land on a specific control.";
/** Observation payload for {@link FOCUS_NOTE}. */
declare const FOCUS_FALLBACK_FOREGROUND: DesktopForeground;
/** Mouse button accepted by `click`. */
type ClickButton = 'left' | 'right';
/** Pointer click on one screen. */
interface ClickInput {
  readonly screen: ScreenInfo;
  readonly position: readonly [number, number];
  readonly button: ClickButton;
  readonly count: 1 | 2;
  /** Modifier tokens held only for this click. Omit for a plain click. */
  readonly modifiers?: readonly string[];
}
/** Focus click plus keyboard typing. */
interface TypeInput {
  readonly screen: ScreenInfo;
  readonly position: readonly [number, number];
  readonly text: string;
  readonly replace: boolean;
  readonly submit: boolean;
}
/** Wheel scroll at a point. */
interface ScrollInput {
  readonly screen: ScreenInfo;
  readonly position: readonly [number, number];
  readonly direction: 'up' | 'down';
  readonly scrollLevel: number;
}
/**
 * Posted key combination.
 * The window fields carry the session's own last observation: Windows hands focus to that
 * window before posting and refuses an elevated one; macOS ignores them.
 */
interface HotkeyInput {
  readonly keys: readonly string[];
  /** Owner window of that observation. Omit when the session has not observed anything yet. */
  readonly windowId?: number;
  /** Extra window ids the observation included (menus and other family windows). */
  readonly transientWindowIds?: readonly number[];
  /** App owning `windowId`, for the focus error message. */
  readonly appName?: string;
}
/** Left-button press-and-hold on one screen. */
interface LongPressInput {
  readonly screen: ScreenInfo;
  readonly position: readonly [number, number];
  readonly durationSeconds: number;
}
/** Pointer drag between two 0–1000 positions, possibly on different screens. */
interface DragInput {
  readonly startScreen: ScreenInfo;
  readonly startPosition: readonly [number, number];
  readonly endScreen: ScreenInfo;
  readonly endPosition: readonly [number, number];
}
/** Open the default browser, or a validated http(s) URL in it. */
interface OpenInBrowserInput {
  /** Normalized http(s) URL. Omit to launch the default browser with no page. */
  readonly url?: string;
}
/** Open a resolved file or folder with Finder / the default app. */
interface OpenInFinderInput {
  /** Absolute POSIX path after expand and realpath. */
  readonly path: string;
  /** When true and `path` is a file, reveal it in Finder instead of opening it. */
  readonly revealOnly: boolean;
}
/** Copy an already-written image file onto the system pasteboard. */
interface CopyImageToClipboardInput {
  /** Absolute path of the PNG/JPEG/GIF/WebP file to place on the pasteboard. */
  readonly path: string;
  /** Encoded type of the file at `path`. */
  readonly mediaType: ImageMediaType;
}
/**
 * Capture plus HID input for one desktop. Production macOS implements this;
 * tests inject a fake; other platforms throw from each method.
 */
interface DesktopBackend {
  /**
   * List the current observation surface (0 or 1 frontmost app after overlay skip;
   * bounds are that app's on-screen window union).
   * @param signal - cooperative cancellation.
   * @returns screens in backend index order; empty when no operable window remains.
   */
  listScreens(signal?: AbortSignal): Promise<readonly ScreenInfo[]>;
  /**
   * Capture the observation rectangle as a display crop.
   * @param screen - surface selected from {@link listScreens}.
   * @param signal - cooperative cancellation.
   * @returns encoded image bytes and media type.
   */
  capture(screen: ScreenInfo, signal?: AbortSignal): Promise<CapturedScreen>;
  /**
   * Report the frontmost app after skipping overlay window ids, plus Finder's
   * folder when that app is Finder. Query failures return {@link FOCUS_FALLBACK_FOREGROUND}.
   * @param signal - cooperative cancellation.
   * @returns structured foreground metadata for the observation envelope.
   */
  inspectForeground(signal?: AbortSignal): Promise<DesktopForeground>;
  /**
   * List localized names of running regular (Dock-visible) applications.
   * @param signal - cooperative cancellation.
   * @returns unique display names in the order the workspace reports them.
   */
  listApps(signal?: AbortSignal): Promise<readonly string[]>;
  /**
   * Activate a running app or launch it by display name or bundle id.
   * @param input - name or bundle identifier.
   * @param signal - cooperative cancellation.
   * @returns whether the app was activated or launched.
   */
  openApp(input: OpenAppInput, signal?: AbortSignal): Promise<OpenAppResult>;
  /**
   * Click at a 0–1000 position on `input.screen`.
   * @param input - screen, position, button, click count, and optional modifiers held only for this click.
   * @param signal - cooperative cancellation.
   */
  click(input: ClickInput, signal?: AbortSignal): Promise<void>;
  /**
   * Click to focus, optionally select-all, type `text`, and optionally press Enter.
   * @param input - screen, position, text, and modifiers.
   * @param signal - cooperative cancellation.
   */
  typeText(input: TypeInput, signal?: AbortSignal): Promise<void>;
  /**
   * Scroll at a 0–1000 position on `input.screen`.
   * @param input - screen, position, direction, and level.
   * @param signal - cooperative cancellation.
   */
  scroll(input: ScrollInput, signal?: AbortSignal): Promise<void>;
  /**
   * Post a key combination. Callers must already reject screenshot chords.
   * @param input - key tokens.
   * @param signal - cooperative cancellation.
   */
  hotkey(input: HotkeyInput, signal?: AbortSignal): Promise<void>;
  /**
   * Press and hold the left button at a 0–1000 position on `input.screen`.
   * @param input - screen, position, and hold duration in seconds.
   * @param signal - cooperative cancellation.
   */
  longPress(input: LongPressInput, signal?: AbortSignal): Promise<void>;
  /**
   * Drag from `startPosition` to `endPosition`, mapping each through its screen.
   * @param input - start and end screens and 0–1000 positions.
   * @param signal - cooperative cancellation.
   */
  drag(input: DragInput, signal?: AbortSignal): Promise<void>;
  /**
   * Launch the default browser, or open `input.url` in it.
   * @param input - optional normalized http(s) URL.
   * @param signal - cooperative cancellation.
   */
  openInBrowser(input: OpenInBrowserInput, signal?: AbortSignal): Promise<void>;
  /**
   * Open a folder in Finder, open a file with its default app, or reveal a file.
   * @param input - resolved path and reveal flag.
   * @param signal - cooperative cancellation.
   */
  openInFinder(input: OpenInFinderInput, signal?: AbortSignal): Promise<void>;
  /**
   * Replace the system pasteboard with the image at `input.path`.
   * Does not restore the previous clipboard.
   * @param input - written screenshot path and media type.
   * @param signal - cooperative cancellation.
   */
  copyImageToClipboard(input: CopyImageToClipboardInput, signal?: AbortSignal): Promise<void>;
  /**
   * Hold overlay HID click-through for one GUI action plus its post-action screenshot.
   * Platform and fake backends run `run` immediately; Desktop `wrapDesktopBackend` uses `withInput`.
   * @param run - HID plus recapture.
   * @param signal - cooperative cancellation for the overlay cloak handshake.
   * @returns the value `run` resolves to.
   */
  withGuiTurn<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
/**
 * Construct the backend for a host platform.
 * @param platform - Node `process.platform` value; tests pass an explicit id.
 * @param excludedRegionCapture - Desktop overlay-exclude capture; CLI omits it and spawns the helper.
 * @returns macOS capture/input on Darwin, Windows capture/input on Win32, otherwise a backend whose methods throw.
 */
declare function createPlatformBackend(platform?: NodeJS.Platform, excludedRegionCapture?: OverlayExcludedRegionCapture): DesktopBackend;
//#endregion
//#region src/fake.d.ts
/** 1×1 red PNG used as the fixture desktop image. */
declare const FAKE_DESKTOP_PNG: Buffer<ArrayBuffer>;
/** Recorded fake-desktop action for assertions. */
type FakeDesktopAction = {
  readonly type: 'click';
  readonly input: ClickInput;
} | {
  readonly type: 'typeText';
  readonly input: TypeInput;
} | {
  readonly type: 'scroll';
  readonly input: ScrollInput;
} | {
  readonly type: 'hotkey';
  readonly input: HotkeyInput;
} | {
  readonly type: 'longPress';
  readonly input: LongPressInput;
} | {
  readonly type: 'drag';
  readonly input: DragInput;
} | {
  readonly type: 'openApp';
  readonly input: OpenAppInput;
} | {
  readonly type: 'openInBrowser';
  readonly input: OpenInBrowserInput;
} | {
  readonly type: 'openInFinder';
  readonly input: OpenInFinderInput;
} | {
  readonly type: 'copyImageToClipboard';
  readonly input: CopyImageToClipboardInput;
};
/** Fake backend that records HID calls and returns a fixture PNG. */
interface FakeDesktopBackend extends DesktopBackend {
  /** Actions in call order. */
  readonly actions: readonly FakeDesktopAction[];
}
/** Options for {@link createFakeDesktopBackend}. */
interface FakeDesktopOptions {
  /** Encoded PNG returned by every capture. Default: {@link FAKE_DESKTOP_PNG}. */
  readonly png?: Uint8Array;
  /** Observation surface list. Default: one 1000×800 logical window. */
  readonly screens?: readonly ScreenInfo[];
  /** Foreground metadata. Default: Pages with no Finder folder. */
  readonly foreground?: DesktopForeground;
  /** Running regular app names. Default: Pages and Safari. */
  readonly apps?: readonly string[];
  /** Thrown from {@link DesktopBackend.openApp} when set. */
  readonly openAppError?: Error;
  /** Result of a successful {@link DesktopBackend.openApp}. Default: activated as the requested name. */
  readonly openAppResult?: OpenAppResult;
}
/**
 * Construct a fake desktop that records actions and returns a fixture PNG.
 * @param options - optional screens, PNG bytes, and foreground metadata.
 * @returns a test/snapshot backend.
 */
declare function createFakeDesktopBackend(options?: FakeDesktopOptions): FakeDesktopBackend;
//#endregion
//#region src/plugin.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': {
      kind: 'computer-use';
    } & ContextFormed;
  }
}
/** Cordis plugin name used as the first-frame notice producer id. */
declare const PLUGIN_NAME = "tool-computer-use";
/** Prompt section sort order: after PTY guidance, before web search. */
declare const POLICY_SECTION_ORDER = 1750;
/**
 * Register the exclusive GUI tools, the policy section, and first-frame screenshot attachment.
 * @param ctx - registration scope; requires `tools`, `systemPrompt`, and `attachments`.
 * @param backend - desktop capture and input.
 * @param config - resolved tunables.
 */
declare function applyComputerUse(ctx: Context, backend: DesktopBackend, config: ResolvedComputerUseConfig): void;
//#endregion
//#region src/coordinate-mode.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': {
      kind: 'computer-use';
    } & ContextFormed;
  }
}
/** Click encoding recorded on a Computer Use session. */
type CoordinateMode = 'millifraction' | 'pixel';
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Click encoding for this Computer Use session: millifraction 0–1000 or
     * attached-raster pixels. Whole-value replace; the last event wins. A log
     * with none folds to millifraction. Written `ignorable: true` whenever the
     * host catalog does not know the type (official harnesses refuse a log
     * carrying an unknown required event outright); the coordinate contract is
     * also echoed in every GUI tool result's text, so a reader that skips this
     * event can still recover the space from the log.
     */
    'computer-use/coordinate-mode': {
      mode: CoordinateMode;
    };
    /** V3→V4 migration alias of the same record (unknown ignorable events are namespaced `plugin:`). */
    'plugin:computer-use/coordinate-mode': {
      mode: CoordinateMode;
    };
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded Computer Use click encoding. */
    computerUseCoordinateMode: {
      mode: CoordinateMode;
    };
  }
}
//#endregion
//#region src/policy.d.ts
/**
 * Computer Use policy for one session encoding.
 * @param mode - millifraction 0–1000 or attached-raster pixels.
 * @returns the assembled policy section text.
 */
declare function policyFor(mode: CoordinateMode): string;
/**
 * Policy section text for a ball conversation the panel does not currently show.
 *
 * The desktop belongs to the conversation the user is looking at: a completion notice may wake any
 * conversation, and only that one may move the mouse. The model still gets the full delegation and
 * coordination rules — it can answer, search, ask, and hand work to a background Code session — so
 * this replaces the capability sentences instead of dropping the policy. See `screen-owner.ts` for
 * the matching execution-time guard.
 * @returns the assembled background policy section text.
 */
declare function backgroundPolicyFor(): string;
/**
 * Stable millifraction Computer Use policy text. Assemblies without an agent
 * and Headless/Web sessions without a coordinate-mode event use this text.
 */
declare const POLICY: string;
//#endregion
//#region src/screen-owner.d.ts
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
/**
 * Agent preset of a floating ball conversation. The overlay in `cordis.patch.yml` registers it and
 * the orb host creates every ball session with it, so it is what separates a ball conversation from
 * the main window's chats and from the standard-preset Code sessions the ball delegates to.
 */
declare const BALL_PRESET = "computer-use";
interface ScreenOwnerState {
  /** Session id of the conversation the ball currently shows, or empty when unrestricted. */
  ownerId: string;
}
/**
 * Tool-visible failure text. The model reads this as an isError result, so it carries the rule and
 * the way out instead of a bare denial.
 */
declare const NOT_SCREEN_OWNER_MESSAGE: string;
/** The shared record; exported so tests can observe and reset it. */
declare function screenOwnerState(): ScreenOwnerState;
/** Publish the session the ball panel shows; an empty string leaves every session unrestricted. */
declare function setScreenOwner(sessionId: string | undefined): void;
/** The session that currently owns the desktop, or `undefined` when nothing is restricted. */
declare function screenOwnerId(): string | undefined;
/** Whether this tool name reaches the shared desktop or the shell. */
declare function isDesktopTool(name: string): boolean;
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
declare function desktopToolDenial(agentId: string | undefined, toolName: string, preset: string | undefined): string | undefined;
/**
 * Agent preset of a live agent, or undefined when it cannot be read.
 *
 * Undefined reads as "not a ball conversation" everywhere it is consumed, so an unreadable header
 * widens access instead of closing it. Locking the wrong session out of the shell is far worse than
 * leaving one ball conversation ungated.
 * @param agent - calling agent from the execution, if the call carried one.
 * @returns the preset name, or undefined.
 */
declare function presetOf(agent: unknown): string | undefined;
//#endregion
//#region src/overlay-guard.d.ts
/**
 * Overlay window ids to omit from one capture.
 * macOS values are CGWindowIDs. Windows values are HWNDs. Desktop Host fills this from Electron's overlay-guard ack; CLI leaves it empty.
 */
interface OverlayCaptureSession {
  readonly excludeWindowIds: readonly number[];
}
/** Logical global rectangle for the Computer Use observation-frame overlay. */
interface ObservationFrameBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Overlay-exclude ScreenCaptureKit JPEG request. Desktop Host fills this over IPC. */
interface OverlayExcludedRegionCaptureInput {
  readonly region: string;
  readonly excludeWindowIds: readonly number[];
  readonly output: string;
}
/**
 * Cloak host chrome for the duration of one capture or HID call.
 * Desktop Host provides this; Web and CLI compositions omit it.
 */
interface ComputerUseOverlayGuard {
  /**
   * Exclude host overlay chrome from screen capture while `run` executes, then restore it.
   * A nested `withCapture` inside `withInput` sends no capture IPC — the enclosing input
   * interval already cloaks every chrome window — but `run` still receives the exclude ids.
   * @param run - capture implementation; receives overlay window ids from the begin ack.
   * @param signal - cooperative cancellation for the cloak handshake.
   * @returns the value `run` resolves to.
   */
  withCapture<T>(run: (session: OverlayCaptureSession) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Make host overlay chrome click-through while `run` executes, wait for posted HID events to be hit-tested, then restore hit testing.
   * @param run - HID implementation.
   * @param signal - cooperative cancellation for the cloak handshake.
   * @returns the value `run` resolves to.
   */
  withInput<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Show or hide the Desktop observation-frame ribbon around the current capture rectangle.
   * Pass-through hosts resolve immediately. Acks before returning so the next capture omits the frame.
   * Abort of a SHOW hides the ribbon and waits for that hide ack without the aborted signal; abort of a hide rejects the wait.
   * @param bounds - observation union in global logical points, or `null` to hide.
   * @param signal - cooperative cancellation for the SHOW ack wait. Hide acks ignore it.
   */
  setObservationFrame(bounds: ObservationFrameBounds | null, signal?: AbortSignal): Promise<void>;
  /**
   * Capture `input.region` as JPEG at `input.output`, omitting overlay CGWindowIDs in the Electron process.
   * Pass-through hosts omit this method; CLI then spawns `macos-sck-capture`.
   * @param input - region `x,y,w,h`, overlay window ids, and JPEG destination path.
   * @param signal - cooperative cancellation for the ack wait.
   */
  captureExcludedRegion?(input: OverlayExcludedRegionCaptureInput, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Overlay cloak; Desktop Host provides it, other compositions leave it undefined. */
    computerUseOverlayGuard?: ComputerUseOverlayGuard;
  }
}
/**
 * Wrap a desktop backend so capture, foreground inspect, listScreens, HID, openApp, and withGuiTurn run inside overlay-guard intervals.
 * After `listScreens`, the wrapper waits for `setObservationFrame` so the next capture exclude list includes the ribbon.
 * When the listing signal is already aborted, the wrapper hides (`null`) without that signal instead of showing bounds.
 * `openApp` and `withGuiTurn` use `withInput` so the overlay yields key status before activate and stays click-through through recapture.
 * Desktop Host refcounts nested cloak calls so one turn sends one input begin/end.
 * `listApps`, `openInBrowser`, `openInFinder`, and `copyImageToClipboard` are unwrapped because
 * they do not capture pixels, inspect windows, post HID, or steal key status.
 * @param inner - platform or fake backend.
 * @param guard - host overlay cloak.
 * @returns a backend that cloaks around capture, inspect, listScreens, HID, openApp, and withGuiTurn.
 */
declare function wrapDesktopBackend(inner: DesktopBackend, guard: ComputerUseOverlayGuard): DesktopBackend;
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "tool-computer-use";
/** Services required at apply time. Missing attachments keep the plugin pending. */
declare const inject: string[];
/**
 * Mount Computer Use with the host-platform backend.
 * When Desktop Host provides `computerUseOverlayGuard`, capture, inspect, listScreens, HID, and withGuiTurn run
 * inside overlay-guard intervals, `listScreens` waits for the observation-frame ribbon ack, and overlay-exclude
 * capture runs ScreenCaptureKit in the Electron process.
 * The guard is read on each desktop call, including when Host installs it after this plugin applies.
 * @param ctx - registration scope; `inject` must already be satisfied.
 * @param config - optional tunables; omitted fields use schema defaults.
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { BALL_PRESET, type CapturedScreen, type ClickButton, type ClickInput, type ComputerUseOverlayGuard, Config, type CopyImageToClipboardInput, type DesktopBackend, type DesktopForeground, type DragInput, FAKE_DESKTOP_PNG, FOCUS_FALLBACK_FOREGROUND, FOCUS_NOTE, type FakeDesktopAction, type FakeDesktopBackend, type FakeDesktopOptions, type HotkeyInput, type LongPressInput, NOT_SCREEN_OWNER_MESSAGE, type OpenAppInput, type OpenAppResult, type OpenInBrowserInput, type OpenInFinderInput, PLUGIN_NAME, POLICY, POLICY_SECTION_ORDER, type ResolvedComputerUseConfig, type ScreenInfo, type ScrollInput, type TypeInput, UNFOCUSED_WINDOW_NOTE, apply, applyComputerUse, backgroundPolicyFor, createFakeDesktopBackend, createPlatformBackend, desktopToolDenial, inject, isDesktopTool, name, policyFor, presetOf, resolveComputerUseConfig, screenOwnerId, screenOwnerState, setScreenOwner, wrapDesktopBackend };
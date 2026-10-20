<p align="center"><img src="assets/orb.png" width="120" alt="The dsh-orb floating ball"></p>

# dsh-orb

English

An unofficial personal plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). One installable bundle that adds a floating-ball agent with Computer Use to the official dsh desktop app and `dsh web` — the official repository stays untouched, and the main window remains the official dsh Web UI.

> **Disclaimer** — This is an unofficial project maintained by an individual developer. It is **not** affiliated with, endorsed by, or connected to DeepSeek AI in any way. DeepSeek, the DeepSeek logo, and the DeepSeek avatar artwork are the property of DeepSeek AI; they appear here only as the default ball avatar shipped by the upstream project.

A floating ball rests at the right edge of your screen. Tell it what you need: quick, visible actions are executed directly in the current app through Computer Use; long-running complex tasks are dispatched to a background coding session, and the result comes back to the ball when it finishes. The main window keeps the full dsh Web UI — session management, the plugin market, and model settings — so you can still write code, edit files, and run commands in it.

There is no telemetry.

## The floating ball

On startup the plugin spawns its own helper (a pinned, verified Electron runtime in an isolated profile) and the ball appears at the right edge of the primary display, always on top.

- **Hover** expands the panel, **click** pins it, and it collapses when the pointer leaves. **Drag** moves the ball; dragging it beyond the left or right screen edge docks it into a thin sliver — hover again to slide it back.
- **Right-click** opens the menu: open the main window, open the floating-ball settings page inside that window, floating-ball agent settings and background agent settings (each track picks its own model and thinking level), the coordinate-encoding toggle, and "Disable floating ball". The ball follows the official dsh process — when the official app exits, the ball exits with it.
- The panel carries the ball's conversation history with **History** and **New**, an **Access** chip (view-only / workspace edits / full access; full by default, applying to the ball's commands and the background sessions it dispatches), and a composer that wraps around the ball. When the agent asks you a question, the question card is answered right on the ball; if the helper disconnects, an unanswered question is handed back to the main window.
- The transcript is rendered natively in the ball: streaming thinking / text / tool calls interleaved in arrival order, collapsible tool cards with parameters and results (terminal, diff, read, search, web), Shiki dual-theme highlighting, KaTeX math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, the version the main window bundles, following the light/dark theme), copy buttons for user and assistant messages, and a per-turn token-usage pill.
- Appearance follows the main window: dark / light theme and interface language (Chinese / English) mirror the official appearance and language settings, including live switching.
- The ball avatar can be set to one of six built-in animated GIFs, or replaced with a custom GIF / PNG / WebP (4 MB cap), in main-window **Settings → Floating Ball**. The built-ins stay animated: the ball plays them whenever it is active, exactly like the shipped default. **More animations** at the end of that row opens the [dshgif.hicp.fun](https://dshgif.hicp.fun/) gallery — download a GIF there and load it with **Choose image**; a file over the cap now reports its own size.

## Dual-track agent architecture

The Computer Use agent inside the floating ball decides how every message is handled; there is no separate task classifier at runtime:

```mermaid
flowchart TD
    user["You speak to the floating ball"] --> orb["Computer Use Agent"]
    orb -->|"Visible GUI actions"| gui["13 GUI tools<br>executed in the current window"]
    orb -->|"Quick lookups: weather, news"| web["web_search / web_fetch<br>answered on the ball"]
    orb -->|"Dig through files, produce documents or websites"| bg["code_agent background session<br>queued, returns immediately"]
    bg -->|"Completion notice"| orb
```

- **Foreground track · Computer Use**: visible operations — opening apps, clicking buttons, filling forms, changing settings — are executed with GUI tools right in front of you, each step based on a live screenshot of the frontmost window. Quick lookups such as weather or news headlines stay on the ball too, answered directly with `web_search` / `web_fetch`.
- **Background track · Code Agent**: complex tasks — digging through files, producing documents, building a website — are dispatched through `code_agent` to a background standard session. Dispatch returns immediately; the ball tells you the background is running and you can keep chatting. When the background session ends and the ball is idle, the completion summary returns to the ball automatically, and the Computer Use agent decides the next move — keep clicking, dispatch more background work, or wrap up.

A background session is the same kind of session you create manually in the main window; it appears in the `dsh_orb` folder in the main-window sidebar, where you can open, continue, or stop it. Follow-up changes to the same deliverable go back to the same background session; unrelated new work opens another one. The conversation history, permissions, and per-track model settings are shared with the official dsh process — the ball reads and writes the same sessions as the main window.

## Computer Use

Every conversation on the ball runs Computer Use: the first message automatically attaches a screenshot of the frontmost app's visible windows, and another screenshot follows every action, including your mouse cursor, so the model always sees the latest screen state.

- While the agent operates, screenshots automatically omit the ball, the expanded panel, and the observation border, and clicks pass through the ball instead of landing on it; the observed window gets a glowing observation border marking what the agent is looking at. Outside of agent operations the ball is a normal window you can screenshot and record.
- Tool list: `click` (single/double/right click, hold modifiers), `input_text`, `scroll`, `hotkey`, `long_press`, `drag`, `wait`, `long_wait`, `screenshot` (saved to the Desktop and copied to the clipboard), `open_in_browser`, `open_in_finder`, `list_apps`, `open_app`.
- **macOS**: the first time you operate the screen, the system permission dialogs are attributed to **DeepSeek Harness** (desktop) or your terminal (`dsh web`) — authorize that process. The ball's onboarding layer walks you through Screen Recording and Accessibility.
- **Windows**: no system-permission onboarding is needed; windows running as administrator refuse to be clicked or typed into.
- Installing this plugin is the consent gate: the GUI tools never ask per click.

## Standalone runtime (this copy)

This copy additionally ships `standalone/`, an independent runtime that does **not** start `dsh`: it reuses the source Electron floating ball from `dist/helper/`, imports the Windows capture/input backend from `dist/computer-use/` directly, uses the bundled `node_modules/koffi` for Win32 calls, drives `agnes-3.0-flash` over Chat Completions, and exposes a local web console plus a one-shot CLI. Run it from the `dsh-orb-src` root; do not copy `standalone/` on its own.

```powershell
node .\standalone\server.mjs          # http://127.0.0.1:3737
node .\standalone\cli.mjs --observe   # capture once, no model call
node .\standalone\self-test.mjs       # offline end-to-end self-test
npm run standalone:live-test          # real Agnes call; uploads the current screenshot
```

### One-click launcher (Windows)

Double-click `start-orb.cmd` in this folder, or the `dsh-orb` shortcut on the Desktop. It starts the server and launches the source Electron floating ball; the console stays open and `Ctrl+C` stops it. Right-click the ball and choose **打开悬浮球设置** to reach the API-key page. On first run, while no API key is configured, the launcher also opens `http://127.0.0.1:3737` automatically. Set `DSH_ORB_NO_BROWSER=1` to suppress even that, `DSH_ORB_NO_HELPER=1` to skip the ball, and `DSH_ORB_STANDALONE_PORT` to change the port. The shortcut uses `assets/orb.ico`.

Interface preview: [floating ball](docs/floating-ball.png) · [right-click menu](docs/floating-menu.png) · [API-key page](docs/config-page.png).

See [standalone/README.md](standalone/README.md) for configuration, API endpoints, image-input modes, and limitations. For the complete developer/handoff guide — architecture, data flow, the floating-ball bridge, testing, and extension recipes — read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## How it works

```
DeepSeek Harness (official, unmodified)
└─ Electron shell (main window, dsh://open, single instance)
     └─ Host, spawned as a plain Node process (ELECTRON_RUN_AS_NODE=1)
          └─ dsh-orb plugin
               ├─ host — sessions, permissions, models, web routes, helper lifecycle
               ├─ computer-use — 13 GUI tools + code_agent (Computer Use preset)
               └─ client-settings — the "Floating Ball" section in main-window settings

Helper (its own downloaded Electron, isolated userData)
├─ ball window, observation border
└─ data requests → authenticated loopback URL of the official Host
```

- One package to install: the `dsh-orb` bundle assembles the host, the Computer Use plugin, the helper, and the settings page into itself at build time.
- The helper runtime is a stock Electron release pinned by SHA-256 (darwin/win32, arm64/x64), downloaded on first use and verified against the pinned hashes; it runs in its own `userData`, separate from the official app.
- The helper talks to the host over a loopback-only NDJSON socket authenticated with a random 32-byte token generated per launch, passed by environment variable — never argv, never written to disk. Authenticated URLs with official credentials never reach the helper.
- Watchdog: the helper exits when it loses the socket; the host restarts it at most three times. Computer Use in the main window keeps working even if the ball cannot start.

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the desktop app, or `dsh web` from the CLI. Built against dsh `0.1.7-rc.2`; the declared compatibility range is `>=0.1.7-rc.2 <0.3.0-0`.
- macOS (Apple Silicon / Intel) or Windows x64. Linux loads the plugin but does not create a ball — background code sessions still work.
- Node.js `^22.19.0 || >=24.0.0`. pnpm `11.7.0` is only needed to rebuild the upstream package; this distribution snapshot cannot be rebuilt in place.

## Install

### From a release

Releases are published to the npm registry and served from npmmirror. The install unit is the release tarball — **not the repository itself**: pasting the repo URL into a plugin page installs the monorepo root package, which fails with "this package declares no bundle".

- **By name** — add `dsh-orb` in the desktop app's plugin page, or:

  ```sh
  dsh plugin add dsh-orb
  ```

- **By version** — `dsh-orb@<version>`. An explicit version skips the release-age gate, and pnpm records `integrity` from registry metadata. Do not paste a remote tarball URL such as `https://registry.npmmirror.com/dsh-orb/-/dsh-orb-<version>.tgz`: pnpm 11.7, which the official client bundles, rejects that URL because the lockfile entry has no `integrity`.

**A just-published version can resolve to the previous one for up to 24 hours.** The official client bundles pnpm 11, whose `minimumReleaseAge` default (1440 minutes) makes a named install settle for the newest version published more than 24 hours ago — a supply-chain guard, not a network problem. To get a fresh release immediately, install `dsh-orb@<version>`, or exempt the package in the profile's `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - dsh-orb
```

With an older version installed there is no need to reinstall: the floating-ball card in the main window's settings page checks for and installs updates, and records the exemption itself.

**Does the in-app update fail with `operation-error`?** Releases through 0.1.4 handed pnpm 11.7 (the client bundles that version) an npmmirror tarball URL. That URL is stored without an `integrity` field, so pnpm rejects it before downloading (`ERR_PNPM_MISSING_TARBALL_INTEGRITY`) and the card only shows the generic `operation-error`. Install `dsh-orb@<version>` from the plugin page — not the tarball URL. After that, the update button installs by version and asks npmmirror first. The raw failure detail lives in the profile's `.plugin-manager/logs/operation-*/pnpm.log`.

### This copy (distribution snapshot)

This directory is the assembled distribution, **not** the upstream monorepo. It has no `packages/` sources and cannot be rebuilt with `pnpm install` / `pnpm build`. Use it in one of two ways:

- As an installed dsh plugin: install the published `dsh-orb` package as described above.
- As a standalone Windows app without dsh: double-click `start-orb.cmd` (see [Standalone runtime](#standalone-runtime-this-copy)).

If you need to change the plugin or the compiled `dist/` code, work in the upstream source repository and rebuild there; do not edit `dist/` in this copy and expect the change to survive an update.

## Development (this snapshot)

There is no TypeScript workspace here. The commands that apply to this copy are:

```powershell
npm run standalone:test      # offline end-to-end test; no key, no mouse movement
node .\smoke.mjs             # Win32 capture/input smoke test
npm run standalone:live-test # real Agnes call; uploads the current screenshot
```

For the architecture, message flow, HTTP API, floating-ball bridge, configuration precedence, test checklists, debugging, and step-by-step extension recipes, read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The user-facing standalone notes are in [standalone/README.md](standalone/README.md). Agents should start with [AGENTS.md](AGENTS.md).

## Status and known limitations

- The **selection toolbar** (search / translate / send-to-agent on text selection) is temporarily disabled while a defect is fixed; its code ships but every entry point is removed and the feature is forced off in preferences.
- Built and tested against dsh `0.1.7-rc.2`; newer dsh versions within the compatibility range may require re-verification. dsh `0.2.1-rc.1` no longer registers the `cwd` prompt variable, so the Computer Use persona must not reference it — the working directory arrives as runtime context instead.
- No floating ball on Linux; headless environments can still run background code sessions.
- The macOS permission dialogs name DeepSeek Harness or your terminal, not this plugin — that is how the OS attributes permissions to the process that hosts the agent.

## Relationship to DeepSeek Harness

This repository is an unofficial derivative work built on top of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), dsh's open-source everything-is-a-plugin agent harness; sessions, plugins, tools, and the Web UI are all driven by it. This project modifies no upstream code — it installs like any third-party dsh plugin. To go deeper:

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — how this copy works, how to run and modify it, and the handoff checklist
- [standalone/README.md](standalone/README.md) — standalone configuration, HTTP API, and image-input modes
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the upstream plugin host

## License

[MIT](LICENSE). Upstream-derived code and assets retain their original licenses; refer to the upstream repository for its third-party notices. This distribution snapshot does not include a separate `THIRD-PARTY-NOTICES.md`.

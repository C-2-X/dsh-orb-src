# 常驻监控任务（Persistent Watch Task）设计稿

状态：**待评审**（2026-10-19，回答用户 4 个决策问题后定稿）
范围：`standalone/` 运行形态；概念与 dsh 插件形态对齐，便于将来到上游移植
本文是设计稿，不是实现说明。实现后请把结论合并回 `docs/DEVELOPMENT.md`，不要另留一份过期说明。

## 1. 需求与决策记录

| 决策点 | 结论 |
| - | - |
| 监控范围 | 微信**全部**会话的新消息 |
| 回复方式 | **全自动发送**，无人工确认 |
| 检测间隔 | **秒级**（≈自动回复），默认 5s，可配 |
| 常驻期间用户是否用电脑 | **是**——agent 不得抢占物理键鼠 |
| 并发 | 常驻任务运行期间，一次性任务与第二个常驻任务一律拒绝（409） |
| 停止 | 悬浮球常驻屏幕，随时可强制停止（现状即满足：球是 always-on-top 窗口，stop 已接通 AbortController） |

## 2. 资料结论（检索于 2026-10-19）

1. **两道出口**：computer-use agent 默认会永远循环，必须同时有“模型自判完成”和“护栏熔断”（educative.io）。
2. **每个动作后回截图**：模型没有别的验证途径，跳过截图是“幻觉成功”首因（teachmeidea / Claude 官方实践）。
3. **三道安全网**：破坏性原语（发消息、提交表单）需要 步数上限（训练轮）+ 时长上限（宵禁）+ 危险动作确认（许可单）。本需求放弃“许可单”（全自动），因此前两道必须更硬，并补频率上限。
4. **wait_for_change / 双核触发**：把变化检测放在廉价层（截图哈希、OCR），画面不变不调模型，避免为近乎相同的帧烧上下文（timetobuildbob；字节青训营 WeChat-Vision-Bot）。
5. **微信自动化三条路线**：协议注入 / Hook（高封号，已被市场证伪）vs 桌面视觉 + 模拟真人操作（不碰进程，业界公认零封号路线：sightflow-agent、WeChat-Vision-Bot、WeChat-AI-AutoReply）。节奏要拟人。
6. **截图 token 成本随循环线性增长**；秒级 + 活跃对话意味着成本主要在“看屏幕”而非动作（grokipedia / niteagent）。
7. **零鼠标移动的既有做法**：目标窗口离屏/挂隐藏桌面 + `PrintWindow` 捕获 + `AttachThreadInput` + `SetForegroundWindow` + `SendInput`（用完恢复光标）（WeChat-AI-AutoReply）。

## 3. 概念模型

```
goal（自然语言目标）+ cadence（检测间隔）+ guardrails（护栏）

每周期：
  ① 廉价观测：截图 → sha256 + 前台应用/窗口标题
  ② 与上一周期比对：无变化 → 不调模型，等待下一周期（零 token 消耗）
  ③ 有变化 → 调模型（目标 + 变化描述 + 最新截图）：
       执行一个 GUI 工具 / 回复"待命" / 调 task_done(summary) 收尾
出口（四道）：task_done ｜ 用户停止 ｜ maxDurationMs ｜ maxActions
```

状态机：`idle → running(checking ⇄ waiting) → done | stopped | guarded`
事件流**完全复用**现有 `TaskRunner` 事件（`task-start / turn-start / tool-start / tool-end / observation / done / stopped / error`），悬浮球与控制台零改动。

## 4. 核心矛盾：键鼠占用 → 双观测/执行面

用户要在常驻期间继续用电脑，而现有工具链（`SendInput` + 物理光标）会抢焦点。设两种“面”：

| 面 | 观测 | 执行 | 状态 |
| - | - | - | - |
| `foreground`（前台） | 现有 `observeDesktop`（前台窗口） | 现有 backend（真实键鼠） | **v1 可实现**；动作瞬间抢焦点，用户会被打断 |
| `offscreen`（离屏） | `PrintWindow(hwnd)` 渲染任意窗口（含离屏/不可见） | `AttachThreadInput` 附加输入 + `SetForegroundWindow` + `SendInput`，用完恢复光标位 | **需 spike**；对微信兼容性未知 |

决策：配置 `persistent.surface: "foreground" | "offscreen"`。
- v1 只做 `foreground`——适合“我离开电脑，帮我盯微信”的场景，今天就能建、能测。
- `offscreen` 先做**可行性 spike**（见 §10），通过后再实现为 v2；新原生能力写在 standalone 侧 koffi 模块（先例：`unicode-input.mjs`），**不碰 `dist/` 编译产物**。
- 微信窗口查找：复用 `windows-native` 的窗口枚举（`smoke.mjs` 已验证可拿 hwnd/标题）；镜像进程多开时取主窗口，取不到明确报错，不猜。

## 5. 架构（复用清单）

| 层 | 改动 |
| - | - |
| `standalone/agent.mjs` | 导出 `executeToolCall`（当前私有）——工具逻辑仍只有一份；`observeDesktop` 已导出 |
| `standalone/persistent.mjs`（新） | 常驻循环：变化检测、按需调模型、复用工具分发 |
| `standalone/task-runner.mjs` | `runPersistent(goal, options)` 与 `run()` 互斥（同一把锁，维持“一次一个任务”）；`onTaskDone` 钩子复用（task_done 时写经验记忆） |
| `standalone/orb-host.mjs`、`web/index.html` | 事件消费零改动；新增启动入口与状态文案 |
| 工具集 | 一次性任务保持 13 个；常驻模式 = 13 + `task_done`（`{summary}`，模型显式收尾，比猜文本可靠） |
| `standalone/memory.mjs` | 无改动；常驻任务完成走同一 `rememberTask` |

悬浮球启动方式：发送 `常驻：<目标>`（文本协议，不加新按钮）。控制台加“常驻任务”区（目标 / 间隔 / 时长 / 开始 / 停止）。

## 6. 配置（`persistent.*`，默认值）

| 字段 | 默认 | 说明 |
| - | - | - |
| `surface` | `foreground` | `foreground` 或 `offscreen`（v2） |
| `defaultIntervalMs` | 5000 | 周期；小于 `minIntervalMs` 被夹取 |
| `minIntervalMs` | 3000 | 防止“不像人”和烧 token |
| `intervalJitterMs` | 1500 | 周期随机抖动，拟人 |
| `maxDurationMs` | 7200000 | 2 小时硬停（宵禁） |
| `maxActions` | 200 | 动作预算（训练轮） |
| `maxSendsPerHour` | 60 | 发送频率上限：超限的输入类动作被拒绝并告知模型（许可单的穷替身） |
| `captureOnIdle` | true | 空闲期是否仍截图比对（廉价，必须开，否则没有“检测”） |

成本量级（需向用户明示）：空闲期零模型调用；活跃期每次变化 = 一次带图请求。5s 周期 + 群聊轰炸 ≈ 每小时数百次调用，按 Agnes 计费实打实发生。建议默认 5s、群里吵时上调到 15–30s。

## 7. API / UI

- `POST /api/task/persistent` `{goal, intervalMs?, maxDurationMs?}` → `{ok, taskId}`；忙碌返回 409（复用现有并发保护）。
- `POST /api/stop` **原样复用**（已接通 AbortController，离屏/前台两种面都走它）。
- `GET /api/status` 增加 `persistent: {goal, checks, actions, sends, elapsedMs, nextCheckInMs}`。
- 悬浮球状态行：`常驻任务 · 第 N 次检查 · 已执行 M 个动作`；`task_done` 后出 assistant 总结块，与现有 done 事件一致。
- 悬浮球始终置顶 = “随时强制停止”现状即满足，无需改动。

## 8. 安全与风险（全自动发送，最高风险项）

1. 无人工确认 → 用四道护栏兜底：频率上限（§6）、时长硬顶、动作预算、全程实时可见 + 一键停止。
2. 系统提示中明确：只回复与目标相关的内容；不确定时不发；不点击链接/文件/红包/转账类元素（微信特有高风险 UI）。
3. 拟人：周期抖动 + 发送限速；不做 7×24。
4. UAC/管理员权限的微信拒绝输入（UIPI）——以普通权限运行，文档明示。
5. 视觉路线不碰进程，但行为仍可能被风控（频率、时长、话术）——文档明示“自用风险自负”。
6. 记忆：常驻完成写一条经验（目标+动作路径+结果）；中途停止不写。

## 9. 测试策略（离线，不碰真键鼠）

假上游脚本化断言：

- 第 1 周期无变化 → `upstreamCalls` 不增加（变化检测生效）。
- 第 2 周期有变化 → 模型调 `click` → 事件序列含 `tool-start/tool-end`。
- 第 3 周期模型调 `task_done` → `done` 事件、`turns/checks` 计数、记忆写入一条。
- `maxSendsPerHour` 触发 → 输入类动作被拒，模型收到拒绝原因。
- 护栏：`maxDurationMs` 到点 → `guarded` 停止；`maxActions` 超限 → 熔断。
- 停止：周期等待中 abort → `stopped` 事件、无记忆写入、runner 复位可接下一任务。
- 互斥：常驻运行中 `POST /api/run` → 409。

离屏面 spike 单独一套手工验收（见 §10），不进自检。

## 10. 分期与决策门

- **v1（已落地 2026-10-19）**：foreground 面 + `persistent.mjs` + 互斥 + `task_done` + 变化检测 + 配置 + 双端入口 + 自检。入口：`POST /api/task/persistent` 或悬浮球发送 `常驻：<目标>`；控制台“常驻任务”区。事件流与一次性任务同构，orb-host/控制台无额外适配。详见 `docs/DEVELOPMENT.md` §5.5。
- **v2（下一步）**：离屏面落地。spike 已验证 `SW_SHOWNOACTIVATE` + `MoveWindow` 负坐标 + `PrintWindow(PW_RENDERFULLCONTENT)` 可完整捕获微信；待定的是输入路径（按 §11 顺序在真微信“文件传输助手”验收）。落地时新增 `persistent.surface` 配置与离屏 observe/execute 实现，`persistent.mjs` 循环不变。
- **v3**：周期摘要主动推送到球；如需“发送前确认”再评估球上 ask 协议（本需求已明确不要）。

## 11. Spike 结果（2026-10-19，`spike-offscreen.mjs`，真微信 4.x + 记事本）

| 实验 | 结果 | 结论 |
| - | - | - |
| E0 窗口发现 | 微信 4.x 是 **Qt** 应用，主窗类名 `Qt51514QWindowIcon`（旧 `WeChatMainWndForPC` 已不存在）；EnumWindows + 类名/标题匹配可稳定找到 | 窗口定位走枚举，不写死类名 |
| E1a 最小化态 PrintWindow | 159×27 残边 | **任何视觉方案都捕获不了最小化窗口**（无可合成内容）——监控时微信必须保持“可见” |
| E1b `SW_SHOWNOACTIVATE` 后 PrintWindow | **438×451 完整画面 PASS** | 不激活即可显示，用户无感 |
| E1c 显示但非前台 | PASS | 被我们的控制台抢占焦点也不影响捕获 |
| E1d 移到 -6000 离屏后 PrintWindow | **PASS，实证图为真实群聊界面（红点/消息/光标俱在）** | **离屏捕获方案成立**：`SW_SHOWNOACTIVATE` + `MoveWindow` 负坐标 + `PrintWindow(PW_RENDERFULLCONTENT)` |
| E2a `PostMessage WM_CHAR` → 离屏记事本 | PASS（文本经 `WM_GETTEXT` 读回验证） | 标准 Edit 控件可零焦点注入；**微信 Qt 自绘控件待真机验证** |
| E2b `AttachThreadInput`+`SetForegroundWindow`+`SendInput` → 离屏窗 | 前台切换成功但输入未送达（点击坐标被钳到屏幕边缘、焦点未落编辑框） | 该路线在离屏窗上不可靠；社区对微信的成熟做法是“发送前短暂还原窗口 + SendInput” |
| E3 离屏捕获反映已输入内容 | PASS | 捕获管线端到端成立 |

 Spike 踩坑记录（供后续维护）：koffi 3.x 的**输出结构体参数必须带 `_Out_` 标注**（`int __stdcall GetWindowRect(void *hWnd, _Out_ SPK_RECT *lpRect)`），否则 koffi 按入参转换、不回写，表现为“调用成功但对象全零”。`dist/computer-use/windows-native-D-QKwZ9u.js` 全部带此标注。

**v2 输入路径决策**（按序落地，每步都在真微信“文件传输助手”上由用户验收）：
1. `PostMessage WM_CHAR`/`WM_PASTE`（成本最低，E2a 已验证对标准控件有效）；
2. 发送前 `SW_RESTORE` 短暂前置 + `SendInput` + 拟人抖动（社区主流，可接受短暂打扰）；
3. UI Automation（`UIAutomationCore.dll`，koffi 直调；pywinauto 生态大量先例，但需对 Qt 版重新验证控件树）。
兜底捕获：WGC DLL（gitcode `open-source-toolkit/77270`，C ABI 可 koffi 直调）用于遮挡场景。

**输入配方已部分落地（2026-10-19）**：`standalone/background-input.mjs` 实现了路径 1 的完整配方——最深子控件命中测试（`ChildWindowFromPoint` 循环）、`ScreenToClient` 客户区坐标换算、`AttachThreadInput` + `SetFocus` 共享输入队列、`WM_CHAR` Unicode 注入。由 `agent.inputDispatch: "background"` 启用（默认 `foreground` 不变）。上游 `dsh-computer-use-native` 的同款实现实测：Chromium/WinForms 可正常点按输入，Win11 XAML 记事本拒绝投递。**微信（Qt）待真机验证**：通过后 v2 离屏模式即可“可见不抢焦点 + 后台输入”，用户操作电脑零干扰。

## 11. 遗留开放问题

1. 微信多开时监控哪一个实例？（默认：第一个可见主窗口）
2. `task_done` 之外是否允许模型用自然语言说“暂时无需回复”类的待命语义？（默认：纯文本回复即待命，不收尾）
3. foreground 面运行时，用户切走微信窗口怎么办？（默认：继续按最新截图工作，系统提示要求模型发现窗口丢失时待命并说明）

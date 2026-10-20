// One-shot CLI: node standalone/cli.mjs "打开记事本并输入 hello"
// Options: --config=<path> --max-turns=<n> --observe --json
import { loadConfig, defaultConfigPath } from "./config.mjs";
import { observeDesktop } from "./agent.mjs";
import { createTaskRunner } from "./task-runner.mjs";
import { rememberTask } from "./memory.mjs";
import { recordTaskTrace } from "./trace.mjs";

const options = parseArgs(process.argv.slice(2));
const config = await loadConfig(options.configPath);

if (options.observe) {
  const observation = await observeDesktop(config, { note: "CLI 手动观察。" });
  const summary = {
    foreground: observation.foreground,
    capturePath: observation.capture?.filePath ?? null,
    captureUrl: observation.capture?.urlPath ?? null
  };
  console.log(options.json ? JSON.stringify(summary, null, 2) : `已截图：${summary.capturePath ?? "未落盘"}\n前台应用：${summary.foreground.appName ?? "未知"}`);
  process.exit(0);
}

const prompt = options.prompt === "" ? (await readStdin()).trim() : options.prompt;
if (prompt === "") {
  console.error('用法: node standalone/cli.mjs "任务描述" [--config=...] [--max-turns=8]');
  console.error("也可以用管道传入任务：echo 打开记事本 | node standalone/cli.mjs");
  process.exit(1);
}

if (config.agnes.apiKey.trim() === "") {
  console.error("Agnes API Key 为空，请先运行 server.mjs 在页面配置，或设置 AGNES_API_KEY。");
  process.exit(1);
}

const runner = createTaskRunner({
  configPath: options.configPath,
  onTaskDone: (entry) => rememberTask(options.configPath, entry),
  onTaskEnd: (entry) => recordTaskTrace(options.configPath, entry)
});
let abortRequested = false;
process.on("SIGINT", () => {
  if (runner.running && !abortRequested) {
    abortRequested = true;
    console.error("已请求停止，正在收尾…（再按一次 Ctrl+C 立即退出）");
    runner.abort();
    return;
  }
  process.exit(130);
});

const result = await runner.run(prompt, { maxTurns: options.maxTurns });
if (result.stopped) {
  console.log(options.json ? JSON.stringify(result, null, 2) : "任务已停止。");
  process.exit(0);
}
if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.answer || "(模型没有返回文本)");
  if (result.exhausted) console.log("（已达到轮数上限，以上是当前进度与收尾总结。）");
  console.log("");
  console.log(`轮数: ${result.turns} | 用量: ${JSON.stringify(result.usage)}`);
  if (result.finalObservation?.capturePath) console.log(`最后截图: ${result.finalObservation.capturePath}`);
}

function parseArgs(argv) {
  let configPath = defaultConfigPath();
  let maxTurns;
  let json = false;
  let observe = false;
  const promptParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") json = true;
    else if (value === "--observe") observe = true;
    else if (value.startsWith("--config=")) configPath = value.slice("--config=".length);
    else if (value === "--config") configPath = argv[++index] ?? configPath;
    else if (value.startsWith("--max-turns=")) maxTurns = Number(value.slice("--max-turns=".length));
    else if (value === "--max-turns") maxTurns = Number(argv[++index]);
    else promptParts.push(value);
  }
  return {
    configPath,
    maxTurns: Number.isFinite(maxTurns) ? maxTurns : undefined,
    json,
    observe,
    prompt: promptParts.join(" ").trim()
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

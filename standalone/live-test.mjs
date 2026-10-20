// Manual live check: text + screenshot image input. Reads the key from AGNES_API_KEY only.
import { loadConfig } from "./config.mjs";
import { observeDesktop } from "./agent.mjs";
import { createChatCompletion, createImageBlock } from "./agnes-client.mjs";
import { TOOL_DEFINITIONS } from "./agent.mjs";

const apiKey = (process.env.AGNES_API_KEY ?? "").trim();
if (apiKey === "") {
  console.error("AGNES_API_KEY is empty");
  process.exit(1);
}

const baseURL = (process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1").replace(/\/+$/, "");
const model = process.env.AGNES_MODEL ?? "agnes-3.0-flash";
const url = baseURL.endsWith("/chat/completions") ? baseURL : baseURL + "/chat/completions";

async function post(label, body) {
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 1000) }; }
  console.log("\n[" + label + "] HTTP " + response.status + " in " + (Date.now() - started) + "ms");
  if (!response.ok) {
    console.log("error:", JSON.stringify(payload?.error ?? payload).slice(0, 1500));
    return { ok: false, status: response.status, payload };
  }
  const message = payload?.choices?.[0]?.message;
  console.log("model:", payload?.model ?? "(none)");
  console.log("finish_reason:", payload?.choices?.[0]?.finish_reason ?? "(none)");
  console.log("content:", typeof message?.content === "string" ? message.content.slice(0, 1000) : JSON.stringify(message?.content));
  console.log("usage:", JSON.stringify(payload?.usage ?? null));
  return { ok: true, status: response.status, payload };
}

const config = await loadConfig();
config.agent.saveCaptures = false;
config.agent.imageInputFormat = "data_url";

const text = await post("text", {
  model,
  messages: [{ role: "user", content: "只回复两个字：收到" }],
  max_tokens: 16,
  temperature: 0
});

const observation = await observeDesktop(config, { note: "live image test" });
const imageBlock = createImageBlock(observation.image);
console.log("\n[image block] type=" + imageBlock.type + " urlPrefix=" + imageBlock.image_url.url.slice(0, 34) + " base64Chars=" + imageBlock.image_url.url.length);

const image = await post("image", {
  model,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "请用一句中文描述这张截图的大致内容，不要执行任何操作，也不要猜测看不清的文字。" },
      imageBlock
    ]
  }],
  max_tokens: 128,
  temperature: 0
});

config.agnes.apiKey = apiKey;
config.agnes.baseURL = baseURL;
config.agnes.model = model;
const toolCompletion = await createChatCompletion(config, [
  { role: "user", content: "请调用 list_apps 工具列出当前可见应用，不要直接回答。" }
], TOOL_DEFINITIONS);
console.log("\n[tools] finish_reason=" + toolCompletion.finishReason);
console.log("tool_calls:", JSON.stringify(toolCompletion.message.tool_calls ?? []).slice(0, 1200));

if (!text.ok || !image.ok) process.exitCode = 2;

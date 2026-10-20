// Model catalog for the standalone build.
//
// The floating ball's model menu, the web console's model field and /api/models
// all read this list, so a new model is added in one place. A model that is not
// listed still works (the field accepts any id); the catalog just adds a guest
// entry so the current selection is never missing from the menu.
//
// Sources:
//   https://agnes-ai.cn/zh-Hans/docs/agnes-30-flash
//   https://agnes-ai.cn/zh-Hans/docs/agnes-25-flash
// Both: 512K context, 65,536 output, tool calls/tool_choice, temperature,
// max_tokens, thinking via chat_template_kwargs.enable_thinking.
// Both docs only show public image URLs, but both models were verified against
// the real gateway with a data: PNG on 2026-10-19: text, inline image and tool
// calls all returned 200. inlineImage therefore stays true for both; the client
// still hints at URL mode if a future gateway rejects a data: request.
export const MODELS = Object.freeze([
  {
    id: "agnes-3.0-flash",
    name: "Agnes 3.0 Flash",
    contextWindow: 512000,
    maxOutput: 65536,
    inlineImage: true,
    toolCalls: true,
    streaming: true,
    thinking: true,
    docs: "https://agnes-ai.cn/zh-Hans/docs/agnes-30-flash",
    notes: "文档只列公开 URL 图片；本机实测 data URL 截图可用。工具编排与长任务遵循是 3.0 的主打改进。"
  },
  {
    id: "agnes-2.5-flash",
    name: "Agnes 2.5 Flash",
    contextWindow: 512000,
    maxOutput: 65536,
    inlineImage: true,
    toolCalls: true,
    streaming: true,
    thinking: true,
    docs: "https://agnes-ai.cn/zh-Hans/docs/agnes-25-flash",
    notes: "文档只列公开 URL 图片；本机实测 data URL 截图、工具调用均可用。"
  }
]);

/** Look up a model by id (trimmed); null when it is a custom id. */
export function modelById(id) {
  const key = String(id ?? "").trim();
  return MODELS.find((model) => model.id === key) ?? null;
}

/**
 * Groups for the floating ball's catalog message. Always includes the current
 * model, appending a guest entry for ids the catalog does not know yet.
 * @param {string} currentModel
 * @returns {{groups: Array<{id: string, name: string, models: Array<object>}>}}
 */
export function catalogGroups(currentModel) {
  const current = String(currentModel ?? "").trim();
  const known = MODELS.map((model) => ({ id: model.id, name: model.name }));
  const items = known.some((item) => item.id === current) || current === ""
    ? known
    : [...known, { id: current, name: current }];
  return {
    groups: [{ id: "agnes", name: "Agnes", models: items }]
  };
}

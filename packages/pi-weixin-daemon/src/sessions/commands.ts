/** Daemon-owned host commands (the only `/` inputs handled over Weixin). */
export const DAEMON_COMMANDS = [
  "help",
  "status",
  "abort",
  "new",
  "compact",
  "model",
  "thinking",
  "resume",
  "reload",
] as const;

export type DaemonCommand = (typeof DAEMON_COMMANDS)[number];

const HELP: Record<string, string> = {
  model: "`/model` — 选择模型；每页 5 个，回复字母选择、数字翻页、q 退出；`a default` 同时设为项目默认。",
  thinking: "`/thinking` — 选择思考强度；回复字母选择、q 退出；`a default` 同时设为项目默认。",
  resume: "`/resume` — 选择并恢复最近会话；`/resume latest` 恢复最近会话。",
  reload: "`/reload` — 重新加载当前会话的 Pi 配置和扩展。",
  help: "`/help` 或 `/help model` — 显示全部或指定命令帮助。",
  status: "`/status` — 显示会话状态。",
  new: "`/new` — 新建会话（空闲时）。",
  abort: "`/abort` — 中止当前任务。",
  compact: "`/compact` — 压缩会话（空闲时）。",
  p: "`/p:<prompt>` — 将以 slash 开头或任意文本作为 prompt 发送给 Pi。",
};

export function helpText(command?: string): string {
  const name = command?.trim().replace(/^\//, "").toLowerCase();
  if (name) return HELP[name] ?? `未知命令 /${name}。`;
  // Markdown list items remain visually separated in Weixin, unlike soft line breaks.
  return ["**可用命令**", ...Object.values(HELP).map((line) => `- ${line}`)].join("\n");
}

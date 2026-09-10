import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";

/**
 * M9 fixture: a project extension exercising ctx.ui.confirm/select/input/notify.
 * The result of each interaction is written to $UI_MARKER.
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_confirm_tool",
    label: "Ask Confirm",
    description: "Asks the user for confirmation via ctx.ui.confirm",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const ok = await ctx.ui.confirm("部署", "确定部署到生产环境吗？");
      fs.writeFileSync(process.env.UI_MARKER!, `confirmed=${ok}\n`, "utf-8");
      return {
        content: [{ type: "text", text: `确认结果: ${ok}` }],
        details: { confirmed: ok },
      };
    },
  });

  pi.registerTool({
    name: "ask_select_tool",
    label: "Ask Select",
    description: "Asks the user to pick an option via ctx.ui.select",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const choice = await ctx.ui.select("选择部署环境", ["生产", "预发", "测试"]);
      fs.writeFileSync(process.env.UI_MARKER!, `select=${choice ?? "none"}\n`, "utf-8");
      return {
        content: [{ type: "text", text: `选择: ${choice ?? "无"}` }],
        details: { choice },
      };
    },
  });

  pi.registerTool({
    name: "ask_input_tool",
    label: "Ask Input",
    description: "Asks the user for text input via ctx.ui.input",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const value = await ctx.ui.input("输入版本号", "v1.0.0");
      fs.writeFileSync(process.env.UI_MARKER!, `input=${value ?? "none"}\n`, "utf-8");
      return {
        content: [{ type: "text", text: `版本号: ${value ?? "无"}` }],
        details: { value },
      };
    },
  });
}

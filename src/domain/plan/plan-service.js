const { normalizeWorkspacePath } = require("../../shared/workspace-paths");

async function handlePlanCommand(runtime, normalized, action = null) {
  const context = await runtime.resolveWorkspaceContext(normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`，再开启计划模式。",
  });
  if (!context) {
    return;
  }
  const { bindingKey, workspaceRoot } = context;
  const command = action?.action || parsePlanCommand(normalized.text);
  if (command === "on") {
    setPlanMode(runtime, bindingKey, workspaceRoot, true);
  } else if (command === "off") {
    setPlanMode(runtime, bindingKey, workspaceRoot, false);
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    card: buildPlanModeCard({
      workspaceRoot,
      enabled: getPlanMode(runtime, bindingKey, workspaceRoot),
    }),
  });
}

function handlePlanCardAction(runtime, action, normalized) {
  return runtime.queueCardActionWithFeedback(
    normalized,
    "正在切换计划模式...",
    () => runtime.handlePlanCommand(normalized, action)
  );
}

function getPlanMode(runtime, bindingKey, workspaceRoot) {
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const map = binding.planModeByWorkspaceRoot || {};
  return Boolean(map[normalizeWorkspacePath(workspaceRoot)]);
}

function setPlanMode(runtime, bindingKey, workspaceRoot, enabled) {
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  const current = runtime.sessionStore.getBinding(bindingKey) || {};
  const planModeByWorkspaceRoot = {
    ...(current.planModeByWorkspaceRoot || {}),
    [normalizedWorkspaceRoot]: Boolean(enabled),
  };
  runtime.sessionStore.updateBinding(bindingKey, {
    ...current,
    planModeByWorkspaceRoot,
  });
}

function buildMessageWithPlanMode(runtime, { bindingKey = "", workspaceRoot = "", text = "" } = {}) {
  if (!bindingKey || !workspaceRoot || !getPlanMode(runtime, bindingKey, workspaceRoot)) {
    return text;
  }
  return [
    "<feishu-plan-mode>",
    "[System note: Feishu Plan Mode is ON for this workspace. Do not execute code changes, shell commands with side effects, file edits, commits, uploads, or Obsidian writes unless Jiao explicitly turns plan mode off or says to execute. First clarify goal, success criteria, scope, risks, and implementation approach. Prefer a concise plan. If the plan is ready, wrap it in <proposed_plan>...</proposed_plan>.]",
    "</feishu-plan-mode>",
    "",
    text,
  ].join("\n");
}

function buildPlanModeCard({ workspaceRoot, enabled }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: enabled ? "计划模式已开启" : "计划模式已关闭",
      },
      template: enabled ? "blue" : "grey",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `项目：\`${workspaceRoot}\``,
            "",
            enabled
              ? "普通消息会先进入讨论/计划，不会直接施工。"
              : "普通消息会按当前默认方式处理，必要时会直接执行。",
            "",
            "命令：`/codex plan on`、`/codex plan off`、`/codex plan`",
          ].join("\n"),
        },
      },
      {
        tag: "hr",
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "开启" },
            type: "primary",
            value: buildPlanActionValue("on"),
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "关闭" },
            value: buildPlanActionValue("off"),
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "刷新状态" },
            value: buildPlanActionValue("status"),
          },
        ],
      },
    ],
  };
}

function buildPlanActionValue(action) {
  return {
    kind: "plan",
    action,
  };
}

function parsePlanCommand(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (/^\/codex\s+plan\s+(on|open|enable|开启|打开)$/.test(normalized)) {
    return "on";
  }
  if (/^\/codex\s+plan\s+(off|close|disable|关闭|退出)$/.test(normalized)) {
    return "off";
  }
  return "status";
}

module.exports = {
  buildMessageWithPlanMode,
  getPlanMode,
  handlePlanCardAction,
  handlePlanCommand,
};

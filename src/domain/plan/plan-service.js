const { normalizeWorkspacePath } = require("../../shared/workspace-paths");

const PLAN_QUESTION_RE = /\[\[yuan-feishu-plan-question:([\s\S]*?)\]\]/g;

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
  if (action.action === "execute") {
    return runtime.queueCardActionWithFeedback(
      normalized,
      "正在确认执行计划...",
      () => executeConfirmedPlan(runtime, action, normalized)
    );
  }
  if (action.action === "answer") {
    return runtime.queueCardActionWithFeedback(
      normalized,
      "正在提交计划补充...",
      () => answerPlanQuestion(runtime, action, normalized)
    );
  }
  return runtime.queueCardActionWithFeedback(
    normalized,
    "正在切换计划模式...",
    () => runtime.handlePlanCommand(normalized, action)
  );
}

async function answerPlanQuestion(runtime, action, normalized) {
  const threadId = normalizeIdentifier(action.threadId);
  const workspaceRoot = normalizeWorkspacePath(
    action.workspaceRoot
      || runtime.resolveWorkspaceRootForThread(threadId)
      || runtime.workspaceRootByThreadId.get(threadId)
      || ""
  );
  const bindingKey = runtime.bindingKeyByThreadId.get(threadId)
    || runtime.sessionStore.buildBindingKey(normalized);
  if (!threadId || !workspaceRoot || !bindingKey) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "无法提交计划补充：没有找到对应线程或项目。",
    });
    return;
  }
  const answerMessage = {
    ...normalized,
    text: [
      "Jiao 在飞书计划问答卡中选择/补充：",
      `问题：${action.question || "未记录"}`,
      `回答：${action.answer || "未记录"}`,
      "",
      "请基于这个回答继续计划模式；如果信息足够，请输出 <proposed_plan>。",
    ].join("\n"),
    command: "message",
  };
  runtime.setPendingBindingContext(bindingKey, answerMessage);
  runtime.setPendingThreadContext(threadId, answerMessage);
  await runtime.ensureThreadAndSendMessage({
    bindingKey,
    workspaceRoot,
    normalized: answerMessage,
    threadId,
  });
}

async function executeConfirmedPlan(runtime, action, normalized) {
  const threadId = normalizeIdentifier(action.threadId);
  const workspaceRoot = normalizeWorkspacePath(
    action.workspaceRoot
      || runtime.resolveWorkspaceRootForThread(threadId)
      || runtime.workspaceRootByThreadId.get(threadId)
      || ""
  );
  const bindingKey = runtime.bindingKeyByThreadId.get(threadId)
    || runtime.sessionStore.buildBindingKey(normalized);
  if (!threadId || !workspaceRoot || !bindingKey) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "无法确认执行：没有找到对应线程或项目。请先发 `/codex where` 检查当前绑定。",
    });
    return;
  }
  setPlanMode(runtime, bindingKey, workspaceRoot, false);
  const executeMessage = {
    ...normalized,
    text: "Jiao 已在飞书计划卡片中确认执行。请按上一条 <proposed_plan> 的方案开始实施；如果执行前发现计划已过期或有高风险，先说明最小阻塞点。",
    command: "message",
  };
  runtime.setPendingBindingContext(bindingKey, executeMessage);
  runtime.setPendingThreadContext(threadId, executeMessage);
  await runtime.ensureThreadAndSendMessage({
    bindingKey,
    workspaceRoot,
    normalized: executeMessage,
    threadId,
  });
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
    "[System note: Feishu Plan Mode is ON for this workspace. Do not execute code changes, shell commands with side effects, file edits, commits, uploads, or Obsidian writes unless Jiao explicitly turns plan mode off or says to execute. First clarify goal, success criteria, scope, risks, and implementation approach. If you need Jiao to choose or supplement information, ask in natural language and also include one hidden directive on its own line: [[yuan-feishu-plan-question:{\"question\":\"...\",\"options\":[\"推荐选项\",\"另一个选项\"]}]]. The bridge will turn that directive into a Feishu question card. If the plan is ready, wrap it in <proposed_plan>...</proposed_plan>.]",
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

async function maybeSendPlanConfirmationCard(runtime, { threadId = "", turnId = "", chatId = "", text = "" } = {}) {
  if (!threadId || !turnId || !chatId || !hasCompletedProposedPlan(text)) {
    return false;
  }
  const key = `${threadId}:${turnId}`;
  if (runtime.planConfirmationKeys.has(key)) {
    return false;
  }
  runtime.planConfirmationKeys.add(key);
  const workspaceRoot = runtime.resolveWorkspaceRootForThread(threadId)
    || runtime.workspaceRootByThreadId.get(threadId)
    || "";
  await runtime.sendInteractiveCard({
    chatId,
    card: buildPlanConfirmationCard({
      threadId,
      workspaceRoot,
    }),
  });
  return true;
}

async function handlePlanQuestionDirectives(runtime, { threadId = "", turnId = "", chatId = "", text = "" } = {}) {
  const questions = extractPlanQuestions(text);
  if (!threadId || !turnId || !chatId || !questions.length) {
    return { text: stripPlanQuestionDirectives(text), sent: 0 };
  }
  const workspaceRoot = runtime.resolveWorkspaceRootForThread(threadId)
    || runtime.workspaceRootByThreadId.get(threadId)
    || "";
  let sent = 0;
  for (const [index, question] of questions.entries()) {
    const key = `${threadId}:${turnId}:q${index}:${question.question}`;
    if (runtime.planQuestionKeys.has(key)) {
      continue;
    }
    runtime.planQuestionKeys.add(key);
    await runtime.sendInteractiveCard({
      chatId,
      card: buildPlanQuestionCard({
        threadId,
        workspaceRoot,
        question,
      }),
    });
    sent += 1;
  }
  return { text: stripPlanQuestionDirectives(text), sent };
}

function buildPlanQuestionCard({ threadId, workspaceRoot, question }) {
  const options = normalizeQuestionOptions(question.options);
  const actions = options.map((option) => ({
    tag: "button",
    text: { tag: "plain_text", content: option.label },
    type: option.recommended ? "primary" : "",
    value: {
      ...buildPlanActionValue("answer"),
      threadId,
      workspaceRoot,
      question: question.question,
      answer: option.label,
    },
  }));
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "计划需要补充" },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            question.question,
            question.description ? `\n${question.description}` : "",
            "",
            "点一个选项后，我会继续修正计划。",
          ].filter(Boolean).join("\n"),
        },
      },
      {
        tag: "action",
        actions: actions.length ? actions : [
          {
            tag: "button",
            text: { tag: "plain_text", content: "我直接补充文字" },
            value: {
              ...buildPlanActionValue("on"),
              threadId,
              workspaceRoot,
            },
          },
        ],
      },
    ],
  };
}

function buildPlanConfirmationCard({ threadId, workspaceRoot }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "计划待确认" },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "我已经整理出计划。",
            "",
            "点“执行计划”后，我会关闭计划模式，并按上面的方案开始实施。",
            "点“继续讨论”则保持计划模式，你可以继续补充边界。",
            workspaceRoot ? `\n项目：\`${workspaceRoot}\`` : "",
          ].filter(Boolean).join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "执行计划" },
            type: "primary",
            value: {
              ...buildPlanActionValue("execute"),
              threadId,
              workspaceRoot,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "继续讨论" },
            value: {
              ...buildPlanActionValue("on"),
              threadId,
              workspaceRoot,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "退出计划模式" },
            value: {
              ...buildPlanActionValue("off"),
              threadId,
              workspaceRoot,
            },
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

function extractPlanQuestions(text) {
  const result = [];
  const source = String(text || "");
  let match;
  while ((match = PLAN_QUESTION_RE.exec(source))) {
    const question = parsePlanQuestion(match[1]);
    if (question?.question) {
      result.push(question);
    }
  }
  return result;
}

function stripPlanQuestionDirectives(text) {
  return String(text || "").replace(PLAN_QUESTION_RE, "").trim();
}

function parsePlanQuestion(rawJson) {
  try {
    const parsed = JSON.parse(String(rawJson || "").trim());
    return {
      question: normalizeIdentifier(parsed.question),
      description: normalizeIdentifier(parsed.description),
      options: Array.isArray(parsed.options) ? parsed.options : [],
    };
  } catch {
    return null;
  }
}

function normalizeQuestionOptions(options) {
  return options
    .map((option, index) => {
      if (typeof option === "string") {
        return {
          label: option.trim(),
          recommended: index === 0,
        };
      }
      return {
        label: normalizeIdentifier(option?.label),
        recommended: Boolean(option?.recommended) || index === 0,
      };
    })
    .filter((option) => option.label)
    .slice(0, 4);
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

function hasCompletedProposedPlan(text) {
  const value = String(text || "");
  return /<proposed_plan>[\s\S]*<\/proposed_plan>/i.test(value);
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildMessageWithPlanMode,
  extractPlanQuestions,
  getPlanMode,
  handlePlanCardAction,
  handlePlanCommand,
  handlePlanQuestionDirectives,
  maybeSendPlanConfirmationCard,
  stripPlanQuestionDirectives,
};

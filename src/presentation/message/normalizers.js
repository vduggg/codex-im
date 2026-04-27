const codexMessageUtils = require("../../infra/codex/message-utils");

function normalizeFeishuTextEvent(event, config) {
  const message = event?.message || {};
  const sender = event?.sender || {};
  if (message.message_type !== "text") {
    return normalizeFeishuNonTextEvent(message, sender, config);
  }

  const text = parseFeishuMessageText(message.content);
  if (!text) {
    return null;
  }

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId: sender?.sender_id?.open_id || sender?.sender_id?.user_id || "",
    messageId: message.message_id || "",
    text,
    command: parseCommand(text),
    receivedAt: new Date().toISOString(),
  };
}

function normalizeFeishuNonTextEvent(message, sender, config) {
  const messageType = typeof message.message_type === "string" ? message.message_type.trim() : "";
  if (!messageType) {
    return null;
  }
  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId: sender?.sender_id?.open_id || sender?.sender_id?.user_id || "",
    messageId: message.message_id || "",
    text: "",
    command: "unsupported_message",
    unsupportedMessageType: messageType,
    receivedAt: new Date().toISOString(),
  };
}

function extractCardAction(data) {
  const action = data?.action || {};
  const value = action.value || {};
  if (!value.kind) {
    const namedAction = extractNamedMemorySubmitAction(action);
    if (namedAction) {
      return namedAction;
    }
    console.log("[codex-im] card callback action missing kind", {
      action,
      hasValue: !!action.value,
    });
    return null;
  }

  if (value.kind === "approval") {
    return {
      kind: value.kind,
      decision: value.decision,
      scope: value.scope || "once",
      requestId: value.requestId,
      threadId: value.threadId,
    };
  }
  if (value.kind === "panel") {
    const selectedValue = extractCardSelectedValue(action, value);
    return {
      kind: value.kind,
      action: value.action || "",
      selectedValue,
    };
  }
  if (value.kind === "thread") {
    return {
      kind: value.kind,
      action: value.action || "",
      threadId: value.threadId || "",
    };
  }
  if (value.kind === "workspace") {
    return {
      kind: value.kind,
      action: value.action || "",
      workspaceRoot: value.workspaceRoot || "",
    };
  }
  if (value.kind === "memory") {
    return {
      kind: value.kind,
      action: value.action || "",
      formValue: extractCardFormValue(action, value),
      priority: value.priority || "",
      taskType: value.taskType || "",
    };
  }
  return null;
}

function extractNamedMemorySubmitAction(action) {
  const name = typeof action?.name === "string" ? action.name.trim() : "";
  if (!name.startsWith("todo_submit_")) {
    return null;
  }
  const formValue = extractCardFormValue(action, {});
  const isHigh = name === "todo_submit_high";
  const isSuspended = name === "todo_submit_suspended";
  return {
    kind: "memory",
    action: "todo_submit",
    formValue,
    priority: isHigh ? "high" : "normal",
    taskType: isSuspended ? "suspended" : "task",
  };
}

function normalizeCardActionContext(data, config) {
  const messageId = normalizeIdentifier(data?.context?.open_message_id);
  const chatId = extractCardChatId(data);
  const senderId = normalizeIdentifier(data?.operator?.open_id);

  if (!chatId || !messageId || !senderId) {
    console.log("[codex-im] card callback missing required context", {
      context_open_message_id: data?.context?.open_message_id,
      context_open_chat_id: data?.context?.open_chat_id,
      operator_open_id: data?.operator?.open_id,
    });
    return null;
  }

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId,
    threadKey: "",
    senderId,
    messageId,
    text: "",
    command: "",
    receivedAt: new Date().toISOString(),
  };
}

function mapCodexMessageToImEvent(message) {
  return codexMessageUtils.mapCodexMessageToImEvent(message);
}

function parseFeishuMessageText(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

function parseCommand(text) {
  const normalized = text.trim().toLowerCase();
  const prefixes = ["/codex "];
  const exactPrefixes = ["/codex"];

  const exactCommands = {
    stop: ["stop"],
    where: ["where"],
    inspect_message: ["message"],
    help: ["help"],
    workspace: ["workspace"],
    remove: ["remove"],
    send: ["send"],
    new: ["new"],
    model: ["model"],
    effort: ["effort"],
    profile: ["profile"],
    memory: ["memory"],
    today: ["today"],
    todo: ["todo"],
    bridge: ["bridge"],
    recall: ["recall"],
    hub: ["hub"],
    approve: ["approve", "approve workspace"],
    reject: ["reject"],
  };

  for (const [command, suffixes] of Object.entries(exactCommands)) {
    if (matchesExactCommand(normalized, suffixes)) {
      return command;
    }
  }

  if (matchesPrefixCommand(normalized, "switch")) {
    return "switch";
  }
  if (matchesPrefixCommand(normalized, "remove")) {
    return "remove";
  }
  if (matchesPrefixCommand(normalized, "send")) {
    return "send";
  }
  if (matchesPrefixCommand(normalized, "bind")) {
    return "bind";
  }
  if (matchesPrefixCommand(normalized, "model")) {
    return "model";
  }
  if (matchesPrefixCommand(normalized, "effort")) {
    return "effort";
  }
  if (matchesPrefixCommand(normalized, "profile")) {
    return "profile";
  }
  if (matchesPrefixCommand(normalized, "memory")) {
    return "memory";
  }
  if (matchesPrefixCommand(normalized, "today")) {
    return "today";
  }
  if (matchesPrefixCommand(normalized, "todo")) {
    return "todo";
  }
  if (matchesPrefixCommand(normalized, "bridge")) {
    return "bridge";
  }
  if (matchesPrefixCommand(normalized, "recall")) {
    return "recall";
  }
  if (matchesPrefixCommand(normalized, "hub")) {
    return "hub";
  }
  if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
    return "unknown_command";
  }
  if (exactPrefixes.includes(normalized)) {
    return "unknown_command";
  }
  if (text.trim()) {
    return "message";
  }

  return "";
}

function matchesExactCommand(text, suffixes) {
  return suffixes.some((suffix) => text === `/codex ${suffix}`);
}

function matchesPrefixCommand(text, command) {
  return text.startsWith(`/codex ${command} `);
}

function extractCardChatId(data) {
  return normalizeIdentifier(data?.context?.open_chat_id);
}

function extractCardSelectedValue(action, value) {
  if (typeof action?.option?.value === "string" && action.option.value.trim()) {
    return action.option.value.trim();
  }
  if (typeof action?.option === "string" && action.option.trim()) {
    return action.option.trim();
  }
  return typeof value?.selectedValue === "string" ? value.selectedValue.trim() : "";
}

function extractCardFormValue(action, value) {
  const formValue = action?.form_value || action?.formValue || value?.form_value || value?.formValue || {};
  if (!formValue || typeof formValue !== "object") {
    return {};
  }
  if (!formValue.title && formValue.todo_form && typeof formValue.todo_form === "object") {
    return {
      ...formValue,
      ...formValue.todo_form,
    };
  }
  return formValue;
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  extractCardAction,
  mapCodexMessageToImEvent,
  normalizeCardActionContext,
  normalizeFeishuTextEvent,
};

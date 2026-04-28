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
  const attachments = extractFeishuMessageAttachments(messageType, message.content);
  const text = parseFeishuNonTextMessageText(messageType, message.content);
  const command = attachments.some((attachment) => attachment?.kind === "image")
    ? "image_message"
    : attachments.length
      ? "attachment_message"
    : "unsupported_message";
  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId: sender?.sender_id?.open_id || sender?.sender_id?.user_id || "",
    messageId: message.message_id || "",
    text,
    command,
    attachments,
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
  if (value.kind === "plan") {
    return {
      kind: value.kind,
      action: value.action || "",
      answer: value.answer || "",
      question: value.question || "",
      threadId: value.threadId || "",
      workspaceRoot: value.workspaceRoot || "",
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
  const parsed = parseFeishuMessageContent(rawContent);
  return typeof parsed.text === "string" ? parsed.text.trim() : "";
}

function parseFeishuMessageContent(rawContent) {
  try {
    return JSON.parse(rawContent || "{}");
  } catch {
    return {};
  }
}

function extractFeishuMessageAttachments(messageType, rawContent) {
  const parsed = parseFeishuMessageContent(rawContent);
  if (messageType === "image") {
    const imageKey = normalizeIdentifier(parsed.image_key || parsed.imageKey || parsed.file_key || parsed.fileKey);
    return imageKey
      ? [{
        kind: "image",
        resourceKey: imageKey,
        resourceType: "image",
      }]
      : [];
  }
  if (messageType === "post") {
    return extractPostImageKeys(parsed).map((resourceKey) => ({
      kind: "image",
      resourceKey,
      resourceType: "image",
    }));
  }
  if (messageType === "file") {
    const resourceKey = normalizeIdentifier(parsed.file_key || parsed.fileKey);
    return resourceKey
      ? [{
        kind: "file",
        resourceKey,
        resourceType: "file",
        fileName: normalizeIdentifier(parsed.file_name || parsed.fileName || parsed.name),
        fileSize: normalizeNumber(parsed.file_size || parsed.fileSize || parsed.size),
        fileType: normalizeIdentifier(parsed.file_type || parsed.fileType),
      }]
      : [];
  }
  if (messageType === "audio" || messageType === "voice") {
    const resourceKey = normalizeIdentifier(parsed.file_key || parsed.fileKey);
    return resourceKey
      ? [{
        kind: "audio",
        resourceKey,
        resourceType: "file",
        fileName: normalizeIdentifier(parsed.file_name || parsed.fileName || parsed.name) || "audio.opus",
        fileSize: normalizeNumber(parsed.file_size || parsed.fileSize || parsed.size),
        fileType: normalizeIdentifier(parsed.file_type || parsed.fileType),
        duration: normalizeNumber(parsed.duration),
      }]
      : [];
  }
  if (messageType === "media") {
    const resourceKey = normalizeIdentifier(parsed.file_key || parsed.fileKey || parsed.media_key || parsed.mediaKey);
    return resourceKey
      ? [{
        kind: "audio",
        resourceKey,
        resourceType: "media",
        fileName: normalizeIdentifier(parsed.file_name || parsed.fileName || parsed.name) || "media.mp4",
        fileSize: normalizeNumber(parsed.file_size || parsed.fileSize || parsed.size),
        fileType: normalizeIdentifier(parsed.file_type || parsed.fileType) || "mp4",
        duration: normalizeNumber(parsed.duration),
      }]
      : [];
  }
  return [];
}

function parseFeishuNonTextMessageText(messageType, rawContent) {
  if (messageType !== "post") {
    return "";
  }
  const parsed = parseFeishuMessageContent(rawContent);
  return extractPostText(parsed).trim();
}

function extractPostImageKeys(value, result = []) {
  if (!value) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractPostImageKeys(item, result);
    }
    return dedupeStrings(result);
  }
  if (typeof value !== "object") {
    return result;
  }

  const tag = normalizeIdentifier(value.tag).toLowerCase();
  const imageKey = normalizeIdentifier(
    value.image_key
      || value.imageKey
      || value.file_key
      || value.fileKey
      || (tag === "img" ? value.key : "")
  );
  if (imageKey) {
    result.push(imageKey);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      extractPostImageKeys(child, result);
    }
  }
  return dedupeStrings(result);
}

function extractPostText(value, fragments = []) {
  if (!value) {
    return fragments.join("").replace(/\n{3,}/g, "\n\n");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractPostText(item, fragments);
    }
    return fragments.join("").replace(/\n{3,}/g, "\n\n");
  }
  if (typeof value !== "object") {
    return fragments.join("").replace(/\n{3,}/g, "\n\n");
  }

  const tag = normalizeIdentifier(value.tag).toLowerCase();
  if (tag === "text" && typeof value.text === "string") {
    fragments.push(value.text);
  } else if ((tag === "a" || tag === "at") && typeof value.text === "string") {
    fragments.push(value.text);
  } else if (tag === "br") {
    fragments.push("\n");
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      extractPostText(child, fragments);
    }
  }
  return fragments.join("").replace(/\n{3,}/g, "\n\n");
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
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
    plan: ["plan"],
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
  if (matchesPrefixCommand(normalized, "plan")) {
    return "plan";
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

function normalizeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

module.exports = {
  extractCardAction,
  mapCodexMessageToImEvent,
  normalizeCardActionContext,
  normalizeFeishuTextEvent,
};

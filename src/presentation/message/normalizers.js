const codexMessageUtils = require("../../infra/codex/message-utils");

function normalizeFeishuTextEvent(event, config) {
  const message = event?.message || {};
  const sender = event?.sender || {};
  const normalizedContent = normalizeIncomingFeishuMessage(message);
  if (!normalizedContent) {
    return null;
  }

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId: sender?.sender_id?.open_id || sender?.sender_id?.user_id || "",
    messageId: message.message_id || "",
    text: normalizedContent.text,
    images: normalizedContent.images,
    files: normalizedContent.files,
    messageType: normalizedContent.messageType,
    command: parseCommand(normalizedContent.text),
    receivedAt: new Date().toISOString(),
  };
}

function extractCardAction(data) {
  const action = data?.action || {};
  const value = action.value || {};
  if (!value.kind) {
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
  return null;
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
    images: [],
    files: [],
    messageType: "card_action",
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

function normalizeIncomingFeishuMessage(message) {
  const messageType = normalizeIdentifier(message?.message_type).toLowerCase();
  if (messageType === "text") {
    const text = parseFeishuMessageText(message.content);
    if (!text) {
      return null;
    }
    return {
      text,
      images: [],
      files: [],
      messageType: "text",
    };
  }

  if (messageType === "image") {
    const imageKey = parseFeishuMessageImageKey(message.content);
    if (!imageKey) {
      return null;
    }
    return {
      text: "",
      images: [
        {
          imageKey,
          sourceType: "image",
        },
      ],
      files: [],
      messageType: "image_only",
    };
  }

  if (messageType === "file") {
    const file = parseFeishuMessageFile(message.content);
    if (!file) {
      return null;
    }
    return {
      text: "",
      images: [],
      files: [file],
      messageType: "file_only",
    };
  }

  if (messageType === "post") {
    const parsedPost = parseFeishuPostMessage(message.content);
    if (!parsedPost) {
      return null;
    }
    return parsedPost;
  }

  return null;
}

function parseFeishuMessageImageKey(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    return normalizeIdentifier(parsed?.image_key);
  } catch {
    return "";
  }
}

function parseFeishuMessageFile(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    const fileKey = normalizeIdentifier(parsed?.file_key);
    if (!fileKey) {
      return null;
    }
    return {
      fileKey,
      fileName: normalizeIdentifier(parsed?.file_name) || "file",
      sourceType: "file",
    };
  } catch {
    return null;
  }
}

function parseFeishuPostMessage(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    const postBody = pickPostBody(parsed);
    if (!postBody) {
      return null;
    }

    const images = [];
    const textSegments = [];
    const contentBlocks = Array.isArray(postBody.content) ? postBody.content : [];
    for (const block of contentBlocks) {
      const blockResult = extractPostBlock(block);
      if (blockResult.text) {
        textSegments.push(blockResult.text);
      }
      if (blockResult.images.length) {
        images.push(...blockResult.images);
      }
    }

    const text = normalizePostText(textSegments.join("\n"));
    if (!text && !images.length) {
      return null;
    }
    return {
      text,
      images,
      files: [],
      messageType: text && images.length ? "mixed" : (images.length ? "image_only" : "text"),
    };
  } catch {
    return null;
  }
}

function pickPostBody(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if (Array.isArray(parsed.content)) {
    return parsed;
  }
  for (const value of Object.values(parsed)) {
    if (value && typeof value === "object" && Array.isArray(value.content)) {
      return value;
    }
  }
  return null;
}

function extractPostBlock(block) {
  const textSegments = [];
  const images = [];
  const items = Array.isArray(block) ? block : [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const tag = normalizeIdentifier(item.tag).toLowerCase();
    if (tag === "text" || tag === "a") {
      const text = normalizePostText(item.text);
      if (text) {
        textSegments.push(text);
      }
      continue;
    }
    if (tag === "at") {
      const userName = normalizePostText(item.user_name);
      if (userName) {
        textSegments.push(`@${userName}`);
      }
      continue;
    }
    if (tag === "img") {
      const imageKey = normalizeIdentifier(item.image_key);
      if (imageKey) {
        images.push({
          imageKey,
          sourceType: "post",
        });
      }
    }
  }
  return {
    text: normalizePostText(textSegments.join("")),
    images,
  };
}

function normalizePostText(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
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

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  extractCardAction,
  mapCodexMessageToImEvent,
  normalizeCardActionContext,
  normalizeFeishuTextEvent,
};

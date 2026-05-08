const messageNormalizers = require("../presentation/message/normalizers");
const eventsRuntime = require("./codex-event-service");
const { formatFailureText } = require("../shared/error-text");

async function onFeishuTextEvent(runtime, event) {
  const normalized = messageNormalizers.normalizeFeishuTextEvent(event, runtime.config);
  if (!normalized) {
    console.warn("[codex-im] ignored feishu message during normalization", {
      messageType: event?.message?.message_type || "",
      messageId: event?.message?.message_id || "",
      contentPreview: String(event?.message?.content || "").slice(0, 300),
    });
    return;
  }

  console.log("[codex-im] normalized feishu message", {
    messageType: normalized.messageType,
    messageId: normalized.messageId,
    chatId: normalized.chatId,
    textLength: normalized.text.length,
    imageCount: normalized.images.length,
    fileCount: Array.isArray(normalized.files) ? normalized.files.length : 0,
    command: normalized.command,
  });

  if (!normalized.images.length && await runtime.dispatchTextCommand(normalized)) {
    return;
  }

  const workspaceContext = await runtime.resolveWorkspaceContext(normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
  });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;
  const { threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  runtime.setPendingBindingContext(bindingKey, normalized);
  if (threadId) {
    runtime.setPendingThreadContext(threadId, normalized);
  }

  await runtime.addPendingReaction(bindingKey, normalized.messageId);

  try {
    const resolvedThreadId = await runtime.ensureThreadAndSendMessage({
      bindingKey,
      workspaceRoot,
      normalized,
      threadId,
    });
    runtime.movePendingReactionToThread(bindingKey, resolvedThreadId);
  } catch (error) {
    await runtime.clearPendingReactionForBinding(bindingKey);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("处理失败", error),
    });
    throw error;
  }
}

async function onFeishuCardAction(runtime, data) {
  try {
    return await runtime.handleCardAction(data);
  } catch (error) {
    console.error(`[codex-im] failed to process card action: ${error.message}`);
    return runtime.buildCardToast(formatFailureText("处理失败", error));
  }
}

function onCodexMessage(runtime, message) {
  eventsRuntime.handleCodexMessage(runtime, message);
}

module.exports = {
  onCodexMessage,
  onFeishuCardAction,
  onFeishuTextEvent,
};

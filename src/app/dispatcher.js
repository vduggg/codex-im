const messageNormalizers = require("../presentation/message/normalizers");
const eventsRuntime = require("./codex-event-service");
const { formatFailureText } = require("../shared/error-text");

async function onFeishuTextEvent(runtime, event) {
  const normalized = messageNormalizers.normalizeFeishuTextEvent(event, runtime.config);
  if (!normalized) {
    return;
  }
  if (normalized.command === "unsupported_message") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildUnsupportedMessageText(normalized.unsupportedMessageType),
    });
    return;
  }

  if (await runtime.dispatchTextCommand(normalized)) {
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

  if (threadId && runtime.activeTurnIdByThreadId.has(threadId)) {
    if (runtime.pendingApprovalByThreadId.has(threadId)) {
      const prompted = await runtime.sendApprovalPrompt({
        threadId,
        normalized,
        reason: "blocked-message",
      });
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: prompted
          ? "上一条还在等授权。我已经把授权卡重新发出来了；也可以直接发 `/codex approve` 或 `/codex reject`。"
          : "上一条还在等授权。可以直接发 `/codex approve` 允许本次请求，或发 `/codex reject` 拒绝。",
        kind: "approval",
      });
      return;
    }
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前线程还有任务在运行。请先等待完成，或发送 `/codex stop` 中断后再发新消息。",
    });
    return;
  }

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

function buildUnsupportedMessageText(messageType) {
  const typeLabel = String(messageType || "unknown");
  if (typeLabel === "image") {
    return [
      "我收到图片了，但飞书图片解析还没接上。",
      "",
      "现在这条桥只处理文字消息，所以图片不会进入 Codex。",
      "临时办法：先把图片里的重点用文字发给我，或者在桌面端直接给 Codex 发图。",
      "",
      "我已经把“图片消息不要静默丢弃”修了，下一步再接图片下载和多模态输入。",
    ].join("\n");
  }
  return [
    `我收到了非文本消息：\`${typeLabel}\`。`,
    "",
    "当前飞书桥暂时只处理文字消息；这类消息还不会进入 Codex。",
  ].join("\n");
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

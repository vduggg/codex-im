const messageNormalizers = require("../presentation/message/normalizers");
const eventsRuntime = require("./codex-event-service");
const attachmentRuntime = require("../domain/attachments/attachment-service");
const { formatFailureText } = require("../shared/error-text");

async function onFeishuTextEvent(runtime, event) {
  let normalized = messageNormalizers.normalizeFeishuTextEvent(event, runtime.config);
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
  const isAttachmentCommand = normalized.command === "image_message" || normalized.command === "attachment_message";
  if (!isAttachmentCommand && await runtime.dispatchTextCommand(normalized)) {
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
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const isImageMessage = normalized.command === "image_message";
  const isAttachmentMessage = isImageMessage || normalized.command === "attachment_message";
  normalized = {
    ...normalized,
    codexModel: codexParams.model || runtime.config.defaultCodexModel || "",
  };
  if (isAttachmentMessage) {
    normalized = await attachmentRuntime.prepareAttachmentMessage(runtime, normalized, {
      workspaceRoot,
      expectedKind: isImageMessage ? "image" : "",
    });
    if (!normalized) {
      return;
    }
  }
  let { threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: !isImageMessage,
  });
  if (isImageMessage) {
    threadId = "";
  }

  if (threadId && runtime.activeTurnIdByThreadId.has(threadId)) {
    if (runtime.pendingApprovalByThreadId.has(threadId)) {
      const queued = runtime.enqueueThreadMessage(threadId, {
        bindingKey,
        workspaceRoot,
        normalized,
      });
      const prompted = await runtime.sendApprovalPrompt({
        threadId,
        normalized,
        reason: "blocked-message",
      });
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: buildQueuedApprovalText({ prompted, queued }),
        kind: "approval",
      });
      return;
    }
    const queued = runtime.enqueueThreadMessage(threadId, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildQueuedMessageText(queued),
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

function buildQueuedMessageText(queued) {
  if (!queued?.ok) {
    if (queued?.reason === "full") {
      return "当前线程还在运行，消息队列也满了。先等我处理完前面的，或发送 `/codex stop` 中断当前任务。";
    }
    return "当前线程还在运行，这条暂时没能进入队列。先等我处理完前面的，或发送 `/codex stop` 中断当前任务。";
  }
  return [
    "当前线程还在运行，我已经把这条消息排进队列。",
    "",
    `队列位置：第 ${queued.position} 条`,
    "上一轮结束后我会自动接着处理，不用重发。",
    "如果要放弃当前任务，可以发送 `/codex stop`。",
  ].join("\n");
}

function buildQueuedApprovalText({ prompted, queued }) {
  const queueText = queued?.ok
    ? [`我也把这条新消息排进队列了，位置：第 ${queued.position} 条。`, "授权处理完后会自动继续。"]
    : ["这条新消息暂时没能进入队列。"];
  return [
    prompted
      ? "上一条还在等授权。我已经把授权卡重新发出来了。"
      : "上一条还在等授权。",
    "可以直接发 `/codex approve` 或 `/codex reject`。",
    "",
    ...queueText,
  ].join("\n");
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

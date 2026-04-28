const MAX_QUEUE_ITEMS_PER_THREAD = 20;

function enqueueThreadMessage(runtime, threadId, item) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return { ok: false, position: 0, reason: "missing_thread" };
  }
  const queue = runtime.messageQueueByThreadId.get(normalizedThreadId) || [];
  if (queue.length >= MAX_QUEUE_ITEMS_PER_THREAD) {
    return { ok: false, position: queue.length, reason: "full" };
  }
  queue.push({
    ...item,
    enqueuedAt: new Date().toISOString(),
  });
  runtime.messageQueueByThreadId.set(normalizedThreadId, queue);
  return { ok: true, position: queue.length };
}

async function drainNextThreadMessage(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return false;
  }
  if (runtime.activeTurnIdByThreadId.has(normalizedThreadId)
    || runtime.pendingApprovalByThreadId.has(normalizedThreadId)) {
    return false;
  }
  const queue = runtime.messageQueueByThreadId.get(normalizedThreadId) || [];
  if (!queue.length) {
    runtime.messageQueueByThreadId.delete(normalizedThreadId);
    return false;
  }
  const batch = queue.splice(0, queue.length);
  runtime.messageQueueByThreadId.delete(normalizedThreadId);
  const next = buildGuidanceMessage(batch);

  await runtime.sendInfoCardMessage({
    chatId: next.normalized.chatId,
    replyToMessageId: next.normalized.messageId,
    text: batch.length > 1
      ? `我已暂停上一轮，并把刚才 ${batch.length} 条补充合并处理。`
      : "我已暂停上一轮，按这条补充修正后继续处理。",
  });

  runtime.setPendingBindingContext(next.bindingKey, next.normalized);
  runtime.setPendingThreadContext(normalizedThreadId, next.normalized);
  await runtime.addPendingReaction(next.bindingKey, next.normalized.messageId);

  try {
    const resolvedThreadId = await runtime.ensureThreadAndSendMessage({
      bindingKey: next.bindingKey,
      workspaceRoot: next.workspaceRoot,
      normalized: next.normalized,
      threadId: normalizedThreadId,
    });
    runtime.movePendingReactionToThread(next.bindingKey, resolvedThreadId);
    return true;
  } catch (error) {
    await runtime.clearPendingReactionForBinding(next.bindingKey);
    await runtime.sendInfoCardMessage({
      chatId: next.normalized.chatId,
      replyToMessageId: next.normalized.messageId,
      text: `队列消息处理失败：${error.message || error}`,
    });
    throw error;
  }
}

function buildGuidanceMessage(batch) {
  if (!batch.length) {
    return null;
  }
  if (batch.length === 1) {
    const item = batch[0];
    return {
      ...item,
      normalized: {
        ...item.normalized,
        text: buildGuidanceText([item]),
      },
    };
  }
  const last = batch[batch.length - 1];
  return {
    ...last,
    normalized: {
      ...last.normalized,
      text: buildGuidanceText(batch),
      attachments: batch.flatMap((item) => Array.isArray(item.normalized.attachments)
        ? item.normalized.attachments
        : []),
    },
  };
}

function buildGuidanceText(batch) {
  const lines = [
    "[System note: Jiao sent additional Feishu messages while the previous Codex turn was still running. The bridge interrupted that turn so you can revise the task boundary. Treat the following messages as ordered user updates. Use the latest constraints and answer the revised task, not the stale partial direction.]",
    "",
    "Ordered Feishu updates:",
  ];
  batch.forEach((item, index) => {
    lines.push(`${index + 1}. ${normalizeMessageText(item.normalized.text)}`);
  });
  return lines.join("\n");
}

function clearThreadMessageQueue(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return 0;
  }
  const count = (runtime.messageQueueByThreadId.get(normalizedThreadId) || []).length;
  runtime.messageQueueByThreadId.delete(normalizedThreadId);
  return count;
}

function getThreadMessageQueueSize(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return 0;
  }
  return (runtime.messageQueueByThreadId.get(normalizedThreadId) || []).length;
}

function normalizeMessageText(text) {
  return String(text || "").trim() || "[empty message]";
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  clearThreadMessageQueue,
  drainNextThreadMessage,
  enqueueThreadMessage,
  getThreadMessageQueueSize,
};

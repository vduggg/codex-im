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
  const next = queue.shift();
  if (!next) {
    runtime.messageQueueByThreadId.delete(normalizedThreadId);
    return false;
  }
  if (queue.length) {
    runtime.messageQueueByThreadId.set(normalizedThreadId, queue);
  } else {
    runtime.messageQueueByThreadId.delete(normalizedThreadId);
  }

  await runtime.sendInfoCardMessage({
    chatId: next.normalized.chatId,
    replyToMessageId: next.normalized.messageId,
    text: queue.length
      ? `轮到这条了，我开始处理。后面还排着 ${queue.length} 条。`
      : "轮到这条了，我开始处理。",
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

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  clearThreadMessageQueue,
  drainNextThreadMessage,
  enqueueThreadMessage,
  getThreadMessageQueueSize,
};

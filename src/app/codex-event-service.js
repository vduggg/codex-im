const codexMessageUtils = require("../infra/codex/message-utils");
const { formatFailureText } = require("../shared/error-text");

async function handleStopCommand(runtime, normalized) {
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  const threadId = workspaceRoot ? runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot) : null;
  const turnId = threadId ? runtime.activeTurnIdByThreadId.get(threadId) || null : null;

  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还没有可停止的运行任务。",
    });
    return;
  }

  try {
    await runtime.codex.sendRequest("turn/interrupt", {
      threadId,
      turnId,
    });
    runtime.cleanupThreadRuntimeState(threadId);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "已发送停止请求，并已清理飞书端运行状态。可以继续发新消息。",
    });
  } catch (error) {
    runtime.cleanupThreadRuntimeState(threadId);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `${formatFailureText("停止请求未确认", error)}\n\n我已先清理飞书端运行状态，你可以继续发消息；如果终端侧仍在跑，建议稍后再发一次 /codex stop。`,
    });
  }
}

function handleCodexMessage(runtime, message) {
  if (typeof message?.method === "string") {
    console.log(`[codex-im] codex event ${message.method}`);
  }
  codexMessageUtils.trackAssistantDeltaReceipt(runtime.assistantDeltaSeenByRunKey, message);
  trackLatestTokenUsage(runtime, message);
  trackLatestToolUsage(runtime, message);
  codexMessageUtils.trackRunningTurn(runtime.activeTurnIdByThreadId, message);
  trackRunningTurnStartedAt(runtime, message);
  codexMessageUtils.trackPendingApproval(runtime.pendingApprovalByThreadId, message);
  codexMessageUtils.trackRunKeyState(runtime.currentRunKeyByThreadId, runtime.activeTurnIdByThreadId, message);
  runtime.pruneRuntimeMapSizes();
  const outbound = codexMessageUtils.mapCodexMessageToImEvent(message, {
    suppressCompletedAssistantText: codexMessageUtils.shouldSuppressCompletedAssistantText(
      runtime.assistantDeltaSeenByRunKey,
      message
    ),
  });
  if (!outbound) {
    return;
  }

  const threadId = outbound.payload?.threadId || "";
  if (!outbound.payload.turnId) {
    outbound.payload.turnId = runtime.activeTurnIdByThreadId.get(threadId) || "";
  }
  const context = runtime.pendingChatContextByThreadId.get(threadId);
  if (context) {
    outbound.payload.chatId = context.chatId;
    outbound.payload.threadKey = context.threadKey;
  }

  if (codexMessageUtils.eventShouldClearPendingReaction(outbound)) {
    runtime.clearPendingReactionForThread(threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction: ${error.message}`);
    });
  }

  const shouldCleanupThreadState = isTerminalTurnMessage(message);
  runtime.deliverToFeishu(outbound)
    .catch((error) => {
      console.error(`[codex-im] failed to deliver Feishu message: ${error.message}`);
    })
    .finally(() => {
      if (!shouldCleanupThreadState || !threadId) {
        return;
      }
      runtime.clearPendingReactionForThread(threadId).catch((error) => {
        console.error(`[codex-im] failed to clear pending reaction: ${error.message}`);
      });
      runtime.cleanupThreadRuntimeState(threadId);
    });
}

function trackLatestTokenUsage(runtime, message) {
  if (message?.method !== "thread/tokenUsage/updated") {
    return;
  }
  const params = message?.params || {};
  const threadId = params?.threadId || "";
  const usage = params?.tokenUsage || {};
  if (!threadId || !usage || typeof usage !== "object") {
    return;
  }
  runtime.latestTokenUsageByThreadId.set(threadId, usage);
}

function trackRunningTurnStartedAt(runtime, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = params?.threadId || "";
  if (!threadId) {
    return;
  }
  if (method === "turn/started" || method === "turn/start") {
    runtime.activeTurnStartedAtByThreadId.set(threadId, Date.now());
    return;
  }
  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    runtime.activeTurnStartedAtByThreadId.delete(threadId);
  }
}

function trackLatestToolUsage(runtime, message) {
  const method = String(message?.method || "");
  const params = message?.params || {};
  if (method === "item/started" || method === "item/completed") {
    const item = params?.item || {};
    const itemType = String(item?.type || "");
    if (!isToolLikeItemType(itemType)) {
      return;
    }
    const threadId = String(params?.threadId || "");
    const turnId = String(params?.turnId || "");
    const itemId = String(item?.id || "");
    if (!threadId || !turnId || !itemId) {
      return;
    }
    const prefix = method === "item/started" ? "开始" : "完成";
    recordToolTrace(runtime, {
      threadId,
      turnId,
      itemId,
      summary: summarizeToolItem(itemType, item, prefix),
    });
    return;
  }

  if (isApprovalRequestEventMethod(method)) {
    const threadId = String(params?.threadId || "");
    const turnId = String(params?.turnId || "");
    const itemId = String(params?.itemId || message?.id || "");
    if (!threadId || !turnId || !itemId) {
      return;
    }
    recordToolTrace(runtime, {
      threadId,
      turnId,
      itemId,
      summary: summarizeApprovalRequest(params),
    });
  }
}

function recordToolTrace(runtime, { threadId, turnId, itemId, summary }) {
  const normalizedThreadId = String(threadId || "");
  const normalizedTurnId = String(turnId || "");
  const normalizedItemId = String(itemId || "");
  if (!normalizedThreadId || !normalizedTurnId || !normalizedItemId) {
    return;
  }
  const runKey = `${normalizedThreadId}:${normalizedTurnId}`;
  const current = runtime.toolItemIdsByRunKey.get(runKey) || new Set();
  current.add(normalizedItemId);
  runtime.toolItemIdsByRunKey.set(runKey, current);

  const toolTrace = runtime.toolTraceByRunKey.get(runKey) || [];
  if (summary && !toolTrace.includes(summary)) {
    toolTrace.push(summary);
    runtime.toolTraceByRunKey.set(runKey, toolTrace.slice(-8));
  }
}

function isToolLikeItemType(itemType) {
  return [
    "commandExecution",
    "webSearch",
    "mcpToolCall",
    "localShellCall",
  ].includes(itemType);
}

function summarizeToolItem(itemType, item, prefix = "") {
  const normalizedType = String(itemType || "");
  const label = prefix ? `${prefix}：` : "";
  if (normalizedType === "webSearch") {
    const query = firstNonEmptyString(
      item?.query,
      item?.input?.query,
      item?.arguments?.query,
      item?.payload?.query
    );
    return query ? `${label}网页搜索：${query}` : `${label}网页搜索`;
  }

  if (normalizedType === "commandExecution" || normalizedType === "localShellCall") {
    const command = firstNonEmptyString(
      item?.command,
      item?.input?.command,
      item?.arguments?.command,
      item?.payload?.command,
      item?.cmd,
      item?.input?.cmd,
      item?.shellCommand
    );
    return command ? `${label}命令执行：${truncateInline(command, 80)}` : `${label}命令执行`;
  }

  if (normalizedType === "mcpToolCall") {
    const toolName = firstNonEmptyString(
      item?.toolName,
      item?.name,
      item?.input?.toolName,
      item?.arguments?.toolName,
      item?.payload?.toolName
    );
    return toolName ? `${label}MCP 工具：${toolName}` : `${label}MCP 工具`;
  }

  return `${label}${normalizedType || "工具调用"}`;
}

function summarizeApprovalRequest(params) {
  const reason = firstNonEmptyString(params?.reason);
  const command = firstNonEmptyString(params?.command);
  const commandText = command ? `：${truncateInline(command, 80)}` : "";
  const reasonText = reason ? `（${truncateInline(reason, 40)}）` : "";
  return `等待授权${reasonText}${commandText}`;
}

function isApprovalRequestEventMethod(method) {
  return typeof method === "string" && method.endsWith("requestApproval");
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function truncateInline(text, limit = 80) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }
  if (clean.length <= limit) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

async function deliverToFeishu(runtime, event) {
  if (event.type === "im.agent_reply") {
    await runtime.upsertAssistantReplyCard({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      chatId: event.payload.chatId,
      text: event.payload.text,
      state: "streaming",
      deferFlush: !runtime.config.feishuStreamingOutput,
    });
    return;
  }

  if (event.type === "im.run_state") {
    if (event.payload.state === "streaming") {
      if (!runtime.config.feishuStreamingOutput) {
        return;
      }
      if (runtime.config.feishuCardKitStreaming !== false) {
        return;
      }
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        state: "streaming",
      });
    } else if (event.payload.state === "completed") {
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        state: "completed",
      });
    } else if (event.payload.state === "failed") {
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        text: event.payload.text || "执行失败",
        state: "failed",
      });
    }
    return;
  }

  if (event.type === "im.approval_request") {
    const approval = runtime.pendingApprovalByThreadId.get(event.payload.threadId);
    if (!approval) {
      return;
    }
    await runtime.flushAssistantReplyCardNow({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId || "",
    }).catch((error) => {
      console.error(`[codex-im] failed to flush reply before approval prompt: ${error.message}`);
    });
    const autoApproved = await runtime.tryAutoApproveRequest(event.payload.threadId, approval);
    if (autoApproved) {
      return;
    }
    await runtime.sendApprovalPrompt({
      threadId: event.payload.threadId,
      reason: "request",
    });
  }
}

function isTerminalTurnMessage(message) {
  const method = typeof message?.method === "string" ? message.method : "";
  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    return true;
  }
  if (method !== "error") {
    return false;
  }
  const params = message?.params || {};
  if (params?.willRetry) {
    return false;
  }
  const errorMessage = String(params?.error?.message || "");
  const errorDetails = String(params?.error?.additionalDetails || "");
  return /stream disconnected|Reconnecting/i.test(errorMessage)
    || /stream disconnected/i.test(errorDetails);
}

module.exports = {
  deliverToFeishu,
  handleCodexMessage,
  handleStopCommand,
};

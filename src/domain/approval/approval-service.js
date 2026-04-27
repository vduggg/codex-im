const codexMessageUtils = require("../../infra/codex/message-utils");
const { formatFailureText } = require("../../shared/error-text");

function buildApprovalRequestKey(threadId, requestId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  const normalizedRequestId = requestId == null ? "" : String(requestId).trim();
  if (!normalizedThreadId || !normalizedRequestId) {
    return "";
  }
  return `${normalizedThreadId}:${normalizedRequestId}`;
}

function beginApprovalResolution(runtime, requestKey) {
  if (!requestKey || runtime.inFlightApprovalRequestKeys.has(requestKey)) {
    return false;
  }
  runtime.inFlightApprovalRequestKeys.add(requestKey);
  return true;
}

function endApprovalResolution(runtime, requestKey) {
  if (!requestKey) {
    return;
  }
  runtime.inFlightApprovalRequestKeys.delete(requestKey);
}

async function applyApprovalDecision(runtime, {
  threadId,
  approval,
  command,
  workspaceRoot = "",
  scope = "once",
}) {
  const decision = command === "approve" ? "accept" : "decline";
  const isWorkspaceScope = scope === "workspace";
  const requestKey = buildApprovalRequestKey(threadId, approval.requestId);
  if (!beginApprovalResolution(runtime, requestKey)) {
    return {
      error: null,
      ignoredAsDuplicate: true,
      decision,
      scope: isWorkspaceScope ? "workspace" : "once",
      method: approval.method,
    };
  }

  try {
    if (
      decision === "accept"
      && isWorkspaceScope
      && codexMessageUtils.isCommandApprovalMethod(approval.method)
    ) {
      const resolvedWorkspaceRoot = workspaceRoot || runtime.resolveWorkspaceRootForThread(threadId);
      runtime.rememberApprovalPrefixForWorkspace(resolvedWorkspaceRoot, approval.commandTokens);
    }

    await runtime.codex.sendResponse(
      approval.requestId,
      codexMessageUtils.buildApprovalResponsePayload(decision)
    );
    await markApprovalResolved(runtime, threadId, decision === "accept" ? "approved" : "rejected");
    return {
      error: null,
      ignoredAsDuplicate: false,
      decision,
      scope: isWorkspaceScope ? "workspace" : "once",
      method: approval.method,
    };
  } catch (error) {
    return {
      error,
      ignoredAsDuplicate: false,
      decision,
      scope: isWorkspaceScope ? "workspace" : "once",
      method: approval.method,
    };
  } finally {
    endApprovalResolution(runtime, requestKey);
  }
}

function buildApprovalResultText({ decision, scope, method }) {
  if (decision !== "accept") {
    return "已拒绝本次请求。";
  }
  if (scope === "workspace" && codexMessageUtils.isCommandApprovalMethod(method)) {
    return "已自动允许该命令，后续同工作区下相同前缀命令将自动放行。";
  }
  return "已允许本次请求。";
}

function resolveApprovalPromptContext(runtime, threadId, normalized = null) {
  const existing = runtime.pendingChatContextByThreadId.get(threadId) || null;
  const bindingKey = runtime.bindingKeyByThreadId.get(threadId) || "";
  const bindingContext = bindingKey
    ? runtime.pendingChatContextByBindingKey.get(bindingKey) || null
    : null;

  return {
    chatId: normalized?.chatId || existing?.chatId || bindingContext?.chatId || "",
    replyToMessageId: normalized?.messageId || existing?.messageId || bindingContext?.messageId || "",
    threadKey: normalized?.threadKey || existing?.threadKey || bindingContext?.threadKey || "",
  };
}

async function sendApprovalPrompt(runtime, {
  threadId,
  normalized = null,
  reason = "pending",
} = {}) {
  const approval = threadId ? runtime.pendingApprovalByThreadId.get(threadId) || null : null;
  if (!threadId || !approval) {
    return false;
  }

  const context = resolveApprovalPromptContext(runtime, threadId, normalized);
  if (!context.chatId) {
    console.error(`[codex-im] approval prompt missing chat context thread=${threadId} reason=${reason}`);
    return false;
  }

  approval.chatId = context.chatId;
  approval.replyToMessageId = context.replyToMessageId || approval.replyToMessageId || "";
  if (normalized) {
    runtime.setPendingThreadContext(threadId, normalized);
  }

  try {
    const response = await runtime.sendInteractiveApprovalCard({
      chatId: approval.chatId,
      approval,
      replyToMessageId: approval.replyToMessageId || "",
    });
    const messageId = codexMessageUtils.extractCreatedMessageId(response);
    if (messageId) {
      approval.cardMessageId = messageId;
    }
    return true;
  } catch (error) {
    console.error(`[codex-im] failed to send approval prompt: ${error.message}`);
    await runtime.sendInfoCardMessage({
      chatId: context.chatId,
      replyToMessageId: context.replyToMessageId || "",
      text: "当前 Codex 正在等待授权。审批卡发送失败时，可以先发 `/codex approve` 允许本次请求，或发 `/codex reject` 拒绝。",
      kind: "info",
    }).catch((fallbackError) => {
      console.error(`[codex-im] failed to send approval fallback: ${fallbackError.message}`);
    });
    return false;
  }
}

async function handleApprovalCommand(runtime, normalized) {
  const { workspaceRoot, threadId } = runtime.getCurrentThreadContext(normalized);
  const approval = threadId ? runtime.pendingApprovalByThreadId.get(threadId) || null : null;

  if (!threadId || !approval) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前没有待处理的授权请求。",
    });
    return;
  }

  try {
    const outcome = await applyApprovalDecision(runtime, {
      threadId,
      approval,
      command: normalized.command,
      workspaceRoot,
      scope: codexMessageUtils.isWorkspaceApprovalCommand(normalized.text) ? "workspace" : "once",
    });
    if (outcome.error) {
      throw outcome.error;
    }
    if (outcome.ignoredAsDuplicate) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "该授权请求正在处理中，请稍后。",
        kind: "info",
      });
      return;
    }

    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildApprovalResultText(outcome),
      kind: outcome.decision === "accept" ? "success" : "info",
    });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("处理授权失败", error),
    });
  }
}

async function markApprovalResolved(runtime, threadId, resolution) {
  const approval = runtime.pendingApprovalByThreadId.get(threadId);
  if (!approval) {
    return;
  }

  approval.resolution = resolution;
  runtime.pendingApprovalByThreadId.delete(threadId);

  if (approval.cardMessageId) {
    try {
      await runtime.updateInteractiveCard({
        messageId: approval.cardMessageId,
        approval,
      });
    } catch (error) {
      console.error(`[codex-im] failed to update approval card: ${error.message}`);
    }
  }
}

async function handleApprovalCardActionAsync(runtime, action, data) {
  const approval = runtime.pendingApprovalByThreadId.get(action.threadId);
  if (!approval || String(approval.requestId) !== String(action.requestId)) {
    await runtime.sendCardActionFeedback(data, "该授权请求已失效。", "error");
    return;
  }

  try {
    const outcome = await applyApprovalDecision(runtime, {
      threadId: action.threadId,
      approval,
      command: action.decision,
      workspaceRoot: runtime.resolveWorkspaceRootForThread(action.threadId),
      scope: action.scope === "workspace" ? "workspace" : "once",
    });
    if (outcome.error) {
      throw outcome.error;
    }
    if (outcome.ignoredAsDuplicate) {
      await runtime.sendCardActionFeedback(data, "该授权请求正在处理中，请稍后。", "info");
      return;
    }
  } catch (error) {
    await runtime.sendCardActionFeedback(data, formatFailureText("处理失败", error), "error");
  }
}

module.exports = {
  applyApprovalDecision,
  handleApprovalCommand,
  handleApprovalCardActionAsync,
  sendApprovalPrompt,
};

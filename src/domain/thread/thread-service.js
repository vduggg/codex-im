const { filterThreadsByWorkspaceRoot } = require("../../shared/workspace-paths");
const { extractSwitchThreadId } = require("../../shared/command-parsing");
const codexMessageUtils = require("../../infra/codex/message-utils");
const planRuntime = require("../plan/plan-service");

const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

async function resolveWorkspaceThreadState(runtime, {
  bindingKey,
  workspaceRoot,
  normalized,
  autoSelectThread = true,
}) {
  const threads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const activeProviderKey = typeof binding.activeProviderKey === "string" ? binding.activeProviderKey.trim() : "";
  const currentProviderKey = runtime.getCodexProviderKey();
  const providerChanged = activeProviderKey && currentProviderKey && activeProviderKey !== currentProviderKey;
  const shouldAutoSelectThread = autoSelectThread && binding.threadScopedBinding !== true && !providerChanged;
  const threadId = selectedThreadId || (shouldAutoSelectThread ? (threads[0]?.id || "") : "");
  if (!selectedThreadId && threadId) {
    runtime.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      buildThreadBindingExtra(runtime, normalized)
    );
  }
  if (threadId) {
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
  }
  return { threads, threadId, selectedThreadId };
}

async function ensureThreadAndSendMessage(runtime, { bindingKey, workspaceRoot, normalized, threadId }) {
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);

  if (!threadId) {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await recordInboundSignalSafely({ runtime, normalized, workspaceRoot, threadId: createdThreadId });
    const textWithMemory = await buildMessageWithMemoryPreflightSafely({
      runtime,
      text: normalized.text,
      bindingKey,
      workspaceRoot,
      threadId: createdThreadId,
    });
    console.log(`[codex-im] turn/start first message thread=${createdThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: createdThreadId,
      text: textWithMemory,
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    runtime.setThreadBindingKey(createdThreadId, bindingKey);
    runtime.setThreadWorkspaceRoot(createdThreadId, workspaceRoot);
    return createdThreadId;
  }

  try {
    await ensureThreadResumed(runtime, threadId);
    await recordInboundSignalSafely({ runtime, normalized, workspaceRoot, threadId });
    const textWithMemory = await buildMessageWithMemoryPreflightSafely({
      runtime,
      text: normalized.text,
      bindingKey,
      workspaceRoot,
      threadId,
    });
    await runtime.codex.sendUserMessage({
      threadId,
      text: textWithMemory,
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    console.log(`[codex-im] turn/start ok workspace=${workspaceRoot} thread=${threadId}`);
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
    return threadId;
  } catch (error) {
    if (!shouldRecreateThread(error)) {
      throw error;
    }

    console.warn(`[codex-im] stale thread detected, recreating workspace thread: ${threadId}`);
    runtime.resumedThreadIds.delete(threadId);
    runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot, runtime.getCodexProviderKey());
    const recreatedThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await recordInboundSignalSafely({ runtime, normalized, workspaceRoot, threadId: recreatedThreadId });
    const textWithMemory = await buildMessageWithMemoryPreflightSafely({
      runtime,
      text: normalized.text,
      bindingKey,
      workspaceRoot,
      threadId: recreatedThreadId,
    });
    console.log(`[codex-im] turn/start retry thread=${recreatedThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: recreatedThreadId,
      text: textWithMemory,
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    runtime.setThreadBindingKey(recreatedThreadId, bindingKey);
    runtime.setThreadWorkspaceRoot(recreatedThreadId, workspaceRoot);
    return recreatedThreadId;
  }
}

async function recordInboundSignalSafely(args) {
  try {
    await args.runtime?.extensions?.memoryBridge?.recordInboundSignal(args);
  } catch (error) {
    console.warn(`[codex-im] memory signal write skipped: ${error.message}`);
  }
}

async function buildMessageWithMemoryPreflightSafely(args) {
  const textWithCapabilities = planRuntime.buildMessageWithPlanMode(args.runtime, {
    bindingKey: args.bindingKey,
    workspaceRoot: args.workspaceRoot,
    text: buildMessageWithBridgeCapabilities(args.text),
  });
  try {
    const buildMessage = args.runtime?.extensions?.memoryBridge?.buildMessageWithMemoryPreflight;
    const textWithMemory = typeof buildMessage === "function"
      ? await buildMessage({ ...args, text: textWithCapabilities })
      : textWithCapabilities;
    recordMemoryPreflightTrace(args.runtime, {
      threadId: args.threadId,
      textWithCapabilities,
      textWithMemory,
    });
    return textWithMemory;
  } catch (error) {
    console.warn(`[codex-im] memory preflight skipped: ${error.message}`);
    return textWithCapabilities;
  }
}

function recordMemoryPreflightTrace(runtime, { threadId, textWithCapabilities, textWithMemory } = {}) {
  if (!runtime?.memoryPreflightByThreadId || !threadId) {
    return;
  }
  if (String(textWithMemory || "") === String(textWithCapabilities || "")) {
    runtime.memoryPreflightByThreadId.delete(threadId);
    return;
  }
  runtime.memoryPreflightByThreadId.set(
    threadId,
    "已挂载共同记忆上下文：Codex Memory Compiler、当天每日桥接、最近 TaskNotes 和 Obsidian Recall。"
  );
}

function buildMessageWithBridgeCapabilities(text) {
  return [
    "<feishu-bridge-capabilities>",
    "[System note: This Feishu bridge can send current-workspace attachments back to Feishu. If Jiao asks you to send a local image, file, or audio, create or locate the file under the bound workspace, then include a hidden directive on its own line: [[yuan-feishu-send:relative/path/from/workspace]]. The bridge will upload it. Supported routing: images as Feishu image messages, .opus/.mp4 as audio, other files as file messages. Do not use absolute paths in the directive; keep a short human explanation separately.]",
    "[System note: Replies are shown in Feishu CardKit. Prefer scan-friendly Markdown: short paragraphs, bold section labels, ordered/bulleted lists, Markdown tables for comparisons, fenced code blocks for commands/snippets, and horizontal rules between major sections. Avoid one dense paragraph.]",
    "</feishu-bridge-capabilities>",
    "",
    text,
  ].join("\n");
}

async function createWorkspaceThread(runtime, { bindingKey, workspaceRoot, normalized }) {
  const response = await runtime.codex.startThread({
    cwd: workspaceRoot,
  });
  console.log(`[codex-im] thread/start ok workspace=${workspaceRoot}`);

  const resolvedThreadId = codexMessageUtils.extractThreadId(response);
  if (!resolvedThreadId) {
    throw new Error("thread/start did not return a thread id");
  }

  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    workspaceRoot,
    resolvedThreadId,
    buildThreadBindingExtra(runtime, normalized)
  );
  runtime.resumedThreadIds.add(resolvedThreadId);
  runtime.setPendingThreadContext(resolvedThreadId, normalized);
  runtime.setThreadBindingKey(resolvedThreadId, bindingKey);
  runtime.setThreadWorkspaceRoot(resolvedThreadId, workspaceRoot);
  return resolvedThreadId;
}

async function ensureThreadResumed(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || runtime.resumedThreadIds.has(normalizedThreadId)) {
    return null;
  }

  const response = await runtime.codex.resumeThread({ threadId: normalizedThreadId });
  runtime.resumedThreadIds.add(normalizedThreadId);
  console.log(`[codex-im] thread/resume ok thread=${normalizedThreadId}`);
  return response;
}

async function handleNewCommand(runtime, normalized) {
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  try {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `已创建新线程并切换到它:\n${workspaceRoot}\n\nthread: ${createdThreadId}`,
    });
    await runtime.showStatusPanel(normalized, { replyToMessageId: normalized.messageId });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `创建新线程失败: ${error.message}`,
    });
  }
}

async function handleSwitchCommand(runtime, normalized) {
  const threadId = extractSwitchThreadId(normalized.text);
  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex switch <threadId>`",
    });
    return;
  }

  await switchThreadById(runtime, normalized, threadId, { replyToMessageId: normalized.messageId });
}

async function refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized) {
  try {
    const threads = await listCodexThreadsForWorkspace(runtime, workspaceRoot);
    const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    const shouldKeepCurrentThread = currentThreadId && runtime.resumedThreadIds.has(currentThreadId);
    if (currentThreadId && !shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)) {
      runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot, runtime.getCodexProviderKey());
    }
    return threads;
  } catch (error) {
    console.warn(`[codex-im] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
    return [];
  }
}

async function listCodexThreadsForWorkspace(runtime, workspaceRoot) {
  const allThreads = await listCodexThreadsPaginated(runtime);
  const sourceFiltered = allThreads.filter((thread) => isSupportedThreadSourceKind(thread?.sourceKind));
  return filterThreadsByWorkspaceRoot(sourceFiltered, workspaceRoot);
}

async function listCodexThreadsPaginated(runtime) {
  const allThreads = [];
  const seenThreadIds = new Set();
  let cursor = null;

  for (let page = 0; page < 10; page += 1) {
    const response = await runtime.codex.listThreads({
      cursor,
      limit: 200,
      sortKey: "updated_at",
    });
    const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
    for (const thread of pageThreads) {
      if (seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      allThreads.push(thread);
    }

    const nextCursor = codexMessageUtils.extractThreadListCursor(response);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
    if (pageThreads.length === 0) {
      break;
    }
  }

  return allThreads;
}

function describeWorkspaceStatus(runtime, threadId) {
  if (!threadId) {
    return { code: "idle", label: "空闲" };
  }
  if (runtime.pendingApprovalByThreadId.has(threadId)) {
    return { code: "approval", label: "等待授权" };
  }
  if (runtime.activeTurnIdByThreadId.has(threadId)) {
    return { code: "running", label: "运行中" };
  }
  return { code: "idle", label: "空闲" };
}

async function switchThreadById(runtime, normalized, threadId, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  if (currentThreadId && currentThreadId === threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "已经是当前线程，无需切换。",
    });
    return;
  }

  const availableThreads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThread = availableThreads.find((thread) => thread.id === threadId) || null;
  if (!selectedThread) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "指定线程当前不可用，请刷新后重试。",
    });
    return;
  }

  const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    resolvedWorkspaceRoot,
    threadId,
    buildThreadBindingExtra(runtime, normalized)
  );
  runtime.setThreadBindingKey(threadId, bindingKey);
  runtime.setThreadWorkspaceRoot(threadId, resolvedWorkspaceRoot);
  runtime.resumedThreadIds.delete(threadId);
  await ensureThreadResumed(runtime, threadId);
  await runtime.showStatusPanel(normalized, { replyToMessageId: replyTarget });
}

function isSupportedThreadSourceKind(sourceKind) {
  const normalized = typeof sourceKind === "string" && sourceKind.trim() ? sourceKind.trim() : "unknown";
  return THREAD_SOURCE_KINDS.has(normalized);
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

function buildThreadBindingExtra(runtime, normalized) {
  const providerState = typeof runtime.getCodexProviderState === "function"
    ? runtime.getCodexProviderState()
    : null;
  return {
    ...codexMessageUtils.buildBindingMetadata(normalized),
    providerKey: providerState?.key || "",
    providerLabel: providerState?.label || "",
  };
}

module.exports = {
  createWorkspaceThread,
  describeWorkspaceStatus,
  ensureThreadAndSendMessage,
  ensureThreadResumed,
  handleNewCommand,
  handleSwitchCommand,
  refreshWorkspaceThreads,
  resolveWorkspaceThreadState,
  switchThreadById,
};

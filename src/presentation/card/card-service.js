const codexMessageUtils = require("../../infra/codex/message-utils");
const messageNormalizers = require("../message/normalizers");
const reactionRepo = require("../../infra/feishu/reaction-repo");
const {
  buildCardKitAssistantElements,
  formatCardKitAssistantMarkdown,
  sanitizeAssistantMarkdown,
  splitAssistantReplyForDisplay,
} = require("../../shared/assistant-markdown");
const { formatFailureText } = require("../../shared/error-text");
const {
  buildApprovalCard,
  buildApprovalResolvedCard,
  buildAssistantReplyCard,
  buildCardResponse,
  buildInfoCard,
  mergeReplyText,
} = require("./builders");

const CARDKIT_STREAMING_ELEMENT_ID = "streaming_content";

async function sendInfoCardMessage(runtime, { chatId, text, replyToMessageId = "", replyInThread = false, kind = "info" }) {
  if (!chatId || !text) {
    return null;
  }

  return sendInteractiveCard(runtime, {
    chatId,
    replyToMessageId,
    replyInThread,
    card: buildInfoCard(text, { kind }),
  });
}

async function sendFeedbackByContext(runtime, normalized, { text, kind = "info", replyToMessageId = "" } = {}) {
  if (!normalized?.chatId || !text) {
    return null;
  }
  return sendInfoCardMessage(runtime, {
    chatId: normalized.chatId,
    replyToMessageId: replyToMessageId || normalized.messageId || "",
    text,
    kind,
  });
}

async function sendInteractiveApprovalCard(runtime, { chatId, approval, replyToMessageId = "", replyInThread = false }) {
  if (!chatId || !approval) {
    return null;
  }

  return sendInteractiveCard(runtime, {
    chatId,
    replyToMessageId,
    replyInThread,
    card: buildApprovalCard(approval),
  });
}

async function updateInteractiveCard(runtime, { messageId, approval }) {
  if (!messageId || !approval) {
    return null;
  }
  return patchInteractiveCard(runtime, {
    messageId,
    card: buildApprovalResolvedCard(approval),
  });
}

async function sendInteractiveCard(runtime, { chatId, card, replyToMessageId = "", replyInThread = false }) {
  if (!chatId || !card) {
    return null;
  }
  return runtime.requireFeishuAdapter().sendInteractiveCard({
    chatId,
    card,
    replyToMessageId,
    replyInThread,
  });
}

async function patchInteractiveCard(runtime, { messageId, card }) {
  if (!messageId || !card) {
    return null;
  }
  return runtime.requireFeishuAdapter().patchInteractiveCard({ messageId, card });
}

async function handleCardAction(runtime, data) {
  const action = messageNormalizers.extractCardAction(data);
  console.log(
    `[codex-im] card callback kind=${action?.kind || "-"} action=${action?.action || "-"} `
    + `thread=${action?.threadId || "-"} request=${action?.requestId || "-"} selected=${action?.selectedValue || "-"}`
  );
  if (!action) {
    runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "无法识别卡片操作。", "error"));
    return buildCardResponse({});
  }

  if (action.kind === "approval") {
    runCardActionTask(runtime, runtime.handleApprovalCardActionAsync(action, data));
    return buildCardResponse({});
  }

  const normalized = messageNormalizers.normalizeCardActionContext(data, runtime.config);
  if (!normalized) {
    runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "无法解析当前卡片上下文。", "error"));
    return buildCardResponse({});
  }

  try {
    const handled = runtime.dispatchCardAction(action, normalized);
    if (handled) {
      return handled;
    }
  } catch (error) {
    runCardActionTask(
      runtime,
      sendCardActionFeedbackByContext(runtime, normalized, formatFailureText("处理失败", error), "error")
    );
    return buildCardResponse({});
  }

  runCardActionTask(runtime, sendCardActionFeedbackByContext(runtime, normalized, "未支持的卡片操作。", "error"));
  return buildCardResponse({});
}

function queueCardActionWithFeedback(runtime, normalized, feedbackText, task) {
  runCardActionTask(runtime, (async () => {
    await sendCardActionFeedbackByContext(runtime, normalized, feedbackText, "progress");
    try {
      await task();
    } catch (error) {
      console.error(`[codex-im] async card action failed: ${error.message}`);
      await sendCardActionFeedbackByContext(
        runtime,
        normalized,
        formatCardActionFailureText(error),
        "error"
      );
    }
  })());
  return buildCardResponse({});
}

function formatCardActionFailureText(error) {
  if (isMacFilePermissionError(error)) {
    const nodePath = process.execPath || "/opt/homebrew/bin/node";
    return [
      "需要 macOS 完整磁盘访问权限。",
      "",
      "Feishu 桥想读取 Jiao Knowledge Wiki，但被系统拦住了：",
      `\`${error.message}\``,
      "",
      "请在“系统设置 -> 隐私与安全性 -> 完整磁盘访问权限”里允许：",
      "- `/opt/homebrew/bin/node`",
      `- \`${nodePath}\``,
      "",
      "授权后在 Mac 上重启 Feishu 桥：",
      "`launchctl kickstart -k gui/$(id -u)/com.yuan.feishu-bridge`",
    ].join("\n");
  }
  return formatFailureText("处理失败", error);
}

function isMacFilePermissionError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return (
    code === "EPERM"
    || code === "EACCES"
    || /operation not permitted/i.test(message)
  );
}

function runCardActionTask(runtime, taskPromise) {
  Promise.resolve(taskPromise).catch((error) => {
    console.error(`[codex-im] async card action failed: ${error.message}`);
  });
}

async function sendCardActionFeedbackByContext(runtime, normalized, text, kind = "info") {
  await sendFeedbackByContext(runtime, normalized, { text, kind });
}

async function sendCardActionFeedback(runtime, data, text, kind = "info") {
  const normalized = messageNormalizers.normalizeCardActionContext(data, runtime.config);
  if (!normalized) {
    return;
  }
  await sendCardActionFeedbackByContext(runtime, normalized, text, kind);
}

async function upsertAssistantReplyCard(
  runtime,
  { threadId, turnId, chatId, text, statusText, state, mode = "delta", deferFlush = false }
) {
  if (!threadId || !chatId) {
    return;
  }

  const resolvedTurnId = turnId
    || runtime.activeTurnIdByThreadId.get(threadId)
    || codexMessageUtils.extractTurnIdFromRunKey(runtime.currentRunKeyByThreadId.get(threadId) || "")
    || "";
  const preferredRunKey = codexMessageUtils.buildRunKey(threadId, resolvedTurnId);
  let runKey = preferredRunKey;
  let existing = runtime.replyCardByRunKey.get(runKey) || null;

  if (!existing) {
    const currentRunKey = runtime.currentRunKeyByThreadId.get(threadId) || "";
    const currentEntry = runtime.replyCardByRunKey.get(currentRunKey) || null;
    const shouldReuseCurrent = !!(
      currentEntry
      && currentEntry.state !== "completed"
      && currentEntry.state !== "failed"
      && (!resolvedTurnId || !currentEntry.turnId || currentEntry.turnId === resolvedTurnId)
    );
    if (shouldReuseCurrent) {
      runKey = currentRunKey;
      existing = currentEntry;
    }
  }

  if (!existing) {
    existing = {
      messageId: "",
      chatId,
      replyToMessageId: "",
      text: "",
      answerText: "",
      processText: "",
      streamPhase: "process",
      state: "streaming",
      threadId,
      turnId: resolvedTurnId,
      startedAt: Date.now(),
      cardKitCardId: "",
      cardKitSequence: 0,
      cardKitLastStreamedText: "",
      cardKitLastStatusSignature: "",
      statusText: "",
      fallbackUsed: false,
    };
  }

  if (typeof text === "string" && text.length > 0) {
    applyAssistantReplyText(existing, text, mode);
  }
  if (typeof statusText === "string") {
    existing.statusText = statusText.trim();
  }
  existing.chatId = chatId;
  existing.replyToMessageId = runtime.pendingChatContextByThreadId.get(threadId)?.messageId || existing.replyToMessageId || "";
  if (state) {
    const currentState = String(existing.state || "");
    const nextState = String(state || "");
    const currentIsTerminal = currentState === "completed" || currentState === "failed";
    const nextIsTerminal = nextState === "completed" || nextState === "failed";
    if (!(currentIsTerminal && !nextIsTerminal)) {
      existing.state = nextState;
    }
  }
  if (existing.state === "completed" || existing.state === "failed") {
    existing.statusText = "";
  }
  if (resolvedTurnId) {
    existing.turnId = resolvedTurnId;
  }

  runtime.setReplyCardEntry(runKey, existing);
  runtime.setCurrentRunKeyForThread(threadId, runKey);

  if (deferFlush && existing.state !== "completed" && existing.state !== "failed") {
    return;
  }

  const shouldFlushImmediately = existing.state === "completed"
    || existing.state === "failed"
    || existing.state === "retrying"
    || (!existing.messageId && hasVisibleReplyCardContent(existing));
  await scheduleReplyCardFlush(runtime, runKey, { immediate: shouldFlushImmediately });
}

function hasVisibleReplyCardContent(entry) {
  return Boolean(
    String(entry?.text || "").trim()
    || String(entry?.answerText || "").trim()
    || String(entry?.processText || "").trim()
  );
}

function applyAssistantReplyText(entry, text, mode = "delta") {
  const incoming = typeof text === "string" ? text : "";
  if (!incoming) {
    return;
  }
  if (mode === "completed_snapshot") {
    applyCompletedAssistantSnapshot(entry, incoming);
    return;
  }
  applyStreamingAssistantDelta(entry, incoming);
}

function applyStreamingAssistantDelta(entry, incoming) {
  if (entry.streamPhase === "answer") {
    entry.answerText = mergeReplyText(entry.answerText || "", incoming);
    entry.text = entry.answerText;
    return;
  }

  const existingProcess = String(entry.processText || "").trim();
  if (!existingProcess && looksLikeFinalAnswerStart(incoming)) {
    entry.streamPhase = "answer";
    entry.answerText = mergeReplyText(entry.answerText || "", incoming);
    entry.text = entry.answerText;
    return;
  }

  const combinedProcess = mergeReplyText(existingProcess, incoming);
  const split = splitAssistantReplyForDisplay(combinedProcess);
  if (split.preAnswerText && split.answerText) {
    entry.streamPhase = "answer";
    entry.processText = mergeProcessText(entry.processText, split.preAnswerText);
    entry.answerText = mergeReplyText(entry.answerText || "", split.answerText);
    entry.text = entry.answerText;
    return;
  }

  entry.streamPhase = "process";
  entry.processText = combinedProcess;
  entry.text = entry.answerText || "";
}

function applyCompletedAssistantSnapshot(entry, text) {
  const completedText = sanitizeAssistantMarkdown(text, { preserveHeadings: true });
  if (!completedText) {
    return;
  }

  const accumulated = sanitizeAssistantMarkdown(entry.answerText || entry.text || "", { preserveHeadings: true });
  const processPrefix = extractProcessPrefixFromCompletedSnapshot(accumulated, completedText);
  if (processPrefix) {
    entry.processText = mergeProcessText(entry.processText, processPrefix);
  }

  entry.answerText = completedText;
  entry.text = completedText;
  entry.streamPhase = "answer";
}

function looksLikeFinalAnswerStart(text) {
  const clean = String(text || "").replace(/^\s+/, "");
  return /^(?:Jiao[，,]\s*(?:弄好了|好了|搞定了|处理好了|刚才|确实|文档|我把|我已|我已经|这次|现在)|(?:可以实现|能实现|答案是|结论是|我的判断是|先说结论)[，,。；;\s])/i.test(clean);
}

function extractProcessPrefixFromCompletedSnapshot(accumulated, completedText) {
  const normalizedAccumulated = String(accumulated || "").trim();
  const normalizedCompleted = String(completedText || "").trim();
  if (!normalizedAccumulated || !normalizedCompleted || normalizedAccumulated === normalizedCompleted) {
    return "";
  }
  if (normalizedAccumulated.endsWith(normalizedCompleted)) {
    return normalizedAccumulated.slice(0, normalizedAccumulated.length - normalizedCompleted.length).trim();
  }
  const markerIndex = normalizedAccumulated.lastIndexOf(normalizedCompleted);
  if (markerIndex > 0) {
    return normalizedAccumulated.slice(0, markerIndex).trim();
  }
  if (
    normalizedCompleted.startsWith(normalizedAccumulated)
    || normalizedCompleted.includes(normalizedAccumulated)
  ) {
    return "";
  }
  return normalizedAccumulated;
}

function mergeProcessText(current, incoming) {
  const left = String(current || "").trim();
  const right = String(incoming || "").trim();
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  if (left.includes(right)) {
    return left;
  }
  if (right.includes(left)) {
    return right;
  }
  return `${left}\n\n${right}`.trim();
}

async function scheduleReplyCardFlush(runtime, runKey, { immediate = false } = {}) {
  const entry = runtime.replyCardByRunKey.get(runKey);
  if (!entry) {
    return;
  }

  if (immediate) {
    clearReplyFlushTimer(runtime, runKey);
    await enqueueReplyCardFlush(runtime, runKey);
    return;
  }

  if (runtime.replyFlushTimersByRunKey.has(runKey)) {
    return;
  }

  const timer = setTimeout(() => {
    runtime.replyFlushTimersByRunKey.delete(runKey);
    enqueueReplyCardFlush(runtime, runKey).catch((error) => {
      console.error(`[codex-im] failed to flush reply card: ${error.message}`);
    });
  }, 300);
  runtime.replyFlushTimersByRunKey.set(runKey, timer);
}

function clearReplyFlushTimer(runtime, runKey) {
  const timer = runtime.replyFlushTimersByRunKey.get(runKey);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  runtime.replyFlushTimersByRunKey.delete(runKey);
}

async function flushReplyCard(runtime, runKey) {
  const entry = runtime.replyCardByRunKey.get(runKey);
  if (!entry) {
    return;
  }

  if (shouldUseCardKitReply(runtime, entry)) {
    try {
      await flushCardKitReplyCard(runtime, runKey, entry);
      return;
    } catch (error) {
      console.error(`[codex-im] CardKit reply failed, falling back to legacy card: ${error.message}`);
      entry.fallbackUsed = true;
      runtime.setReplyCardEntry(runKey, entry);
    }
  }

  await flushLegacyReplyCard(runtime, runKey, entry);
}

function shouldUseCardKitReply(runtime, entry) {
  return Boolean(
    runtime.config.feishuCardKitStreaming !== false
    && entry
    && !entry.fallbackUsed
  );
}

async function flushCardKitReplyCard(runtime, runKey, entry) {
  const adapter = runtime.requireFeishuAdapter();
  if (!entry.cardKitCardId) {
    const initialContent = buildCardKitStreamingContent(entry);
    const initialStatusSignature = buildCardKitStatusSignature(runtime, runKey, entry);
    const cardId = await adapter.createCardEntity({
      card: buildCardKitStreamingCard(runtime, runKey, entry, { content: initialContent }),
    });
    entry.cardKitCardId = cardId;
    entry.cardKitSequence = 0;
    entry.cardKitLastStreamedText = initialContent;
    entry.cardKitLastStatusSignature = initialStatusSignature;

    const response = await adapter.sendCardByCardId({
      chatId: entry.chatId,
      cardId,
      replyToMessageId: entry.replyToMessageId,
    });
    entry.messageId = codexMessageUtils.extractCreatedMessageId(response);
    if (!entry.messageId) {
      throw new Error("Feishu CardKit send did not return message_id");
    }
    runtime.setReplyCardEntry(runKey, entry);
    runtime.clearPendingReactionForThread(entry.threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction after CardKit card: ${error.message}`);
    });
  }

  if (entry.state === "completed" || entry.state === "failed") {
    await finalizeCardKitReply(runtime, entry);
    runtime.disposeReplyRunState(runKey, entry.threadId);
    return;
  }

  const content = buildCardKitStreamingContent(entry);
  const statusSignature = buildCardKitStatusSignature(runtime, runKey, entry);
  if (statusSignature !== entry.cardKitLastStatusSignature) {
    entry.cardKitSequence += 1;
    await adapter.updateCardKitCard({
      cardId: entry.cardKitCardId,
      card: buildCardKitStreamingCard(runtime, runKey, entry, { content }),
      sequence: entry.cardKitSequence,
    });
    entry.cardKitLastStreamedText = content;
    entry.cardKitLastStatusSignature = statusSignature;
    runtime.setReplyCardEntry(runKey, entry);
    return;
  }

  if (content === entry.cardKitLastStreamedText) {
    return;
  }
  entry.cardKitSequence += 1;
  await adapter.streamCardContent({
    cardId: entry.cardKitCardId,
    elementId: CARDKIT_STREAMING_ELEMENT_ID,
    content,
    sequence: entry.cardKitSequence,
  });
  entry.cardKitLastStreamedText = content;
  runtime.setReplyCardEntry(runKey, entry);
}

async function finalizeCardKitReply(runtime, entry) {
  const adapter = runtime.requireFeishuAdapter();
  const card = buildCardKitFinalCard(runtime, entry);

  entry.cardKitSequence += 1;
  await adapter.setCardStreamingMode({
    cardId: entry.cardKitCardId,
    streamingMode: false,
    sequence: entry.cardKitSequence,
  });

  entry.cardKitSequence += 1;
  await adapter.updateCardKitCard({
    cardId: entry.cardKitCardId,
    card,
    sequence: entry.cardKitSequence,
  });
}

function buildCardKitStreamingCard(runtime, runKey, entry, options = {}) {
  const content = typeof options.content === "string" ? options.content : buildCardKitStreamingContent(entry);
  const elements = [
    ...buildCardKitStatusPanels(runtime, runKey, entry),
    {
      tag: "markdown",
      content,
      text_align: "left",
      text_size: "normal_v2",
      margin: "0px 0px 0px 0px",
      element_id: CARDKIT_STREAMING_ELEMENT_ID,
    },
  ];

  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: buildCardKitSummary(content, entry.state),
      },
    },
    body: {
      elements,
    },
  };
}

function buildCardKitFinalCard(runtime, entry) {
  const runKey = codexMessageUtils.buildRunKey(entry.threadId, entry.turnId);
  const display = buildAssistantDisplayContent(entry);
  const content = display.answer;
  const footer = buildCardKitFooter(runtime, entry);
  const elements = [
    ...buildCardKitStatusPanels(runtime, runKey, entry),
    ...buildCardKitAssistantElements(content, { elementId: CARDKIT_STREAMING_ELEMENT_ID }),
  ];

  if (footer) {
    elements.push({
      tag: "markdown",
      content: footer,
      text_size: "notation",
    });
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      wide_screen_mode: true,
      update_multi: true,
      summary: {
        content: buildCardKitSummary(content, entry.state),
      },
    },
    body: { elements },
  };
}

function buildCardKitStatusPanels(runtime, runKey, entry) {
  const toolTrace = runtime.toolTraceByRunKey.get(runKey);
  const elapsed = formatReplyElapsed(entry.startedAt);
  const tokenUsage = runtime.latestTokenUsageByThreadId.get(entry.threadId);
  const display = buildAssistantDisplayContent(entry);
  return [
    buildCardKitCollapsiblePanel({
      title: buildProcessPanelTitle({
        state: entry.state,
        elapsed,
      }),
      expanded: entry.state !== "completed" && entry.state !== "failed",
      content: formatProcessTimelineText({
        state: entry.state,
        elapsed,
        toolTrace,
        tokenUsage,
        statusText: entry.statusText,
        assistantNotes: display.notes,
        memoryTrace: runtime.memoryPreflightByThreadId?.get(entry.threadId),
      }),
    }),
  ];
}

function buildCardKitCollapsiblePanel({ title, content, expanded = false }) {
  return {
    tag: "collapsible_panel",
    expanded: expanded === true,
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px",
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    padding: "8px 8px 8px 8px",
    elements: [
      {
        tag: "markdown",
        content,
        text_size: "notation",
      },
    ],
  };
}

function buildProcessPanelTitle({ state, elapsed = "" } = {}) {
  const timeText = elapsed || "刚刚";
  if (state === "retrying") {
    return `重连中 · 已处理 ${timeText}`;
  }
  if (state === "failed") {
    return `处理失败 · 已处理 ${timeText}`;
  }
  return `已处理 ${timeText}`;
}

function buildCardKitStreamingContent(entry) {
  return buildAssistantDisplayContent(entry).answer;
}

function buildCardKitStatusSignature(runtime, runKey, entry) {
  const toolItems = runtime.toolItemIdsByRunKey.get(runKey);
  const toolTrace = runtime.toolTraceByRunKey.get(runKey);
  const tokenUsage = runtime.latestTokenUsageByThreadId.get(entry.threadId);
  const display = buildAssistantDisplayContent(entry);
  return JSON.stringify({
    state: entry.state,
    statusText: entry.statusText || "",
    toolCount: toolItems instanceof Set ? toolItems.size : 0,
    toolTrace: Array.isArray(toolTrace) ? toolTrace.filter(Boolean) : [],
    reasoning: Number(tokenUsage?.last?.reasoningOutputTokens || 0),
    notes: display.notes,
    memory: runtime.memoryPreflightByThreadId?.get(entry.threadId) || "",
  });
}

function resolveAssistantReplyContent(entry) {
  const answerText = typeof entry.answerText === "string" ? entry.answerText.trim() : "";
  if (answerText) {
    return answerText;
  }
  const text = typeof entry.text === "string" ? entry.text.trim() : "";
  if (text) {
    return text;
  }
  if (entry.state === "failed") {
    return "这次没有顺利完成。";
  }
  if (entry.state === "completed") {
    return "我已经处理好了。";
  }
  if (entry.state === "retrying") {
    return entry.statusText || "模型通道正在重连。";
  }
  return "我正在认真处理这轮内容，结果会在这里流式出来。";
}

function buildAssistantDisplayContent(entry) {
  const raw = resolveAssistantReplyContent(entry);
  const explicitProcessText = typeof entry.processText === "string" ? entry.processText.trim() : "";
  if (entry.state !== "completed") {
    return {
      answer: raw ? formatCardKitAssistantMarkdown(raw) : "正在处理，正式回复会在结束后显示。",
      notes: explicitProcessText ? formatCardKitThinkingMarkdown(explicitProcessText) : "",
    };
  }
  if (explicitProcessText) {
    return {
      answer: formatCardKitAssistantMarkdown(raw),
      notes: formatCardKitThinkingMarkdown(explicitProcessText),
    };
  }
  const split = splitAssistantReplyForDisplay(raw);
  return {
    answer: formatCardKitAssistantMarkdown(split.answerText),
    notes: formatCardKitThinkingMarkdown(split.preAnswerText),
  };
}

function buildCardKitFooter(runtime, entry) {
  const parts = [];
  if (entry.state === "failed") {
    parts.push("未完成");
  } else if (entry.state === "completed") {
    parts.push("已完成");
  } else if (entry.state === "retrying") {
    parts.push("模型通道重连中");
  } else {
    parts.push("正在回复");
  }

  const elapsed = formatReplyElapsed(entry.startedAt);
  if (elapsed) {
    parts.push(`耗时 ${elapsed}`);
  }
  if (runtime.config.defaultCodexModel) {
    parts.push(runtime.config.defaultCodexModel);
  }

  const usageText = formatUsageText(runtime.latestTokenUsageByThreadId.get(entry.threadId));
  if (usageText) {
    parts.push(usageText);
  }

  const contextText = formatContextText(runtime.latestTokenUsageByThreadId.get(entry.threadId));
  if (contextText) {
    parts.push(contextText);
  }

  const toolCountText = formatToolCountText(runtime.toolItemIdsByRunKey.get(
    codexMessageUtils.buildRunKey(entry.threadId, entry.turnId)
  ));
  if (toolCountText) {
    parts.push(toolCountText);
  }

  return parts.join(" · ");
}

function buildCardKitSummary(content, state) {
  const plain = String(content || "")
    .replace(/[*_`#>[\]()~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain) {
    return plain.slice(0, 120);
  }
  if (state === "failed") {
    return "这次没有顺利完成。";
  }
  if (state === "completed") {
    return "我已经处理好了。";
  }
  if (state === "retrying") {
    return "模型通道重连中。";
  }
  return "正在回复。";
}

async function flushLegacyReplyCard(runtime, runKey, entry) {
  const legacyDisplay = entry.state === "completed"
    ? splitAssistantReplyForDisplay(resolveAssistantReplyContent(entry))
    : { answerText: entry.text };
  const card = buildAssistantReplyCard({
    text: legacyDisplay.answerText,
    state: entry.state,
    elapsed: formatReplyElapsed(entry.startedAt),
    model: runtime.config.defaultCodexModel || "予安-Mira",
    toolText: formatToolTraceText(runtime.toolTraceByRunKey.get(runKey), entry.state),
    thinkingText: formatThinkingText({
      state: entry.state,
      elapsed: formatReplyElapsed(entry.startedAt),
      toolTrace: runtime.toolTraceByRunKey.get(runKey),
      tokenUsage: runtime.latestTokenUsageByThreadId.get(entry.threadId),
      assistantNotes: buildAssistantDisplayContent(entry).notes,
      memoryTrace: runtime.memoryPreflightByThreadId?.get(entry.threadId),
    }),
    usageText: formatUsageText(runtime.latestTokenUsageByThreadId.get(entry.threadId)),
    contextText: formatContextText(runtime.latestTokenUsageByThreadId.get(entry.threadId)),
    toolCountText: formatToolCountText(runtime.toolItemIdsByRunKey.get(runKey)),
  });

  if (!entry.messageId) {
    const response = await sendInteractiveCard(runtime, {
      chatId: entry.chatId,
      card,
      replyToMessageId: entry.replyToMessageId,
    });
    entry.messageId = codexMessageUtils.extractCreatedMessageId(response);
    if (!entry.messageId) {
      return;
    }
    runtime.setReplyCardEntry(runKey, entry);
    runtime.clearPendingReactionForThread(entry.threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction after first reply card: ${error.message}`);
    });
    if (entry.state === "completed" || entry.state === "failed") {
      runtime.disposeReplyRunState(runKey, entry.threadId);
    }
    return;
  }

  await patchInteractiveCard(runtime, {
    messageId: entry.messageId,
    card,
  });

  if (entry.state === "completed" || entry.state === "failed") {
    runtime.disposeReplyRunState(runKey, entry.threadId);
  }
}

async function enqueueReplyCardFlush(runtime, runKey) {
  if (runtime.replyFlushInFlightByRunKey.has(runKey)) {
    runtime.replyFlushQueuedByRunKey.add(runKey);
    return runtime.replyFlushInFlightByRunKey.get(runKey);
  }

  const flushPromise = (async () => {
    try {
      do {
        runtime.replyFlushQueuedByRunKey.delete(runKey);
        await flushReplyCard(runtime, runKey);
      } while (runtime.replyFlushQueuedByRunKey.has(runKey));
    } finally {
      runtime.replyFlushInFlightByRunKey.delete(runKey);
      runtime.replyFlushQueuedByRunKey.delete(runKey);
    }
  })();

  runtime.replyFlushInFlightByRunKey.set(runKey, flushPromise);
  return flushPromise;
}

async function addPendingReaction(runtime, bindingKey, messageId) {
  if (!bindingKey || !messageId) {
    return;
  }

  await clearPendingReactionForBinding(runtime, bindingKey);

  const reaction = await createReaction(runtime, {
    messageId,
    emojiType: "Typing",
  });
  runtime.pendingReactionByBindingKey.set(bindingKey, {
    messageId,
    reactionId: reaction.reactionId,
  });
}

function movePendingReactionToThread(runtime, bindingKey, threadId) {
  if (!bindingKey || !threadId) {
    return;
  }

  const pending = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByBindingKey.delete(bindingKey);
  runtime.pendingReactionByThreadId.set(threadId, pending);
}

async function clearPendingReactionForBinding(runtime, bindingKey) {
  const pending = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByBindingKey.delete(bindingKey);
  await deleteReaction(runtime, pending);
}

async function clearPendingReactionForThread(runtime, threadId) {
  if (!threadId) {
    return;
  }
  const pending = runtime.pendingReactionByThreadId.get(threadId);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByThreadId.delete(threadId);
  await deleteReaction(runtime, pending);
}

async function createReaction(runtime, { messageId, emojiType }) {
  return reactionRepo.createReaction(runtime.requireFeishuAdapter(), { messageId, emojiType });
}

async function deleteReaction(runtime, { messageId, reactionId }) {
  await reactionRepo.deleteReaction(runtime.requireFeishuAdapter(), { messageId, reactionId });
}

function disposeReplyRunState(runtime, runKey, threadId) {
  if (runKey) {
    clearReplyFlushTimer(runtime, runKey);
    runtime.replyFlushQueuedByRunKey.delete(runKey);
    runtime.replyFlushInFlightByRunKey.delete(runKey);
    runtime.replyCardByRunKey.delete(runKey);
    runtime.toolItemIdsByRunKey.delete(runKey);
    runtime.toolTraceByRunKey.delete(runKey);
    runtime.assistantDeltaSeenByRunKey.delete(runKey);
  }
  if (threadId && runtime.currentRunKeyByThreadId.get(threadId) === runKey) {
    runtime.currentRunKeyByThreadId.delete(threadId);
  }
  if (threadId && runtime.memoryPreflightByThreadId) {
    runtime.memoryPreflightByThreadId.delete(threadId);
  }
}

async function flushAssistantReplyCardNow(runtime, { threadId, turnId = "" } = {}) {
  if (!threadId) {
    return;
  }
  const preferredRunKey = codexMessageUtils.buildRunKey(threadId, turnId);
  const runKey = runtime.replyCardByRunKey.has(preferredRunKey)
    ? preferredRunKey
    : runtime.currentRunKeyByThreadId.get(threadId) || preferredRunKey;
  if (!runtime.replyCardByRunKey.has(runKey)) {
    return;
  }
  clearReplyFlushTimer(runtime, runKey);
  await enqueueReplyCardFlush(runtime, runKey);
}

function formatReplyElapsed(startedAt) {
  if (!startedAt || !Number.isFinite(startedAt)) {
    return "";
  }
  const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
  if (elapsedSeconds < 10) {
    return `${elapsedSeconds.toFixed(1)}s`;
  }
  return `${Math.round(elapsedSeconds)}s`;
}

function formatUsageText(tokenUsage) {
  const last = tokenUsage?.last;
  if (!last || typeof last !== "object") {
    return "";
  }
  const input = Number(last.inputTokens || 0);
  const output = Number(last.outputTokens || 0);
  if (!input && !output) {
    return "";
  }
  return `↑ ${formatCompactTokens(input)} · ↓ ${formatCompactTokens(output)}`;
}

function formatContextText(tokenUsage) {
  const last = tokenUsage?.last;
  const used = Number(last?.totalTokens || 0);
  const window = Number(tokenUsage?.modelContextWindow || 0);
  if (!used || !window) {
    return "";
  }
  const pct = Math.max(0, Math.min(100, Math.round((used / window) * 100)));
  return `上下文 ${formatCompactTokens(used)}/${formatCompactTokens(window)} (${pct}%)`;
}

function formatToolCountText(toolItems) {
  const count = toolItems instanceof Set ? toolItems.size : 0;
  return `API ${count} 次`;
}

function formatToolTraceText(toolTrace, state) {
  const steps = Array.isArray(toolTrace) ? toolTrace.filter(Boolean) : [];
  if (!steps.length) {
    if (state === "failed") {
      return "这轮在正式收口前断掉了，工具步骤没完整留住。";
    }
    if (state === "completed") {
      return "这轮没有额外工具调用，主要是直接整理回复。";
    }
    return "这轮还没走到明确的工具步骤。";
  }
  return steps.map((step) => `- ${step}`).join("\n");
}

function formatProcessTimelineText({ state, elapsed, toolTrace, tokenUsage, statusText = "", assistantNotes = "", memoryTrace = "" }) {
  const sections = [];
  const thinkingText = formatThinkingText({
    state,
    elapsed,
    toolTrace,
    tokenUsage,
    statusText,
    assistantNotes,
    memoryTrace,
  }).trim();
  if (thinkingText) {
    sections.push(thinkingText);
  }

  const steps = Array.isArray(toolTrace) ? toolTrace.filter(Boolean) : [];
  if (steps.length) {
    sections.push(["**执行记录**", ...steps.map((step) => `- ${step}`)].join("\n"));
  }

  return sections.join("\n\n").trim() || "这轮还没产生可展示的公开过程。";
}

function formatThinkingText({ state, elapsed, toolTrace, tokenUsage, statusText = "", assistantNotes = "", memoryTrace = "" }) {
  const steps = Array.isArray(toolTrace) ? toolTrace.filter(Boolean) : [];
  const reasoningTokens = Number(tokenUsage?.last?.reasoningOutputTokens || 0);
  const publicNotes = typeof assistantNotes === "string" ? assistantNotes.trim() : "";
  const memoryText = typeof memoryTrace === "string" ? memoryTrace.trim() : "";
  const withMemory = (text) => memoryText ? `${memoryText}\n\n${text}` : text;
  if (state === "retrying") {
    return withMemory(statusText
      ? `${statusText}\n\n这说明飞书消息已经进入 Codex，但当前模型供应商链路还没稳定返回。`
      : "模型供应商链路正在重连；飞书桥已经收到消息，正在等待 Codex 自动恢复。");
  }
  if (state === "failed") {
    return withMemory(elapsed
      ? `这轮在 ${elapsed} 左右断流了，我没把它完整收住。`
      : "这轮中途断掉了，所以我先停在这里。");
  }
  if (state === "completed") {
    if (publicNotes) {
      const prefix = elapsed
        ? `这轮已经收口，耗时约 ${elapsed}。下面是 Codex 公开给出的前置上下文/过程摘要，不是隐藏推理链：`
        : "这轮已经收口。下面是 Codex 公开给出的前置上下文/过程摘要，不是隐藏推理链：";
      return withMemory(`${prefix}\n\n${publicNotes}`);
    }
    if (steps.length) {
      return withMemory(elapsed
        ? `这轮已经收口。我先过了一遍问题，再走了 ${steps.length} 个步骤，最后在 ${elapsed} 左右把回复收好。`
        : `这轮已经收口。我先过了一遍问题，再走了 ${steps.length} 个步骤，把回复整理好了。`);
    }
    if (reasoningTokens > 0) {
      return withMemory(`这轮有 ${formatCompactTokens(reasoningTokens)} 思考 token，但没有公开思考摘要；我只能展示状态摘要，不展开私密推理链。`);
    }
    return withMemory(elapsed
      ? `这轮已经收口。我直接把问题想顺后，在 ${elapsed} 左右把回复整理好了。`
      : "这轮已经收口，我把回复整理好了。");
  }
  if (publicNotes) {
    return withMemory(publicNotes);
  }
  if (steps.length) {
    return withMemory(`我已经开始顺这轮的路子了，当前先走了 ${steps.length} 个步骤，正在往正式回复里收。`);
  }
  if (reasoningTokens > 0) {
    return withMemory(`底层已经在思考，但当前没有公开思考摘要；我会显示可公开的阶段状态。`);
  }
  return withMemory("我先把你的意思接住，再把这轮回复往清楚的方向收。");
}

function formatCardKitThinkingMarkdown(text) {
  const formatted = formatCardKitAssistantMarkdown(text);
  if (Buffer.byteLength(formatted, "utf8") <= 8000) {
    return formatted;
  }
  const clipped = formatted.slice(0, 3600).trim();
  return `${clipped}\n\n_思考面板内容较长，已截断显示。_`;
}

function formatCompactTokens(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) {
    return "0";
  }
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(1)}m`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return `${Math.round(n)}`;
}


module.exports = {
  addPendingReaction,
  clearPendingReactionForBinding,
  clearPendingReactionForThread,
  disposeReplyRunState,
  flushAssistantReplyCardNow,
  handleCardAction,
  movePendingReactionToThread,
  patchInteractiveCard,
  queueCardActionWithFeedback,
  runCardActionTask,
  sendCardActionFeedback,
  sendCardActionFeedbackByContext,
  sendInfoCardMessage,
  sendInteractiveApprovalCard,
  sendInteractiveCard,
  updateInteractiveCard,
  upsertAssistantReplyCard,
};

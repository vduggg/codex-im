#!/usr/bin/env node

const assert = require("node:assert/strict");
const { upsertAssistantReplyCard } = require("../src/presentation/card/card-service");

function createRuntime() {
  const createdCards = [];
  const streamedContent = [];
  const runtime = {
    activeTurnIdByThreadId: new Map(),
    currentRunKeyByThreadId: new Map(),
    replyCardByRunKey: new Map(),
    pendingChatContextByThreadId: new Map(),
    toolTraceByRunKey: new Map(),
    toolItemIdsByRunKey: new Map(),
    latestTokenUsageByThreadId: new Map(),
    memoryPreflightByThreadId: new Map(),
    replyFlushTimersByRunKey: new Map(),
    replyFlushInFlightByRunKey: new Map(),
    replyFlushQueuedByRunKey: new Set(),
    createdCards,
    streamedContent,
    config: {
      feishuStreamingOutput: true,
      feishuCardKitStreaming: true,
    },
  };
  runtime.setReplyCardEntry = (runKey, entry) => {
    runtime.replyCardByRunKey.set(runKey, entry);
  };
  runtime.setCurrentRunKeyForThread = (threadId, runKey) => {
    runtime.currentRunKeyByThreadId.set(threadId, runKey);
  };
  runtime.requireFeishuAdapter = () => ({
    async createCardEntity({ card }) {
      createdCards.push(card);
      return "card-1";
    },
    async sendCardByCardId() {
      return { data: { message_id: "message-1" } };
    },
    async streamCardContent({ content }) {
      streamedContent.push(content);
    },
    async updateCardKitCard({ card }) {
      createdCards.push(card);
    },
    async setCardStreamingMode() {},
  });
  runtime.clearPendingReactionForThread = async () => {};
  runtime.disposeReplyRunState = () => {};
  return runtime;
}

function findStreamingMarkdown(card) {
  const elements = card?.body?.elements || [];
  for (const element of elements) {
    if (element?.element_id === "streaming_content") {
      return element.content || "";
    }
  }
  return "";
}

function findProcessMarkdown(card) {
  const panel = (card?.body?.elements || []).find((element) => element?.tag === "collapsible_panel");
  const markdown = (panel?.elements || []).find((element) => element?.tag === "markdown");
  return markdown?.content || "";
}

async function testCompletedSnapshotPromotesPreviousTextToProcessPanel() {
  const runtime = createRuntime();
  const base = {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "chat-1",
    state: "streaming",
    deferFlush: true,
  };

  const processText = "Jiao，我先去定位文档，然后检查飞书卡片渲染。";
  const answerText = "Jiao，弄好了。\n\n- 正文只保留最终回复\n- 过程进入思考面板";

  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: processText,
    mode: "delta",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: answerText,
    mode: "delta",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: answerText,
    mode: "completed_snapshot",
  });

  const entry = runtime.replyCardByRunKey.get("thread-1:turn-1");
  assert.ok(entry, "reply entry should exist");
  assert.strictEqual(entry.answerText, answerText);
  assert.match(entry.processText, /我先去定位文档/);
  assert.doesNotMatch(entry.answerText, /我先去定位文档/);
}

async function testThinkTagsAreRemovedFromCompletedSnapshot() {
  const runtime = createRuntime();
  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-2",
    turnId: "turn-2",
    chatId: "chat-2",
    text: "<think>hidden</think>Jiao，弄好了。",
    mode: "completed_snapshot",
    state: "streaming",
    deferFlush: true,
  });

  const entry = runtime.replyCardByRunKey.get("thread-2:turn-2");
  assert.strictEqual(entry.answerText, "hiddenJiao，弄好了。");
  assert.doesNotMatch(entry.answerText, /<\/?think>/);
}

async function testStreamingOnlyProcessSurvivesFinalSnapshotReplacement() {
  const runtime = createRuntime();
  const base = {
    threadId: "thread-3",
    turnId: "turn-3",
    chatId: "chat-3",
    state: "streaming",
    deferFlush: true,
  };

  const streamingProcess = "我先看了一下这轮上下文，已经把共同记忆和工具步骤对上了。";
  const finalAnswer = "Jiao，弄好了。\n\n最终回复只保留结论。";

  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: streamingProcess,
    mode: "delta",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: finalAnswer,
    mode: "completed_snapshot",
  });

  const entry = runtime.replyCardByRunKey.get("thread-3:turn-3");
  assert.strictEqual(entry.answerText, finalAnswer);
  assert.match(entry.processText, /共同记忆和工具步骤/);
  assert.doesNotMatch(entry.answerText, /共同记忆和工具步骤/);
}

async function testPartialFinalDeltaDoesNotBecomeProcessText() {
  const runtime = createRuntime();
  const base = {
    threadId: "thread-4",
    turnId: "turn-4",
    chatId: "chat-4",
    state: "streaming",
    deferFlush: true,
  };

  const partialAnswer = "Jiao，弄好了。";
  const finalAnswer = "Jiao，弄好了。\n\n最终回复继续补齐后半段。";

  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: partialAnswer,
    mode: "delta",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: finalAnswer,
    mode: "completed_snapshot",
  });

  const entry = runtime.replyCardByRunKey.get("thread-4:turn-4");
  assert.strictEqual(entry.answerText, finalAnswer);
  assert.strictEqual(entry.processText, "");
}

async function testRunningCardStreamsAssistantDelta() {
  const runtime = createRuntime();
  const delta = "Jiao，我正在查日志，先确认不是 app-server 卡死。";

  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-5",
    turnId: "turn-5",
    chatId: "chat-5",
    text: delta,
    mode: "delta",
    state: "streaming",
  });

  assert.equal(runtime.createdCards.length, 1);
  assert.match(findProcessMarkdown(runtime.createdCards[0]), /正在查日志/);
  assert.match(findStreamingMarkdown(runtime.createdCards[0]), /结果会在这里流式出来/);
}

async function testProcessDeltaStreamsIntoProcessedPanelBeforeAnswerStarts() {
  const runtime = createRuntime();
  const processDelta = "我先看一下现有桥接代码，确认流式文本现在走到哪里。";

  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-6",
    turnId: "turn-6",
    chatId: "chat-6",
    text: processDelta,
    mode: "delta",
    state: "streaming",
  });

  const card = runtime.createdCards.at(-1);
  assert.match(findProcessMarkdown(card), /现有桥接代码/);
  assert.match(findStreamingMarkdown(card), /结果会在这里流式出来/);
}

async function testAnswerStartsStreamingAfterFinalMarker() {
  const runtime = createRuntime();
  const base = {
    threadId: "thread-7",
    turnId: "turn-7",
    chatId: "chat-7",
    mode: "delta",
    state: "streaming",
  };

  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: "我先确认入口，再看 CardKit 更新路径。",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: "\n\nJiao，弄好了。\n\n现在正文开始流式输出。",
  });
  await new Promise((resolve) => setTimeout(resolve, 650));

  const entry = runtime.replyCardByRunKey.get("thread-7:turn-7");
  assert.equal(entry.streamPhase, "answer");
  assert.match(entry.processText, /确认入口/);
  assert.match(entry.answerText, /^Jiao，弄好了/);
  assert.match(runtime.streamedContent.at(-1) || "", /现在正文开始流式输出/);
}

(async () => {
  await testCompletedSnapshotPromotesPreviousTextToProcessPanel();
  await testThinkTagsAreRemovedFromCompletedSnapshot();
  await testStreamingOnlyProcessSurvivesFinalSnapshotReplacement();
  await testPartialFinalDeltaDoesNotBecomeProcessText();
  await testRunningCardStreamsAssistantDelta();
  await testProcessDeltaStreamsIntoProcessedPanelBeforeAnswerStarts();
  await testAnswerStartsStreamingAfterFinalMarker();
  console.log("card reply content tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { handleCodexMessage } = require("../src/app/codex-event-service");

test("cleans pending temp images after terminal turn events", async () => {
  const cleanedTurns = [];
  const cleanedStateThreads = [];
  const runtime = {
    activeTurnIdByThreadId: new Map([["thread_1", "turn_1"]]),
    pendingApprovalByThreadId: new Map(),
    currentRunKeyByThreadId: new Map(),
    pendingChatContextByThreadId: new Map([
      ["thread_1", { chatId: "chat_1", threadKey: "key_1" }],
    ]),
    config: {
      feishuStreamingOutput: true,
    },
    pruneRuntimeMapSizes() {},
    clearPendingReactionForThread() {
      return Promise.resolve();
    },
    cleanupPendingTempImageFiles(threadId, turnId) {
      cleanedTurns.push({ threadId, turnId });
      return Promise.resolve();
    },
    cleanupThreadRuntimeState(threadId) {
      cleanedStateThreads.push(threadId);
    },
    deliverToFeishu() {
      return Promise.resolve();
    },
  };

  handleCodexMessage(runtime, {
    method: "turn/completed",
    params: {
      threadId: "thread_1",
      turn: {
        id: "turn_1",
        status: "completed",
      },
    },
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(cleanedTurns, [{ threadId: "thread_1", turnId: "turn_1" }]);
  assert.deepEqual(cleanedStateThreads, ["thread_1"]);
});

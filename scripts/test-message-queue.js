#!/usr/bin/env node

const assert = require("assert");
const {
  clearThreadMessageQueue,
  drainNextThreadMessage,
  enqueueThreadMessage,
  getThreadMessageQueueSize,
} = require("../src/domain/thread/message-queue");

async function main() {
  const calls = [];
  const runtime = {
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    messageQueueByThreadId: new Map(),
    sendInfoCardMessage: async (payload) => calls.push(["info", payload]),
    setPendingBindingContext: (bindingKey, normalized) => calls.push(["binding", bindingKey, normalized.messageId]),
    setPendingThreadContext: (threadId, normalized) => calls.push(["thread", threadId, normalized.messageId]),
    addPendingReaction: async (bindingKey, messageId) => calls.push(["reaction:add", bindingKey, messageId]),
    ensureThreadAndSendMessage: async (payload) => {
      calls.push(["send:payload", payload]);
      calls.push(["send", payload.threadId, payload.normalized.messageId]);
      return payload.threadId;
    },
    movePendingReactionToThread: (bindingKey, threadId) => calls.push(["reaction:move", bindingKey, threadId]),
    clearPendingReactionForBinding: async (bindingKey) => calls.push(["reaction:clear", bindingKey]),
  };

  const first = enqueueThreadMessage(runtime, "thread-1", buildItem("m1"));
  const second = enqueueThreadMessage(runtime, "thread-1", buildItem("m2"));
  assert.deepStrictEqual(first, { ok: true, position: 1 });
  assert.deepStrictEqual(second, { ok: true, position: 2 });
  assert.strictEqual(getThreadMessageQueueSize(runtime, "thread-1"), 2);

  runtime.activeTurnIdByThreadId.set("thread-1", "turn-active");
  assert.strictEqual(await drainNextThreadMessage(runtime, "thread-1"), false);
  assert.strictEqual(getThreadMessageQueueSize(runtime, "thread-1"), 2);
  runtime.activeTurnIdByThreadId.delete("thread-1");

  assert.strictEqual(await drainNextThreadMessage(runtime, "thread-1"), true);
  assert.strictEqual(getThreadMessageQueueSize(runtime, "thread-1"), 0);
  assert.deepStrictEqual(calls.find((call) => call[0] === "send"), ["send", "thread-1", "m2"]);
  const sent = calls.find((call) => call[0] === "send:payload")[1];
  assert.match(sent.normalized.text, /Ordered Feishu updates:/);
  assert.match(sent.normalized.text, /message m1/);
  assert.match(sent.normalized.text, /message m2/);

  enqueueThreadMessage(runtime, "thread-1", buildItem("m3"));
  assert.strictEqual(clearThreadMessageQueue(runtime, "thread-1"), 1);
  assert.strictEqual(getThreadMessageQueueSize(runtime, "thread-1"), 0);
  console.log("message queue fixtures ok");
}

function buildItem(messageId) {
  return {
    bindingKey: "binding-1",
    workspaceRoot: "/tmp/workspace",
    normalized: {
      chatId: "oc_test",
      messageId,
      text: `message ${messageId}`,
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

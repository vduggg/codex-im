#!/usr/bin/env node

const assert = require("assert");
const { mapCodexMessageToImEvent } = require("../src/infra/codex/message-utils");

const event = mapCodexMessageToImEvent({
  method: "error",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    error: {
      message: "unexpected status 502 Bad Gateway",
      additionalDetails: "Upstream service temporarily unavailable",
    },
  },
});

assert.deepStrictEqual(event, {
  type: "im.run_state",
  payload: {
    threadId: "thread-1",
    turnId: "turn-1",
    state: "failed",
    text: "执行失败：unexpected status 502 Bad Gateway",
  },
});

const retrying = mapCodexMessageToImEvent({
  method: "error",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    willRetry: true,
    error: { message: "stream disconnected" },
  },
});

assert.strictEqual(retrying, null);
console.log("codex error event fixtures ok");

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "ws") {
    return class MockWebSocket {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { CodexRpcClient } = require("../src/infra/codex/rpc-client");

Module._load = originalLoad;

test("sends text and local image items in order", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://unused" });
  let capturedMethod = "";
  let capturedParams = null;

  client.sendRequest = async (method, params) => {
    capturedMethod = method;
    capturedParams = params;
    return { result: {} };
  };

  await client.sendUserMessage({
    threadId: "thread_x",
    text: "请描述这张图",
    imagePaths: ["/tmp/a.png", "/tmp/b.png"],
    accessMode: "default",
    workspaceRoot: "/tmp/project",
  });

  assert.equal(capturedMethod, "turn/start");
  assert.deepEqual(capturedParams.input, [
    {
      type: "text",
      text: "请描述这张图",
      text_elements: [],
    },
    {
      type: "localImage",
      path: "/tmp/a.png",
    },
    {
      type: "localImage",
      path: "/tmp/b.png",
    },
  ]);
});

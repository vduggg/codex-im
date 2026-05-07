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

test("notifies listeners when codex transport closes", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://unused" });
  const seen = [];

  client.onTransportClosed((error) => {
    seen.push(error.message);
  });

  client.handleTransportClosed(new Error("Codex app-server exited with code 1"));

  assert.deepEqual(seen, ["Codex app-server exited with code 1"]);
  assert.equal(client.isReady, false);
  assert.equal(client.transportCloseError?.message, "Codex app-server exited with code 1");
});

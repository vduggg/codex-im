#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  extractSendDirectives,
  handleOutboundAttachmentDirectives,
  stripSendDirectives,
} = require("../src/domain/attachments/outbound-directive-service");

async function main() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuan-feishu-directive-"));
  fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "hello", "utf8");
  const sent = [];
  const runtime = {
    sentAttachmentDirectiveKeys: new Set(),
    workspaceRootByThreadId: new Map([["thread-1", workspaceRoot]]),
    resolveWorkspaceRootForThread: () => workspaceRoot,
    sendLocalAttachmentToFeishu: async (payload) => sent.push(payload),
    sendInfoCardMessage: async (payload) => sent.push({ kind: "info", ...payload }),
  };

  const text = "给你文件\n[[yuan-feishu-send:note.txt]]";
  assert.deepStrictEqual(extractSendDirectives(text), ["note.txt"]);
  assert.strictEqual(stripSendDirectives(text), "给你文件");

  const result = await handleOutboundAttachmentDirectives(runtime, {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "oc_test",
    text,
  });
  assert.strictEqual(result.text, "给你文件");
  assert.strictEqual(result.sent, 1);
  assert.strictEqual(sent[0].fileName, "note.txt");
  assert.strictEqual(sent[0].kind, "file");

  const duplicate = await handleOutboundAttachmentDirectives(runtime, {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "oc_test",
    text,
  });
  assert.strictEqual(duplicate.sent, 0);

  console.log("outbound directive fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

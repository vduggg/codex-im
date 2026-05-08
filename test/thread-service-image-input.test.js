const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureThreadAndSendMessage,
} = require("../src/domain/thread/thread-service");

test("sends mixed feishu input with temporary image paths and cleans them afterward", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-thread-image-"));
  const createdFile = path.join(tempRoot, "image.png");
  fs.writeFileSync(createdFile, "fake");

  let capturedArgs = null;
  let cleanupCalled = false;
  let rememberedThreadId = null;
  let rememberedTurnId = null;
  let rememberedFiles = null;
  const runtime = {
    resumedThreadIds: new Set(["thread_existing"]),
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return {
        model: "",
        effort: "",
      };
    },
    async downloadMessageImagesToTemp(_adapter, options) {
      assert.equal(options.images.length, 1);
      return [{ path: createdFile }];
    },
    async cleanupTempFiles(files) {
      cleanupCalled = true;
      for (const file of files) {
        await fs.promises.unlink(file.path);
      }
    },
    setPendingTempImageFiles(threadId, turnId, files) {
      rememberedThreadId = threadId;
      rememberedTurnId = turnId;
      rememberedFiles = files;
    },
    requireFeishuAdapter() {
      return {};
    },
    codex: {
      async sendUserMessage(args) {
        capturedArgs = args;
        return {
          result: {
            turn: {
              id: "turn_created",
            },
          },
        };
      },
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
  };

  const threadId = await ensureThreadAndSendMessage(runtime, {
    bindingKey: "binding",
    workspaceRoot: "/tmp/project",
    normalized: {
      text: "请描述这张图",
      images: [{ imageKey: "img_post" }],
      files: [],
      messageType: "mixed",
    },
    threadId: "thread_existing",
  });

  assert.equal(threadId, "thread_existing");
  assert.equal(capturedArgs.text, "请描述这张图");
  assert.deepEqual(capturedArgs.imagePaths, [createdFile]);
  assert.equal(rememberedThreadId, "thread_existing");
  assert.equal(rememberedTurnId, "turn_created");
  assert.deepEqual(rememberedFiles, [{ path: createdFile }]);
  assert.equal(cleanupCalled, false);
  assert.equal(fs.existsSync(createdFile), true);
  await runtime.cleanupTempFiles(rememberedFiles);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("keeps pure text sends on the old path", async () => {
  let downloadCalled = false;
  let capturedArgs = null;
  const runtime = {
    resumedThreadIds: new Set(["thread_text"]),
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return {
        model: "",
        effort: "",
      };
    },
    async downloadMessageImagesToTemp() {
      downloadCalled = true;
      return [];
    },
    async cleanupTempFiles() {},
    requireFeishuAdapter() {
      return {};
    },
    codex: {
      async sendUserMessage(args) {
        capturedArgs = args;
      },
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
  };

  await ensureThreadAndSendMessage(runtime, {
    bindingKey: "binding",
    workspaceRoot: "/tmp/project",
    normalized: {
      text: "/codex where",
      images: [],
      files: [],
      messageType: "text",
    },
    threadId: "thread_text",
  });

  assert.equal(downloadCalled, false);
  assert.equal(capturedArgs.text, "/codex where");
  assert.deepEqual(capturedArgs.imagePaths, []);
});

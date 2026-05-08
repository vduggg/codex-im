const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ensureThreadAndSendMessage,
} = require("../src/domain/thread/thread-service");

test("appends workspace-relative file paths to the text sent to codex", async () => {
  let capturedArgs = null;
  let saveCalled = false;
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
    async downloadMessageImagesToTemp() {
      return [];
    },
    async saveMessageFilesToWorkspaceInbox(_adapter, options) {
      saveCalled = true;
      assert.equal(options.messageId, "om_file");
      assert.equal(options.workspaceRoot, "/tmp/project");
      assert.deepEqual(options.files, [
        {
          fileKey: "file_v3_test",
          fileName: "build.log",
          sourceType: "file",
        },
      ]);
      return [
        {
          path: "/tmp/project/.codex-im/inbox/20260507T120000Z-build.log",
          relativePath: ".codex-im/inbox/20260507T120000Z-build.log",
        },
      ];
    },
    async cleanupTempFiles() {},
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
    setPendingTempImageFiles() {},
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
  };

  const threadId = await ensureThreadAndSendMessage(runtime, {
    bindingKey: "binding",
    workspaceRoot: "/tmp/project",
    normalized: {
      text: "帮我分析",
      images: [],
      files: [
        {
          fileKey: "file_v3_test",
          fileName: "build.log",
          sourceType: "file",
        },
      ],
      messageType: "file_only",
      messageId: "om_file",
    },
    threadId: "thread_existing",
  });

  assert.equal(threadId, "thread_existing");
  assert.equal(saveCalled, true);
  assert.match(capturedArgs.text, /帮我分析/);
  assert.match(capturedArgs.text, /\.codex-im\/inbox\/20260507T120000Z-build\.log/);
  assert.deepEqual(capturedArgs.imagePaths, []);
});

test("builds a prompt for file-only messages", async () => {
  let capturedArgs = null;
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
    async downloadMessageImagesToTemp() {
      return [];
    },
    async saveMessageFilesToWorkspaceInbox() {
      return [
        {
          path: "/tmp/project/.codex-im/inbox/20260507T120000Z-build.log",
          relativePath: ".codex-im/inbox/20260507T120000Z-build.log",
        },
      ];
    },
    async cleanupTempFiles() {},
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
    setPendingTempImageFiles() {},
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
  };

  await ensureThreadAndSendMessage(runtime, {
    bindingKey: "binding",
    workspaceRoot: "/tmp/project",
    normalized: {
      text: "",
      images: [],
      files: [
        {
          fileKey: "file_v3_test",
          fileName: "build.log",
          sourceType: "file",
        },
      ],
      messageType: "file_only",
      messageId: "om_file",
    },
    threadId: "thread_existing",
  });

  assert.doesNotMatch(capturedArgs.text, /^\s*$/);
  assert.match(capturedArgs.text, /用户上传了 1 个文件/);
  assert.match(capturedArgs.text, /\.codex-im\/inbox\/20260507T120000Z-build\.log/);
});

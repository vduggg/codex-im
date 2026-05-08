const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  cleanupInboxFiles,
  saveMessageFilesToWorkspaceInbox,
} = require("../src/infra/feishu/file-resource-service");

test("saves downloaded files into workspace inbox with sanitized names", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-file-workspace-"));
  const feishuAdapter = {
    async downloadFileByKey({ messageId, fileKey }) {
      assert.equal(messageId, "om_file");
      assert.equal(fileKey, "file_v3_test");
      return {
        buffer: Buffer.from("hello", "utf8"),
        mimeType: "text/plain",
      };
    },
  };

  const saved = await saveMessageFilesToWorkspaceInbox(feishuAdapter, {
    messageId: "om_file",
    workspaceRoot,
    files: [
      {
        fileKey: "file_v3_test",
        fileName: "../build.log",
      },
    ],
    now: () => new Date("2026-05-07T12:00:00.000Z"),
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].relativePath, ".codex-im/inbox/20260507T120000Z-build.log");
  assert.equal(fs.readFileSync(saved[0].path, "utf8"), "hello");

  await cleanupInboxFiles(saved);
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("removes already saved files when a later download fails", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-file-workspace-"));
  let callCount = 0;
  const feishuAdapter = {
    async downloadFileByKey() {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("download failed");
      }
      return {
        buffer: Buffer.from("hello", "utf8"),
        mimeType: "text/plain",
      };
    },
  };

  await assert.rejects(
    () => saveMessageFilesToWorkspaceInbox(feishuAdapter, {
      messageId: "om_file",
      workspaceRoot,
      files: [
        {
          fileKey: "file_v3_first",
          fileName: "first.log",
        },
        {
          fileKey: "file_v3_second",
          fileName: "second.log",
        },
      ],
      now: () => new Date("2026-05-07T12:00:00.000Z"),
    }),
    /download failed/
  );

  const inboxRoot = path.join(workspaceRoot, ".codex-im", "inbox");
  assert.deepEqual(fs.existsSync(inboxRoot) ? fs.readdirSync(inboxRoot) : [], []);
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

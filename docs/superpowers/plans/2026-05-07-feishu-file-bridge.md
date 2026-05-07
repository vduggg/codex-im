# Feishu File Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inbound Feishu file handling that stores uploaded files in the current bound workspace and forwards a file-path prompt to Codex, while preserving the existing outbound `/codex send` flow.

**Architecture:** Extend message normalization with file metadata, add a Feishu file resource downloader plus a workspace inbox saver, and update the thread send path to append saved file paths to the text sent to Codex. Keep the Codex RPC contract unchanged by representing inbound files as saved workspace paths inside a synthetic text prompt.

**Tech Stack:** Node.js 18, CommonJS, node:test, Feishu SDK adapter, existing Codex JSON-RPC client.

---

## File Structure

- Modify `src/presentation/message/normalizers.js`
  - Parse Feishu `file` messages and include `files` in normalized payloads.
- Modify `src/app/dispatcher.js`
  - Log file counts and preserve existing command-routing behavior.
- Modify `src/domain/thread/thread-service.js`
  - Save inbound files before sending to Codex and append a file notice block to the outgoing text.
- Modify `src/app/feishu-bot-runtime.js`
  - Expose the new file resource service through runtime forwarders.
- Modify `src/infra/feishu/client-adapter.js`
  - Add `downloadFileByKey({ messageId, fileKey })`.
- Create `src/infra/feishu/file-resource-service.js`
  - Save Feishu file resources into `<workspaceRoot>/.codex-im/inbox/`.
- Modify `test/message-normalizers.test.js`
  - Add file normalization tests.
- Modify `test/feishu-client-adapter.test.js`
  - Add file resource download tests.
- Create `test/feishu-file-resource-service.test.js`
  - Cover inbox persistence and rollback.
- Create `test/thread-service-file-input.test.js`
  - Cover final Codex text composition with saved file paths.
- Modify `README.md`
  - Document inbound file behavior.

### Task 1: Normalize Feishu File Messages

**Files:**
- Modify: `src/presentation/message/normalizers.js`
- Modify: `src/app/dispatcher.js`
- Modify: `test/message-normalizers.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("normalizes file messages as file_only", () => {
  const normalized = normalizeFeishuTextEvent({
    message: {
      message_type: "file",
      content: JSON.stringify({
        file_key: "file_v3_test",
        file_name: "build.log",
      }),
      chat_id: "oc_file",
      message_id: "om_file",
    },
    sender: buildSender(),
  }, buildConfig());

  assert.equal(normalized.messageType, "file_only");
  assert.equal(normalized.text, "");
  assert.deepEqual(normalized.images, []);
  assert.deepEqual(normalized.files, [
    {
      fileKey: "file_v3_test",
      fileName: "build.log",
      sourceType: "file",
    },
  ]);
});

test("ignores malformed file messages without file_key", () => {
  const normalized = normalizeFeishuTextEvent({
    message: {
      message_type: "file",
      content: JSON.stringify({
        file_name: "build.log",
      }),
      chat_id: "oc_file_bad",
      message_id: "om_file_bad",
    },
    sender: buildSender(),
  }, buildConfig());

  assert.equal(normalized, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/message-normalizers.test.js`
Expected: FAIL because normalized file messages currently return `null` and no `files` property exists.

- [ ] **Step 3: Write minimal implementation**

```js
function normalizeIncomingFeishuMessage(message) {
  const messageType = normalizeIdentifier(message?.message_type).toLowerCase();

  if (messageType === "file") {
    const parsedFile = parseFeishuMessageFile(message.content);
    if (!parsedFile) {
      return null;
    }
    return {
      text: "",
      images: [],
      files: [parsedFile],
      messageType: "file_only",
    };
  }
}

function parseFeishuMessageFile(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    const fileKey = normalizeIdentifier(parsed?.file_key);
    if (!fileKey) {
      return null;
    }
    return {
      fileKey,
      fileName: normalizeIdentifier(parsed?.file_name) || "file",
      sourceType: "file",
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/message-normalizers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/message-normalizers.test.js src/presentation/message/normalizers.js src/app/dispatcher.js
git commit -m "feat: normalize inbound feishu file messages"
```

### Task 2: Download And Persist Feishu File Resources

**Files:**
- Modify: `src/infra/feishu/client-adapter.js`
- Create: `src/infra/feishu/file-resource-service.js`
- Modify: `test/feishu-client-adapter.test.js`
- Create: `test/feishu-file-resource-service.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("downloads file bytes by file key", async () => {
  const adapter = new FeishuClientAdapter({
    im: {
      v1: {
        messageResource: {
          get: async ({ params, path }) => {
            assert.equal(params.type, "file");
            assert.equal(path.message_id, "om_file");
            assert.equal(path.file_key, "file_v3_test");
            return {
              data: Buffer.from("hello"),
              headers: {
                "content-type": "text/plain",
              },
            };
          },
        },
      },
    },
  });

  const resource = await adapter.downloadFileByKey({
    messageId: "om_file",
    fileKey: "file_v3_test",
  });

  assert.equal(resource.buffer.toString("utf8"), "hello");
});

test("saves downloaded files into workspace inbox", async () => {
  const saved = await saveMessageFilesToWorkspaceInbox(feishuAdapter, {
    messageId: "om_file",
    workspaceRoot: tempRoot,
    files: [
      {
        fileKey: "file_v3_test",
        fileName: "../build.log",
      },
    ],
    now: () => new Date("2026-05-07T12:00:00.000Z"),
  });

  assert.equal(saved[0].relativePath, ".codex-im/inbox/20260507T120000Z-build.log");
  assert.equal(fs.readFileSync(saved[0].path, "utf8"), "hello");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/feishu-client-adapter.test.js test/feishu-file-resource-service.test.js`
Expected: FAIL because `downloadFileByKey` and `saveMessageFilesToWorkspaceInbox` do not exist.

- [ ] **Step 3: Write minimal implementation**

```js
async function downloadFileByKey({ messageId, fileKey }) {
  const getMessageResource = resolveGetMessageResourceMethod(this.client);
  const response = await getMessageResource.call(
    this.client.im?.v1?.messageResource || this.client.im?.messageResource || this.client,
    {
      params: { type: "file" },
      path: {
        message_id: normalizeMessageId(messageId),
        file_key: normalizeIdentifier(fileKey),
      },
    }
  );

  const buffer = await extractBinaryBuffer(response);
  if (!buffer.length) {
    throw new Error("Feishu file download returned empty data");
  }
  return {
    buffer,
    mimeType: extractContentType(response),
  };
}
```

```js
async function saveMessageFilesToWorkspaceInbox(feishuAdapter, {
  messageId,
  workspaceRoot,
  files,
  now = () => new Date(),
}) {
  const inboxRoot = path.join(workspaceRoot, ".codex-im", "inbox");
  await fs.promises.mkdir(inboxRoot, { recursive: true });
  const savedFiles = [];

  try {
    for (const file of files) {
      const resource = await feishuAdapter.downloadFileByKey({
        messageId,
        fileKey: file.fileKey,
      });
      const targetName = buildInboxFileName(now(), file.fileName);
      const targetPath = path.join(inboxRoot, targetName);
      await fs.promises.writeFile(targetPath, resource.buffer);
      savedFiles.push({
        path: targetPath,
        relativePath: path.posix.join(".codex-im", "inbox", targetName),
        fileKey: file.fileKey,
        fileName: file.fileName,
      });
    }
  } catch (error) {
    await cleanupTempFiles(savedFiles);
    throw error;
  }

  return savedFiles;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/feishu-client-adapter.test.js test/feishu-file-resource-service.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/feishu-client-adapter.test.js test/feishu-file-resource-service.test.js src/infra/feishu/client-adapter.js src/infra/feishu/file-resource-service.js
git commit -m "feat: persist inbound feishu files into workspace inbox"
```

### Task 3: Append Saved File Paths To Codex Prompts

**Files:**
- Modify: `src/domain/thread/thread-service.js`
- Modify: `src/app/feishu-bot-runtime.js`
- Create: `test/thread-service-file-input.test.js`
- Modify: `test/thread-service-image-input.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("appends workspace-relative file paths to the text sent to codex", async () => {
  let capturedArgs = null;
  const runtime = {
    resumedThreadIds: new Set(["thread_existing"]),
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    async saveMessageFilesToWorkspaceInbox(_adapter, options) {
      assert.equal(options.workspaceRoot, "/tmp/project");
      return [
        {
          path: "/tmp/project/.codex-im/inbox/20260507T120000Z-build.log",
          relativePath: ".codex-im/inbox/20260507T120000Z-build.log",
        },
      ];
    },
    requireFeishuAdapter() {
      return {};
    },
    codex: {
      async sendUserMessage(args) {
        capturedArgs = args;
        return { result: { turn: { id: "turn_created" } } };
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
      text: "帮我分析",
      images: [],
      files: [{ fileKey: "file_v3_test", fileName: "build.log" }],
      messageType: "file_only",
      messageId: "om_file",
    },
    threadId: "thread_existing",
  });

  assert.match(capturedArgs.text, /帮我分析/);
  assert.match(capturedArgs.text, /\.codex-im\/inbox\/20260507T120000Z-build\.log/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/thread-service-file-input.test.js test/thread-service-image-input.test.js`
Expected: FAIL because thread send flow ignores `normalized.files`.

- [ ] **Step 3: Write minimal implementation**

```js
async function prepareWorkspaceInboxFiles(runtime, workspaceRoot, normalized) {
  const files = Array.isArray(normalized?.files) ? normalized.files : [];
  if (!files.length) {
    return [];
  }
  return runtime.saveMessageFilesToWorkspaceInbox(runtime.requireFeishuAdapter(), {
    messageId: normalized?.messageId || "",
    workspaceRoot,
    files,
  });
}

function buildTextWithInboundFiles(text, savedFiles) {
  const baseText = typeof text === "string" ? text.trim() : "";
  if (!savedFiles.length) {
    return baseText;
  }
  const fileLines = savedFiles.map((file) => `- ${file.relativePath}`);
  const notice = `用户${baseText ? "还" : ""}上传了 ${savedFiles.length} 个文件，请先读取它们，再继续回答：\n${fileLines.join("\n")}`;
  return baseText ? `${baseText}\n\n${notice}` : notice;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/thread-service-file-input.test.js test/thread-service-image-input.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/thread-service-file-input.test.js test/thread-service-image-input.test.js src/domain/thread/thread-service.js src/app/feishu-bot-runtime.js
git commit -m "feat: forward inbound feishu files to codex as workspace paths"
```

### Task 4: Documentation And Regression Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/feishu-setup.md` if permission docs need adjustment

- [ ] **Step 1: Write the failing documentation expectation**

```md
- 飞书文字、图片、文件和图文输入
- 飞书发给机器人的文件会保存到当前绑定项目的 `.codex-im/inbox/`
```

- [ ] **Step 2: Run verification against the current tree**

Run: `rg -n "文件和图文输入|\\.codex-im/inbox" README.md docs/feishu-setup.md`
Expected: no matches for the new inbound file wording.

- [ ] **Step 3: Update docs**

```md
- 飞书文字、图片、文件和图文输入
- 飞书发给机器人的文件会保存到当前绑定项目的 `.codex-im/inbox/`，随后以文件路径形式交给 Codex 继续处理
```

- [ ] **Step 4: Run full verification**

Run: `node --test test/message-normalizers.test.js test/feishu-client-adapter.test.js test/feishu-file-resource-service.test.js test/thread-service-image-input.test.js test/thread-service-file-input.test.js && npm run check`
Expected: all tests PASS and syntax check PASS

- [ ] **Step 5: Commit**

```bash
git add README.md docs/feishu-setup.md test/message-normalizers.test.js test/feishu-client-adapter.test.js test/feishu-file-resource-service.test.js test/thread-service-image-input.test.js test/thread-service-file-input.test.js src/presentation/message/normalizers.js src/infra/feishu/client-adapter.js src/infra/feishu/file-resource-service.js src/domain/thread/thread-service.js src/app/feishu-bot-runtime.js src/app/dispatcher.js
git commit -m "feat: add inbound feishu file bridge"
```

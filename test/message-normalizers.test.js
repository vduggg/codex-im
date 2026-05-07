const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeFeishuTextEvent,
} = require("../src/presentation/message/normalizers");

function buildConfig() {
  return {
    defaultWorkspaceId: "default",
  };
}

function buildSender() {
  return {
    sender_id: {
      open_id: "ou_test",
    },
  };
}

test("normalizes pure text messages without changing command parsing", () => {
  const normalized = normalizeFeishuTextEvent({
    message: {
      message_type: "text",
      content: JSON.stringify({ text: "/codex bind /tmp/project" }),
      chat_id: "oc_text",
      root_id: "om_root",
      message_id: "om_text",
    },
    sender: buildSender(),
  }, buildConfig());

  assert.equal(normalized.messageType, "text");
  assert.equal(normalized.text, "/codex bind /tmp/project");
  assert.equal(normalized.command, "bind");
  assert.deepEqual(normalized.images, []);
  assert.deepEqual(normalized.files, []);
});

test("marks pure image messages as image_only", () => {
  const normalized = normalizeFeishuTextEvent({
    message: {
      message_type: "image",
      content: JSON.stringify({ image_key: "img_only" }),
      chat_id: "oc_image",
      message_id: "om_image",
    },
    sender: buildSender(),
  }, buildConfig());

  assert.equal(normalized.messageType, "image_only");
  assert.equal(normalized.text, "");
  assert.equal(normalized.command, "");
  assert.deepEqual(normalized.images, [
    {
      imageKey: "img_only",
      sourceType: "image",
    },
  ]);
  assert.deepEqual(normalized.files, []);
});

test("normalizes post messages with both text and image tags", () => {
  const normalized = normalizeFeishuTextEvent({
    message: {
      message_type: "post",
      content: JSON.stringify({
        zh_cn: {
          title: "",
          content: [
            [
              { tag: "text", text: "请描述这张图" },
              { tag: "img", image_key: "img_post" },
            ],
          ],
        },
      }),
      chat_id: "oc_post",
      message_id: "om_post",
    },
    sender: buildSender(),
  }, buildConfig());

  assert.equal(normalized.messageType, "mixed");
  assert.equal(normalized.text, "请描述这张图");
  assert.equal(normalized.command, "message");
  assert.deepEqual(normalized.images, [
    {
      imageKey: "img_post",
      sourceType: "post",
    },
  ]);
  assert.deepEqual(normalized.files, []);
});

test("normalizes top-level post messages with both text and image tags", () => {
  const normalized = normalizeFeishuTextEvent({
    message: {
      message_type: "post",
      content: JSON.stringify({
        title: "",
        content: [
          [
            { tag: "text", text: "你好 " },
          ],
          [
            { tag: "img", image_key: "img_top_level" },
          ],
          [
            { tag: "text", text: "看看这个图片说的什么" },
          ],
        ],
      }),
      chat_id: "oc_post_top",
      message_id: "om_post_top",
    },
    sender: buildSender(),
  }, buildConfig());

  assert.equal(normalized.messageType, "mixed");
  assert.equal(normalized.text, "你好\n看看这个图片说的什么");
  assert.deepEqual(normalized.images, [
    {
      imageKey: "img_top_level",
      sourceType: "post",
    },
  ]);
  assert.deepEqual(normalized.files, []);
});

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
  assert.equal(normalized.command, "");
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

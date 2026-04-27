#!/usr/bin/env node

const assert = require("assert");
const { FeishuClientAdapter } = require("../src/infra/feishu/client-adapter");
const { normalizeFeishuTextEvent } = require("../src/presentation/message/normalizers");
const {
  classifyLocalAttachment,
  inferFeishuFileType,
  isSafeTextFile,
} = require("../src/shared/media-types");

async function main() {
  testMediaClassification();
  testNonTextNormalizers();
  await testFeishuAdapterUploads();
  console.log("media fixtures ok");
}

function testMediaClassification() {
  assert.strictEqual(classifyLocalAttachment("out.png"), "image");
  assert.strictEqual(classifyLocalAttachment("voice.opus"), "audio");
  assert.strictEqual(classifyLocalAttachment("voice.mp4"), "audio");
  assert.strictEqual(classifyLocalAttachment("notes.md"), "file");
  assert.strictEqual(inferFeishuFileType("voice.opus"), "opus");
  assert.strictEqual(inferFeishuFileType("clip.mp4"), "mp4");
  assert.strictEqual(inferFeishuFileType("paper.pdf"), "pdf");
  assert.strictEqual(inferFeishuFileType("notes.md"), "stream");
  assert.strictEqual(isSafeTextFile("notes.md"), true);
  assert.strictEqual(isSafeTextFile("archive.zip"), false);
}

function testNonTextNormalizers() {
  const config = { defaultWorkspaceId: "default" };
  const sender = { sender_id: { open_id: "ou_test" } };

  const image = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "image",
      chat_id: "oc_test",
      message_id: "om_image",
      content: JSON.stringify({ image_key: "img_key" }),
    },
  }, config);
  assert.strictEqual(image.command, "image_message");
  assert.deepStrictEqual(image.attachments[0], {
    kind: "image",
    resourceKey: "img_key",
    resourceType: "image",
  });

  const file = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "file",
      chat_id: "oc_test",
      message_id: "om_file",
      content: JSON.stringify({
        file_key: "file_key",
        file_name: "report.md",
        file_size: 42,
        file_type: "stream",
      }),
    },
  }, config);
  assert.strictEqual(file.command, "attachment_message");
  assert.strictEqual(file.attachments[0].kind, "file");
  assert.strictEqual(file.attachments[0].resourceKey, "file_key");
  assert.strictEqual(file.attachments[0].fileName, "report.md");
  assert.strictEqual(file.attachments[0].fileSize, 42);

  const audio = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "audio",
      chat_id: "oc_test",
      message_id: "om_audio",
      content: JSON.stringify({
        file_key: "audio_key",
        file_name: "voice.opus",
        duration: 7,
      }),
    },
  }, config);
  assert.strictEqual(audio.command, "attachment_message");
  assert.strictEqual(audio.attachments[0].kind, "audio");
  assert.strictEqual(audio.attachments[0].resourceType, "file");
  assert.strictEqual(audio.attachments[0].duration, 7);
}

async function testFeishuAdapterUploads() {
  const calls = [];
  const fakeClient = {
    im: {
      v1: {
        file: {
          create: async (payload) => {
            calls.push(["file.create", payload]);
            return { file_key: "file_uploaded" };
          },
        },
        image: {
          create: async (payload) => {
            calls.push(["image.create", payload]);
            return { image_key: "image_uploaded" };
          },
        },
        message: {
          create: async (payload) => {
            calls.push(["message.create", payload]);
            return { code: 0 };
          },
          reply: async (payload) => {
            calls.push(["message.reply", payload]);
            return { code: 0 };
          },
        },
      },
    },
  };
  const adapter = new FeishuClientAdapter(fakeClient);

  await adapter.sendFileMessage({
    chatId: "oc_test",
    fileName: "voice.opus",
    fileBuffer: Buffer.from("audio"),
    fileType: "opus",
    msgType: "audio",
  });
  assert.strictEqual(calls[0][0], "file.create");
  assert.strictEqual(calls[0][1].data.file_type, "opus");
  assert.strictEqual(calls[1][1].data.msg_type, "audio");
  assert.strictEqual(calls[1][1].data.content, JSON.stringify({ file_key: "file_uploaded" }));

  await adapter.sendImageMessage({
    chatId: "oc_test",
    imageBuffer: Buffer.from("image"),
    replyToMessageId: "om_parent:extra",
  });
  assert.strictEqual(calls[2][0], "image.create");
  assert.strictEqual(calls[2][1].data.image_type, "message");
  assert.strictEqual(calls[3][0], "message.reply");
  assert.strictEqual(calls[3][1].path.message_id, "om_parent");
  assert.strictEqual(calls[3][1].data.msg_type, "image");
  assert.strictEqual(calls[3][1].data.content, JSON.stringify({ image_key: "image_uploaded" }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

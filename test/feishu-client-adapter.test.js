const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const {
  FeishuClientAdapter,
} = require("../src/infra/feishu/client-adapter");

test("downloads image bytes through im.v1.messageResource.get", async () => {
  const client = {
    im: {
      v1: {
        messageResource: {
          async get({ params, path }) {
            assert.equal(params.type, "image");
            assert.equal(path.message_id, "om_test");
            assert.equal(path.file_key, "img_test");
            return {
              getReadableStream() {
                return Readable.from([Buffer.from([1, 2]), Buffer.from([3])]);
              },
              headers: {
                "content-type": "image/png",
              },
            };
          },
        },
      },
    },
  };

  const adapter = new FeishuClientAdapter(client);
  const resource = await adapter.downloadImageByKey({
    messageId: "om_test",
    imageKey: "img_test",
  });

  assert.deepEqual([...resource.buffer], [1, 2, 3]);
  assert.equal(resource.mimeType, "image/png");
});

test("downloads file bytes through im.v1.messageResource.get", async () => {
  const client = {
    im: {
      v1: {
        messageResource: {
          async get({ params, path }) {
            assert.equal(params.type, "file");
            assert.equal(path.message_id, "om_file");
            assert.equal(path.file_key, "file_v3_test");
            return {
              getReadableStream() {
                return Readable.from([Buffer.from("he"), Buffer.from("llo")]);
              },
              headers: {
                "content-type": "text/plain",
              },
            };
          },
        },
      },
    },
  };

  const adapter = new FeishuClientAdapter(client);
  const resource = await adapter.downloadFileByKey({
    messageId: "om_file",
    fileKey: "file_v3_test",
  });

  assert.equal(resource.buffer.toString("utf8"), "hello");
  assert.equal(resource.mimeType, "text/plain");
});

test("rejects empty image keys", async () => {
  const adapter = new FeishuClientAdapter({});
  await assert.rejects(
    () => adapter.downloadImageByKey({ messageId: "om_test", imageKey: "" }),
    /imageKey is required/
  );
});

test("rejects empty file keys", async () => {
  const adapter = new FeishuClientAdapter({});
  await assert.rejects(
    () => adapter.downloadFileByKey({ messageId: "om_test", fileKey: "" }),
    /fileKey is required/
  );
});

test("rejects empty message ids for message resources", async () => {
  const adapter = new FeishuClientAdapter({
    im: {
      v1: {
        messageResource: {
          async get() {
            throw new Error("should not be called");
          },
        },
      },
    },
  });
  await assert.rejects(
    () => adapter.downloadImageByKey({ messageId: "", imageKey: "img_test" }),
    /messageId is required/
  );
});

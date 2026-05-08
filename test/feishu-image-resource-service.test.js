const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  downloadMessageImagesToTemp,
  cleanupTempFiles,
} = require("../src/infra/feishu/image-resource-service");

test("downloads image bytes to temporary files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-image-test-"));
  try {
    const adapter = {
      async downloadImageByKey({ messageId, imageKey }) {
        assert.equal(messageId, "om_test");
        assert.equal(imageKey, "img_png");
        return {
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png",
        };
      },
    };

    const files = await downloadMessageImagesToTemp(adapter, {
      messageId: "om_test",
      images: [{ imageKey: "img_png" }],
      tempRoot,
    });

    assert.equal(files.length, 1);
    assert.match(files[0].path, /om_test-1\.png$/);
    assert.equal(fs.existsSync(files[0].path), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("cleans up temporary files without throwing on missing files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-image-clean-"));
  const firstFile = path.join(tempRoot, "a.png");
  const secondFile = path.join(tempRoot, "missing.png");
  fs.writeFileSync(firstFile, "ok");

  await cleanupTempFiles([
    { path: firstFile },
    { path: secondFile },
  ]);

  assert.equal(fs.existsSync(firstFile), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("removes already downloaded files when a later image download fails", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-image-partial-"));
  try {
    const adapter = {
      async downloadImageByKey({ imageKey }) {
        if (imageKey === "img_bad") {
          throw new Error("download failed");
        }
        return {
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png",
        };
      },
    };

    await assert.rejects(
      () => downloadMessageImagesToTemp(adapter, {
        messageId: "om_partial",
        images: [
          { imageKey: "img_ok" },
          { imageKey: "img_bad" },
        ],
        tempRoot,
      }),
      /download failed/
    );

    assert.equal(fs.readdirSync(tempRoot).length, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

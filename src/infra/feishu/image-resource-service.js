const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TEMP_ROOT = path.join(os.tmpdir(), "codex-im-feishu-images");

async function downloadMessageImagesToTemp(feishuAdapter, {
  messageId,
  images,
  tempRoot = DEFAULT_TEMP_ROOT,
}) {
  const normalizedImages = Array.isArray(images) ? images : [];
  if (!normalizedImages.length) {
    return [];
  }

  await fs.promises.mkdir(tempRoot, { recursive: true });
  const files = [];
  let currentFilePath = "";
  try {
    for (let index = 0; index < normalizedImages.length; index += 1) {
      currentFilePath = "";
      const image = normalizedImages[index] || {};
      const resource = await feishuAdapter.downloadImageByKey({
        messageId,
        imageKey: image.imageKey,
      });
      const extension = inferImageExtension(resource);
      currentFilePath = path.join(tempRoot, `${sanitizeFileToken(messageId) || "message"}-${index + 1}.${extension}`);
      await fs.promises.writeFile(currentFilePath, resource.buffer);
      files.push({
        path: currentFilePath,
        mimeType: resource.mimeType || "",
        imageKey: image.imageKey || "",
      });
    }
  } catch (error) {
    await cleanupTempFiles(currentFilePath ? [...files, { path: currentFilePath }] : files);
    throw error;
  }
  return files;
}

async function cleanupTempFiles(files) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  for (const file of normalizedFiles) {
    const filePath = typeof file?.path === "string" ? file.path : "";
    if (!filePath) {
      continue;
    }
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`[codex-im] temp image cleanup failed path=${filePath}: ${error.message}`);
      }
    }
  }
}

function inferImageExtension(resource) {
  const mimeType = String(resource?.mimeType || "").toLowerCase();
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return "jpg";
  }
  if (mimeType === "image/gif") {
    return "gif";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  if (mimeType === "image/bmp") {
    return "bmp";
  }

  const buffer = Buffer.isBuffer(resource?.buffer) ? resource.buffer : Buffer.alloc(0);
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "gif";
  }
  return "img";
}

function sanitizeFileToken(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

module.exports = {
  cleanupTempFiles,
  downloadMessageImagesToTemp,
  inferImageExtension,
};

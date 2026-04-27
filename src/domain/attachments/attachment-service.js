const fs = require("fs");
const path = require("path");
const { formatFailureText } = require("../../shared/error-text");

async function handleImageMessage(runtime, normalized) {
  const image = extractFirstImageAttachment(normalized);
  if (!image?.resourceKey) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        "我收到图片了，但没有从飞书事件里解析到图片资源键。",
        "",
        "这一步先停住，不会猜测下载地址。需要再看一条真实事件结构。",
      ].join("\n"),
    });
    return;
  }

  try {
    const filePath = buildImageCachePath(runtime.config, normalized, image);
    const result = await runtime.requireFeishuAdapter().downloadMessageResource({
      messageId: normalized.messageId,
      fileKey: image.resourceKey,
      type: "image",
      filePath,
    });
    const stats = fs.statSync(filePath);
    assertCachedImageSize(runtime.config, filePath, stats.size);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildImageDownloadedText({
        filePath: result.filePath || filePath,
        size: stats.size,
        headers: result.headers,
      }),
    });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        "我收到图片了，但飞书图片下载这一步失败。",
        "",
        formatFailureText("下载失败", error),
        "",
        "文字链路不受影响；这通常是机器人缺少消息资源读取权限，或者图片资源键不匹配。",
      ].join("\n"),
    });
  }
}

function extractFirstImageAttachment(normalized) {
  const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
  return attachments.find((attachment) => attachment?.kind === "image") || null;
}

function buildImageCachePath(config, normalized, image) {
  const rootDir = config.attachmentsDir || path.join(process.env.HOME || "", ".codex", "yuan-feishu", "attachments");
  const day = normalizeDay(normalized.receivedAt);
  const messageId = sanitizePathPart(normalized.messageId || "message");
  const resourceKey = sanitizePathPart(image.resourceKey || "image");
  return path.join(rootDir, day, `${messageId}-${resourceKey}.bin`);
}

function normalizeDay(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function sanitizePathPart(value) {
  const normalized = String(value || "").trim();
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96) || "item";
}

function assertCachedImageSize(config, filePath, size) {
  const maxBytes = Number(config.maxImageBytes || 0);
  if (maxBytes > 0 && size > maxBytes) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup; the caller still gets the size-limit error.
    }
    throw new Error(`image is too large: ${size} bytes > ${maxBytes} bytes`);
  }
}

function buildImageDownloadedText({ filePath, size, headers }) {
  const contentType = normalizeHeader(headers, "content-type") || "unknown";
  return [
    "我收到图片了，也已经把原图下载到本地私有缓存。",
    "",
    `本地路径：\`${filePath}\``,
    `大小：${size} bytes`,
    `类型：${contentType}`,
    "",
    "现在还没有把图片发进 Codex 多模态，只是验证飞书下载链路。下一步再接视觉理解。",
  ].join("\n");
}

function normalizeHeader(headers, name) {
  if (!headers || typeof headers !== "object") {
    return "";
  }
  const direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  if (typeof direct === "string") {
    return direct;
  }
  return Array.isArray(direct) ? direct.join(", ") : "";
}

module.exports = {
  handleImageMessage,
};

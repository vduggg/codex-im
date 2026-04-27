const fs = require("fs");
const path = require("path");
const { formatFailureText } = require("../../shared/error-text");

async function prepareImageMessage(runtime, normalized, { workspaceRoot = "" } = {}) {
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
    return null;
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
    const contentType = normalizeHeader(result.headers, "content-type") || "image/png";
    return buildImageNormalizedMessage({
      normalized,
      filePath: result.filePath || filePath,
      size: stats.size,
      contentType,
      workspaceRoot,
    });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        "我收到图片了，但图片理解这一步还没走通。",
        "",
        formatFailureText("图片处理失败", error),
        "",
        "文字链路不受影响；原图只保存在本地私有缓存，不会写入 Obsidian。",
      ].join("\n"),
    });
    return null;
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

function buildImageNormalizedMessage({ normalized, filePath, size, contentType, workspaceRoot }) {
  const userText = normalizeUserImageText(normalized.text);
  const text = [
    userText,
    "",
    "[System note: Jiao sent an image through Feishu. The bridge downloaded the original image to local private cache and attached it to this Codex turn as a native image input. Look at the attached image directly; do not treat this note as a replacement for visual inspection.]",
  ].join("\n");

  return {
    ...normalized,
    text,
    command: "message",
    attachments: [
      ...preserveNonDownloadedAttachments(normalized.attachments),
      {
        kind: "image",
        filePath,
        size,
        contentType,
        workspaceRoot,
        resourceKey: extractFirstImageAttachment(normalized)?.resourceKey || "",
      },
    ],
    imageContext: { filePath, size, contentType, mode: "native" },
  };
}

function normalizeUserImageText(text) {
  const normalized = String(text || "").trim();
  return normalized || "请看这张图片。";
}

function preserveNonDownloadedAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((attachment) => attachment?.kind !== "image" || attachment.filePath);
}

module.exports = {
  prepareImageMessage,
};

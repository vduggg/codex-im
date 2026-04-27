const path = require("path");

const IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const FEISHU_AUDIO_EXTENSIONS = new Set([
  ".mp4",
  ".opus",
]);

const SAFE_TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".conf",
  ".csv",
  ".css",
  ".env",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".text",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function classifyLocalAttachment(filePath) {
  const ext = getLowerExtension(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (FEISHU_AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  return "file";
}

function inferFeishuFileType(filePath) {
  const ext = getLowerExtension(filePath);
  if (ext === ".opus") {
    return "opus";
  }
  if (ext === ".mp4") {
    return "mp4";
  }
  if (ext === ".pdf") {
    return "pdf";
  }
  if (ext === ".doc" || ext === ".docx") {
    return "doc";
  }
  if (ext === ".xls" || ext === ".xlsx" || ext === ".csv") {
    return "xls";
  }
  if (ext === ".ppt" || ext === ".pptx") {
    return "ppt";
  }
  return "stream";
}

function isSafeTextFile(filePath, contentType = "") {
  const ext = getLowerExtension(filePath);
  if (SAFE_TEXT_EXTENSIONS.has(ext)) {
    return true;
  }
  const normalizedContentType = String(contentType || "").toLowerCase();
  return normalizedContentType.startsWith("text/")
    || normalizedContentType.includes("json")
    || normalizedContentType.includes("xml");
}

function getLowerExtension(filePath) {
  return path.extname(String(filePath || "")).toLowerCase();
}

module.exports = {
  FEISHU_AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  SAFE_TEXT_EXTENSIONS,
  classifyLocalAttachment,
  inferFeishuFileType,
  isSafeTextFile,
};

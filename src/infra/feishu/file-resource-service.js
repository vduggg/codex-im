const fs = require("fs");
const path = require("path");

async function saveMessageFilesToWorkspaceInbox(feishuAdapter, {
  messageId,
  workspaceRoot,
  files,
  now = () => new Date(),
} = {}) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  if (!normalizedFiles.length) {
    return [];
  }

  const inboxRoot = path.join(String(workspaceRoot || ""), ".codex-im", "inbox");
  await fs.promises.mkdir(inboxRoot, { recursive: true });

  const savedFiles = [];
  try {
    for (let index = 0; index < normalizedFiles.length; index += 1) {
      const file = normalizedFiles[index] || {};
      const resource = await feishuAdapter.downloadFileByKey({
        messageId,
        fileKey: file.fileKey,
      });
      const targetName = buildUniqueInboxFileName({
        inboxRoot,
        fileName: file.fileName,
        timestamp: formatUtcTimestamp(now()),
      });
      const targetPath = path.join(inboxRoot, targetName);
      await fs.promises.writeFile(targetPath, resource.buffer);
      savedFiles.push({
        path: targetPath,
        relativePath: path.posix.join(".codex-im", "inbox", targetName),
        fileKey: file.fileKey || "",
        fileName: normalizeSourceFileName(file.fileName),
        mimeType: resource.mimeType || "",
      });
    }
  } catch (error) {
    await cleanupInboxFiles(savedFiles);
    throw error;
  }

  return savedFiles;
}

async function cleanupInboxFiles(files) {
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
        console.warn(`[codex-im] inbox file cleanup failed path=${filePath}: ${error.message}`);
      }
    }
  }
}

function buildUniqueInboxFileName({ inboxRoot, fileName, timestamp }) {
  const normalizedName = normalizeSourceFileName(fileName);
  const parsed = path.parse(normalizedName);
  const baseName = parsed.name || "file";
  const extension = parsed.ext || "";
  let attempt = 0;

  while (true) {
    const suffix = attempt > 0 ? `-${attempt + 1}` : "";
    const candidate = `${timestamp}-${baseName}${suffix}${extension}`;
    if (!fs.existsSync(path.join(inboxRoot, candidate))) {
      return candidate;
    }
    attempt += 1;
  }
}

function normalizeSourceFileName(fileName) {
  const baseName = path.basename(typeof fileName === "string" && fileName.trim() ? fileName.trim() : "file");
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "file";
}

function formatUtcTimestamp(date) {
  const value = date instanceof Date ? date : new Date(date);
  const year = String(value.getUTCFullYear()).padStart(4, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  const seconds = String(value.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

module.exports = {
  cleanupInboxFiles,
  saveMessageFilesToWorkspaceInbox,
};

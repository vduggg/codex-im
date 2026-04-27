const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

async function summarizeImage({ config, filePath, contentType, userText = "", workspaceRoot = "", model = "" }) {
  const visionConfig = config.vision || {};
  if (visionConfig.enabled === false) {
    throw new Error("Vision is disabled. Set CODEX_IM_VISION_ENABLED=true to enable image understanding.");
  }
  const provider = normalizeVisionProvider(visionConfig.provider);
  if (provider === "codex-cli") {
    return summarizeImageWithCodexCli({
      visionConfig,
      filePath,
      userText,
      workspaceRoot,
      model,
    });
  }
  return summarizeImageWithResponsesApi({
    visionConfig,
    filePath,
    contentType,
    userText,
  });
}

async function summarizeImageWithResponsesApi({ visionConfig, filePath, contentType, userText }) {
  if (!visionConfig.apiKey) {
    throw new Error("Vision API key is missing. Set CODEX_IM_VISION_API_KEY or OPENAI_API_KEY.");
  }

  const baseUrl = normalizeBaseUrl(visionConfig.baseUrl);
  const model = visionConfig.model || "gpt-4.1-mini";
  const timeoutMs = Number(visionConfig.timeoutMs || 60000);
  const imageDataUrl = buildImageDataUrl(filePath, contentType);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${visionConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildVisionPrompt(userText),
              },
              {
                type: "input_image",
                image_url: imageDataUrl,
              },
            ],
          },
        ],
        max_output_tokens: Number(visionConfig.maxOutputTokens || 800),
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(formatOpenAiError(response.status, payload));
    }
    const text = extractResponseText(payload);
    if (!text) {
      throw new Error("Vision response did not include text output");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeImageWithCodexCli({ visionConfig, filePath, userText, workspaceRoot, model }) {
  const command = visionConfig.codexCommand || "codex";
  const resolvedModel = String(model || visionConfig.model || "").trim();
  const timeoutMs = Number(visionConfig.timeoutMs || 60000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yuan-feishu-vision-"));
  const outputPath = path.join(tempDir, "summary.txt");
  const cwd = normalizeWorkspaceRoot(workspaceRoot);
  const args = [
    "exec",
    "-C",
    cwd,
    "--skip-git-repo-check",
    "--ephemeral",
    "--image",
    filePath,
    "-o",
    outputPath,
    "--color",
    "never",
    "--",
    buildVisionPrompt(userText),
  ];
  if (resolvedModel) {
    args.splice(7, 0, "--model", resolvedModel);
  }

  try {
    await runCommand(command, args, { timeoutMs });
    const text = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "";
    if (!text) {
      throw new Error("Codex CLI vision response did not include text output");
    }
    return text;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

function buildVisionPrompt(userText) {
  const suffix = String(userText || "").trim()
    ? `\n\nJiao accompanying text:\n${String(userText).trim()}`
    : "";
  return [
    "请用中文理解这张图片，输出给后续 Codex 文本链路使用。",
    "要求：",
    "1. 先概括图片内容。",
    "2. 提取关键文字、数字、路径、错误信息、按钮状态或界面元素。",
    "3. 如果是截图，判断用户可能想让我处理什么。",
    "4. 不要编造看不见的信息；不确定就写不确定。",
    suffix,
  ].filter(Boolean).join("\n");
}

function buildImageDataUrl(filePath, contentType) {
  const mime = normalizeContentType(contentType);
  const encoded = fs.readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${encoded}`;
}

function normalizeContentType(contentType) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(normalized)) {
    return normalized;
  }
  return "image/png";
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function normalizeVisionProvider(provider) {
  const normalized = String(provider || "codex-cli").trim().toLowerCase();
  return normalized === "responses" || normalized === "responses-api" ? "responses" : "codex-cli";
}

function normalizeWorkspaceRoot(workspaceRoot) {
  const normalized = String(workspaceRoot || "").trim();
  return normalized || process.cwd();
}

async function runCommand(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill failures; the timeout error is enough for the caller.
      }
      reject(new Error(`Codex CLI vision timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(buildCommandFailureMessage(command, code, stdout, stderr)));
    });
  });
}

function buildCommandFailureMessage(command, code, stdout, stderr) {
  const detail = [stderr, stdout]
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
  return `${command} exited with code ${code}${detail ? `: ${detail}` : ""}`;
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = part?.text || part?.summary || "";
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
      }
    }
  }
  return parts.join("\n\n").trim();
}

function formatOpenAiError(status, payload) {
  const message = payload?.error?.message || payload?.message || "unknown error";
  return `Vision API failed: HTTP ${status} ${message}`;
}

module.exports = {
  summarizeImage,
};

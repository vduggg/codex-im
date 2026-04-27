const fs = require("fs");

async function summarizeImage({ config, filePath, contentType, userText = "" }) {
  const visionConfig = config.vision || {};
  if (visionConfig.enabled === false) {
    throw new Error("Vision is disabled. Set CODEX_IM_VISION_ENABLED=true to enable image understanding.");
  }
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

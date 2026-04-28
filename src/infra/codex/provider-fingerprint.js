const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function readCodexProviderState({
  configPath = defaultCodexConfigPath(),
  appServerProfile = "",
} = {}) {
  const raw = readFileSafely(configPath);
  const config = parseCodexConfig(raw);
  const providerName = config.modelProvider || "default";
  const providerBlock = config.providers[providerName] || {};
  const baseUrl = providerBlock.baseUrl || "";
  const host = extractHost(baseUrl);
  const state = {
    appServerProfile: normalizeValue(appServerProfile) || "main",
    modelProvider: providerName,
    model: config.model || "",
    baseUrl,
    baseUrlHost: host,
    wireApi: providerBlock.wireApi || "",
    requiresOpenaiAuth: providerBlock.requiresOpenaiAuth || "",
  };
  return {
    ...state,
    key: buildProviderKey(state),
    label: buildProviderLabel(state),
  };
}

function parseCodexConfig(raw) {
  const result = {
    modelProvider: "",
    model: "",
    providers: {},
  };
  let section = "";
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const sectionMatch = trimmed.match(/^\[model_providers\.([^\]]+)\]$/);
    if (sectionMatch) {
      section = `model_providers.${stripTomlQuotes(sectionMatch[1])}`;
      continue;
    }
    if (trimmed.startsWith("[")) {
      section = "";
      continue;
    }
    const pair = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!pair) {
      continue;
    }
    const key = pair[1];
    const value = parseTomlScalar(pair[2]);
    if (!section) {
      if (key === "model_provider") {
        result.modelProvider = value;
      } else if (key === "model") {
        result.model = value;
      }
      continue;
    }
    if (section.startsWith("model_providers.")) {
      const providerName = section.slice("model_providers.".length);
      result.providers[providerName] = result.providers[providerName] || {};
      if (key === "base_url") {
        result.providers[providerName].baseUrl = value;
      } else if (key === "wire_api") {
        result.providers[providerName].wireApi = value;
      } else if (key === "requires_openai_auth") {
        result.providers[providerName].requiresOpenaiAuth = value;
      }
    }
  }
  return result;
}

function buildProviderKey(state) {
  const hashInput = JSON.stringify({
    appServerProfile: state.appServerProfile || "main",
    modelProvider: state.modelProvider || "",
    baseUrl: state.baseUrl || "",
    wireApi: state.wireApi || "",
    requiresOpenaiAuth: String(state.requiresOpenaiAuth || ""),
  });
  return `provider:${crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 12)}`;
}

function buildProviderLabel(state) {
  const profile = state.appServerProfile || "main";
  const provider = state.modelProvider || "default";
  const route = state.baseUrlHost || (state.requiresOpenaiAuth === "true" ? "official-auth" : "default");
  return `${profile}/${provider}/${route}`;
}

function parseTomlScalar(rawValue) {
  const withoutComment = String(rawValue || "").replace(/\s+#.*$/, "").trim();
  if (withoutComment === "true" || withoutComment === "false") {
    return withoutComment;
  }
  return stripTomlQuotes(withoutComment);
}

function stripTomlQuotes(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

function extractHost(baseUrl) {
  try {
    return baseUrl ? new URL(baseUrl).host : "";
  } catch {
    return "";
  }
}

function readFileSafely(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function defaultCodexConfigPath() {
  return path.join(process.env.HOME || "", ".codex", "config.toml");
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  parseCodexConfig,
  readCodexProviderState,
};

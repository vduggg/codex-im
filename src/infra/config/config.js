const path = require("path");
const os = require("os");

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const ALLOWED_ACCESS_MODES = new Set(["default", "full-access"]);

function readConfig() {
  const mode = process.argv[2] || "";

  return {
    mode,
    workspaceAllowlist: readListEnv("CODEX_IM_WORKSPACE_ALLOWLIST"),
    codexEndpoint: process.env.CODEX_IM_CODEX_ENDPOINT || "",
    codexCommand: process.env.CODEX_IM_CODEX_COMMAND || "",
    codexAppServerProfile: readTextEnv("CODEX_IM_CODEX_APP_SERVER_PROFILE"),
    defaultCodexModel: readTextEnv("CODEX_IM_DEFAULT_CODEX_MODEL"),
    defaultCodexEffort: readTextEnv("CODEX_IM_DEFAULT_CODEX_EFFORT"),
    defaultCodexAccessMode: readAccessModeEnv("CODEX_IM_DEFAULT_CODEX_ACCESS_MODE"),
    feishu: {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
    },
    defaultWorkspaceId: process.env.CODEX_IM_DEFAULT_WORKSPACE_ID || "default",
    feishuStreamingOutput: readBooleanEnv("CODEX_IM_FEISHU_STREAMING_OUTPUT", true),
    feishuCardKitStreaming: readBooleanEnv("CODEX_IM_FEISHU_CARDKIT_STREAMING", true),
    codexRpcTimeoutMs: readPositiveIntEnv("CODEX_IM_CODEX_RPC_TIMEOUT_MS", 45000),
    codexTurnStartTimeoutMs: readPositiveIntEnv("CODEX_IM_CODEX_TURN_START_TIMEOUT_MS", 60000),
    staleTurnTimeoutMs: readPositiveIntEnv("CODEX_IM_STALE_TURN_TIMEOUT_MS", 30 * 60 * 1000),
    sessionsFile: process.env.CODEX_IM_SESSIONS_FILE
      || path.join(os.homedir(), ".codex-im", "sessions.json"),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBooleanEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveIntEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function readAccessModeEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return ALLOWED_ACCESS_MODES.has(value) ? value : "";
}

module.exports = { readConfig };

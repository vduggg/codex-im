const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { SessionStore } = require("../src/infra/storage/session-store");
const { parseCodexConfig, readCodexProviderState } = require("../src/infra/codex/provider-fingerprint");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yuan-feishu-provider-"));
const sessionsFile = path.join(tempDir, "sessions.json");
const store = new SessionStore({ filePath: sessionsFile });
const bindingKey = "workspace:chat:sender:user";
const workspaceRoot = "/tmp/yuan-feishu";

store.setThreadIdForWorkspace(bindingKey, workspaceRoot, "thread-proxy", {
  providerKey: "provider:proxy",
  providerLabel: "main/OpenAI/api.pptoken.org",
});
store.setThreadIdForWorkspace(bindingKey, workspaceRoot, "thread-official", {
  providerKey: "provider:official",
  providerLabel: "main/OpenAI/official-auth",
});

assert.strictEqual(
  store.getThreadIdForWorkspace(bindingKey, workspaceRoot, "provider:proxy"),
  "thread-proxy"
);
assert.strictEqual(
  store.getThreadIdForWorkspace(bindingKey, workspaceRoot, "provider:official"),
  "thread-official"
);
assert.strictEqual(
  store.getThreadIdForWorkspace(bindingKey, workspaceRoot, "provider:missing"),
  ""
);
assert.strictEqual(
  store.getThreadIdForWorkspace(bindingKey, workspaceRoot),
  "thread-official"
);

const parsed = parseCodexConfig(`
model_provider = "OpenAI"
model = "gpt-5.5"

[model_providers.OpenAI]
base_url = "https://api.pptoken.org/v1"
wire_api = "responses"
requires_openai_auth = false
`);
assert.strictEqual(parsed.modelProvider, "OpenAI");
assert.strictEqual(parsed.providers.OpenAI.baseUrl, "https://api.pptoken.org/v1");

const configPath = path.join(tempDir, "config.toml");
fs.writeFileSync(configPath, `
model_provider = "OpenAI"
model = "gpt-5.5"

[model_providers.OpenAI]
base_url = "https://api.pptoken.org/v1"
wire_api = "responses"
requires_openai_auth = false
`);
const provider = readCodexProviderState({ configPath, appServerProfile: "" });
assert.strictEqual(provider.label, "main/OpenAI/api.pptoken.org");
assert.ok(provider.key.startsWith("provider:"));

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("provider routing fixtures ok");

const { spawn } = require("child_process");
const os = require("os");
const WebSocket = require("ws");
const { buildUserInputItems } = require("./user-input");

const IS_WINDOWS = os.platform() === "win32";
const DEFAULT_CODEX_COMMAND = "codex";
const WINDOWS_EXECUTABLE_SUFFIX_RE = /\.(cmd|exe|bat)$/i;
const CODEX_CLIENT_INFO = {
  name: "codex_im_agent",
  title: "Codex IM Agent",
  version: "0.2.0",
};

class CodexRpcClient {
  constructor({ endpoint = "", env = process.env, codexCommand = "" }) {
    this.endpoint = endpoint;
    this.env = env;
    this.codexCommand = codexCommand || resolveDefaultCodexCommand(env);
    this.mode = endpoint ? "websocket" : "spawn";
    this.socket = null;
    this.child = null;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.isReady = false;
    this.messageListeners = new Set();
    this.transportCloseListeners = new Set();
    this.transportCloseError = null;
  }

  async connect() {
    if (this.mode === "websocket") {
      await this.connectWebSocket();
      return;
    }

    await this.connectSpawn();
  }

  async connectSpawn() {
    const commandCandidates = buildCodexCommandCandidates(this.codexCommand);
    let child = null;
    let lastError = null;
    let selectedCommand = "";

    for (const command of commandCandidates) {
      try {
        const spawnSpec = buildSpawnSpec(command);
        child = spawn(spawnSpec.command, spawnSpec.args, {
          env: { ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        selectedCommand = command;
        child.once("spawn", () => {
          console.log(`[codex-im] spawned Codex app-server via ${spawnSpec.command} ${spawnSpec.args.join(" ")}`);
        });
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== "ENOENT" && error?.code !== "EINVAL") {
          throw error;
        }
      }
    }

    if (!child) {
      const attempted = commandCandidates.join(", ");
      const detail = lastError?.message ? `: ${lastError.message}` : "";
      throw new Error(`Unable to spawn Codex app-server. Tried ${attempted}${detail}. You can override with CODEX_IM_CODEX_COMMAND.`);
    }

    this.child = child;

    child.on("error", (error) => {
      this.handleTransportClosed(
        new Error(`Failed to spawn Codex app-server via ${selectedCommand || this.codexCommand}: ${error.message}`)
      );
      console.error(`[codex-im] failed to spawn Codex app-server via ${selectedCommand || this.codexCommand}: ${error.message}`);
    });

    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.handleIncoming(trimmed);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error(`[codex-im] codex stderr: ${text}`);
      }
    });

    child.on("close", (code) => {
      const message = code == null
        ? "Codex app-server exited"
        : `Codex app-server exited with code ${code}`;
      this.handleTransportClosed(new Error(message));
      console.error(`[codex-im] ${message}`);
    });
  }

  async connectWebSocket() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.endpoint);
      this.socket = socket;

      socket.on("open", () => resolve());
      socket.on("error", (error) => {
        this.handleTransportClosed(new Error(`Codex websocket error: ${error.message}`));
        reject(error);
      });
      socket.on("message", (chunk) => {
        const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (message.trim()) {
          this.handleIncoming(message);
        }
      });
      socket.on("close", () => {
        this.handleTransportClosed(new Error("Codex websocket closed"));
      });
    });
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onTransportClosed(listener) {
    this.transportCloseListeners.add(listener);
    return () => this.transportCloseListeners.delete(listener);
  }

  async initialize() {
    if (this.isReady) {
      return;
    }

    await this.sendRequest("initialize", {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.sendNotification("initialized", null);
    this.isReady = true;
  }

  async sendUserMessage({
    threadId,
    text,
    imagePaths = [],
    model = null,
    effort = null,
    accessMode = null,
    workspaceRoot = "",
  }) {
    const input = buildTurnInputPayload({
      text,
      imagePaths,
    });
    return threadId
      ? this.sendRequest(
        "turn/start",
        buildTurnStartParams({
          threadId,
          input,
          model,
          effort,
          accessMode,
          workspaceRoot,
        })
      )
      : this.sendRequest("thread/start", { input });
  }

  async startThread({ cwd }) {
    return this.sendRequest("thread/start", buildStartThreadParams(cwd));
  }

  async resumeThread({ threadId }) {
    const normalizedThreadId = normalizeNonEmptyString(threadId);
    if (!normalizedThreadId) {
      throw new Error("thread/resume requires a non-empty threadId");
    }
    return this.sendRequest("thread/resume", { threadId: normalizedThreadId });
  }

  async listThreads({ cursor = null, limit = 100, sortKey = "updated_at" } = {}) {
    return this.sendRequest("thread/list", buildListThreadsParams({
      cursor,
      limit,
      sortKey,
    }));
  }

  async listModels() {
    return this.sendRequest("model/list", {});
  }

  async sendRequest(method, params) {
    const id = createRequestId();
    const payload = JSON.stringify({ id, method, params });

    const responsePromise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    logCodexOutboundMessage(`request:${method}`, payload);
    this.sendRaw(payload);
    return responsePromise;
  }

  async sendNotification(method, params) {
    const payload = JSON.stringify({ method, params });
    logCodexOutboundMessage(`notification:${method}`, payload);
    this.sendRaw(payload);
  }

  async sendResponse(id, result) {
    const payload = JSON.stringify({ id, result });
    logCodexOutboundMessage("response", payload);
    this.sendRaw(payload);
  }

  sendRaw(payload) {
    if (this.mode === "websocket") {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("Codex websocket is not connected");
      }
      this.socket.send(payload);
      return;
    }

    if (!this.child || !this.child.stdin.writable) {
      throw this.transportCloseError || new Error("Codex process stdin is not writable");
    }
    this.child.stdin.write(`${payload}\n`);
  }

  handleTransportClosed(error) {
    if (this.transportCloseError) {
      return;
    }

    this.isReady = false;
    this.transportCloseError = error;

    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();

    for (const listener of this.transportCloseListeners) {
      listener(error);
    }
  }

  handleIncoming(rawMessage) {
    const parsed = tryParseJson(rawMessage);
    if (!parsed) {
      logCodexParseFailure(rawMessage);
      return;
    }
    logCodexInboundMessage(parsed);

    if (parsed && parsed.id != null && this.pending.has(String(parsed.id))) {
      const { resolve, reject } = this.pending.get(String(parsed.id));
      this.pending.delete(String(parsed.id));
      if (parsed.error) {
        reject(new Error(parsed.error.message || "Codex RPC request failed"));
        return;
      }
      resolve(parsed);
      return;
    }

    for (const listener of this.messageListeners) {
      listener(parsed);
    }
  }
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tryParseJson(rawMessage) {
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function logCodexOutboundMessage(operation, payload) {
  try {
    console.log(`[codex-im] codex=> op=${operation} ${payload}`);
  } catch {
    console.log(`[codex-im] codex=> op=${operation} <unserializable payload>`);
  }
}

function logCodexInboundMessage(message) {
  try {
    console.log(`[codex-im] codex<= ${JSON.stringify(message)}`);
  } catch {
    console.log("[codex-im] codex<= <unserializable message>");
  }
}

function logCodexParseFailure(rawMessage) {
  const sample = String(rawMessage || "").slice(0, 300);
  console.warn(`[codex-im] codex<= [parse_failed] raw=${JSON.stringify(sample)}`);
}

function resolveDefaultCodexCommand(env = process.env) {
  return normalizeNonEmptyString(env.CODEX_IM_CODEX_COMMAND) || DEFAULT_CODEX_COMMAND;
}

function buildCodexCommandCandidates(configuredCommand) {
  const explicit = normalizeNonEmptyString(configuredCommand);
  if (explicit) {
    if (!IS_WINDOWS) {
      return [explicit];
    }

    const candidates = [explicit];
    if (!WINDOWS_EXECUTABLE_SUFFIX_RE.test(explicit)) {
      candidates.push(`${explicit}.cmd`, `${explicit}.exe`, `${explicit}.bat`);
    }
    return [...new Set(candidates)];
  }

  if (IS_WINDOWS) {
    return [DEFAULT_CODEX_COMMAND, `${DEFAULT_CODEX_COMMAND}.cmd`, `${DEFAULT_CODEX_COMMAND}.exe`, `${DEFAULT_CODEX_COMMAND}.bat`];
  }

  return [DEFAULT_CODEX_COMMAND];
}

function buildSpawnSpec(command) {
  if (IS_WINDOWS) {
    return {
      command: "cmd.exe",
      args: ["/c", command, "app-server"],
    };
  }

  return {
    command,
    args: ["app-server"],
  };
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function buildStartThreadParams(cwd) {
  const normalizedCwd = normalizeNonEmptyString(cwd);
  return normalizedCwd ? { cwd: normalizedCwd } : {};
}

function buildListThreadsParams({ cursor, limit, sortKey }) {
  const params = { limit, sortKey };
  const normalizedCursor = normalizeNonEmptyString(cursor);

  if (normalizedCursor) {
    params.cursor = normalizedCursor;
  } else if (cursor != null) {
    params.cursor = cursor;
  }

  return params;
}

function buildTurnInputPayload(payload) {
  return buildUserInputItems(payload);
}

function buildTurnStartParams({ threadId, input, model, effort, accessMode, workspaceRoot }) {
  const params = { threadId, input };
  const normalizedModel = normalizeNonEmptyString(model);
  const normalizedEffort = normalizeNonEmptyString(effort);
  const normalizedAccessMode = normalizeAccessMode(accessMode);
  const executionPolicies = buildExecutionPolicies(normalizedAccessMode, workspaceRoot);
  if (normalizedModel) {
    params.model = normalizedModel;
  }
  if (normalizedEffort) {
    params.effort = normalizedEffort;
  }
  if (normalizedAccessMode) {
    params.accessMode = normalizedAccessMode;
  }
  params.approvalPolicy = executionPolicies.approvalPolicy;
  params.sandboxPolicy = executionPolicies.sandboxPolicy;
  return params;
}

function normalizeAccessMode(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "default") {
    return "current";
  }
  return normalized === "full-access" ? normalized : "";
}

function buildExecutionPolicies(accessMode, workspaceRoot) {
  if (accessMode === "full-access") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  const normalizedWorkspaceRoot = normalizeNonEmptyString(workspaceRoot);
  const sandboxPolicy = normalizedWorkspaceRoot
    ? {
      type: "workspaceWrite",
      writableRoots: [normalizedWorkspaceRoot],
      networkAccess: true,
    }
    : {
      type: "workspaceWrite",
      networkAccess: true,
    };
  return {
    approvalPolicy: "on-request",
    sandboxPolicy,
  };
}

module.exports = { CodexRpcClient };

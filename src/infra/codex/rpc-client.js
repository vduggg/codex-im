const { spawn } = require("child_process");
const os = require("os");
const WebSocket = require("ws");

const IS_WINDOWS = os.platform() === "win32";
const DEFAULT_CODEX_COMMAND = "codex";
const WINDOWS_EXECUTABLE_SUFFIX_RE = /\.(cmd|exe|bat)$/i;
const CODEX_CLIENT_INFO = {
  name: "codex_im_agent",
  title: "Codex IM Agent",
  version: "0.2.0",
};

class CodexRpcClient {
  constructor({
    endpoint = "",
    env = process.env,
    codexCommand = "",
    appServerProfile = "",
    requestTimeoutMs = 45000,
    turnStartTimeoutMs = 60000,
  }) {
    this.endpoint = endpoint;
    this.env = env;
    this.codexCommand = codexCommand || resolveDefaultCodexCommand(env);
    this.appServerProfile = normalizeNonEmptyString(appServerProfile);
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnStartTimeoutMs = turnStartTimeoutMs;
    this.mode = endpoint ? "websocket" : "spawn";
    this.socket = null;
    this.child = null;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.isReady = false;
    this.messageListeners = new Set();
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
        const spawnSpec = buildSpawnSpec(command, this.appServerProfile);
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
      if (this.child !== child) {
        return;
      }
      this.isReady = false;
      this.rejectAllPending(error);
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
      if (this.child !== child) {
        return;
      }
      this.isReady = false;
      this.rejectAllPending(new Error(`Codex app-server exited with code ${code}`));
      console.error(`[codex-im] codex app-server exited with code ${code}`);
    });
  }

  async restartSpawn({ appServerProfile = "" } = {}) {
    if (this.mode === "websocket") {
      throw new Error("Cannot restart external Codex websocket endpoint from codex-im");
    }
    this.appServerProfile = normalizeNonEmptyString(appServerProfile);
    this.isReady = false;
    this.rejectAllPending(new Error("Codex app-server restarting"));
    if (this.child) {
      const child = this.child;
      this.child = null;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        child.once("close", finish);
        child.once("exit", finish);
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
        }
        setTimeout(finish, 3000);
      });
    }
    this.stdoutBuffer = "";
    await this.connectSpawn();
    await this.initialize();
  }

  async connectWebSocket() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.endpoint);
      this.socket = socket;
      let opened = false;

      socket.on("open", () => {
        opened = true;
        resolve();
      });
      socket.on("error", (error) => {
        this.isReady = false;
        if (!opened) {
          reject(error);
          return;
        }
        this.rejectAllPending(error);
      });
      socket.on("message", (chunk) => {
        const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (message.trim()) {
          this.handleIncoming(message);
        }
      });
      socket.on("close", () => {
        this.isReady = false;
        this.rejectAllPending(new Error("Codex websocket closed"));
      });
    });
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
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
    model = null,
    effort = null,
    accessMode = null,
    workspaceRoot = "",
  }) {
    const input = buildTurnInputPayload(text);
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

  async sendRequest(method, params, options = {}) {
    const id = createRequestId();
    const payload = JSON.stringify({ id, method, params });
    const timeoutMs = options.timeoutMs || this.getRequestTimeoutMs(method);

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    logCodexOutboundMessage(`request:${method}`, payload);
    try {
      this.sendRaw(payload);
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending) {
        pending.reject(error);
      }
    }
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
      throw new Error("Codex process stdin is not writable");
    }
    this.child.stdin.write(`${payload}\n`);
  }

  handleIncoming(rawMessage) {
    const parsed = tryParseJson(rawMessage);
    if (!parsed) {
      logCodexParseFailure(rawMessage);
      return;
    }
    logCodexInboundMessage(parsed);

    if (parsed && parsed.method) {
      for (const listener of this.messageListeners) {
        listener(parsed);
      }
      return;
    }

    if (parsed && parsed.id != null) {
      if (!this.pending.has(String(parsed.id))) {
        console.warn(`[codex-im] codex<= response for unknown or timed-out request id=${parsed.id}`);
        return;
      }
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

  getRequestTimeoutMs(method) {
    if (method === "turn/start") {
      return this.turnStartTimeoutMs;
    }
    return this.requestTimeoutMs;
  }

  rejectAllPending(error) {
    if (!this.pending.size) {
      return;
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(error);
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
    const summary = summarizeRawCodexPayload(payload);
    console.log(`[codex-im] codex=> op=${operation} ${summary}`);
  } catch {
    console.log(`[codex-im] codex=> op=${operation} <unserializable payload>`);
  }
}

function logCodexInboundMessage(message) {
  try {
    console.log(`[codex-im] codex<= ${summarizeCodexMessage(message)}`);
  } catch {
    console.log("[codex-im] codex<= <unserializable message>");
  }
}

function summarizeRawCodexPayload(payload) {
  const size = Buffer.byteLength(String(payload || ""), "utf8");
  const parsed = tryParseJson(payload);
  if (!parsed) {
    return `bytes=${size} raw=${JSON.stringify(String(payload || "").slice(0, 120))}`;
  }
  return `${summarizeCodexMessage(parsed)} payloadBytes=${size}`;
}

function summarizeCodexMessage(message) {
  const parts = [];
  if (message?.id != null) {
    parts.push(`id=${message.id}`);
  }
  if (message?.method) {
    parts.push(`method=${message.method}`);
  }
  const params = message?.params || {};
  const result = message?.result || {};
  const threadId = params.threadId || result.thread?.id;
  const turnId = params.turnId;
  const itemId = params.itemId || message?.item?.id;
  if (threadId) {
    parts.push(`thread=${threadId}`);
  }
  if (turnId) {
    parts.push(`turn=${turnId}`);
  }
  if (itemId) {
    parts.push(`item=${itemId}`);
  }
  if (message?.error?.message) {
    parts.push(`error=${JSON.stringify(message.error.message)}`);
  }
  if (result?.data && Array.isArray(result.data)) {
    parts.push(`resultItems=${result.data.length}`);
  }
  if (result?.thread?.turns && Array.isArray(result.thread.turns)) {
    parts.push(`turns=${result.thread.turns.length}`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
  parts.push(`bytes=${bytes}`);
  return parts.length ? parts.join(" ") : `bytes=${bytes}`;
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

function buildSpawnSpec(command, appServerProfile = "") {
  const normalizedProfile = normalizeNonEmptyString(appServerProfile);
  if (IS_WINDOWS) {
    const args = ["/c", command];
    if (normalizedProfile) {
      args.push("--profile", normalizedProfile);
    }
    args.push("app-server");
    return {
      command: "cmd.exe",
      args,
    };
  }

  const args = [];
  if (normalizedProfile) {
    args.push("--profile", normalizedProfile);
  }
  args.push("app-server");
  return {
    command,
    args,
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

function buildTurnInputPayload(text) {
  const normalizedText = normalizeNonEmptyString(text);
  const items = [];

  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
    });
  }

  return items;
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

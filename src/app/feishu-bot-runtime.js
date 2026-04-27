const { readConfig } = require("../infra/config/config");
const { SessionStore } = require("../infra/storage/session-store");
const { CodexRpcClient } = require("../infra/codex/rpc-client");
const {
  buildCardResponse,
  buildCardToast,
  buildDailyBridgeSummaryCard,
  buildEffortInfoText,
  buildEffortListText,
  buildEffortValidationErrorText,
  buildHelpCardText,
  buildModelInfoText,
  buildModelListText,
  buildModelValidationErrorText,
  buildMemoryBridgePanelCard,
  buildStatusPanelCard,
  buildThreadMessagesSummary,
  buildThreadPickerCard,
  buildTodoFormCard,
  buildWorkspaceBindingsCard,
  listBoundWorkspaces,
} = require("../presentation/card/builders");
const {
  addPendingReaction,
  clearPendingReactionForBinding,
  clearPendingReactionForThread,
  disposeReplyRunState,
  flushAssistantReplyCardNow,
  handleCardAction,
  movePendingReactionToThread,
  patchInteractiveCard,
  queueCardActionWithFeedback,
  runCardActionTask,
  sendCardActionFeedback,
  sendCardActionFeedbackByContext,
  sendInfoCardMessage,
  sendInteractiveApprovalCard,
  sendInteractiveCard,
  updateInteractiveCard,
  upsertAssistantReplyCard,
} = require("../presentation/card/card-service");
const {
  FeishuClientAdapter,
  patchWsClientForCardCallbacks,
} = require("../infra/feishu/client-adapter");
const runtimeCommands = require("./command-dispatcher");
const approvalRuntime = require("../domain/approval/approval-service");
const runtimeState = require("../domain/session/binding-context");
const threadRuntime = require("../domain/thread/thread-service");
const workspaceRuntime = require("../domain/workspace/workspace-service");
const memoryBridgeRuntime = require("../domain/memory-bridge/memory-bridge-service");
const hubRuntime = require("../domain/hub/hub-service");
const eventsRuntime = require("./codex-event-service");
const approvalPolicyRuntime = require("../domain/approval/approval-policy");
const appDispatcher = require("./dispatcher");
const { extractModelCatalogFromListResponse } = require("../shared/model-catalog");
const { extractProfileValue } = require("../shared/command-parsing");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const CODEX_APP_SERVER_PROFILES = Object.freeze({
  main: "",
  default: "",
  openai: "",
  deepseek: "deepseek-pro",
  "deepseek-pro": "deepseek-pro",
});

class FeishuBotRuntime {
  constructor(config = readConfig()) {
    this.config = config;
    this.sessionStore = new SessionStore({ filePath: config.sessionsFile });
    this.codex = new CodexRpcClient({
      endpoint: config.codexEndpoint,
      env: process.env,
      codexCommand: config.codexCommand,
      appServerProfile: config.codexAppServerProfile,
      requestTimeoutMs: config.codexRpcTimeoutMs,
      turnStartTimeoutMs: config.codexTurnStartTimeoutMs,
    });
    this.codexAppServerProfile = config.codexAppServerProfile || "";
    this.lark = null;
    this.client = null;
    this.wsClient = null;
    this.feishuAdapter = null;
    this.pendingChatContextByThreadId = new Map();
    this.pendingChatContextByBindingKey = new Map();
    this.activeTurnIdByThreadId = new Map();
    this.activeTurnStartedAtByThreadId = new Map();
    this.pendingApprovalByThreadId = new Map();
    this.replyCardByRunKey = new Map();
    this.currentRunKeyByThreadId = new Map();
    this.replyFlushTimersByRunKey = new Map();
    this.replyFlushInFlightByRunKey = new Map();
    this.replyFlushQueuedByRunKey = new Set();
    this.latestTokenUsageByThreadId = new Map();
    this.toolItemIdsByRunKey = new Map();
    this.toolTraceByRunKey = new Map();
    this.assistantDeltaSeenByRunKey = new Map();
    this.pendingReactionByBindingKey = new Map();
    this.pendingReactionByThreadId = new Map();
    this.bindingKeyByThreadId = new Map();
    this.workspaceRootByThreadId = new Map();
    this.approvalAllowlistByWorkspaceRoot = new Map();
    this.inFlightApprovalRequestKeys = new Set();
    this.resumedThreadIds = new Set();
    this.staleTurnWatchdog = null;
    this.memoryBridgeScheduler = null;
    this.codex.onMessage((message) => appDispatcher.onCodexMessage(this, message));
  }

  async start() {
    this.validateConfig();
    this.initializeFeishuSdk();
    await this.codex.connect();
    await this.codex.initialize();
    await this.refreshAvailableModelCatalogAtStartup();
    this.startLongConnection();
    this.startStaleTurnWatchdog();
    this.memoryBridgeScheduler = memoryBridgeRuntime.startDailyBridgeScheduler();
    console.log(`[codex-im] feishu-bot runtime ready for app ${maskSecret(this.config.feishu.appId)}`);
  }

  validateConfig() {
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required for feishu-bot mode");
    }
    if (!String(this.config.defaultCodexModel || "").trim()) {
      throw new Error("CODEX_IM_DEFAULT_CODEX_MODEL is required");
    }
    if (!String(this.config.defaultCodexEffort || "").trim()) {
      throw new Error("CODEX_IM_DEFAULT_CODEX_EFFORT is required");
    }
    if (!String(this.config.defaultCodexAccessMode || "").trim()) {
      throw new Error(
        "CODEX_IM_DEFAULT_CODEX_ACCESS_MODE is required and must be one of: default, full-access"
      );
    }
  }

  initializeFeishuSdk() {
    try {
      // Official SDK: https://github.com/larksuite/node-sdk
      this.lark = require("@larksuiteoapi/node-sdk");
    } catch {
      throw new Error(
        "Missing @larksuiteoapi/node-sdk. Run `npm install` in codex-im before starting feishu-bot mode."
      );
    }

    this.client = new this.lark.Client({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      appType: this.lark.AppType.SelfBuild,
      domain: this.lark.Domain.Feishu,
      loggerLevel: this.lark.LoggerLevel.info,
    });

    this.wsClient = new this.lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      appType: this.lark.AppType.SelfBuild,
      domain: this.lark.Domain.Feishu,
      loggerLevel: this.lark.LoggerLevel.info,
      wsConfig: {
        PingInterval: 30,
        PingTimeout: 5,
      },
    });
    this.feishuAdapter = new FeishuClientAdapter(this.client);
    patchWsClientForCardCallbacks(this.wsClient);
  }

  startLongConnection() {
    const eventDispatcher = new this.lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        appDispatcher.onFeishuTextEvent(this, data).catch((error) => {
          console.error(`[codex-im] failed to process Feishu message: ${error.message}`);
        });
      },
      "card.action.trigger": async (data) => appDispatcher.onFeishuCardAction(this, data),
    });

    this.wsClient.start({ eventDispatcher });
    console.log("[codex-im] Feishu long connection started");
  }

  async refreshAvailableModelCatalogAtStartup() {
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      throw new Error("model/list returned no models at startup");
    }
    this.sessionStore.setAvailableModelCatalog(models);
    const validatedDefaults = workspaceRuntime.validateDefaultCodexParamsConfig(this, models);
    if (!validatedDefaults.model) {
      throw new Error(`Invalid CODEX_IM_DEFAULT_CODEX_MODEL: ${this.config.defaultCodexModel}`);
    }
    if (!validatedDefaults.effort) {
      throw new Error(
        `Invalid CODEX_IM_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${validatedDefaults.model}`
      );
    }
    console.log(`[codex-im] model catalog refreshed at startup: ${models.length} entries`);
  }

  startStaleTurnWatchdog() {
    const timeoutMs = Number(this.config.staleTurnTimeoutMs || 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || this.staleTurnWatchdog) {
      return;
    }
    const intervalMs = Math.max(30000, Math.min(60000, Math.floor(timeoutMs / 3)));
    this.staleTurnWatchdog = setInterval(() => {
      this.clearStaleTurns(timeoutMs).catch((error) => {
        console.error(`[codex-im] stale turn watchdog failed: ${error.message}`);
      });
    }, intervalMs);
    if (typeof this.staleTurnWatchdog.unref === "function") {
      this.staleTurnWatchdog.unref();
    }
  }

  async clearStaleTurns(timeoutMs) {
    const now = Date.now();
    for (const [threadId, startedAt] of this.activeTurnStartedAtByThreadId.entries()) {
      if (!startedAt || now - startedAt < timeoutMs) {
        continue;
      }
      const context = this.pendingChatContextByThreadId.get(threadId);
      const turnId = this.activeTurnIdByThreadId.get(threadId) || "";
      console.warn(`[codex-im] stale turn detected thread=${threadId} turn=${turnId}`);
      this.cleanupThreadRuntimeState(threadId);
      if (context?.chatId) {
        await this.sendInfoCardMessage({
          chatId: context.chatId,
          replyToMessageId: context.messageId,
          text: "检测到 Codex 长时间没有返回完成事件，我已清理飞书端运行状态。可以继续发消息；如果上一个任务仍在终端侧运行，先发 `/codex stop` 再继续更稳。",
        });
      }
    }
  }

  resolveReplyToMessageId(normalized, replyToMessageId = "") {
    return replyToMessageId || normalized.messageId;
  }

  getBindingContext(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    let workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      workspaceRoot = this.inheritThreadBindingFromSender(normalized, bindingKey);
    }
    return { bindingKey, workspaceRoot };
  }

  inheritThreadBindingFromSender(normalized, bindingKey) {
    const threadKey = typeof normalized?.threadKey === "string" ? normalized.threadKey.trim() : "";
    const messageId = typeof normalized?.messageId === "string" ? normalized.messageId.trim() : "";
    const hasStableThreadKey = threadKey && threadKey !== messageId;
    if (!hasStableThreadKey) {
      return "";
    }

    const senderBindingKey = this.sessionStore.buildBindingKey({
      ...normalized,
      threadKey: "",
      messageId: "",
    });
    if (!senderBindingKey || senderBindingKey === bindingKey) {
      return "";
    }

    const inheritedWorkspaceRoot = this.resolveWorkspaceRootForBinding(senderBindingKey);
    if (!inheritedWorkspaceRoot) {
      return "";
    }

    const inheritedParams = this.sessionStore.getCodexParamsForWorkspace(
      senderBindingKey,
      inheritedWorkspaceRoot
    );

    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      inheritedWorkspaceRoot,
      "",
      {
        workspaceId: normalized.workspaceId,
        chatId: normalized.chatId,
        threadKey: normalized.threadKey,
        senderId: normalized.senderId,
        inheritedFromBindingKey: senderBindingKey,
        threadScopedBinding: true,
      }
    );
    if (inheritedParams.model || inheritedParams.effort) {
      this.sessionStore.setCodexParamsForWorkspace(bindingKey, inheritedWorkspaceRoot, inheritedParams);
    }

    console.log(
      `[codex-im] inherited workspace binding from sender binding for feishu thread=${threadKey} workspace=${inheritedWorkspaceRoot}`
    );
    return inheritedWorkspaceRoot;
  }

  getCurrentThreadContext(normalized) {
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    const threadId = workspaceRoot ? this.resolveThreadIdForBinding(bindingKey, workspaceRoot) : "";
    return { bindingKey, workspaceRoot, threadId };
  }

  requireFeishuAdapter() {
    if (!this.feishuAdapter) {
      throw new Error("Feishu adapter is not initialized");
    }
    return this.feishuAdapter;
  }

  describeCodexAppServerProfile() {
    return this.codexAppServerProfile || "main";
  }

  async switchCodexAppServerProfile(profileAlias) {
    const rawAlias = String(profileAlias || "").trim().toLowerCase();
    if (!rawAlias) {
      return {
        ok: false,
        message: `当前 Codex 运行档：${this.describeCodexAppServerProfile()}\n\n用法：\`/codex profile main\` 或 \`/codex profile deepseek\``,
      };
    }
    if (!(rawAlias in CODEX_APP_SERVER_PROFILES)) {
      return {
        ok: false,
        message: "未知运行档。可用：`main`、`deepseek`。",
      };
    }
    if (this.activeTurnIdByThreadId.size > 0) {
      return {
        ok: false,
        message: "当前还有任务在运行。先等完成，或发送 `/codex stop` 后再切换运行档。",
      };
    }

    const nextProfile = CODEX_APP_SERVER_PROFILES[rawAlias];
    const currentProfile = this.codexAppServerProfile || "";
    if (nextProfile === currentProfile) {
      return {
        ok: true,
        message: `已经是当前运行档：${this.describeCodexAppServerProfile()}`,
      };
    }

    if (nextProfile === "deepseek-pro") {
      await ensureDeepSeekAdapter(process.env);
    }

    await this.codex.restartSpawn({ appServerProfile: nextProfile });
    this.codexAppServerProfile = nextProfile;
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (models.length) {
      this.sessionStore.setAvailableModelCatalog(models);
    }
    this.resumedThreadIds.clear();
    return {
      ok: true,
      message: `已切换 Codex 运行档：${this.describeCodexAppServerProfile()}`,
    };
  }

  async handleProfileCommand(normalized) {
    const value = extractProfileValue(normalized.text);
    if (!value) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: [
          `当前 Codex 运行档：${this.describeCodexAppServerProfile()}`,
          "",
          "用法：",
          "`/codex profile main`",
          "`/codex profile deepseek`",
          "",
          "说明：该命令会重启飞书桥背后的 Codex app-server；不会修改 OpenClaw。",
        ].join("\n"),
      });
      return;
    }
    try {
      const result = await this.switchCodexAppServerProfile(value);
      if (result.ok) {
        const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
        if (workspaceRoot) {
          this.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
            model: "",
            effort: "",
          });
        }
      }
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: result.ok
          ? `${result.message}\n\n当前项目的模型覆盖已清空，将使用该运行档默认模型。`
          : result.message,
      });
    } catch (error) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `切换 Codex 运行档失败：${error.message}`,
      });
    }
  }

  async resolveWorkspaceStats(workspaceRoot) {
    try {
      const stats = await fs.promises.stat(workspaceRoot);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, isDirectory: false };
      }
      throw error;
    }
  }
}

function attachRuntimeForwarders() {
  const proto = FeishuBotRuntime.prototype;

  const plainForwarders = {
    buildCardResponse,
    buildCardToast,
    buildDailyBridgeSummaryCard,
    buildEffortInfoText,
    buildEffortListText,
    buildEffortValidationErrorText,
    buildHelpCardText,
    buildMemoryBridgePanelCard,
    buildModelInfoText,
    buildModelListText,
    buildModelValidationErrorText,
    buildStatusPanelCard,
    buildThreadMessagesSummary,
    buildThreadPickerCard,
    buildTodoFormCard,
    buildWorkspaceBindingsCard,
    listBoundWorkspaces,
  };

  for (const [methodName, fn] of Object.entries(plainForwarders)) {
    proto[methodName] = function forwardedPlain(...args) {
      return fn(...args);
    };
  }

  const runtimeFirstForwarders = {
    dispatchTextCommand: runtimeCommands.dispatchTextCommand,
    resolveWorkspaceContext: workspaceRuntime.resolveWorkspaceContext,
    resolveWorkspaceThreadState: threadRuntime.resolveWorkspaceThreadState,
    ensureThreadAndSendMessage: threadRuntime.ensureThreadAndSendMessage,
    ensureThreadResumed: threadRuntime.ensureThreadResumed,
    resolveWorkspaceRootForBinding: runtimeState.resolveWorkspaceRootForBinding,
    resolveThreadIdForBinding: runtimeState.resolveThreadIdForBinding,
    setThreadBindingKey: runtimeState.setThreadBindingKey,
    setThreadWorkspaceRoot: runtimeState.setThreadWorkspaceRoot,
    setPendingBindingContext: runtimeState.setPendingBindingContext,
    setPendingThreadContext: runtimeState.setPendingThreadContext,
    setReplyCardEntry: runtimeState.setReplyCardEntry,
    setCurrentRunKeyForThread: runtimeState.setCurrentRunKeyForThread,
    resolveWorkspaceRootForThread: runtimeState.resolveWorkspaceRootForThread,
    rememberApprovalPrefixForWorkspace: approvalPolicyRuntime.rememberApprovalPrefixForWorkspace,
    shouldAutoApproveRequest: approvalPolicyRuntime.shouldAutoApproveRequest,
    tryAutoApproveRequest: approvalPolicyRuntime.tryAutoApproveRequest,
    applyApprovalDecision: approvalRuntime.applyApprovalDecision,
    sendApprovalPrompt: approvalRuntime.sendApprovalPrompt,
    handleBindCommand: workspaceRuntime.handleBindCommand,
    handleWhereCommand: workspaceRuntime.handleWhereCommand,
    showStatusPanel: workspaceRuntime.showStatusPanel,
    handleMessageCommand: workspaceRuntime.handleMessageCommand,
    handleHelpCommand: workspaceRuntime.handleHelpCommand,
    handleUnknownCommand: workspaceRuntime.handleUnknownCommand,
    handleWorkspacesCommand: workspaceRuntime.handleWorkspacesCommand,
    showThreadPicker: workspaceRuntime.showThreadPicker,
    handleNewCommand: threadRuntime.handleNewCommand,
    handleSwitchCommand: threadRuntime.handleSwitchCommand,
    handleRemoveCommand: workspaceRuntime.handleRemoveCommand,
    handleSendCommand: workspaceRuntime.handleSendCommand,
    handleModelCommand: workspaceRuntime.handleModelCommand,
    handleEffortCommand: workspaceRuntime.handleEffortCommand,
    handleBridgeCommand: memoryBridgeRuntime.handleBridgeCommand,
    handleMemoryCommand: memoryBridgeRuntime.handleMemoryCommand,
    handleMemoryHelpCommand: memoryBridgeRuntime.handleMemoryHelpCommand,
    handleTodayCommand: memoryBridgeRuntime.handleTodayCommand,
    handleTodoCommand: memoryBridgeRuntime.handleTodoCommand,
    handleTodoFormCommand: memoryBridgeRuntime.handleTodoFormCommand,
    handleTodoSubmitCardAction: memoryBridgeRuntime.handleTodoSubmitCardAction,
    handleRecallCommand: memoryBridgeRuntime.handleRecallCommand,
    handleHubCommand: hubRuntime.handleHubCommand,
    refreshWorkspaceThreads: threadRuntime.refreshWorkspaceThreads,
    describeWorkspaceStatus: threadRuntime.describeWorkspaceStatus,
    switchThreadById: threadRuntime.switchThreadById,
    handleStopCommand: eventsRuntime.handleStopCommand,
    handleApprovalCommand: approvalRuntime.handleApprovalCommand,
    deliverToFeishu: eventsRuntime.deliverToFeishu,
    sendInfoCardMessage,
    sendInteractiveApprovalCard,
    updateInteractiveCard,
    sendInteractiveCard,
    patchInteractiveCard,
    handleCardAction,
    dispatchCardAction: runtimeCommands.dispatchCardAction,
    handleMemoryCardAction: runtimeCommands.handleMemoryCardAction,
    handlePanelCardAction: runtimeCommands.handlePanelCardAction,
    handleThreadCardAction: runtimeCommands.handleThreadCardAction,
    handleWorkspaceCardAction: runtimeCommands.handleWorkspaceCardAction,
    queueCardActionWithFeedback,
    runCardActionTask,
    handleApprovalCardActionAsync: approvalRuntime.handleApprovalCardActionAsync,
    sendCardActionFeedbackByContext,
    sendCardActionFeedback,
    switchWorkspaceByPath: workspaceRuntime.switchWorkspaceByPath,
    removeWorkspaceByPath: workspaceRuntime.removeWorkspaceByPath,
    upsertAssistantReplyCard,
    flushAssistantReplyCardNow,
    addPendingReaction,
    movePendingReactionToThread,
    clearPendingReactionForBinding,
    clearPendingReactionForThread,
    disposeReplyRunState,
    cleanupThreadRuntimeState: runtimeState.cleanupThreadRuntimeState,
    pruneRuntimeMapSizes: runtimeState.pruneRuntimeMapSizes,
  };

  for (const [methodName, fn] of Object.entries(runtimeFirstForwarders)) {
    proto[methodName] = function forwardedRuntimeFirst(...args) {
      return fn(this, ...args);
    };
  }

  proto.getCodexParamsForWorkspace = function getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    return this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  };
}

attachRuntimeForwarders();

FeishuBotRuntime.prototype.sendFileMessage = function sendFileMessage(args) {
  return this.requireFeishuAdapter().sendFileMessage(args);
};

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

module.exports = { FeishuBotRuntime };

function ensureDeepSeekAdapter(env = process.env) {
  return new Promise((resolve, reject) => {
    checkDeepSeekAdapter((isAlive) => {
      if (isAlive) {
        resolve();
        return;
      }
      const adapterScript = path.join(env.HOME || "", ".codex", "bin", "start-deepseek-litellm.sh");
      const adapterEnv = { ...env };
      if (!adapterEnv.DEEPSEEK_API_KEY) {
        adapterEnv.DEEPSEEK_API_KEY = readDeepSeekApiKeyFromOpenClaw(env.HOME || "");
      }
      if (!adapterEnv.DEEPSEEK_API_KEY) {
        reject(new Error("DeepSeek API key is missing. Set DEEPSEEK_API_KEY before switching to deepseek."));
        return;
      }
      const outPath = path.join(env.HOME || "", ".codex", "deepseek-adapter.log");
      const out = fs.openSync(outPath, "a");
      const child = spawn(adapterScript, [], {
        env: adapterEnv,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        checkDeepSeekAdapter((ready) => {
          if (ready) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (attempts >= 30) {
            clearInterval(timer);
            reject(new Error(`DeepSeek adapter failed to start. See ${outPath}`));
          }
        });
      }, 250);
    });
  });
}

function checkDeepSeekAdapter(callback) {
  const req = http.request({
    host: "127.0.0.1",
    port: 4011,
    path: "/v1/models",
    method: "GET",
    timeout: 1000,
  }, (res) => {
    res.resume();
    callback(res.statusCode >= 200 && res.statusCode < 300);
  });
  req.on("error", () => callback(false));
  req.on("timeout", () => {
    req.destroy();
    callback(false);
  });
  req.end();
}

function readDeepSeekApiKeyFromOpenClaw(home) {
  try {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(parsed?.models?.providers?.deepseek?.apiKey || "").trim();
  } catch {
    return "";
  }
}

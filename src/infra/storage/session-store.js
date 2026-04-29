const fs = require("fs");
const path = require("path");
const { normalizeModelCatalog } = require("../../shared/model-catalog");

const DEFAULT_APPROVAL_AUTO_ALLOW_TTL_MS = 12 * 60 * 60 * 1000;

class SessionStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    const parentDirectory = path.dirname(this.filePath);
    fs.mkdirSync(parentDirectory, { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.bindings) {
        this.state = {
          ...createEmptyState(),
          ...parsed,
          bindings: parsed.bindings || {},
          approvalCommandAllowlistByWorkspaceRoot: parsed.approvalCommandAllowlistByWorkspaceRoot || {},
          approvalCommandAutoAllowByWorkspaceRoot: parsed.approvalCommandAutoAllowByWorkspaceRoot || {},
          availableModelCatalog: parsed.availableModelCatalog || {
            models: [],
            updatedAt: "",
          },
        };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  getActiveWorkspaceRoot(bindingKey) {
    return this.state.bindings[bindingKey]?.activeWorkspaceRoot || "";
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const current = this.getBinding(bindingKey) || { threadIdByWorkspaceRoot: {} };
    const threadIdByWorkspaceRoot = getThreadMap(current);
    if (normalizedWorkspaceRoot && !(normalizedWorkspaceRoot in threadIdByWorkspaceRoot)) {
      threadIdByWorkspaceRoot[normalizedWorkspaceRoot] = "";
    }

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot, providerKey = "") {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    const normalizedProviderKey = normalizeValue(providerKey);
    const binding = this.state.bindings[bindingKey] || {};
    if (normalizedProviderKey) {
      return binding.providerThreadIdByWorkspaceRoot?.[normalizedWorkspaceRoot]?.[normalizedProviderKey] || "";
    }
    return binding.threadIdByWorkspaceRoot?.[normalizedWorkspaceRoot] || "";
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const { providerKey, providerLabel, ...bindingExtra } = extra || {};
    const normalizedProviderKey = normalizeValue(providerKey);
    const normalizedProviderLabel = normalizeValue(providerLabel);
    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...getThreadMap(current),
      [normalizedWorkspaceRoot]: threadId,
    };
    const providerThreadIdByWorkspaceRoot = getProviderThreadMap(current);
    if (normalizedProviderKey) {
      providerThreadIdByWorkspaceRoot[normalizedWorkspaceRoot] = {
        ...(providerThreadIdByWorkspaceRoot[normalizedWorkspaceRoot] || {}),
        [normalizedProviderKey]: threadId,
      };
    }

    return this.updateBinding(bindingKey, {
      ...current,
      ...bindingExtra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      activeProviderKey: normalizedProviderKey || normalizeValue(current.activeProviderKey),
      activeProviderLabel: normalizedProviderLabel || normalizeValue(current.activeProviderLabel),
      threadIdByWorkspaceRoot,
      providerThreadIdByWorkspaceRoot,
    });
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot, providerKey = "") {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const normalizedProviderKey = normalizeValue(providerKey);
    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...getThreadMap(current),
      [normalizedWorkspaceRoot]: "",
    };
    const providerThreadIdByWorkspaceRoot = getProviderThreadMap(current);
    if (normalizedProviderKey && providerThreadIdByWorkspaceRoot[normalizedWorkspaceRoot]) {
      providerThreadIdByWorkspaceRoot[normalizedWorkspaceRoot] = {
        ...providerThreadIdByWorkspaceRoot[normalizedWorkspaceRoot],
        [normalizedProviderKey]: "",
      };
    }

    return this.updateBinding(bindingKey, {
      ...current,
      threadIdByWorkspaceRoot,
      providerThreadIdByWorkspaceRoot,
    });
  }

  getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return { model: "", effort: "" };
    }
    const raw = this.state.bindings[bindingKey]?.codexParamsByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!raw || typeof raw !== "object") {
      return { model: "", effort: "" };
    }
    return {
      model: normalizeValue(raw.model),
      effort: normalizeValue(raw.effort),
    };
  }

  setCodexParamsForWorkspace(bindingKey, workspaceRoot, { model, effort }) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const codexParamsByWorkspaceRoot = {
      ...getCodexParamsMap(current),
      [normalizedWorkspaceRoot]: {
        model: normalizeValue(model),
        effort: normalizeValue(effort),
      },
    };

    return this.updateBinding(bindingKey, {
      ...current,
      codexParamsByWorkspaceRoot,
    });
  }

  getApprovalCommandAllowlistForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return [];
    }
    const allowlist = this.state.approvalCommandAllowlistByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!Array.isArray(allowlist)) {
      return [];
    }
    return normalizeCommandAllowlist(allowlist);
  }

  getApprovalCommandAutoAllowForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return false;
    }
    const raw = this.state.approvalCommandAutoAllowByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (raw === true) {
      return true;
    }
    if (!raw || typeof raw !== "object" || raw.enabled !== true) {
      return false;
    }
    const expiresAt = Date.parse(raw.expiresAt || "");
    return Number.isNaN(expiresAt) || expiresAt > Date.now();
  }

  setApprovalCommandAutoAllowForWorkspace(workspaceRoot, enabled = true) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }

    const now = new Date();
    this.state.approvalCommandAutoAllowByWorkspaceRoot = {
      ...(this.state.approvalCommandAutoAllowByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: enabled === true
        ? {
          enabled: true,
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + DEFAULT_APPROVAL_AUTO_ALLOW_TTL_MS).toISOString(),
        }
        : {
          enabled: false,
          updatedAt: now.toISOString(),
          expiresAt: "",
        },
    };
    this.save();
    return this.state.approvalCommandAutoAllowByWorkspaceRoot[normalizedWorkspaceRoot];
  }

  getAvailableModelCatalog() {
    const raw = this.state.availableModelCatalog;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const models = normalizeModelCatalog(raw.models);
    if (!models.length) {
      return null;
    }
    const updatedAt = normalizeValue(raw.updatedAt);
    return {
      models,
      updatedAt,
    };
  }

  setAvailableModelCatalog(models) {
    const normalizedModels = normalizeModelCatalog(models);
    if (!normalizedModels.length) {
      return null;
    }

    this.state.availableModelCatalog = {
      models: normalizedModels,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.availableModelCatalog;
  }

  rememberApprovalCommandPrefixForWorkspace(workspaceRoot, commandTokens) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedTokens = normalizeCommandTokens(commandTokens);
    if (!normalizedWorkspaceRoot || !normalizedTokens.length) {
      return null;
    }

    const currentAllowlist = this.getApprovalCommandAllowlistForWorkspace(normalizedWorkspaceRoot);
    const exists = currentAllowlist.some((prefix) => (
      prefix.length === normalizedTokens.length
      && prefix.every((token, index) => token === normalizedTokens[index])
    ));
    if (exists) {
      return currentAllowlist;
    }

    this.state.approvalCommandAllowlistByWorkspaceRoot = {
      ...(this.state.approvalCommandAllowlistByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: [...currentAllowlist, normalizedTokens],
    };
    this.save();
    return this.state.approvalCommandAllowlistByWorkspaceRoot[normalizedWorkspaceRoot];
  }

  removeWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = getThreadMap(current);
    const providerThreadIdByWorkspaceRoot = getProviderThreadMap(current);
    const codexParamsByWorkspaceRoot = getCodexParamsMap(current);
    const hasWorkspaceEntry = Object.prototype.hasOwnProperty.call(
      threadIdByWorkspaceRoot,
      normalizedWorkspaceRoot
    );
    const activeWorkspaceRoot = normalizeValue(current.activeWorkspaceRoot);
    if (!hasWorkspaceEntry && activeWorkspaceRoot !== normalizedWorkspaceRoot) {
      return current;
    }

    delete threadIdByWorkspaceRoot[normalizedWorkspaceRoot];
    delete providerThreadIdByWorkspaceRoot[normalizedWorkspaceRoot];
    delete codexParamsByWorkspaceRoot[normalizedWorkspaceRoot];

    const nextActiveWorkspaceRoot = activeWorkspaceRoot === normalizedWorkspaceRoot
      ? (Object.keys(threadIdByWorkspaceRoot).sort((left, right) => left.localeCompare(right))[0] || "")
      : activeWorkspaceRoot;

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: nextActiveWorkspaceRoot,
      codexParamsByWorkspaceRoot,
      providerThreadIdByWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...nextBinding,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  buildBindingKey({ workspaceId, chatId, threadKey, senderId, messageId }) {
    const normalizedThreadKey = normalizeValue(threadKey);
    const normalizedMessageId = normalizeValue(messageId);
    const hasStableThreadKey = normalizedThreadKey && normalizedThreadKey !== normalizedMessageId;

    if (hasStableThreadKey) {
      return `${workspaceId}:${chatId}:thread:${normalizedThreadKey}`;
    }
    return `${workspaceId}:${chatId}:sender:${senderId}`;
  }

}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createEmptyState() {
  return {
    bindings: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    approvalCommandAutoAllowByWorkspaceRoot: {},
    availableModelCatalog: {
      models: [],
      updatedAt: "",
    },
  };
}

function getThreadMap(binding) {
  return { ...(binding?.threadIdByWorkspaceRoot || {}) };
}

function getProviderThreadMap(binding) {
  const raw = binding?.providerThreadIdByWorkspaceRoot || {};
  const copy = {};
  for (const [workspaceRoot, providerMap] of Object.entries(raw)) {
    if (providerMap && typeof providerMap === "object" && !Array.isArray(providerMap)) {
      copy[workspaceRoot] = { ...providerMap };
    }
  }
  return copy;
}

function getCodexParamsMap(binding) {
  return { ...(binding?.codexParamsByWorkspaceRoot || {}) };
}

function normalizeCommandTokens(tokens) {
  if (!Array.isArray(tokens)) {
    return [];
  }
  return tokens
    .map((token) => (typeof token === "string" ? token.trim() : ""))
    .filter(Boolean);
}

function normalizeCommandAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) {
    return [];
  }
  return allowlist
    .map((tokens) => normalizeCommandTokens(tokens))
    .filter((tokens) => tokens.length > 0);
}

module.exports = { SessionStore };

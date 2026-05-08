const MAX_PENDING_BINDING_CONTEXT_ENTRIES = 300;
const MAX_PENDING_THREAD_CONTEXT_ENTRIES = 500;
const MAX_REPLY_CARD_ENTRIES = 500;
const MAX_THREAD_CONTEXT_CACHE_ENTRIES = 500;

function resolveWorkspaceRootForBinding(runtime, bindingKey) {
  const active = runtime.sessionStore.getActiveWorkspaceRoot(bindingKey);
  return typeof active === "string" && active.trim() ? active.trim() : "";
}

function resolveThreadIdForBinding(runtime, bindingKey, workspaceRoot) {
  return runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
}

function setThreadBindingKey(runtime, threadId, bindingKey) {
  if (!threadId || !bindingKey) {
    return;
  }
  setBoundedMapEntry(runtime, runtime.bindingKeyByThreadId, threadId, bindingKey, MAX_THREAD_CONTEXT_CACHE_ENTRIES);
}

function setThreadWorkspaceRoot(runtime, threadId, workspaceRoot) {
  if (!threadId || !workspaceRoot) {
    return;
  }
  setBoundedMapEntry(
    runtime,
    runtime.workspaceRootByThreadId,
    threadId,
    workspaceRoot,
    MAX_THREAD_CONTEXT_CACHE_ENTRIES
  );
}

function setPendingBindingContext(runtime, bindingKey, normalized) {
  if (!bindingKey || !normalized) {
    return;
  }
  setBoundedMapEntry(
    runtime,
    runtime.pendingChatContextByBindingKey,
    bindingKey,
    normalized,
    MAX_PENDING_BINDING_CONTEXT_ENTRIES
  );
}

function setPendingThreadContext(runtime, threadId, normalized) {
  if (!threadId || !normalized) {
    return;
  }
  setBoundedMapEntry(
    runtime,
    runtime.pendingChatContextByThreadId,
    threadId,
    normalized,
    MAX_PENDING_THREAD_CONTEXT_ENTRIES
  );
}

function setPendingTempImageFiles(runtime, threadId, turnId, files) {
  if (!threadId) {
    return;
  }

  let normalizedTurnId = normalizeTurnId(turnId);
  let sourceFiles = files;
  if (Array.isArray(turnId) && files === undefined) {
    normalizedTurnId = "";
    sourceFiles = turnId;
  }

  const normalizedFiles = Array.isArray(sourceFiles) ? sourceFiles.filter(Boolean) : [];
  if (!normalizedFiles.length) {
    removePendingTempImageEntry(runtime, threadId, normalizedTurnId);
    return;
  }

  const entries = getPendingTempImageEntries(runtime, threadId);
  const existingIndex = findPendingTempImageEntryIndex(entries, normalizedTurnId);
  const entry = {
    turnId: normalizedTurnId,
    files: normalizedFiles,
  };
  if (existingIndex >= 0) {
    entries[existingIndex] = entry;
  } else {
    entries.push(entry);
  }

  setBoundedMapEntry(
    runtime,
    runtime.pendingTempImageFilesByThreadId,
    threadId,
    entries,
    MAX_THREAD_CONTEXT_CACHE_ENTRIES
  );
}

async function cleanupPendingTempImageFiles(runtime, threadId, turnId = "") {
  if (!threadId) {
    return;
  }

  const files = removePendingTempImageEntry(runtime, threadId, normalizeTurnId(turnId));
  if (!files.length) {
    return;
  }
  await runtime.cleanupTempFiles(files);
}

function getPendingTempImageEntries(runtime, threadId) {
  const current = runtime.pendingTempImageFilesByThreadId.get(threadId);
  if (!Array.isArray(current)) {
    return [];
  }

  const entries = [];
  const legacyFiles = [];
  for (const entry of current) {
    if (entry && typeof entry === "object" && Array.isArray(entry.files)) {
      const files = entry.files.filter(Boolean);
      if (files.length) {
        entries.push({
          turnId: normalizeTurnId(entry.turnId),
          files,
        });
      }
      continue;
    }
    if (entry) {
      legacyFiles.push(entry);
    }
  }

  if (legacyFiles.length) {
    entries.unshift({
      turnId: "",
      files: legacyFiles,
    });
  }
  return entries;
}

function findPendingTempImageEntryIndex(entries, turnId) {
  if (!Array.isArray(entries) || !entries.length) {
    return -1;
  }

  const normalizedTurnId = normalizeTurnId(turnId);
  if (normalizedTurnId) {
    const exactIndex = entries.findIndex((entry) => entry.turnId === normalizedTurnId);
    if (exactIndex >= 0) {
      return exactIndex;
    }
    return entries.findIndex((entry) => !entry.turnId);
  }

  const untaggedIndex = entries.findIndex((entry) => !entry.turnId);
  if (untaggedIndex >= 0) {
    return untaggedIndex;
  }
  return entries.length === 1 ? 0 : -1;
}

function removePendingTempImageEntry(runtime, threadId, turnId) {
  const entries = getPendingTempImageEntries(runtime, threadId);
  const entryIndex = findPendingTempImageEntryIndex(entries, turnId);
  if (entryIndex < 0) {
    return [];
  }

  const [removed] = entries.splice(entryIndex, 1);
  if (entries.length) {
    runtime.pendingTempImageFilesByThreadId.set(threadId, entries);
  } else {
    runtime.pendingTempImageFilesByThreadId.delete(threadId);
  }
  return removed?.files || [];
}

function normalizeTurnId(turnId) {
  return typeof turnId === "string" && turnId.trim() ? turnId.trim() : "";
}

function setReplyCardEntry(runtime, runKey, entry) {
  if (!runKey || !entry) {
    return;
  }
  if (runtime.replyCardByRunKey.has(runKey)) {
    runtime.replyCardByRunKey.delete(runKey);
  }
  runtime.replyCardByRunKey.set(runKey, entry);
  while (runtime.replyCardByRunKey.size > MAX_REPLY_CARD_ENTRIES) {
    const oldestRunKey = runtime.replyCardByRunKey.keys().next().value;
    if (!oldestRunKey) {
      break;
    }
    const oldestEntry = runtime.replyCardByRunKey.get(oldestRunKey) || null;
    runtime.disposeReplyRunState(oldestRunKey, oldestEntry?.threadId || "");
  }
}

function setCurrentRunKeyForThread(runtime, threadId, runKey) {
  if (!threadId || !runKey) {
    return;
  }
  setBoundedMapEntry(
    runtime,
    runtime.currentRunKeyByThreadId,
    threadId,
    runKey,
    MAX_THREAD_CONTEXT_CACHE_ENTRIES
  );
}

function setBoundedMapEntry(runtime, map, key, value, limit) {
  if (!map || !key) {
    return;
  }
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) {
      break;
    }
    map.delete(oldestKey);
  }
}

function resolveBindingKeyForThread(runtime, threadId) {
  if (!threadId) {
    return "";
  }

  const fromMap = runtime.bindingKeyByThreadId.get(threadId) || "";
  if (fromMap) {
    return fromMap;
  }

  const context = runtime.pendingChatContextByThreadId.get(threadId);
  if (!context) {
    return "";
  }

  const resolved = runtime.sessionStore.buildBindingKey(context);
  setThreadBindingKey(runtime, threadId, resolved);
  return resolved;
}

function resolveWorkspaceRootForThread(runtime, threadId) {
  if (!threadId) {
    return "";
  }

  const fromMap = runtime.workspaceRootByThreadId.get(threadId) || "";
  if (fromMap) {
    return fromMap;
  }

  const bindingKey = resolveBindingKeyForThread(runtime, threadId);
  const workspaceRoot = resolveWorkspaceRootForBinding(runtime, bindingKey);
  if (workspaceRoot) {
    setThreadWorkspaceRoot(runtime, threadId, workspaceRoot);
  }
  return workspaceRoot;
}

function cleanupThreadRuntimeState(runtime, threadId) {
  if (!threadId) {
    return;
  }

  runtime.pendingApprovalByThreadId.delete(threadId);
  runtime.activeTurnIdByThreadId.delete(threadId);
  runtime.pendingChatContextByThreadId.delete(threadId);
  runtime.bindingKeyByThreadId.delete(threadId);
  runtime.workspaceRootByThreadId.delete(threadId);

  for (const [runKey, entry] of runtime.replyCardByRunKey.entries()) {
    if (entry?.threadId === threadId) {
      runtime.disposeReplyRunState(runKey, threadId);
    }
  }
}

function pruneRuntimeMapSizes(runtime) {
  pruneMapToLimit(runtime.activeTurnIdByThreadId, MAX_THREAD_CONTEXT_CACHE_ENTRIES);
  pruneMapToLimit(runtime.currentRunKeyByThreadId, MAX_THREAD_CONTEXT_CACHE_ENTRIES);
}

function pruneMapToLimit(map, limit) {
  if (!map || map.size <= limit) {
    return;
  }
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) {
      break;
    }
    map.delete(oldestKey);
  }
}

module.exports = {
  cleanupPendingTempImageFiles,
  cleanupThreadRuntimeState,
  pruneRuntimeMapSizes,
  resolveThreadIdForBinding,
  resolveWorkspaceRootForBinding,
  resolveWorkspaceRootForThread,
  setCurrentRunKeyForThread,
  setPendingBindingContext,
  setPendingTempImageFiles,
  setPendingThreadContext,
  setReplyCardEntry,
  setThreadBindingKey,
  setThreadWorkspaceRoot,
};

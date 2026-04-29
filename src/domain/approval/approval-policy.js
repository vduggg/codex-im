const codexMessageUtils = require("../../infra/codex/message-utils");

function rememberApprovalPrefixForWorkspace(runtime, workspaceRoot, commandTokens) {
  const normalizedTokens = codexMessageUtils.normalizeCommandTokens(commandTokens);
  if (!workspaceRoot || !normalizedTokens.length) {
    return;
  }

  runtime.sessionStore.setApprovalCommandAutoAllowForWorkspace(workspaceRoot, true);
  runtime.sessionStore.rememberApprovalCommandPrefixForWorkspace(workspaceRoot, normalizedTokens);
  runtime.approvalAllowlistByWorkspaceRoot.set(
    workspaceRoot,
    runtime.sessionStore.getApprovalCommandAllowlistForWorkspace(workspaceRoot)
  );
}

function shouldAutoApproveRequest(runtime, workspaceRoot, approval) {
  if (!workspaceRoot || !approval) {
    return false;
  }
  if (!codexMessageUtils.isCommandApprovalMethod(approval.method)) {
    return false;
  }
  if (runtime.sessionStore.getApprovalCommandAutoAllowForWorkspace(workspaceRoot)) {
    return true;
  }
  const cachedAllowlist = runtime.approvalAllowlistByWorkspaceRoot.get(workspaceRoot) || [];
  const allowlist = cachedAllowlist.length
    ? cachedAllowlist
    : runtime.sessionStore.getApprovalCommandAllowlistForWorkspace(workspaceRoot);
  if (allowlist.length && !cachedAllowlist.length) {
    runtime.approvalAllowlistByWorkspaceRoot.set(workspaceRoot, allowlist);
  }
  if (!allowlist.length) {
    return false;
  }
  return codexMessageUtils.matchesCommandPrefix(approval.commandTokens, allowlist);
}

async function tryAutoApproveRequest(runtime, threadId, approval) {
  if (!threadId || !approval) {
    return false;
  }

  const workspaceRoot = runtime.resolveWorkspaceRootForThread(threadId);
  if (!shouldAutoApproveRequest(runtime, workspaceRoot, approval)) {
    return false;
  }

  const outcome = await runtime.applyApprovalDecision({
    threadId,
    approval,
    command: "approve",
    workspaceRoot,
    scope: "once",
  });
  return !outcome.error;
}

module.exports = {
  rememberApprovalPrefixForWorkspace,
  shouldAutoApproveRequest,
  tryAutoApproveRequest,
};

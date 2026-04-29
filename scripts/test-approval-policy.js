#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const approvalPolicy = require("../src/domain/approval/approval-policy");
const { SessionStore } = require("../src/infra/storage/session-store");

function createRuntime({ autoAllow = false, allowlist = [] } = {}) {
  let savedAutoAllow = autoAllow;
  let savedAllowlist = allowlist;
  return {
    approvalAllowlistByWorkspaceRoot: new Map(),
    sessionStore: {
      getApprovalCommandAutoAllowForWorkspace() {
        return savedAutoAllow;
      },
      setApprovalCommandAutoAllowForWorkspace(_workspaceRoot, enabled) {
        savedAutoAllow = enabled === true;
      },
      getApprovalCommandAllowlistForWorkspace() {
        return savedAllowlist;
      },
      rememberApprovalCommandPrefixForWorkspace(_workspaceRoot, commandTokens) {
        savedAllowlist = [...savedAllowlist, commandTokens];
      },
    },
  };
}

const workspaceRoot = "/Users/keeploving/YuAn&FeiShu";
const commandApproval = {
  method: "command_execution_request_approval",
  commandTokens: ["perl", "-0pi", "-e", "s/a/b/", "usage.md"],
};

{
  const runtime = createRuntime({ autoAllow: true });
  assert.strictEqual(
    approvalPolicy.shouldAutoApproveRequest(runtime, workspaceRoot, {
      ...commandApproval,
      commandTokens: ["zsh", "-lc", "date >> usage.md"],
    }),
    true,
    "workspace auto-allow should approve later command approvals in the same workspace"
  );
}

{
  const runtime = createRuntime({ autoAllow: true });
  assert.strictEqual(
    approvalPolicy.shouldAutoApproveRequest(runtime, workspaceRoot, {
      method: "file_write_request_approval",
      commandTokens: ["zsh", "-lc", "date"],
    }),
    false,
    "workspace auto-allow must not approve non-command approval methods"
  );
}

{
  const runtime = createRuntime({ autoAllow: false, allowlist: [["mkdir", "-p"]] });
  assert.strictEqual(
    approvalPolicy.shouldAutoApproveRequest(runtime, workspaceRoot, {
      ...commandApproval,
      commandTokens: ["mkdir", "-p", "/tmp/example"],
    }),
    true,
    "legacy command-prefix allowlist should continue to work"
  );
}

{
  const runtime = createRuntime();
  approvalPolicy.rememberApprovalPrefixForWorkspace(runtime, workspaceRoot, ["perl", "-0pi"]);
  assert.strictEqual(
    approvalPolicy.shouldAutoApproveRequest(runtime, workspaceRoot, {
      ...commandApproval,
      commandTokens: ["sed", "-n", "1,20p", "usage.md"],
    }),
    true,
    "clicking auto-allow should promote the workspace to command auto-allow"
  );
}

{
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuan-feishu-approval-"));
  const store = new SessionStore({ filePath: path.join(temporaryDirectory, "sessions.json") });
  store.setApprovalCommandAutoAllowForWorkspace(workspaceRoot, true);
  assert.strictEqual(
    store.getApprovalCommandAutoAllowForWorkspace(workspaceRoot),
    true,
    "stored workspace auto-allow should be active immediately"
  );

  const state = JSON.parse(fs.readFileSync(path.join(temporaryDirectory, "sessions.json"), "utf8"));
  state.approvalCommandAutoAllowByWorkspaceRoot[workspaceRoot].expiresAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(path.join(temporaryDirectory, "sessions.json"), JSON.stringify(state, null, 2));
  const reloadedStore = new SessionStore({ filePath: path.join(temporaryDirectory, "sessions.json") });
  assert.strictEqual(
    reloadedStore.getApprovalCommandAutoAllowForWorkspace(workspaceRoot),
    false,
    "expired workspace auto-allow should not remain active"
  );
}

console.log("approval policy tests passed");

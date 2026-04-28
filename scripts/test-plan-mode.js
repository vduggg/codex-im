#!/usr/bin/env node

const assert = require("assert");
const plan = require("../src/domain/plan/plan-service");

async function main() {
  const binding = {};
  const sent = [];
  const runtime = {
    sessionStore: {
      getBinding: () => binding,
      updateBinding: (_bindingKey, next) => Object.assign(binding, next),
    },
    resolveWorkspaceContext: async () => ({
      bindingKey: "binding-1",
      workspaceRoot: "/tmp/workspace",
    }),
    sendInteractiveCard: async (payload) => sent.push(payload),
  };

  await plan.handlePlanCommand(runtime, {
    chatId: "oc_test",
    messageId: "om_test",
    text: "/codex plan on",
  });
  assert.strictEqual(plan.getPlanMode(runtime, "binding-1", "/tmp/workspace"), true);
  assert.match(sent[0].card.header.title.content, /已开启/);

  const planned = plan.buildMessageWithPlanMode(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/tmp/workspace",
    text: "帮我改这个插件",
  });
  assert.match(planned, /Feishu Plan Mode is ON/);
  assert.match(planned, /帮我改这个插件/);

  await plan.handlePlanCommand(runtime, {
    chatId: "oc_test",
    messageId: "om_test",
    text: "/codex plan off",
  });
  assert.strictEqual(plan.getPlanMode(runtime, "binding-1", "/tmp/workspace"), false);
  console.log("plan mode fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

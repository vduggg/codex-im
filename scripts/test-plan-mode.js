#!/usr/bin/env node

const assert = require("assert");
const plan = require("../src/domain/plan/plan-service");

async function main() {
  const binding = {};
  const sent = [];
  const runtime = {
    bindingKeyByThreadId: new Map([["thread-1", "binding-1"]]),
    planConfirmationKeys: new Set(),
    planQuestionKeys: new Set(),
    workspaceRootByThreadId: new Map([["thread-1", "/tmp/workspace"]]),
    sessionStore: {
      getBinding: () => binding,
      buildBindingKey: () => "binding-1",
      updateBinding: (_bindingKey, next) => Object.assign(binding, next),
    },
    resolveWorkspaceContext: async () => ({
      bindingKey: "binding-1",
      workspaceRoot: "/tmp/workspace",
    }),
    resolveWorkspaceRootForThread: () => "/tmp/workspace",
    queueCardActionWithFeedback: async (_normalized, _feedback, task) => {
      await task();
      return {};
    },
    sendInteractiveCard: async (payload) => sent.push(payload),
    sendInfoCardMessage: async (payload) => sent.push(payload),
    setPendingBindingContext: () => {},
    setPendingThreadContext: () => {},
    ensureThreadAndSendMessage: async (payload) => {
      sent.push({ executePayload: payload });
      return payload.threadId;
    },
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

  const confirmationSent = await plan.maybeSendPlanConfirmationCard(runtime, {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "oc_test",
    text: "<proposed_plan>\n做这件事\n</proposed_plan>",
  });
  assert.strictEqual(confirmationSent, true);
  const confirmationCard = sent.find((payload) => payload.card?.header?.title?.content === "计划待确认");
  assert.ok(confirmationCard);
  const executeButton = confirmationCard.card.elements[1].actions[0];
  assert.strictEqual(executeButton.value.action, "execute");
  assert.strictEqual(executeButton.value.threadId, "thread-1");

  await plan.handlePlanCardAction(runtime, executeButton.value, {
    chatId: "oc_test",
    messageId: "om_card",
    workspaceId: "default",
    senderId: "ou_test",
  });
  assert.strictEqual(plan.getPlanMode(runtime, "binding-1", "/tmp/workspace"), false);
  const executePayload = sent.find((payload) => payload.executePayload)?.executePayload;
  assert.strictEqual(executePayload.threadId, "thread-1");
  assert.match(executePayload.normalized.text, /确认执行/);

  const questionText = '需要你选一下\n[[yuan-feishu-plan-question:{"question":"测试范围选哪个？","options":["真实飞书","本地模拟"]}]]';
  assert.strictEqual(plan.extractPlanQuestions(questionText)[0].question, "测试范围选哪个？");
  const questionResult = await plan.handlePlanQuestionDirectives(runtime, {
    threadId: "thread-1",
    turnId: "turn-2",
    chatId: "oc_test",
    text: questionText,
  });
  assert.strictEqual(questionResult.sent, 1);
  assert.strictEqual(questionResult.text, "需要你选一下");
  const questionCard = sent.find((payload) => payload.card?.header?.title?.content === "计划需要补充");
  assert.ok(questionCard);
  const answerButton = questionCard.card.elements[1].actions[0];
  assert.strictEqual(answerButton.value.action, "answer");
  assert.strictEqual(answerButton.value.question, "测试范围选哪个？");

  await plan.handlePlanCardAction(runtime, answerButton.value, {
    chatId: "oc_test",
    messageId: "om_answer",
    workspaceId: "default",
    senderId: "ou_test",
  });
  const answerPayload = sent.find((payload) => payload.executePayload?.normalized?.messageId === "om_answer")?.executePayload;
  assert.match(answerPayload.normalized.text, /测试范围选哪个/);
  assert.match(answerPayload.normalized.text, /真实飞书/);
  console.log("plan mode fixtures ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  buildCardKitAssistantElements,
  formatCardKitAssistantMarkdown,
} = require("../src/shared/assistant-markdown");

function testLongChineseParagraphSplits() {
  const input = [
    "我来处理，Jiao：先读这类任务的写入协议，再抓文章内容，最后按知识库位置沉淀成一篇可追溯的笔记。",
    "飞书这次还给了新的附件回传能力说明，我会按它走，不再用临时SDK绕路。",
    "公众号直链在网页工具里打不开，我会换成本机抓取试一下，并且先按Wiki的外部资料入库标准定处理方式。",
    "这类单篇文章先做source card和light extract，不直接塞成稳定知识。",
    "文章抓到了，标题是这个51K星标的开源神器，让任何Agent都能一键切换所有模型。",
    "核心对象是cc-switch，我还查了Github当前README，它现在是一个管理Claude Code、Codex、Gemini CLI、OpenCode、OpenClaw的跨平台桌面工具。",
  ].join("");

  const output = formatCardKitAssistantMarkdown(input);
  assert.match(output, /\n\n/);
  assert.ok(output.split("\n\n").length >= 3, output);
}

function testStructuredMarkdownIsPreserved() {
  const input = [
    "先说结论：",
    "",
    "- 第一条",
    "- 第二条",
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    "| A | B |",
    "",
    "```js",
    "const value = '这段代码不要被拆开。';",
    "```",
  ].join("\n");

  const output = formatCardKitAssistantMarkdown(input);
  assert.match(output, /- 第一条/);
  assert.match(output, /\| 项 \| 值 \|/);
  assert.match(output, /```js\nconst value/);
}

function testDenseReplyBecomesScannableMarkdown() {
  const input = [
    "我的判断是： **这个工具值得重点关注，但现在不建议直接安装。 **原因很明确： 1.它解决的是我们的真痛点我们现在确实有Codex、OpenClaw、Hermes、不同模型、不同路由、不同额度的问题。",
    "`cc-switch`这类工具如果稳定，能把切模型、看用量、备用模型故障转移收成一个统一入口。",
    "2.它比单纯模型切换更有价值我最在意的不是点一下换模型，而是它的三块能力。",
    "3.但它也很危险它不是普通App。",
  ].join("\n\n");

  const output = formatCardKitAssistantMarkdown(input);
  assert.match(output, /我的判断是：\n\n\*\*这个工具值得重点关注，但现在不建议直接安装。\*\*\n\n原因很明确：/);
  assert.match(output, /原因很明确：\n\n1\. 它解决的是我们的真痛点/);
  assert.match(output, /\n\n2\. 它比单纯模型切换更有价值/);
  assert.match(output, /\n\n3\. 但它也很危险/);
}

function testCardKitAssistantElementsSplitRichBlocks() {
  const input = formatCardKitAssistantMarkdown([
    "**Patch 功能分析**",
    "",
    "这个 patch 目录包含飞书卡片 Footer 的完整实现。",
    "",
    "---",
    "",
    "做的事：",
    "",
    "1. 从 `agent_result` 提取 `model` 和 `api_calls`",
    "2. 调用 `get_model_context_length(model)`",
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    "| 模型 | gpt-5.5 |",
    "",
    "```python",
    "response = build_card_json(payload)",
    "```",
  ].join("\n"));

  const elements = buildCardKitAssistantElements(input, { elementId: "streaming_content" });
  assert.ok(elements.length >= 6, JSON.stringify(elements));
  assert.strictEqual(elements[0].tag, "markdown");
  assert.strictEqual(elements[0].element_id, "streaming_content");
  assert.ok(elements.some((element) => element.tag === "hr"));
  assert.ok(elements.some((element) => element.tag === "markdown" && element.content.includes("| 项 | 值 |")));
  assert.ok(elements.some((element) => element.tag === "markdown" && element.content.includes("```python")));
}

testLongChineseParagraphSplits();
testStructuredMarkdownIsPreserved();
testDenseReplyBecomesScannableMarkdown();
testCardKitAssistantElementsSplitRichBlocks();
console.log("assistant markdown formatting tests passed");

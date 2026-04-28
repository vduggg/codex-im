#!/usr/bin/env node

const assert = require("node:assert/strict");
const { formatCardKitAssistantMarkdown } = require("../src/shared/assistant-markdown");

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

testLongChineseParagraphSplits();
testStructuredMarkdownIsPreserved();
console.log("assistant markdown formatting tests passed");

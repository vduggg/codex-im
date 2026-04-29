const ASSISTANT_REPLY_MAX_BYTES = 24 * 1024;
const LONG_PARAGRAPH_MIN_CHARS = 240;
const READABLE_PARAGRAPH_TARGET_CHARS = 140;
const READABLE_PARAGRAPH_MAX_CHARS = 220;
const DANGEROUS_HTML_TAG_RE = /<\/?(script|style|iframe|object|embed|meta|link)[^>]*>/gi;
const DANGEROUS_LINK_RE = /(\]\()\s*(javascript:|data:text\/html)[^)]+(\))/gi;
const THINK_TAG_RE = /<\/?think>/gi;

function sanitizeAssistantMarkdown(text, options = {}) {
  const preserveHeadings = Boolean(options.preserveHeadings);
  let normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(THINK_TAG_RE, "")
    .replace(DANGEROUS_HTML_TAG_RE, "")
    .replace(DANGEROUS_LINK_RE, "$1about:blank$3")
    .replace(/\n{3,}/g, "\n\n");

  if (!preserveHeadings) {
    normalized = normalized.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, (_, title) => `**${String(title).trim()}**`);
  }

  normalized = normalized.trim();

  if (Buffer.byteLength(normalized, "utf8") <= ASSISTANT_REPLY_MAX_BYTES) {
    return normalized;
  }
  const suffix = "\n\n_内容过长，已截断显示。_";
  const budget = ASSISTANT_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  if (budget <= 0) {
    return suffix.trim();
  }
  const clipped = clipUtf8ByBytes(normalized, budget);
  return `${clipped}${suffix}`;
}

function formatCardKitAssistantMarkdown(text) {
  const sanitized = sanitizeAssistantMarkdown(text, { preserveHeadings: true });
  return optimizeCardKitMarkdown(sanitized);
}

function splitAssistantReplyForDisplay(text) {
  const normalized = sanitizeAssistantMarkdown(text, { preserveHeadings: true });
  const marker = findFinalAnswerMarker(normalized);
  if (marker <= 0) {
    return {
      answerText: normalized,
      preAnswerText: "",
    };
  }

  const preAnswerText = normalized.slice(0, marker).trim();
  const answerText = normalized.slice(marker).trim();
  if (!answerText || answerText.length < 16) {
    return {
      answerText: normalized,
      preAnswerText: "",
    };
  }
  return {
    answerText,
    preAnswerText,
  };
}

function findFinalAnswerMarker(text) {
  const normalized = String(text || "");
  const markerRe = /(?:^|\n{2,})(Jiao[，,]\s*(?:弄好了|好了|搞定了|处理好了|刚才|确实|文档|我把|我已|我已经|这次|现在)|(?:可以实现|能实现|答案是)[，,。；;\s])/g;
  let lastIndex = -1;
  let match;
  while ((match = markerRe.exec(normalized)) !== null) {
    const prefixLength = match[0].length - match[1].length;
    lastIndex = match.index + prefixLength;
  }
  return lastIndex;
}

function buildCardKitAssistantElements(content, options = {}) {
  const blocks = splitCardKitMarkdownBlocks(content);
  const elementId = typeof options.elementId === "string" ? options.elementId : "";
  const maxElements = Number.isFinite(options.maxElements) ? Math.max(1, options.maxElements) : 36;
  const elements = [];

  for (const block of compactCardKitBlocks(blocks, maxElements)) {
    if (block.type === "hr") {
      elements.push({ tag: "hr" });
      continue;
    }
    const element = {
      tag: "markdown",
      content: block.content,
      text_align: "left",
      text_size: block.type === "code" ? "notation" : "normal_v2",
      margin: elements.length === 0 ? "0px 0px 0px 0px" : "8px 0px 0px 0px",
    };
    if (elementId && !elements.some((item) => item.element_id === elementId)) {
      element.element_id = elementId;
    }
    elements.push(element);
  }

  if (!elements.length) {
    elements.push({
      tag: "markdown",
      content: "我正在整理正式回复。",
      text_align: "left",
      text_size: "normal_v2",
      margin: "0px 0px 0px 0px",
      ...(elementId ? { element_id: elementId } : {}),
    });
  }
  return elements;
}

function optimizeCardKitMarkdown(text) {
  const codeBlocks = [];
  const marker = "___CODEX_CARDKIT_CODE_BLOCK_";
  let normalized = String(text || "").replace(/```[\s\S]*?```/g, (match) => {
    const index = codeBlocks.push(match) - 1;
    return `${marker}${index}___`;
  });

  normalized = normalizeMarkdownEmphasis(normalized);
  normalized = normalizeNumberedListMarkers(normalized);
  normalized = downgradeHeadingsForCardKit(normalized);
  normalized = repairMarkdownTables(normalized);
  normalized = splitLongPlainParagraphs(normalized);

  codeBlocks.forEach((block, index) => {
    normalized = normalized.replace(`${marker}${index}___`, `\n\n${block}\n\n`);
  });

  return normalized.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeMarkdownEmphasis(text) {
  return String(text || "")
    .replace(/\*\*\s*([^*\n][^*\n]*?)\s*\*\*/g, "**$1**")
    .replace(/([：:])\s+(\*\*[^*\n]+?\*\*)/g, "$1\n\n$2")
    .replace(/(\*\*[^*\n]+?[。！？!?；;]\*\*)(?=\S)/g, "$1\n\n")
    .replace(/(\*\*[^*\n]+?\*\*)\s*([。！？!?；;])\s*/g, "$1$2\n\n");
}

function normalizeNumberedListMarkers(text) {
  const lines = String(text || "").split("\n");
  return lines.map((line) => {
    if (/^\s*\d{1,2}\.\s+/.test(line)) {
      return line;
    }
    return line
      .replace(/([：:])\s*(\d{1,2})\.(?=\S)/g, "$1\n\n$2. ")
      .replace(/([。！？!?；;])\s+(\d{1,2})\.(?=\S)/g, "$1\n\n$2. ")
      .replace(/^(\s*)(\d{1,2})\.(?=\S)/, "$1$2. ");
  }).join("\n");
}

function downgradeHeadingsForCardKit(text) {
  if (!/^#{1,3}\s+/m.test(text)) {
    return text;
  }
  return text
    .replace(/^#{2,6}\s+(.+)$/gm, "##### $1")
    .replace(/^#\s+(.+)$/gm, "#### $1");
}

function repairMarkdownTables(text) {
  const lines = String(text || "").split("\n");
  const output = [];
  let previousWasTable = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headerCells = parseMarkdownTableRow(line);
    const nextLine = lines[index + 1] || "";

    if (headerCells && headerCells.length >= 2 && looksLikeTableSeparator(nextLine)) {
      if (output.length && output[output.length - 1].trim() && !previousWasTable) {
        output.push("");
      }
      output.push(formatMarkdownTableRow(headerCells));
      output.push(formatMarkdownTableSeparator(headerCells.length));
      previousWasTable = true;
      index += 1;
      continue;
    }

    const rowCells = previousWasTable ? parseLooseMarkdownTableRow(line) : null;
    if (rowCells && rowCells.length >= 2) {
      output.push(formatMarkdownTableRow(padTableCells(rowCells, output[output.length - 1])));
      previousWasTable = true;
      continue;
    }

    if (previousWasTable && line.trim()) {
      output.push("");
    }
    output.push(line);
    previousWasTable = false;
  }

  return output.join("\n");
}

function splitLongPlainParagraphs(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((block) => {
      if (!shouldSplitPlainParagraph(block)) {
        return block;
      }
      return splitParagraphIntoReadableChunks(block).join("\n\n");
    })
    .join("\n\n");
}

function shouldSplitPlainParagraph(block) {
  const trimmed = String(block || "").trim();
  if (trimmed.length < LONG_PARAGRAPH_MIN_CHARS) {
    return false;
  }
  if (/\n\s*(?:[-*+]|\d+\.)\s+/.test(block) || /^\s{0,3}#{1,6}\s+/m.test(block)) {
    return false;
  }
  if (/^\s*\|.+\|\s*$/m.test(block)) {
    return false;
  }
  if (block.includes("___CODEX_CARDKIT_CODE_BLOCK_")) {
    return false;
  }
  return true;
}

function splitParagraphIntoReadableChunks(block) {
  const sentences = splitIntoSentences(String(block || "").replace(/\s*\n\s*/g, " ").trim());
  if (sentences.length <= 1) {
    return [block];
  }

  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current}${sentence}` : sentence;
    if (current && (next.length > READABLE_PARAGRAPH_TARGET_CHARS || current.length >= READABLE_PARAGRAPH_MAX_CHARS)) {
      chunks.push(current.trim());
      current = sentence;
      continue;
    }
    current = next;
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks.length > 1 ? chunks : [block];
}

function splitIntoSentences(text) {
  const matches = String(text || "").match(/[^。！？!?；;]+[。！？!?；;]+(?:[”’"'）)\]]+)?\s*|[^。！？!?；;]+$/g);
  return matches ? matches.map((item) => item.trim()).filter(Boolean) : [text];
}

function splitCardKitMarkdownBlocks(content) {
  const blocks = [];
  const source = String(content || "").trim();
  if (!source) {
    return blocks;
  }
  const codeFenceRe = /```[\s\S]*?```/g;
  let cursor = 0;
  let match = codeFenceRe.exec(source);
  while (match) {
    pushTextBlocks(blocks, source.slice(cursor, match.index));
    blocks.push({ type: "code", content: match[0].trim() });
    cursor = match.index + match[0].length;
    match = codeFenceRe.exec(source);
  }
  pushTextBlocks(blocks, source.slice(cursor));
  return blocks;
}

function pushTextBlocks(blocks, text) {
  const normalized = String(text || "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "\n---\n")
    .trim();
  if (!normalized) {
    return;
  }
  for (const part of normalized.split(/\n{2,}/)) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      continue;
    }
    blocks.push({
      type: looksLikeMarkdownTableBlock(trimmed) ? "table" : "markdown",
      content: trimmed,
    });
  }
}

function compactCardKitBlocks(blocks, maxElements) {
  if (blocks.length <= maxElements) {
    return blocks;
  }
  const head = blocks.slice(0, maxElements - 1);
  const tail = blocks.slice(maxElements - 1)
    .filter((block) => block.type !== "hr")
    .map((block) => block.content)
    .filter(Boolean)
    .join("\n\n");
  if (tail) {
    head.push({ type: "markdown", content: tail });
  }
  return head;
}

function looksLikeMarkdownTableBlock(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length >= 2 && parseMarkdownTableRow(lines[0]) && looksLikeTableSeparator(lines[1]);
}

function parseMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function parseLooseMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|") || looksLikeTableSeparator(trimmed)) {
    return null;
  }
  const normalized = trimmed.startsWith("|") ? trimmed : `| ${trimmed}`;
  const withRightPipe = normalized.endsWith("|") ? normalized : `${normalized} |`;
  return parseMarkdownTableRow(withRightPipe);
}

function looksLikeTableSeparator(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !trimmed.includes("-")) {
    return false;
  }
  const normalized = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "");
  const cells = normalized.split("|").map((cell) => cell.trim()).filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function formatMarkdownTableRow(cells) {
  return `| ${cells.map((cell) => String(cell || "").trim()).join(" | ")} |`;
}

function formatMarkdownTableSeparator(count) {
  return `| ${Array.from({ length: Math.max(2, count) }, () => "---").join(" | ")} |`;
}

function padTableCells(cells, previousLine) {
  const previousCells = parseMarkdownTableRow(previousLine);
  const targetLength = previousCells ? previousCells.length : cells.length;
  if (cells.length >= targetLength) {
    return cells;
  }
  return [...cells, ...Array.from({ length: targetLength - cells.length }, () => "")];
}

function clipUtf8ByBytes(input, maxBytes) {
  if (!input || maxBytes <= 0) {
    return "";
  }
  let bytes = 0;
  let endIndex = 0;
  for (const char of input) {
    const next = Buffer.byteLength(char, "utf8");
    if (bytes + next > maxBytes) {
      break;
    }
    bytes += next;
    endIndex += char.length;
  }
  return input.slice(0, endIndex);
}

module.exports = {
  buildCardKitAssistantElements,
  formatCardKitAssistantMarkdown,
  sanitizeAssistantMarkdown,
  splitAssistantReplyForDisplay,
};

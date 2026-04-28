const ASSISTANT_REPLY_MAX_BYTES = 24 * 1024;
const LONG_PARAGRAPH_MIN_CHARS = 240;
const READABLE_PARAGRAPH_TARGET_CHARS = 140;
const READABLE_PARAGRAPH_MAX_CHARS = 220;
const DANGEROUS_HTML_TAG_RE = /<\/?(script|style|iframe|object|embed|meta|link)[^>]*>/gi;
const DANGEROUS_LINK_RE = /(\]\()\s*(javascript:|data:text\/html)[^)]+(\))/gi;

function sanitizeAssistantMarkdown(text, options = {}) {
  const preserveHeadings = Boolean(options.preserveHeadings);
  let normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
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
  formatCardKitAssistantMarkdown,
  sanitizeAssistantMarkdown,
};

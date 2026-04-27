const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { extractBridgeValue, extractRecallValue, extractTodoValue } = require("../../../shared/command-parsing");

const execFileAsync = promisify(execFile);
const VAULT_ROOT = "/Users/keeploving/Library/Mobile Documents/iCloud~md~obsidian/Documents/Jiao Knowledge Wiki";
const AGENT_MEMORY_DIR = path.join(VAULT_ROOT, "08_agent_memory_AI可读");
const DAILY_BRIDGE_DIR = path.join(AGENT_MEMORY_DIR, "20_每日桥接");
const REALTIME_SIGNAL_DIR = path.join(AGENT_MEMORY_DIR, "21_实时信号", "Codex Feishu Gateway");
const TASKS_DIR = path.join(VAULT_ROOT, "02_process_整理中", "任务池");
const RECALL_SCRIPT = path.join(VAULT_ROOT, "99_meta_规则与模板", "scripts", "recall_wiki.py");
const MEMORY_COMPILER_SCRIPT = path.join(VAULT_ROOT, "99_meta_规则与模板", "scripts", "codex_memory_compiler.py");
const OPENCLAW_DASHBOARD = "/Users/keeploving/.openclaw/workspace/runtime/project-hub/dashboard/index.json";
const OPENCLAW_RUNNER_STATE = "/Users/keeploving/.openclaw/workspace/runtime/project-hub/runner-state.json";
const HERMES_CRON_JOBS = "/Users/keeploving/.hermes/cron/jobs.json";
const DAILY_BRIDGE_AUTO_START = "<!-- DAILY_BRIDGE_AUTO_START -->";
const DAILY_BRIDGE_AUTO_END = "<!-- DAILY_BRIDGE_AUTO_END -->";
const MEMORY_PREFLIGHT_MAX_CHARS = 5200;
const SIGNAL_MESSAGE_MAX_CHARS = 420;
const RECALL_SCRIPT_TIMEOUT_MS = 25000;
const MEMORY_COMPILER_TIMEOUT_MS = 20000;
const RECALL_MAX_FILE_BYTES = 300000;
const RECALL_MAX_FILES = 900;
const RECALL_CONTEXT_LIMIT = 5;
const DAILY_BRIDGE_SCHEDULER_INTERVAL_MS = 30 * 60 * 1000;
const MEMORY_INTENT_RE = /(今天|今日|做了什么|做啥|进度|待办|任务|挂起|记忆|记得|知识库|沉淀|复盘|总结|Obsidian|GBrain|Memory|Wiki|OpenClaw|Hermes|Codex|LLM\s*Wiki|TaskNotes|项目|桥接)/i;
const SECRET_PATTERNS = [
  /\b[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|pwd)[A-Za-z0-9_]*\s*[:=]\s*["']?[^"'\s]+/gi,
  /\b(?:sk|gk|pat|ghp|xoxb|xoxp)_[A-Za-z0-9_\-]{16,}\b/g,
  /\b[A-Za-z0-9_\-]{24,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/g,
];

const BRIDGE_FILES = [
  "08_agent_memory_AI可读/00_AGENT_BRIDGE_BOOTSTRAP.md",
  "08_agent_memory_AI可读/README_FOR_AGENTS.md",
  "08_agent_memory_AI可读/TaskNotes 跨平台写入协议.md",
  "08_agent_memory_AI可读/跨平台记忆同步状态.md",
];
const RECALL_SEARCH_DIRS = [
  "08_agent_memory_AI可读",
  "04_projects_项目",
  "03_wiki_知识页",
  "05_decisions_决策",
  "06_runbooks_操作手册",
  path.join("02_process_整理中", "任务池"),
];
const RECALL_IGNORE_DIRS = new Set([
  ".git",
  ".obsidian",
  "node_modules",
  ".trash",
  "trash",
  "backups",
  "backup",
]);

let dailyBridgeScheduler = null;

async function handleMemoryCommand(runtime, normalized) {
  if (/^\/codex\s+memory\s+compile\b/i.test(String(normalized.text || "").trim())) {
    const dateText = formatDate(new Date());
    const compiled = await compileCodexMemorySnapshot({ dateText });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        compiled
          ? "已编译 Codex 外置记忆快照。"
          : "Codex 外置记忆快照编译失败，已保留原有每日桥接/recall 回退链路。",
        "",
        `日期：\`${dateText}\``,
        `位置：\`08_agent_memory_AI可读/10_记忆系统/Codex Memory Compiler/${dateText}.md\``,
        "",
        compiled ? clipText(stripFrontmatter(compiled).trim(), 2200) : "请在桌面端查看 Gateway 日志确认失败原因。",
      ].join("\n"),
    });
    return;
  }

  if (typeof runtime.buildMemoryBridgePanelCard === "function" && typeof runtime.sendInteractiveCard === "function") {
    await runtime.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      card: runtime.buildMemoryBridgePanelCard({
        vaultRoot: VAULT_ROOT,
        bridgeFiles: BRIDGE_FILES,
        tasks: await listRecentTasks({ limit: 6 }),
        platformStatus: await collectPlatformStatus(),
        todayDate: formatDate(new Date()),
      }),
    });
    return;
  }

  await handleMemoryHelpCommand(runtime, normalized);
}

async function handleMemoryHelpCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: buildMemoryBridgeText(),
  });
}

async function handleRecallCommand(runtime, normalized) {
  const query = extractRecallValue(normalized.text);
  if (!query) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        "用法：`/codex recall <关键词>`",
        "",
        "例子：",
        "- `/codex recall 今天做了什么`",
        "- `/codex recall Hermes 记忆系统`",
        "- `/codex recall GBrain Obsidian`",
      ].join("\n"),
    });
    return;
  }

  const hits = await searchVault(query, { limit: 8 });
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: buildRecallText(query, hits),
  });
}

async function handleBridgeCommand(runtime, normalized) {
  const note = extractBridgeValue(normalized.text);
  const dateText = formatDate(new Date());
  const filePath = await updateDailyBridge({
    dateText,
    note,
    source: "Codex Feishu Gateway",
  });

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      "已沉淀今天的桥接摘要。",
      "",
      `日期：\`${dateText}\``,
      `位置：\`${path.relative(VAULT_ROOT, filePath)}\``,
      "",
      "可以点“今日摘要”，或发送 `/codex today` 查看。",
    ].join("\n"),
  });
}

async function handleTodayCommand(runtime, normalized) {
  const dateText = extractTodayDate(normalized.text) || formatDate(new Date());
  const filePath = path.join(DAILY_BRIDGE_DIR, `${dateText}.md`);
  let text = "";
  try {
    text = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: [
          `今天还没有桥接摘要：\`${dateText}\``,
          "",
          "可以先发 `/codex todo <内容>` 记待办，或者让予安在桌面端补一份每日桥接摘要。",
        ].join("\n"),
      });
      return;
    }
    throw error;
  }

  const realtimeText = await readRealtimeSignalText(dateText);
  if (typeof runtime.buildDailyBridgeSummaryCard === "function" && typeof runtime.sendInteractiveCard === "function") {
    await runtime.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      card: runtime.buildDailyBridgeSummaryCard({
        dateText,
        ...extractDailyBridgeSummary(text),
        signals: await collectDailySignals(dateText, { limit: 5 }),
        tasks: await collectDailyTasks(dateText, { limit: 6 }),
        platformStatus: await collectPlatformStatus(),
        bridgeFiles: BRIDGE_FILES,
      }),
    });
    return;
  }

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: formatDailyBridgeText(dateText, text, realtimeText),
  });
}

async function handleTodoCommand(runtime, normalized) {
  const rawValue = extractTodoValue(normalized.text);
  const directive = parseTodoDirective(rawValue);
  if (directive.kind === "form") {
    await handleTodoFormCommand(runtime, normalized);
    return;
  }
  if (directive.kind === "help") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildTodoHelpText(await listRecentTasks()),
    });
    return;
  }

  if (directive.kind === "list") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildTodoListText(await listRecentTasks()),
    });
    return;
  }

  const created = await createTaskNote({
    title: directive.title,
    taskType: directive.taskType,
    status: directive.status,
    priority: directive.priority,
    source: "Codex Feishu Gateway",
    createdBy: "予安",
  });

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      "已写入 TaskNotes。",
      "",
      `标题：${created.title}`,
      `类型：${created.taskType}`,
      `位置：\`${created.relativePath}\``,
    ].join("\n"),
  });
}

async function handleTodoFormCommand(runtime, normalized) {
  if (typeof runtime.buildTodoFormCard !== "function" || typeof runtime.sendInteractiveCard !== "function") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前运行时还不支持表单卡片，请先用 `/codex todo <内容>`。",
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    card: runtime.buildTodoFormCard(),
  });
}

async function handleTodoSubmitCardAction(runtime, action, normalized) {
  const formValue = action?.formValue || {};
  const title = String(formValue.title || formValue.todo_title || "").trim();
  const taskType = String(action?.taskType || "").trim() === "suspended" ? "suspended" : "task";
  const status = taskType === "suspended" ? "suspended" : "open";
  const priority = normalizePriority(action?.priority);
  const created = await createTaskNote({
    title,
    taskType,
    status,
    priority,
    source: "Codex Feishu Todo Form",
    createdBy: "予安",
  });

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      "已通过卡片写入 TaskNotes。",
      "",
      `标题：${created.title}`,
      `类型：${created.taskType}`,
      `优先级：${created.priority}`,
      `位置：\`${created.relativePath}\``,
    ].join("\n"),
  });
}

function buildMemoryBridgeText() {
  return [
    "Jiao Knowledge Wiki 共同记忆桥",
    "",
    `Vault：\`${VAULT_ROOT}\``,
    "",
    "必读入口：",
    ...BRIDGE_FILES.map((item) => `- \`${item}\``),
    "",
    "飞书快捷命令：",
    "- `/codex today` 查看今日桥接摘要",
    "- `/codex today YYYY-MM-DD` 查看指定日期摘要",
    "- `/codex bridge` 沉淀今天的桥接摘要",
    "- `/codex bridge <补充说明>` 带补充说明沉淀今天",
    "- `/codex todo <内容>` 写入 TaskNotes",
    "- `/codex todo list` 查看最近待办",
    "- `/codex recall <关键词>` 检索 Obsidian 共同知识库",
    "- `/codex memory` 查看共同记忆入口",
    "- `/codex memory compile` 手动编译 Codex 外置记忆快照",
  ].join("\n");
}

async function updateDailyBridge({ dateText, note, source }) {
  const now = new Date();
  const filePath = path.join(DAILY_BRIDGE_DIR, `${dateText}.md`);
  let existing = "";
  try {
    existing = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    existing = buildDailyBridgeBaseNote(dateText, now);
  }

  const autoSection = await buildDailyBridgeAutoSection({
    dateText,
    note,
    source,
    now,
  });
  await fs.promises.mkdir(DAILY_BRIDGE_DIR, { recursive: true });
  await fs.promises.writeFile(
    filePath,
    replaceDailyBridgeAutoSection(existing, autoSection),
    "utf8"
  );
  return filePath;
}

function buildDailyBridgeBaseNote(dateText, now) {
  return [
    "---",
    "type: agent-memory",
    "status: active",
    "privacy: private",
    "source: Codex Feishu Gateway",
    `captured_at: ${dateText}`,
    `updated_at: ${formatDate(now)}`,
    "owner: Jiao",
    "maintainer: 予安",
    "---",
    "",
    `# ${dateText} 每日桥接摘要`,
    "",
    "## 手动补充区",
    "",
  ].join("\n");
}

async function buildDailyBridgeAutoSection({ dateText, note, source, now }) {
  const tasks = await collectDailyTasks(dateText);
  const changedDocs = await collectChangedAgentDocs(dateText);
  const signals = await collectDailySignals(dateText);
  const platformStatus = await collectPlatformStatus();
  const digest = buildDailyDigestLines({ tasks, signals, changedDocs, platformStatus });
  return [
    DAILY_BRIDGE_AUTO_START,
    "## 自动更新区",
    "",
    `- 更新时间：${formatDateTime(now)}`,
    `- 触发来源：${source || "Codex Feishu Gateway"}`,
    "",
    "### 自动整理摘要",
    "",
    ...digest,
    "",
    "### 本次补充",
    "",
    note ? `- ${note}` : "- 无手动补充。",
    "",
    "### 今日任务池变化",
    "",
    ...formatDailyTaskLines(tasks),
    "",
    "### 平台运行状态",
    "",
    ...formatDailyPlatformStatusLines(platformStatus),
    "",
    "### 今日 Codex 飞书实时信号",
    "",
    ...formatDailySignalLines(signals),
    "",
    "### 今日 Agent 记忆桥文件变化",
    "",
    ...formatDailyPathLines(changedDocs),
    "",
    "### 固定恢复入口",
    "",
    "1. `08_agent_memory_AI可读/00_AGENT_BRIDGE_BOOTSTRAP.md`",
    "2. `08_agent_memory_AI可读/README_FOR_AGENTS.md`",
    "3. `08_agent_memory_AI可读/TaskNotes 跨平台写入协议.md`",
    "4. `08_agent_memory_AI可读/跨平台记忆同步状态.md`",
    DAILY_BRIDGE_AUTO_END,
    "",
  ].join("\n");
}

function buildDailyDigestLines({ tasks = [], signals = [], changedDocs = [], platformStatus = [] } = {}) {
  const taskCounts = new Map();
  for (const task of tasks) {
    const status = task.status || "unknown";
    taskCounts.set(status, (taskCounts.get(status) || 0) + 1);
  }

  const focus = [];
  if (signals.length) {
    focus.push(`飞书侧今日捕获 ${signals.length} 条实时信号，最近一条是：${signals[signals.length - 1].message}`);
  }
  if (tasks.length) {
    const statusText = Array.from(taskCounts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${status} ${count}`)
      .join("、");
    focus.push(`任务池今日识别 ${tasks.length} 项变化：${statusText}。`);
  }
  if (changedDocs.length) {
    focus.push(`Agent 记忆桥今日更新 ${changedDocs.length} 个页面/缓存。`);
  }
  if (platformStatus.length) {
    focus.push(`平台状态：${platformStatus.map((item) => `${item.platform} ${item.status}`).join("；")}。`);
  }
  if (!focus.length) {
    focus.push("今日暂无足够信号形成自动摘要。");
  }

  const openLike = tasks.filter((task) => ["open", "in-progress", "waiting", "suspended"].includes(task.status));
  const highPriority = openLike.filter((task) => task.priority === "high");
  const nextActions = (highPriority.length ? highPriority : openLike).slice(0, 3).map((task) => (
    `跟进 \`${task.fileName}\`：${task.title}（${task.status}）。`
  ));
  if (!nextActions.length) {
    nextActions.push("暂无自动识别的未收口任务；下一步以项目页和人工接力为准。");
  }

  const joinedDocs = changedDocs.join("\n");
  const watch = [];
  if (joinedDocs.includes("平台接入矩阵") || joinedDocs.includes("跨平台记忆同步状态")) {
    watch.push("跨平台接入规则今天有更新，后续 Agent 启动时应重新读取桥接入口。");
  }
  if (tasks.some((task) => /Hermes|OpenClaw/i.test(task.title || ""))) {
    watch.push("Hermes / OpenClaw 相关任务仍在观察或等待真实运行日志。");
  }
  for (const item of platformStatus) {
    if (item.watch) {
      watch.push(item.watch);
    }
  }
  if (!watch.length) {
    watch.push("暂无额外自动预警。");
  }

  return [
    "**今日焦点**：",
    ...focus.map((item) => `- ${item}`),
    "",
    "**下一步**：",
    ...nextActions.map((item) => `- ${item}`),
    "",
    "**需要观察**：",
    ...watch.map((item) => `- ${item}`),
  ];
}

function replaceDailyBridgeAutoSection(markdown, autoSection) {
  const pattern = new RegExp(
    `${escapeRegExp(DAILY_BRIDGE_AUTO_START)}[\\s\\S]*?${escapeRegExp(DAILY_BRIDGE_AUTO_END)}\\n?`,
    "m"
  );
  const source = String(markdown || "").trimEnd();
  const match = source.match(pattern);
  if (match) {
    const preservedEntries = extractDailyBridgeManualEntries(match[0]);
    const replacement = preservedEntries
      ? `${autoSection.trimEnd()}\n\n${preservedEntries.trim()}\n`
      : autoSection;
    return `${source.replace(pattern, replacement).trimEnd()}\n`;
  }
  return `${source}\n\n${autoSection}`;
}

function extractDailyBridgeManualEntries(markdown) {
  const entries = [];
  const pattern = /^##\s+\[\d{2}:\d{2}\][\s\S]*?(?=^##\s+\[\d{2}:\d{2}\]|^<!-- DAILY_BRIDGE_AUTO_END -->|$(?![\s\S]))/gm;
  const seen = new Set();
  for (const match of String(markdown || "").matchAll(pattern)) {
    const entry = match[0].trim();
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join("\n\n");
}

function formatDailyBridgeText(dateText, markdown, realtimeMarkdown = "") {
  const body = stripFrontmatter(markdown).trim();
  const realtimeBody = stripFrontmatter(realtimeMarkdown).trim();
  const realtimeSection = realtimeBody
    ? `\n\n## Codex 飞书实时信号\n\n${clipText(tailText(realtimeBody, 1600), 1600)}`
    : "";
  const clipped = clipText(body || "摘要为空。", 3500);
  return [
    `每日桥接摘要：${dateText}`,
    "",
    `${clipped}${realtimeSection}`,
  ].join("\n");
}

function extractDailyBridgeSummary(markdown) {
  return {
    focus: extractBoldListSection(markdown, "今日焦点", 4),
    nextActions: extractBoldListSection(markdown, "下一步", 4),
    watches: extractBoldListSection(markdown, "需要观察", 3),
  };
}

function extractBoldListSection(markdown, title, limit) {
  const pattern = new RegExp(
    `\\*\\*${escapeRegExp(title)}\\*\\*[:：][\\s\\S]*?(?=\\n\\s*\\n|\\n\\*\\*|\\n###|\\n##|$)`,
    "m"
  );
  const match = String(markdown || "").match(pattern);
  if (!match) {
    return [];
  }
  return match[0]
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

async function buildMessageWithMemoryPreflight({ text, workspaceRoot = "", threadId = "" } = {}) {
  const originalText = String(text || "");
  const context = await buildMemoryPreflightContext({ text: originalText, workspaceRoot, threadId });
  if (!context) {
    return originalText;
  }
  return [
    context,
    "",
    "<user-message>",
    originalText,
    "</user-message>",
  ].join("\n");
}

async function buildMemoryPreflightContext({ text, workspaceRoot = "", threadId = "" } = {}) {
  if (!shouldAttachMemoryPreflight(text)) {
    return "";
  }

  const today = formatDate(new Date());
  const [compiledMemory, dailyBridge, realtimeLog, tasks, recallHits] = await Promise.all([
    compileCodexMemorySnapshot({ dateText: today }),
    readDailyBridgeText(today),
    readRealtimeSignalText(today),
    listRecentTasks({ limit: 8 }),
    searchVault(text, { limit: RECALL_CONTEXT_LIMIT }),
  ]);

  const taskLines = tasks.length
    ? tasks.map((task) => `- [${task.status}] ${task.title} · \`${task.fileName}\``).join("\n")
    : "- 当前任务池里没有可展示的最近待办。";
  const body = [
    "<memory-context>",
    "[System note: The following is recalled context from Jiao Knowledge Wiki, NOT new user input. Use it only as background when answering Jiao.]",
    "",
    `Vault: ${VAULT_ROOT}`,
    workspaceRoot ? `Workspace: ${workspaceRoot}` : "",
    threadId ? `Thread: ${threadId}` : "",
    "",
    "## Codex Memory Compiler Snapshot",
    compiledMemory
      ? clipText(stripFrontmatter(compiledMemory).trim(), 3600)
      : "No compiled memory snapshot found; falling back to daily bridge below.",
    "",
    compiledMemory ? "" : "## Today Daily Bridge",
    compiledMemory ? "" : (dailyBridge ? tailText(stripFrontmatter(dailyBridge).trim(), 2200) : "No daily bridge found for today."),
    compiledMemory ? "" : "",
    compiledMemory ? "" : "## Recent Codex Feishu Signals",
    compiledMemory ? "" : (realtimeLog ? tailText(stripFrontmatter(realtimeLog).trim(), 1200) : "No realtime signal log found for today."),
    "",
    "## Recent TaskNotes",
    taskLines,
    "",
    "## Related Obsidian Recall",
    formatRecallContext(recallHits),
    "",
    "## Recall Rule",
    "If Jiao asks what happened today, current progress, pending tasks, memory, Obsidian, OpenClaw, Hermes, Codex, or project status, answer from this context first and explicitly say when information is missing.",
    "</memory-context>",
  ].filter(Boolean).join("\n");

  return clipText(body, MEMORY_PREFLIGHT_MAX_CHARS);
}

async function compileCodexMemorySnapshot({ dateText = formatDate(new Date()) } = {}) {
  try {
    await fs.promises.access(MEMORY_COMPILER_SCRIPT, fs.constants.R_OK);
    const { stdout } = await execFileAsync("python3", [
      MEMORY_COMPILER_SCRIPT,
      "--date",
      dateText,
      "--stdout",
    ], {
      timeout: MEMORY_COMPILER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout || "";
  } catch (error) {
    console.warn(`[codex-im] codex_memory_compiler.py unavailable, falling back to raw memory context: ${error.message}`);
    return "";
  }
}

function shouldAttachMemoryPreflight(text) {
  const value = String(text || "").trim();
  if (!value || value.startsWith("/codex")) {
    return false;
  }
  return MEMORY_INTENT_RE.test(value);
}

async function recordInboundSignal({ normalized, workspaceRoot = "", threadId = "" } = {}) {
  const text = String(normalized?.text || "").trim();
  if (!text || text.startsWith("/codex")) {
    return null;
  }
  const now = new Date();
  const dateText = formatDate(now);
  const filePath = path.join(REALTIME_SIGNAL_DIR, `${dateText}.md`);
  await fs.promises.mkdir(REALTIME_SIGNAL_DIR, { recursive: true });
  await ensureRealtimeSignalFile(filePath, dateText);
  const entry = [
    "",
    `## ${formatTime(now)} · 飞书入站`,
    "",
    `- workspace: ${workspaceRoot ? `\`${workspaceRoot}\`` : "未绑定"}`,
    `- thread: ${threadId ? `\`${threadId}\`` : "未创建"}`,
    `- message: ${formatSignalMessage(text)}`,
    "",
  ].join("\n");
  await fs.promises.appendFile(filePath, entry, "utf8");
  return {
    filePath,
    relativePath: path.relative(VAULT_ROOT, filePath),
  };
}

function startDailyBridgeScheduler({ intervalMs = DAILY_BRIDGE_SCHEDULER_INTERVAL_MS } = {}) {
  if (dailyBridgeScheduler) {
    return dailyBridgeScheduler;
  }

  const run = () => {
    const now = new Date();
    updateDailyBridge({
      dateText: formatDate(now),
      note: "Gateway 内部定时刷新：同步今日任务池、飞书实时信号和记忆桥文件变化。",
      source: "Codex Feishu Gateway Scheduler",
    }).catch((error) => {
      console.error(`[codex-im] daily bridge scheduler failed: ${error.message}`);
    });
  };

  dailyBridgeScheduler = setInterval(run, intervalMs);
  if (typeof dailyBridgeScheduler.unref === "function") {
    dailyBridgeScheduler.unref();
  }

  const firstRunTimer = setTimeout(run, 10000);
  if (typeof firstRunTimer.unref === "function") {
    firstRunTimer.unref();
  }
  return dailyBridgeScheduler;
}

async function ensureRealtimeSignalFile(filePath, dateText) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const header = [
    "---",
    "type: agent-memory",
    "status: active",
    "privacy: private",
    "source: Codex Feishu Gateway",
    `captured_at: ${dateText}`,
    `updated_at: ${dateText}`,
    "owner: Jiao",
    "maintainer: 予安",
    "---",
    "",
    `# ${dateText} Codex 飞书实时信号`,
    "",
    "这份日志用于让飞书端的予安实时知道今天发生过什么。它只记录短摘要和入口指针，不写密钥、token 或可攻击细节。",
    "",
  ].join("\n");
  await fs.promises.writeFile(filePath, header, { encoding: "utf8", flag: "wx" });
}

async function readDailyBridgeText(dateText) {
  try {
    return await fs.promises.readFile(path.join(DAILY_BRIDGE_DIR, `${dateText}.md`), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readRealtimeSignalText(dateText) {
  try {
    return await fs.promises.readFile(path.join(REALTIME_SIGNAL_DIR, `${dateText}.md`), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function searchVault(query, { limit = 6 } = {}) {
  const scriptHits = await searchVaultViaRecallScript(query, { limit });
  if (scriptHits) {
    return scriptHits;
  }

  const terms = extractSearchTerms(query);
  if (!terms.length) {
    return [];
  }

  const files = [];
  for (const relativeDir of RECALL_SEARCH_DIRS) {
    await collectRecallMarkdownFiles(path.join(VAULT_ROOT, relativeDir), files);
    if (files.length >= RECALL_MAX_FILES) {
      break;
    }
  }

  const hits = [];
  for (const item of files.slice(0, RECALL_MAX_FILES)) {
    let text = "";
    try {
      if (item.size > RECALL_MAX_FILE_BYTES) {
        continue;
      }
      text = await fs.promises.readFile(item.filePath, "utf8");
    } catch {
      continue;
    }
    const hit = scoreRecallDocument({ filePath: item.filePath, text, terms, mtimeMs: item.mtimeMs });
    if (hit.score > 0) {
      hits.push(hit);
    }
  }

  return hits
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.mtimeMs - left.mtimeMs;
    })
    .slice(0, limit);
}

async function searchVaultViaRecallScript(query, { limit = 6 } = {}) {
  try {
    await fs.promises.access(RECALL_SCRIPT, fs.constants.R_OK);
    const { stdout } = await execFileAsync("python3", [
      RECALL_SCRIPT,
      String(query || ""),
      "--limit",
      String(limit),
      "--format",
      "json",
    ], {
      timeout: RECALL_SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.map(normalizeRecallScriptHit).filter(Boolean);
  } catch (error) {
    console.warn(`[codex-im] recall_wiki.py unavailable, falling back to JS keyword recall: ${error.message}`);
    return null;
  }
}

function normalizeRecallScriptHit(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const relativePath = item.relativePath || item.relative_path || "";
  if (!relativePath) {
    return null;
  }
  const matchedTerms = Array.isArray(item.matchedTerms)
    ? item.matchedTerms
    : Array.isArray(item.matched_terms)
      ? item.matched_terms
      : [];
  return {
    score: Number(item.score) || 0,
    title: item.title || path.basename(relativePath, ".md"),
    relativePath,
    excerpt: item.excerpt || "",
    matchedTerms,
    mtimeMs: item.mtimeMs || (Number(item.mtime) ? Number(item.mtime) * 1000 : 0),
  };
}

async function collectRecallMarkdownFiles(directory, output) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (output.length >= RECALL_MAX_FILES) {
      return;
    }
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (RECALL_IGNORE_DIRS.has(entry.name.toLowerCase())) {
        continue;
      }
      await collectRecallMarkdownFiles(filePath, output);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const stats = await fs.promises.stat(filePath);
    output.push({
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
  }
}

function scoreRecallDocument({ filePath, text, terms, mtimeMs }) {
  const relativePath = path.relative(VAULT_ROOT, filePath);
  const stripped = stripFrontmatter(text);
  const title = extractMarkdownTitle(stripped) || path.basename(filePath, ".md");
  const pathText = relativePath.toLowerCase();
  const titleText = title.toLowerCase();
  const bodyText = stripped.toLowerCase();
  let score = 0;
  const matchedTerms = [];

  for (const term of terms) {
    const needle = term.toLowerCase();
    const pathHits = countOccurrences(pathText, needle);
    const titleHits = countOccurrences(titleText, needle);
    const bodyHits = countOccurrences(bodyText, needle);
    if (pathHits || titleHits || bodyHits) {
      matchedTerms.push(term);
      score += pathHits * 10 + titleHits * 14 + Math.min(bodyHits, 12) * 2;
    }
  }

  if (!score) {
    return { score: 0 };
  }

  const daysOld = Math.max(0, (Date.now() - mtimeMs) / 86400000);
  const recencyBonus = Math.max(0, 4 - Math.floor(daysOld));
  score += recencyBonus;

  return {
    score,
    title,
    relativePath,
    excerpt: buildRecallExcerpt(stripped, matchedTerms.length ? matchedTerms : terms),
    matchedTerms,
    mtimeMs,
  };
}

function extractSearchTerms(query) {
  const raw = String(query || "").trim();
  if (!raw) {
    return [];
  }

  const terms = [];
  const asciiTerms = raw.match(/[a-z0-9][a-z0-9._-]{1,}/gi) || [];
  for (const term of asciiTerms) {
    terms.push(term);
  }

  const chineseChunks = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const hotChineseTerms = [
    "今天",
    "今日",
    "待办",
    "挂起",
    "记忆",
    "知识库",
    "沉淀",
    "复盘",
    "总结",
    "项目",
    "桥接",
    "飞书",
    "录音",
    "日历",
    "提醒",
  ];
  for (const chunk of chineseChunks) {
    if (chunk.length <= 12) {
      terms.push(chunk);
    }
    for (const hot of hotChineseTerms) {
      if (chunk.includes(hot)) {
        terms.push(hot);
      }
    }
    for (const part of chunk.split(/我们|你们|这个|那个|一下|怎么|什么|哪些|如何|可以|是不是|有没有|都|了|的|和|与|及|在|里|中|上|下/)) {
      if (part.length >= 2) {
        terms.push(part);
      }
    }
  }

  return [...new Set(terms.map((term) => term.trim()).filter((term) => term.length >= 2))]
    .slice(0, 14);
}

function extractMarkdownTitle(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) {
    return 0;
  }
  let count = 0;
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index < 0) {
      return count;
    }
    count += 1;
    start = index + needle.length;
  }
}

function buildRecallExcerpt(markdown, terms) {
  const clean = redactSensitiveText(String(markdown || ""))
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lower = clean.toLowerCase();
  const firstIndex = terms
    .map((term) => lower.indexOf(String(term || "").toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (firstIndex === undefined) {
    return clipText(clean, 360);
  }
  const start = Math.max(0, firstIndex - 120);
  const end = Math.min(clean.length, firstIndex + 420);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < clean.length ? " ..." : "";
  return clipText(`${prefix}${clean.slice(start, end).trim()}${suffix}`, 520);
}

function formatRecallContext(hits) {
  if (!hits.length) {
    return "No related Obsidian pages matched this query.";
  }
  return hits.map((hit, index) => [
    `${index + 1}. ${hit.title} · \`${hit.relativePath}\``,
    `   Matched: ${hit.matchedTerms.join(", ") || "keyword"}`,
    `   Excerpt: ${hit.excerpt.replace(/\n/g, " ")}`,
  ].join("\n")).join("\n");
}

function buildRecallText(query, hits) {
  if (!hits.length) {
    return [
      `Obsidian 召回：${query}`,
      "",
      "没有在当前安全检索范围里找到匹配内容。",
      "",
      "检索范围：Agent 记忆桥、项目页、Wiki、决策、Runbook、任务池。",
    ].join("\n");
  }

  return [
    `Obsidian 召回：${query}`,
    "",
    ...hits.map((hit, index) => [
      `${index + 1}. ${hit.title}`,
      `路径：\`${hit.relativePath}\``,
      `匹配：${hit.matchedTerms.join("、") || "关键词"}`,
      `摘要：${hit.excerpt}`,
    ].join("\n")),
  ].join("\n\n");
}

function buildTodoHelpText(tasks) {
  return [
    "TaskNotes 用法",
    "",
    "- `/codex todo <内容>` 创建普通待办",
    "- `/codex todo !high <内容>` 创建高优先级待办",
    "- `/codex todo suspend <内容>` 创建挂起事项",
    "- `/codex todo list` 查看最近待办",
    "",
    buildTodoListText(tasks),
  ].join("\n");
}

function buildTodoListText(tasks) {
  if (!tasks.length) {
    return "当前任务池里还没有可展示的待办。";
  }
  return [
    "最近待办：",
    ...tasks.map((task, index) => `${index + 1}. [${task.status}] ${task.title} (${task.fileName})`),
  ].join("\n");
}

async function collectDailySignals(dateText, { limit = 10 } = {}) {
  const text = await readRealtimeSignalText(dateText);
  if (!text) {
    return [];
  }
  const matches = String(text).match(/^##\s+\d{2}:\d{2}\s+·\s+飞书入站[\s\S]*?(?=^##\s+\d{2}:\d{2}\s+·\s+飞书入站|(?![\s\S]))/gm) || [];
  return matches.slice(-limit).map((block) => {
    const time = (block.match(/^##\s+([^·\n]+)·/) || [])[1]?.trim() || "";
    const message = (block.match(/^- message:\s*(.+)$/m) || [])[1]?.trim() || "未提取消息";
    return { time, message };
  });
}

function parseTodoDirective(rawValue) {
  let value = String(rawValue || "").trim();
  if (!value) {
    return { kind: "help" };
  }

  const normalized = value.toLowerCase();
  if (normalized === "list" || normalized === "ls") {
    return { kind: "list" };
  }
  if (normalized === "form" || normalized === "card" || normalized === "new") {
    return { kind: "form" };
  }
  if (normalized === "help") {
    return { kind: "help" };
  }

  let priority = "normal";
  let taskType = "task";
  let status = "open";
  if (/^!high\s+/i.test(value)) {
    priority = "high";
    value = value.replace(/^!high\s+/i, "").trim();
  } else if (/^!low\s+/i.test(value)) {
    priority = "low";
    value = value.replace(/^!low\s+/i, "").trim();
  }

  if (/^(suspend|suspended|挂起)\s+/i.test(value)) {
    taskType = "suspended";
    status = "suspended";
    value = value.replace(/^(suspend|suspended|挂起)\s+/i, "").trim();
  }

  return {
    kind: "create",
    title: value || "未命名待办",
    priority,
    taskType,
    status,
  };
}

async function createTaskNote({ title, taskType, status, priority, source, createdBy }) {
  const now = new Date();
  const directory = TASKS_DIR;
  await fs.promises.mkdir(directory, { recursive: true });

  const fileName = `${formatDateTimeForFile(now)}-${sanitizeFileName(title)}.md`;
  const filePath = path.join(directory, fileName);
  const relativePath = path.relative(VAULT_ROOT, filePath);
  const markdown = buildTaskMarkdown({
    title,
    taskType,
    status,
    priority,
    source,
    createdBy,
    createdAt: formatDateTime(now),
  });

  await fs.promises.writeFile(filePath, markdown, { encoding: "utf8", flag: "wx" });
  return { title, taskType, status, priority, filePath, relativePath, fileName };
}

function buildTaskMarkdown({
  title,
  taskType,
  status,
  priority,
  source,
  createdBy,
  createdAt,
}) {
  return [
    "---",
    `title: "${escapeYamlString(title)}"`,
    `status: ${status}`,
    `priority: ${priority}`,
    "due: ",
    "scheduled: ",
    "contexts:",
    "  - Jiao",
    "projects:",
    '  - "[[Jiao Knowledge Wiki]]"',
    "tags:",
    "  - task",
    `task_type: ${taskType}`,
    `source: ${source}`,
    `created_by: ${createdBy}`,
    `created_at: ${createdAt}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## 为什么要做",
    "",
    "从飞书入口记录，避免只留在聊天记录里。",
    "",
    "## 下一步动作",
    "",
    "待明确下一步。",
    "",
    "## 完成标准",
    "",
    "完成后更新状态，并将重要经验沉淀到 Wiki、Decision 或 Runbook。",
    "",
    "## 相关链接",
    "",
    "- [[Jiao Knowledge Wiki]]",
    "",
  ].join("\n");
}

async function listRecentTasks({ limit = 8 } = {}) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(TASKS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      console.warn(`[codex-im] list recent tasks skipped: ${error.message}`);
      return [{
        fileName: "TaskNotes permission blocked",
        title: "无法读取任务池：请给 Feishu 桥进程完整磁盘访问权限",
        status: "blocked",
      }];
    }
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, limit);

  const tasks = [];
  for (const fileName of files) {
    const filePath = path.join(TASKS_DIR, fileName);
    try {
      const text = await fs.promises.readFile(filePath, "utf8");
      tasks.push({
        fileName,
        title: extractFrontmatterValue(text, "title") || fileName.replace(/\.md$/, ""),
        status: extractFrontmatterValue(text, "status") || "open",
      });
    } catch {
      tasks.push({
        fileName,
        title: fileName.replace(/\.md$/, ""),
        status: "unknown",
      });
    }
  }
  return tasks;
}

async function collectDailyTasks(dateText, { limit = 12 } = {}) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(TASKS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const tasks = [];
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const fileName of fileNames) {
    const filePath = path.join(TASKS_DIR, fileName);
    const stats = await fs.promises.stat(filePath);
    const text = await fs.promises.readFile(filePath, "utf8");
    const createdAt = extractFrontmatterValue(text, "created_at");
    const modifiedAt = formatDate(stats.mtime);
    if (!createdAt.startsWith(dateText) && modifiedAt !== dateText) {
      continue;
    }
    tasks.push({
      fileName,
      title: extractFrontmatterValue(text, "title") || fileName.replace(/\.md$/, ""),
      status: extractFrontmatterValue(text, "status") || "open",
      priority: extractFrontmatterValue(text, "priority") || "normal",
      taskType: extractFrontmatterValue(text, "task_type") || "task",
    });
    if (tasks.length >= limit) {
      break;
    }
  }
  return tasks;
}

async function collectChangedAgentDocs(dateText, { limit = 16 } = {}) {
  const docs = [];
  await collectMarkdownFiles(AGENT_MEMORY_DIR, docs, dateText);
  return docs
    .filter((item) => path.basename(item.filePath) !== `${dateText}.md`)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((item) => path.relative(VAULT_ROOT, item.filePath));
}

async function collectPlatformStatus() {
  const statuses = [];
  const runner = await readJsonFile(OPENCLAW_RUNNER_STATE);
  const dashboard = await readJsonFile(OPENCLAW_DASHBOARD);
  if (runner || dashboard) {
    const projects = Array.isArray(dashboard?.projects) ? dashboard.projects : [];
    const activeProjects = projects.filter((project) => !["done", "completed", "archived"].includes(String(project.status || "").toLowerCase()));
    let detail = `runner=${runner?.last_result || "unknown"}`;
    if (activeProjects.length) {
      const project = activeProjects[0];
      detail += `，当前=${project.title || project.id} / ${project.phase || "unknown"}`;
    } else {
      detail += "，当前无未完成 running 项目";
    }
    statuses.push({
      platform: "OpenClaw project-hub",
      status: runner?.last_result || "unknown",
      detail,
      watch: activeProjects.length ? "OpenClaw project-hub 仍有未完成项目，需要继续观察 runner 是否自动推进。" : "",
    });
  }

  const cron = await readJsonFile(HERMES_CRON_JOBS);
  const jobs = Array.isArray(cron?.jobs) ? cron.jobs : [];
  if (jobs.length) {
    const enabledJobs = jobs.filter((job) => job.enabled !== false);
    const nextRuns = enabledJobs.map((job) => job.next_run_at).filter(Boolean).sort();
    const lastStatuses = Array.from(new Set(enabledJobs.map((job) => job.last_status || "unknown"))).sort();
    statuses.push({
      platform: "Hermes Cron",
      status: enabledJobs.length ? "scheduled" : "disabled",
      detail: `enabled=${enabledJobs.length}/${jobs.length}，last=${lastStatuses.join(",") || "unknown"}，next=${nextRuns[0] || "未提供"}`,
      watch: enabledJobs.length
        ? "Hermes Cron 下一次真实运行后，需要检查是否成功使用 recall_wiki 混合召回。"
        : "Hermes Cron 当前没有启用任务。",
    });
  }

  statuses.push({
    platform: "Codex Feishu Gateway",
    status: "running",
    detail: "自动桥接脚本可写入每日桥接；实时进程状态以 codex-gateway status 为准。",
    watch: "",
  });
  return statuses;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function collectMarkdownFiles(directory, output, dateText) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(filePath, output, dateText);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const stats = await fs.promises.stat(filePath);
    if (formatDate(stats.mtime) === dateText) {
      output.push({ filePath, mtimeMs: stats.mtimeMs });
    }
  }
}

function formatDailyTaskLines(tasks) {
  if (!tasks.length) {
    return ["- 今日暂无可自动识别的任务池变化。"];
  }
  return tasks.map((task) => (
    `- [${task.status}] ${task.title} · ${task.priority} · ${task.taskType} · \`${task.fileName}\``
  ));
}

function formatDailyPathLines(paths) {
  if (!paths.length) {
    return ["- 今日暂无可自动识别的 Agent 记忆桥文件变化。"];
  }
  return paths.map((item) => `- \`${item}\``);
}

function formatDailyPlatformStatusLines(statuses) {
  if (!statuses.length) {
    return ["- 暂无可自动识别的平台运行状态。"];
  }
  return statuses.map((item) => `- ${item.platform}：${item.status} · ${item.detail}`);
}

function formatDailySignalLines(signals) {
  if (!signals.length) {
    return ["- 今日暂无 Codex 飞书实时信号。"];
  }
  return signals.map((signal) => `- ${signal.time} · ${signal.message}`);
}

function extractTodayDate(text) {
  const match = String(text || "").match(/^\/codex\s+today\s+(\d{4}-\d{2}-\d{2})\s*$/i);
  return match ? match[1] : "";
}

function extractFrontmatterValue(markdown, key) {
  const match = String(markdown || "").match(new RegExp(`^${escapeRegExp(key)}:\\s*"?([^"\\n]+)"?\\s*$`, "m"));
  return match ? match[1].trim() : "";
}

function stripFrontmatter(markdown) {
  return String(markdown || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function clipText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 20)}\n\n...（已截断）`;
}

function tailText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) {
    return value;
  }
  return `...（前文已省略）\n${value.slice(value.length - maxChars)}`;
}

function redactSensitiveText(value) {
  let text = String(value || "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

function formatSignalMessage(text) {
  const clean = redactSensitiveText(String(text || ""))
    .replace(/\s+/g, " ")
    .trim();
  const clipped = clean.length > SIGNAL_MESSAGE_MAX_CHARS
    ? `${clean.slice(0, SIGNAL_MESSAGE_MAX_CHARS - 16)}...（已截断）`
    : clean;
  return clipped ? `“${clipped.replace(/"/g, '\\"')}”` : "空消息";
}

function sanitizeFileName(value) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|#[\]]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "untitled-task";
}

function normalizePriority(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["low", "normal", "high"].includes(normalized) ? normalized : "normal";
}

function escapeYamlString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-");
}

function formatDateTimeForFile(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("") + `-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

function formatDateTime(date) {
  return `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  buildMessageWithMemoryPreflight,
  buildMemoryPreflightContext,
  handleBridgeCommand,
  handleMemoryCommand,
  handleMemoryHelpCommand,
  handleRecallCommand,
  handleTodayCommand,
  handleTodoCommand,
  handleTodoFormCommand,
  handleTodoSubmitCardAction,
  recordInboundSignal,
  searchVault,
  startDailyBridgeScheduler,
};

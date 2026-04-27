const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const OPENCLAW_BIN = process.env.CODEX_IM_OPENCLAW_BIN || "/opt/homebrew/bin/openclaw";
const HERMES_BIN = process.env.CODEX_IM_HERMES_BIN || "/Users/keeploving/.hermes/hermes-agent/venv/bin/hermes";
const OPENCLAW_WORKSPACE = process.env.CODEX_IM_OPENCLAW_WORKSPACE || "/Users/keeploving/.openclaw/workspace";
const PROJECT_HUB_ROOT = path.join(OPENCLAW_WORKSPACE, "runtime", "project-hub");
const PROJECT_HUB_REGISTRY = path.join(PROJECT_HUB_ROOT, "mention-registry.json");
const PROJECT_HUB_DASHBOARD = path.join(PROJECT_HUB_ROOT, "dashboard", "index.json");
const CODEX_IM_STATE_DIR = process.env.CODEX_IM_STATE_DIR || path.join(process.env.HOME || "/Users/keeploving", ".codex-im");
const HUB_LOG_DIR = path.join(CODEX_IM_STATE_DIR, "hub-dispatch-logs");
const ALLOWED_OPENCLAW_AGENTS = new Set(["main", "xiye", "lantu", "lixing", "hengjing", "guizheng", "ash-mini"]);

async function handleHubCommand(runtime, normalized) {
  const directive = parseHubDirective(normalized.text);
  if (directive.kind === "help") {
    await sendHubHelp(runtime, normalized);
    return;
  }
  if (directive.kind === "status") {
    await sendHubStatus(runtime, normalized);
    return;
  }
  if (directive.kind === "broadcast") {
    await handleHubBroadcast(runtime, normalized, directive.message);
    return;
  }
  if (directive.kind === "dispatch") {
    await handleOpenClawDispatch(runtime, normalized, directive.agent, directive.message);
    return;
  }
  if (directive.kind === "hermes") {
    await handleHermesDispatch(runtime, normalized, directive.message);
    return;
  }
  if (directive.kind === "pull") {
    await sendHubPull(runtime, normalized);
    return;
  }
  await sendHubHelp(runtime, normalized);
}

async function sendHubHelp(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      "Codex Hub 指挥台",
      "",
      "这组命令只控制外部协作链，不影响 Codex Desktop 本体。",
      "",
      "- `/codex hub status` 查看 OpenClaw / Hermes / 项目中枢状态",
      "- `/codex hub broadcast <内容>` 向项目中枢群广播进度，不 @ 任何 Agent",
      "- `/codex hub dispatch xiye <任务>` 直连派发给 OpenClaw Agent",
      "- `/codex hub hermes <任务>` 直连派发给 Hermes",
      "- `/codex hub pull` 拉取最近 gate result / 接力状态",
      "",
      "规则：干活走直连，群里只广播给 Jiao 看。",
    ].join("\n"),
  });
}

async function sendHubStatus(runtime, normalized) {
  const project = await loadCurrentHubProject();
  const xiye = await loadAgentStatus("xiye");
  const hermes = await getHermesGatewayStatusLine();
  const openclaw = await getOpenClawGatewayStatusLine();
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      "Hub 状态",
      "",
      `OpenClaw：${openclaw}`,
      `Hermes：${hermes}`,
      "",
      "当前项目中枢：",
      project
        ? `- ${project.title || project.project_name} · ${project.status} · ${project.phase} · owner: ${project.current_owner || project.owner || "unknown"}`
        : "- 暂未找到运行中的 LLM Wiki 接入项目",
      "",
      "析野状态：",
      xiye
        ? `- ${xiye.status || "unknown"} · ${xiye.current_project || "无当前项目"} · ${xiye.current_task || "无当前任务"}`
        : "- 未找到状态文件",
    ].join("\n"),
  });
}

async function handleHubBroadcast(runtime, normalized, rawMessage) {
  const message = sanitizeBroadcastMessage(rawMessage);
  if (!message) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "广播内容不能为空。用法：`/codex hub broadcast <内容>`",
    });
    return;
  }
  const result = await sendProjectHubBroadcast(`【予安进度】${message}`);
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: result.ok
      ? "已广播到项目中枢群。没有 @ 任何 Agent，只做进度可见。"
      : `广播失败：${result.error}`,
  });
}

async function handleOpenClawDispatch(runtime, normalized, agent, rawMessage) {
  const targetAgent = String(agent || "").trim();
  const message = String(rawMessage || "").trim();
  if (!ALLOWED_OPENCLAW_AGENTS.has(targetAgent) || !message) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        "OpenClaw 派发参数不完整。",
        "",
        "用法：`/codex hub dispatch xiye <任务>`",
        "可选 Agent：main, xiye, lantu, lixing, hengjing, guizheng, ash-mini",
      ].join("\n"),
    });
    return;
  }
  const spawned = await spawnLoggedProcess({
    prefix: `openclaw-${targetAgent}`,
    command: OPENCLAW_BIN,
    args: ["agent", "--agent", targetAgent, "--message", message, "--json"],
  });
  const broadcast = await sendProjectHubBroadcast(`【予安进度】已通过直连派发给 OpenClaw/${targetAgent}。群内不 @，执行链走本地 agent。`);
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      `已直连派发给 OpenClaw/${targetAgent}。`,
      "",
      `PID：${spawned.pid}`,
      `日志：\`${spawned.logPath}\``,
      `广播：${broadcast.ok ? "已发送" : `失败：${broadcast.error}`}`,
    ].join("\n"),
  });
}

async function handleHermesDispatch(runtime, normalized, rawMessage) {
  const message = String(rawMessage || "").trim();
  if (!message) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "Hermes 派发内容不能为空。用法：`/codex hub hermes <任务>`",
    });
    return;
  }
  const spawned = await spawnLoggedProcess({
    prefix: "hermes",
    command: HERMES_BIN,
    args: ["chat", "-Q", "--source", "tool", "-q", message],
  });
  const broadcast = await sendProjectHubBroadcast("【予安进度】已通过 Hermes CLI 投递任务。群内只广播进度，不把 @ 当执行链。");
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      "已直连派发给 Hermes。",
      "",
      `PID：${spawned.pid}`,
      `日志：\`${spawned.logPath}\``,
      `广播：${broadcast.ok ? "已发送" : `失败：${broadcast.error}`}`,
    ].join("\n"),
  });
}

async function sendHubPull(runtime, normalized) {
  const projectDir = path.join(OPENCLAW_WORKSPACE, "projects", "llmwiki-obsidian-bridge-2026-04-25");
  const resultDir = path.join(projectDir, "runtime", "gate-results");
  const resultFiles = await listFiles(resultDir);
  const hermesHandoff = "/Users/keeploving/.hermes/work/llmwiki-obsidian-bridge-20260425/HERMES_HANDOFF.md";
  const hermesExists = await pathExists(hermesHandoff);
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      "Hub 拉取结果",
      "",
      "OpenClaw gate results：",
      ...(resultFiles.length ? resultFiles.map((file) => `- ${file}`) : ["- 暂无 gate result 写回"]),
      "",
      `Hermes 接力卡：${hermesExists ? "存在" : "未找到"}`,
    ].join("\n"),
  });
}

function parseHubDirective(text) {
  const raw = String(text || "").trim();
  const value = raw.replace(/^\/codex\s+hub\b/i, "").trim();
  if (!value || value === "help") {
    return { kind: "help" };
  }
  if (value === "status") {
    return { kind: "status" };
  }
  if (value === "pull") {
    return { kind: "pull" };
  }
  const broadcast = value.match(/^broadcast\s+([\s\S]+)$/i);
  if (broadcast) {
    return { kind: "broadcast", message: broadcast[1].trim() };
  }
  const dispatch = value.match(/^dispatch\s+([a-z0-9-]+)\s+([\s\S]+)$/i);
  if (dispatch) {
    return { kind: "dispatch", agent: dispatch[1].trim(), message: dispatch[2].trim() };
  }
  const hermes = value.match(/^hermes\s+([\s\S]+)$/i);
  if (hermes) {
    return { kind: "hermes", message: hermes[1].trim() };
  }
  return { kind: "help" };
}

async function loadCurrentHubProject() {
  const dashboard = await readJsonSafe(PROJECT_HUB_DASHBOARD);
  const projects = Array.isArray(dashboard?.projects) ? dashboard.projects : [];
  return projects.find((project) => project.id === "llmwiki-obsidian-bridge-20260425")
    || projects.find((project) => String(project.status || "") === "running")
    || null;
}

async function loadAgentStatus(nodeId) {
  return readJsonSafe(path.join(OPENCLAW_WORKSPACE, "runtime", "agents", nodeId, "status.json"));
}

async function getHermesGatewayStatusLine() {
  const result = await runShortCommand(HERMES_BIN, ["gateway", "status"], 8000);
  if (!result.ok) {
    return `未知（${result.error}）`;
  }
  return /Gateway is running/i.test(result.output) ? "运行中" : clipOneLine(result.output, 80);
}

async function getOpenClawGatewayStatusLine() {
  const processCheck = await runShortCommand("/usr/bin/pgrep", ["-f", "openclaw-gateway"], 2000);
  if (processCheck.ok && processCheck.output.trim()) {
    return "运行中";
  }
  const result = await runShortCommand(OPENCLAW_BIN, ["health"], 8000);
  if (!result.ok) {
    return `未知（${result.error}）`;
  }
  if (/ok|healthy|running/i.test(result.output)) {
    return "运行中";
  }
  return clipOneLine(result.output, 80);
}

async function sendProjectHubBroadcast(message) {
  const target = await resolveProjectHubTarget();
  if (!target) {
    return { ok: false, error: "未找到项目中枢群 target" };
  }
  const result = await runShortCommand(OPENCLAW_BIN, [
    "message",
    "send",
    "--channel",
    "feishu",
    "--account",
    "default",
    "--target",
    target,
    "--message",
    message,
    "--json",
  ], 90000);
  return result.ok ? { ok: true } : { ok: false, error: result.error || clipOneLine(result.output, 160) };
}

async function resolveProjectHubTarget() {
  const explicit = String(process.env.CODEX_IM_PROJECT_HUB_TARGET || "").trim();
  if (explicit) {
    return explicit;
  }
  const registry = await readJsonSafe(PROJECT_HUB_REGISTRY);
  const targets = Array.isArray(registry?.targets) ? registry.targets : [];
  const group = targets.find((item) => item?.key === "project-hub-group");
  const chatId = String(group?.chat_id || "").trim();
  return chatId ? `chat:${chatId}` : "";
}

async function spawnLoggedProcess({ prefix, command, args }) {
  await fs.promises.mkdir(HUB_LOG_DIR, { recursive: true });
  const logPath = path.join(HUB_LOG_DIR, `${formatDateTimeForFile(new Date())}-${sanitizeFileName(prefix)}.log`);
  const fd = await fs.promises.open(logPath, "a");
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", fd.fd, fd.fd],
    env: {
      ...process.env,
      PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
  });
  child.unref();
  await fd.close();
  return { pid: child.pid, logPath };
}

async function runShortCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, output, error: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output, error: code === 0 ? "" : clipOneLine(output, 200) || `exit ${code}` });
    });
  });
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function listFiles(directory) {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeBroadcastMessage(value) {
  return String(value || "")
    .replace(/<at\b[^>]*>.*?<\/at>/gi, "")
    .replace(/chat:oc_[a-z0-9]+/gi, "[chat]")
    .replace(/ou_[a-z0-9]+/gi, "[user]")
    .trim()
    .slice(0, 900);
}

function clipOneLine(value, maxChars) {
  const line = String(value || "").replace(/\s+/g, " ").trim();
  if (line.length <= maxChars) {
    return line;
  }
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatDateTimeForFile(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function sanitizeFileName(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|#[\]\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "hub";
}

module.exports = {
  handleHubCommand,
};

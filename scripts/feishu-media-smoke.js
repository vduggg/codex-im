#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const lark = require("@larksuiteoapi/node-sdk");
const dotenv = require("dotenv");
const { readConfig } = require("../src/infra/config/config");
const { FeishuClientAdapter } = require("../src/infra/feishu/client-adapter");
const {
  classifyLocalAttachment,
  inferFeishuFileType,
} = require("../src/shared/media-types");

dotenv.config();

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function main() {
  const config = readConfig();
  const chatId = process.env.CODEX_IM_SMOKE_CHAT_ID || resolveFirstChatId(config.sessionsFile);
  if (!chatId) {
    throw new Error("No smoke chat id found. Set CODEX_IM_SMOKE_CHAT_ID or bind a Feishu chat first.");
  }
  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET.");
  }

  const client = new lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    disableTokenCache: false,
  });
  const adapter = new FeishuClientAdapter(client);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yuan-feishu-media-smoke-"));
  const prefix = `[自动测试] yuan-feishu-media ${new Date().toISOString()}`;

  const textPath = path.join(tempDir, "yuan-feishu-media-smoke.txt");
  fs.writeFileSync(textPath, `${prefix}\nfile upload smoke test\n`, "utf8");
  const imagePath = path.join(tempDir, "yuan-feishu-media-smoke.png");
  fs.writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

  await sendLocalPath(adapter, chatId, imagePath);
  console.log(`sent image smoke to ${chatId}`);
  await sendLocalPath(adapter, chatId, textPath);
  console.log(`sent file smoke to ${chatId}`);

  const audioPath = resolveAudioSmokePath();
  if (audioPath) {
    await sendLocalPath(adapter, chatId, audioPath);
    console.log(`sent audio smoke to ${chatId}: ${audioPath}`);
  } else {
    console.log("audio smoke skipped: set CODEX_IM_SMOKE_AUDIO_PATH to a small .opus or .mp4 file");
  }
}

async function sendLocalPath(adapter, chatId, filePath) {
  const kind = classifyLocalAttachment(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  if (kind === "image") {
    await adapter.sendImageMessage({
      chatId,
      imageBuffer: fileBuffer,
    });
    return;
  }
  const fileType = inferFeishuFileType(filePath);
  await adapter.sendFileMessage({
    chatId,
    fileName: path.basename(filePath),
    fileBuffer,
    fileType,
    msgType: kind === "audio" ? "audio" : "file",
  });
}

function resolveFirstChatId(sessionsFile) {
  if (!sessionsFile || !fs.existsSync(sessionsFile)) {
    return "";
  }
  const data = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
  const bindings = data.bindings || data || {};
  for (const key of Object.keys(bindings)) {
    const parts = key.split(":");
    const chatId = parts.find((part) => part.startsWith("oc_"));
    if (chatId) {
      return chatId;
    }
  }
  return "";
}

function resolveAudioSmokePath() {
  const fromEnv = process.env.CODEX_IM_SMOKE_AUDIO_PATH || "";
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  const candidates = [
    path.join(os.homedir(), ".nvm/versions/node/v24.14.1/lib/node_modules/openclaw/dist/extensions/discord/node_modules/@discordjs/opus/tests/frame.opus"),
    path.join(os.homedir(), ".nvm/versions/node/v24.14.1/lib/node_modules/openclaw/node_modules/@discordjs/opus/tests/frame.opus"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

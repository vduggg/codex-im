const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const profiles = Object.freeze({
  deepseek: "deepseek-pro",
  "deepseek-pro": "deepseek-pro",
});

const displayNames = Object.freeze({
  deepseek: "deepseek",
});

function getProfileHelpLines() {
  return ["`/codex profile deepseek`"];
}

function getProfileNote() {
  return "；不会修改 OpenClaw";
}

async function beforeSwitchCodexAppServerProfile(nextProfile, env = process.env) {
  if (nextProfile === "deepseek-pro") {
    await ensureDeepSeekAdapter(env);
  }
}

function ensureDeepSeekAdapter(env = process.env) {
  return new Promise((resolve, reject) => {
    checkDeepSeekAdapter((isAlive) => {
      if (isAlive) {
        resolve();
        return;
      }
      const adapterScript = path.join(env.HOME || "", ".codex", "bin", "start-deepseek-litellm.sh");
      const adapterEnv = { ...env };
      if (!adapterEnv.DEEPSEEK_API_KEY) {
        adapterEnv.DEEPSEEK_API_KEY = readDeepSeekApiKeyFromOpenClaw(env.HOME || "");
      }
      if (!adapterEnv.DEEPSEEK_API_KEY) {
        reject(new Error("DeepSeek API key is missing. Set DEEPSEEK_API_KEY before switching to deepseek."));
        return;
      }
      const outPath = path.join(env.HOME || "", ".codex", "deepseek-adapter.log");
      const out = fs.openSync(outPath, "a");
      const child = spawn(adapterScript, [], {
        env: adapterEnv,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        checkDeepSeekAdapter((ready) => {
          if (ready) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (attempts >= 30) {
            clearInterval(timer);
            reject(new Error(`DeepSeek adapter failed to start. See ${outPath}`));
          }
        });
      }, 250);
    });
  });
}

function checkDeepSeekAdapter(callback) {
  const req = http.request({
    host: "127.0.0.1",
    port: 4011,
    path: "/v1/models",
    method: "GET",
    timeout: 1000,
  }, (res) => {
    res.resume();
    callback(res.statusCode >= 200 && res.statusCode < 300);
  });
  req.on("error", () => callback(false));
  req.on("timeout", () => {
    req.destroy();
    callback(false);
  });
  req.end();
}

function readDeepSeekApiKeyFromOpenClaw(home) {
  try {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(parsed?.models?.providers?.deepseek?.apiKey || "").trim();
  } catch {
    return "";
  }
}

module.exports = {
  beforeSwitchCodexAppServerProfile,
  displayNames,
  getProfileHelpLines,
  getProfileNote,
  profiles,
};

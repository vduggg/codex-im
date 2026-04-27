const memoryBridgeRuntime = require("../private/extensions/memory-bridge/memory-bridge-service");
const hubRuntime = require("../private/extensions/hub/hub-service");
const codexProfileAdapter = require("../private/extensions/codex-profile-adapter");

module.exports = {
  codexProfiles: codexProfileAdapter,
  memoryBridge: memoryBridgeRuntime,
  hub: hubRuntime,
};

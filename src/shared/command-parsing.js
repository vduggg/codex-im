function extractBindPath(text) {
  return extractCommandArgument(text, "/codex bind ");
}

function extractSwitchThreadId(text) {
  return extractCommandArgument(text, "/codex switch ");
}

function extractRemoveWorkspacePath(text) {
  return extractCommandArgument(text, "/codex remove ");
}

function extractSendPath(text) {
  return extractCommandArgument(text, "/codex send ");
}

function extractModelValue(text) {
  return extractCommandArgument(text, "/codex model ");
}

function extractEffortValue(text) {
  return extractCommandArgument(text, "/codex effort ");
}

function extractProfileValue(text) {
  return extractCommandArgument(text, "/codex profile ");
}

function extractTodoValue(text) {
  return extractCommandArgument(text, "/codex todo ");
}

function extractBridgeValue(text) {
  return extractCommandArgument(text, "/codex bridge ");
}

function extractRecallValue(text) {
  return extractCommandArgument(text, "/codex recall ");
}

function extractCommandArgument(text, prefix) {
  const trimmed = String(text || "").trim();
  const normalizedPrefix = String(prefix || "").toLowerCase();
  if (trimmed.toLowerCase().startsWith(normalizedPrefix)) {
    return trimmed.slice(normalizedPrefix.length).trim();
  }
  return "";
}

module.exports = {
  extractBindPath,
  extractBridgeValue,
  extractEffortValue,
  extractModelValue,
  extractProfileValue,
  extractRecallValue,
  extractRemoveWorkspacePath,
  extractSendPath,
  extractSwitchThreadId,
  extractTodoValue,
};

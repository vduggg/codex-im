function buildUserInputItems({ text = "", imagePaths = [] } = {}) {
  const items = [];
  const normalizedText = normalizeNonEmptyString(text);
  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
      text_elements: [],
    });
  }

  const normalizedImagePaths = Array.isArray(imagePaths) ? imagePaths : [];
  for (const imagePath of normalizedImagePaths) {
    const normalizedPath = normalizeNonEmptyString(imagePath);
    if (!normalizedPath) {
      continue;
    }
    items.push({
      type: "localImage",
      path: normalizedPath,
    });
  }

  return items;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildUserInputItems,
};

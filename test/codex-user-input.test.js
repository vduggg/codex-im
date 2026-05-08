const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildUserInputItems,
} = require("../src/infra/codex/user-input");

test("builds text and local image items in order", () => {
  const items = buildUserInputItems({
    text: "请描述这张图",
    imagePaths: ["/tmp/a.png", "/tmp/b.png"],
  });

  assert.deepEqual(items, [
    {
      type: "text",
      text: "请描述这张图",
      text_elements: [],
    },
    {
      type: "localImage",
      path: "/tmp/a.png",
    },
    {
      type: "localImage",
      path: "/tmp/b.png",
    },
  ]);
});

test("keeps pure text payloads unchanged", () => {
  const items = buildUserInputItems({
    text: "/codex where",
    imagePaths: [],
  });

  assert.deepEqual(items, [
    {
      type: "text",
      text: "/codex where",
      text_elements: [],
    },
  ]);
});

test("builds image only payloads without adding text", () => {
  const items = buildUserInputItems({
    text: "",
    imagePaths: ["/tmp/a.png"],
  });

  assert.deepEqual(items, [
    {
      type: "localImage",
      path: "/tmp/a.png",
    },
  ]);
});

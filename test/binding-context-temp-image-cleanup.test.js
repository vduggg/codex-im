const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bindingContext = require("../src/domain/session/binding-context");

test("cleans only the matching turn temp images on the same thread", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-binding-context-"));
  const fileA = path.join(tempRoot, "a.png");
  const fileB = path.join(tempRoot, "b.png");
  fs.writeFileSync(fileA, "a");
  fs.writeFileSync(fileB, "b");

  const deleted = [];
  const runtime = {
    pendingTempImageFilesByThreadId: new Map(),
    async cleanupTempFiles(files) {
      for (const file of files) {
        deleted.push(path.basename(file.path));
        await fs.promises.unlink(file.path).catch(() => {});
      }
    },
  };

  bindingContext.setPendingTempImageFiles(runtime, "thread_1", "turn_1", [{ path: fileA }]);
  bindingContext.setPendingTempImageFiles(runtime, "thread_1", "turn_2", [{ path: fileB }]);

  await bindingContext.cleanupPendingTempImageFiles(runtime, "thread_1", "turn_1");

  assert.deepEqual(deleted, ["a.png"]);
  assert.equal(fs.existsSync(fileA), false);
  assert.equal(fs.existsSync(fileB), true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

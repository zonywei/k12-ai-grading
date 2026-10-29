import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultHome } from "../scripts/core.mjs";
test("环境：双宿主互斥、进程中断释放锁、损坏缓存重新核验", () => {
  const python = path.join(
    defaultHome(),
    "python",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const result = spawnSync(
    python,
    [fileURLToPath(new URL("./test_environment.py", import.meta.url))],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(result.stderr.includes("Ran 3 tests"));
});

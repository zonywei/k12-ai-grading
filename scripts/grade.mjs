#!/usr/bin/env node
// 智能体离线入口：无浏览器、无网络、无关键词评分；接收智能体已理解的逐点决策。
import path from "node:path";
import { Store, json, fail } from "./core.mjs";
const args = process.argv.slice(2),
  cmd = args[0];
const option = (k) => {
  const i = args.indexOf("--" + k);
  return i < 0 ? "" : args[i + 1];
};
try {
  fail(option("run-dir"), "由智能体指定本机私密run-dir");
  const store = new Store(option("run-dir"));
  if (cmd === "rubric")
    console.log(JSON.stringify(store.setRubric(json(option("input")))));
  else if (cmd === "record") {
    const x = json(option("input"));
    fail(
      x.snapshot?.snapshot_file?.startsWith("snapshots/"),
      "离线作答必须有snapshots下的文件引用",
    );
    fail(
      path
        .resolve(store.dir, x.snapshot.snapshot_file)
        .startsWith(store.dir + path.sep),
      "快照路径越界",
    );
    store.write(x.snapshot.snapshot_file, x.snapshot);
    console.log(JSON.stringify(store.score(x.decision, x.snapshot)));
  } else if (cmd === "summary") console.log(JSON.stringify(store.summary()));
  else
    throw Error(
      "命令：rubric|record --input FILE，或summary；均需--run-dir PRIVATE_DIR",
    );
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exitCode = 2;
}

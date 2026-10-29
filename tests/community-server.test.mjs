import { chromium } from "playwright";
import { readCatalog } from "../scripts/rules.mjs";
import { renderRulesHTML } from "../scripts/build_rules_docs.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultHome, digest } from "../scripts/core.mjs";
import {
  contributionBody,
  improvementCodes,
  syntheticChecks,
} from "../scripts/experience.mjs";
import { communityService } from "../scripts/sharing.mjs";
const privatePython = path.join(
  defaultHome(),
  "python",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const processes = [],
  dirs = [];
after(() => {
  for (const p of processes) p.kill();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
async function service(t, { rate = 60 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k12-server-"));
  dirs.push(dir);
  const child = spawn(
    fs.existsSync(privatePython)
      ? privatePython
      : process.platform === "win32"
        ? "python"
        : "python3",
    [
      fileURLToPath(new URL("../community-server/server.py", import.meta.url)),
      "--port",
      "0",
      "--db",
      path.join(dir, "intake.sqlite"),
      "--downloads",
      path.join(dir, "downloads"),
      "--rate-limit",
      String(rate),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  processes.push(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
  const ready = await new Promise((resolve, reject) => {
    let data = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("接收端未就绪"));
    }, 5000);
    child.stderr.on("data", (v) => (err += v));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(err));
    });
    child.stdout.on("data", (v) => {
      data += v;
      if (data.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(data.split("\n")[0]));
      }
    });
  });
  const base = `http://127.0.0.1:${ready.port}`;
  const post = async (payload, headers = {}, raw) =>
    fetch(base + "/api/v1/contributions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": payload.key,
        "X-K12-Sharing-Policy": communityService.notice_version,
        ...headers,
      },
      body: raw ?? JSON.stringify(payload),
    });
  return { base, post, child, dir };
}
function packet() {
  const body = contributionBody({
    subject: "physics",
    stage: "high",
    improvements: [
      { code: "receipt-before-next", synthetic_check: "missing-receipt" },
    ],
  });
  return { key: digest(body), ...body };
}

test("真实HTTP入库后才给回执，同key重试只形成一个待审核条目", async (t) => {
  const { post, base } = await service(t),
    p = packet();
  const first = await post(p);
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), {
    accepted: true,
    key: p.key,
    duplicate: false,
    status: "pending_review",
  });
  const second = await post(p);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  assert.equal((await (await fetch(base + "/health")).json()).ok, true);
});
test("接收端拒绝夹带字段、未知代码、错哈希、重复JSON字段与过期政策", async (t) => {
  const { post } = await service(t),
    p = packet();
  for (const payload of [
    { ...p, student_name: "合成隐私" },
    { ...p, improvements: [{ code: "任意原文", synthetic_check: "negation" }] },
    { ...p, key: "0".repeat(64) },
    { ...p, schema_version: true },
    { ...p, stage: [] },
    {
      ...p,
      improvements: [
        {
          code: "receipt-before-next",
          synthetic_check: "missing-receipt",
          answer: "合成原文",
        },
      ],
    },
  ]) {
    const r = await post(payload);
    assert.equal(r.status, 400);
    assert.equal((await r.text()).includes("合成"), false);
  }
  assert.equal((await post(p, { "X-K12-Sharing-Policy": "old" })).status, 403);
  assert.equal(
    (
      await post(
        p,
        {},
        JSON.stringify(p).replace(
          '"schema_version":1',
          '"schema_version":1,"schema_version":1',
        ),
      )
    ).status,
    400,
  );
  assert.equal((await post(p, { "Idempotency-Key": "wrong" })).status, 400);
});
test("接收端长度、类型、限流及公开数据读取边界", async (t) => {
  const { post, base } = await service(t, { rate: 4 }),
    p = packet();
  assert.equal((await post(p, {}, " ".repeat(16385))).status, 413);
  assert.equal((await post(p, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post(p)).status, 201);
  assert.equal((await post(p)).status, 200);
  assert.equal((await post(p)).status, 429);
  for (const url of [
    "/api/v1/contributions",
    "/admin",
    "/contributions.sqlite",
    "/downloads/../PRIVACY.md",
  ])
    assert.equal((await fetch(base + url)).status, 404);
  assert.equal((await fetch(base + "/privacy")).status, 200);
});
test("Node与Python固定枚举序列化、排序及历史版本协议一致", async (t) => {
  const { post } = await service(t);
  for (const stage of ["primary", "middle", "high", "general"]) {
    const body = contributionBody(
      {
        subject: "physics",
        stage,
        improvements: improvementCodes
          .slice(0, 12)
          .reverse()
          .map((code, i) => ({ code, synthetic_check: syntheticChecks[i] })),
      },
      "3.0.0",
    );
    const r = await post({ key: digest(body), ...body });
    assert.equal(r.status, 201, await r.text());
  }
});

test("数据库无法提交时不给接收回执，健康检查也报告不可用", async (t) => {
  const { post, base, dir } = await service(t);
  fs.writeFileSync(path.join(dir, "intake.sqlite"), "not-a-database");
  const response = await post(packet());
  assert.equal(response.status, 503);
  assert.notEqual((await response.json()).accepted, true);
  assert.equal((await fetch(base + "/health")).status, 503);
});
test("并发重复投稿仅一次新建，其他请求读取相同入库回执", async (t) => {
  const { post } = await service(t),
    p = packet();
  const results = await Promise.all(Array.from({ length: 8 }, () => post(p)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200).length, 7);
  for (const response of results)
    assert.equal((await response.json()).key, p.key);
});

test("规则页经HTTP服务下载时CSP允许学段学科交互", async (t) => {
  const { base, dir } = await service(t);
  fs.mkdirSync(path.join(dir, "downloads"));
  fs.writeFileSync(
    path.join(dir, "downloads/K12-default-rules.html"),
    renderRulesHTML(readCatalog()),
  );
  const response = await fetch(base + "/downloads/K12-default-rules.html");
  await response.text();
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy"),
    /script-src 'sha256-/,
  );
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base + "/downloads/K12-default-rules.html");
  await page.locator("#school-stage").selectOption("high");
  await page.locator("#subject").selectOption("physics");
  assert.match(await page.locator("#heading").textContent(), /物理/);
  assert.equal(await page.locator("#primary-control").isVisible(), false);
});

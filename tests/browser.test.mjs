import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Store, digest, commit, recover } from "../scripts/core.mjs";
import { BrowserAdapter, dispatch, observe } from "../scripts/browser.mjs";
import { prepareIntake } from "../scripts/intake.mjs";
import { readCatalog } from "../scripts/rules.mjs";
import { renderRulesHTML } from "../scripts/build_rules_docs.mjs";
const r = {
  schema_version: 2,
  task_id: "t",
  qid: "Q9",
  version: "1",
  kind: "short_answer",
  question: "结合材料分析",
  reference_answer: "借景抒情",
  max_score: 2,
  step: 1,
  points: [{ id: "a", max: 2, description: "说明景情关系", source: "agent" }],
};
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>语文阅卷 · 本地验收</title><style>body{font:18px system-ui;background:#f4f6f9;color:#182136;padding:40px}main{max-width:850px;margin:auto;background:white;border-radius:14px;padding:30px}input,button{font:inherit;padding:10px;margin:8px}#answer{padding:24px;border:1px solid #ccc}small{color:#586678}</style><main><h1>语文阅卷 · 本地验收</h1><small>模拟学生数据，仅验证工具，不连接真实考试</small><div id=task data-task-id=t>当前任务 t</div><div id=paper data-paper-id=p>答卷 p</div><p>题号 <span id=qid>Q9</span>　满分 <span id=max>2</span>　步长 <span id=step>1</span></p><div id=state>待评</div><h2>学生作答</h2><div id=answer>借秋雨写心中的凄凉</div><label>评分 <input id=score type=number></label><button id=save>保存当前答卷</button><button id=next>下一份</button><div id=msg></div></main><script>save.onclick=async()=>{await fetch('/save',{method:'POST',body:JSON.stringify({task_id:'t',paper_id:paper.dataset.paperId,score:Number(score.value)})});state.textContent='已评';msg.textContent='已保存';};next.onclick=()=>{paper.dataset.paperId='p2';paper.textContent='答卷 p2';};</script></html>`;
async function fixture(t) {
  let saved = null,
    saveCount = 0,
    mode = "normal";
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/data")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          result: {
            task_id: "t",
            score: 2,
            token: "DO-NOT-EXPORT",
            nested: { password: "NO-PASSWORD" },
          },
        }),
      );
    } else if (req.url.startsWith("/saved")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          mode === "nullscore"
            ? { task_id: "t", paper_id: "p", saved: true, score: null }
            : saved || { saved: false },
        ),
      );
    } else if (req.url === "/save") {
      let text = "";
      for await (const b of req) text += b;
      saveCount++;
      const x = JSON.parse(text);
      if (mode !== "nosave") saved = { ...x, saved: true };
      res.end("ok");
    } else {
      res.setHeader("Content-Type", "text/html;charset=utf-8");
      res.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-browser-"));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { origin, dir, setMode: (m) => (mode = m), count: () => saveCount };
}
function configure(f) {
  return {
    observed_evidence: "本地验收页面和服务代码",
    task_id: { selector: "#task", attr: "data-task-id" },
    paper_id: { selector: "#paper", attr: "data-paper-id" },
    qid: { selector: "#qid" },
    max_score: { selector: "#max" },
    step: { selector: "#step" },
    status: { selector: "#state" },
    pending_value: "待评",
    answer: { selector: "#answer" },
    score_input: { selector: "#score" },
    submit: { selector: "#save" },
    submit_semantics: "save-current",
    receipt: {
      kind: "backend",
      observed_evidence: "模拟服务已保存记录",
      url_template: f.origin + "/saved?paper={paper_id}&task={task_id}",
      fields: {
        task_id: "task_id",
        paper_id: "paper_id",
        score: "score",
        saved: "saved",
      },
      saved_value: true,
    },
  };
}
async function setup(t) {
  const f = await fixture(t),
    browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(f.origin);
  const store = new Store(f.dir);
  store.setRubric(r);
  store.authorize({ task_id: "t", submit: true, user_request: "本地模拟测试" });
  store.write("adapter.json", configure(f));
  const adapter = new BrowserAdapter(store, page, f.origin);
  const s = await adapter.read();
  const d = {
    task_id: s.task_id,
    paper_id: s.paper_id,
    answer_hash: s.answer_hash,
    rubric_hash: digest(r),
    awards: [
      {
        point_id: "a",
        score: 2,
        reason: "解释景情关系",
        evidence: { type: "text", quote: s.text },
      },
    ],
    review: { required: false, reasons: [] },
    status: "ready",
    summary: "智能体读卷",
    self_check: {
      negation: true,
      context: true,
      duplicates: true,
      rules: true,
    },
  };
  const scored = store.score(d, s);
  return { ...f, page, store, adapter, s, scored };
}
test("真实Playwright：读卷→持久评分→UI保存→后台回读", async (t) => {
  const x = await setup(t);
  assert.equal(
    (await commit(x.store, x.adapter, x.scored.record_file)).confirmed,
    true,
  );
  assert.equal(x.count(), 1);
  assert.equal(x.store.summary().counts.confirmed, 1);
});
test("v3完整任务：核对材料→读卷学情→浏览器保存回读→报告复盘和默认不共享", async (t) => {
  const x = await setup(t),
    r3 = { ...r, workflow_version: 3, version: "3" };
  const d = x.store.read(x.scored.record_file);
  x.store.setRubric(r3);
  d.rubric_hash = digest(r3);
  d.confidence = { level: "high", reasons: [], affected_points: [] };
  d.learning = {
    judgment: "本题景情关系解释有依据。",
    action: "换一个同类景物句再解释景情联系。",
    check: "检查是否同时写出景物特征与对应心境。",
    point_ids: ["a"],
  };
  assert.throws(() => x.store.score(d, x.s), /intake.json|核对/);
  const intake = prepareIntake(x.store, {
    task_id: "t",
    subject: "chinese",
    stage: "high",
    grade: 10,
    question_clear: true,
    reference_clear: true,
    rules_clear: true,
    reference_origin: "teacher",
    rubric_mode: "agent-organized",
    teacher_rubric_checked: true,
    teacher_rubric_status: "partial",
    agent_organization_notified: true,
    rubric_generation_notice: "教师仅给总分，已告知按内置原则和参考答案补拟。",
    mode: "writeback",
    scope: {
      label: "本地合成页面当前1卷",
      expected_papers: 1,
      platform_count_reconciled: true,
    },
  });
  assert.equal(intake.ready, true);
  const scored = x.store.score(d, x.s);
  assert.equal(
    x.store.read(scored.record_file).default_rules_hash,
    intake.default_rules.profile_hash,
  );
  assert.equal(
    (await commit(x.store, x.adapter, scored.record_file)).confirmed,
    true,
  );
  assert.equal(x.count(), 1);
  const input = path.join(x.dir, "finish-input.json");
  x.store.write("finish-input.json", {
    analysis: {
      insights: [
        {
          finding: "景情关系已有明确表达。",
          action: "用另一处景物做迁移解释。",
          check: "核对景物特征和情感联系。",
          evidence_papers: ["p"],
        },
      ],
    },
    reflection: {
      worked: ["本地合成保存与后台回读一致。"],
      mistakes: [],
      teacher_reminders: [],
      next_actions: ["下次补充否定表达锚点。"],
    },
    contribution: {
      subject: "chinese",
      stage: "high",
      improvements: [
        { code: "no-keyword-scoring", synthetic_check: "negation" },
      ],
    },
  });
  const finish = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/workflow.mjs", import.meta.url)),
      "finish",
      "--run-dir",
      x.dir,
      "--home",
      path.join(x.dir, "isolated-home"),
      "--input",
      input,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(finish.status, 0, finish.stderr);
  const out = JSON.parse(finish.stdout);
  assert.equal(out.report.stats.complete, true);
  assert.equal(out.reflection.saved, true);
  assert.equal(out.upload.enabled, false);
  assert.equal(out.contribution.queued, false);
  assert.equal(
    fs.existsSync(path.join(x.dir, "isolated-home/contributions/queue")),
    false,
  );
  assert.equal(x.count(), 1);
});
test("真实Playwright：仅翻页不能确认保存，身份变化不写分", async (t) => {
  const x = await setup(t);
  await x.page.locator("#next").click();
  await assert.rejects(
    commit(x.store, x.adapter, x.scored.record_file),
    /当前卷/,
  );
  assert.equal(x.count(), 0);
  await assert.rejects(
    dispatch(x.store, x.adapter, {
      command: "click",
      data: { selector: "#next", intent: "navigate" },
    }),
    /评分操作/,
  );
});
test("真实Playwright：后台未保存时unknown且恢复不重交", async (t) => {
  const x = await setup(t);
  x.setMode("nosave");
  assert.equal(
    (await commit(x.store, x.adapter, x.scored.record_file)).unknown,
    true,
  );
  await recover(x.store, x.adapter);
  assert.equal(x.store.summary().unconfirmed, 1);
  assert.equal(x.count(), 1);
});
test("真实Playwright：缺失分数不能转成0作为回执", async (t) => {
  const x = await setup(t);
  x.setMode("nullscore");
  await assert.rejects(
    x.adapter.receipt({ paper_id: "p", task_id: "t" }),
    /分数缺失/,
  );
});
test("真实Playwright：图像快照可追溯，观察不读取密码输入值", async (t) => {
  const x = await setup(t);
  await x.page.locator("#answer").evaluate((e) => {
    e.innerHTML = "<canvas width=200 height=60></canvas>";
    const c = e.firstChild.getContext("2d");
    c.fillText("synthetic handwriting", 10, 30);
  });
  await x.page.locator("main").evaluate((e) => {
    const p = document.createElement("input");
    p.type = "password";
    p.value = "never-export-password";
    e.append(p);
  });
  const s = await x.adapter.read();
  assert.equal(s.artifacts.length, 1);
  const o = await observe(x.page, x.store);
  assert.equal(JSON.stringify(o).includes("never-export-password"), false);
});
test("文件队列复用同一Playwright会话并正常关闭", async (t) => {
  const f = await fixture(t),
    cwd = path.resolve(import.meta.dirname, "..");
  const service = spawn(
    process.execPath,
    [
      "scripts/zx.mjs",
      "serve",
      "--run-dir",
      f.dir,
      "--test-origin",
      f.origin,
      "--headless",
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  service.stdout.on("data", (b) => (output += b));
  let err = "";
  service.stderr.on("data", (b) => (err += b));
  t.after(() => {
    if (service.exitCode === null) service.kill("SIGTERM");
  });
  for (let i = 0; i < 100 && !output.includes('"ready":true'); i++) {
    if (service.exitCode !== null) throw Error(err);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /"ready":true/);
  const request = (cmd) =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        ["scripts/zx.mjs", cmd, "--run-dir", f.dir],
        { cwd },
      );
      let out = "",
        error = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (error += b));
      p.on("close", (code) =>
        code === 0 ? resolve(JSON.parse(out)) : reject(Error(error || out)),
      );
    });
  assert.equal((await request("status")).result.open, true);
  assert.equal((await request("observe")).result.frames.length, 1);
  assert.equal((await request("status")).result.open, true);
  await request("stop");
  await new Promise((resolve) => service.once("close", resolve));
  assert.equal(fs.existsSync(path.join(f.dir, "service.lock")), false);
});

test("真实Playwright：直接选中canvas也能读图，原图未加载则停止", async (t) => {
  const x = await setup(t);
  await x.page
    .locator("#answer")
    .evaluate((e) => (e.innerHTML = "<canvas width=100 height=50></canvas>"));
  const config = configure(x);
  config.answer = { selector: "#answer canvas" };
  x.store.write("adapter.json", config);
  assert.equal((await x.adapter.read()).artifacts.length, 1);
  config.answer = { selector: "#answer" };
  x.store.write("adapter.json", config);
  await x.page
    .locator("#answer")
    .evaluate(
      (e) => (e.innerHTML = '<img src="http://127.0.0.1:1/unavailable.png">'),
    );
  await assert.rejects(x.adapter.read(), /原图尚未加载/);
});
test("真实Playwright：网络默认关闭，开启后只读响应过滤凭据", async (t) => {
  const x = await setup(t);
  await x.page.evaluate(() => fetch("/data?token=DO-NOT-EXPORT"));
  assert.equal((await x.adapter.network()).length, 0);
  await dispatch(x.store, x.adapter, {
    command: "network",
    data: { enabled: true },
  });
  await x.page.evaluate(() => fetch("/data?token=DO-NOT-EXPORT"));
  const net = await x.adapter.network();
  assert.equal(net.length, 1);
  assert.equal(JSON.stringify(net).includes("DO-NOT-EXPORT"), false);
  const data = await x.adapter.responseData({ index: 0, paths: ["result"] });
  assert.equal(data.result.score, 2);
  assert.equal(JSON.stringify(data).includes("DO-NOT-EXPORT"), false);
  assert.equal(JSON.stringify(data).includes("NO-PASSWORD"), false);
});

test("规则手册先选学段再联动学科，初高中不显示年级，科名随学段变化", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(renderRulesHTML(readCatalog()));
  assert.equal(await page.locator("#subject").isDisabled(), true);
  await page.locator("#school-stage").selectOption("primary");
  assert.deepEqual(await page.locator("#subject option").allTextContents(), [
    "请选择学科",
    "语文",
    "数学",
    "英语",
    "科学",
    "道德与法治",
  ]);
  assert.equal(await page.locator("#primary-control").isVisible(), true);
  await page.locator("#subject").selectOption("civics");
  assert.match(
    await page.locator("#stage h2").innerText(),
    /小学 · 道德与法治/,
  );
  await page.locator("#school-stage").selectOption("high");
  assert.equal(await page.locator("#primary-control").isVisible(), false);
  assert.match(await page.locator("#stage h2").innerText(), /高中 · 思想政治/);
  assert.equal(await page.locator("#subject option").count(), 10);
  assert.equal(await page.locator("#subject option[value=science]").count(), 0);
  await page.locator("#school-stage").selectOption("middle");
  assert.match(
    await page.locator("#stage h2").innerText(),
    /初中 · 道德与法治/,
  );
  assert.equal(await page.locator("#primary-control").isVisible(), false);
  assert.equal(
    await page.locator("#subject option[value=science]").innerText(),
    "科学",
  );
  assert.equal(
    await page.locator("#subject option[value=biology]").innerText(),
    "生物学",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
});

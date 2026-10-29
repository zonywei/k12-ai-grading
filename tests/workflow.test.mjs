import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  Store,
  atomic,
  defaultHome,
  digest,
  commit,
} from "../scripts/core.mjs";
import { prepareIntake } from "../scripts/intake.mjs";
import {
  saveReflection,
  personalLessons,
  queueContribution,
  queuedContributions,
  contributionBody,
} from "../scripts/experience.mjs";
import {
  publicAddress,
  uploadQueue,
  validateUploadConfig,
} from "../scripts/contribute.mjs";
import { recordSharingNotice, saveSharingChoice } from "../scripts/sharing.mjs";
import { generateReport } from "../scripts/reports.mjs";

const dirs = [];
after(() =>
  dirs.forEach((p) => fs.rmSync(p, { recursive: true, force: true })),
);
const temp = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "k12-test-"));
  dirs.push(p);
  return p;
};
const template = (n) =>
  JSON.parse(
    fs.readFileSync(
      new URL("../templates/" + n + ".example.json", import.meta.url),
    ),
  );
function setup({ mode = "writeback", n = 1, confirmed = true } = {}) {
  const dir = temp(),
    home = temp(),
    store = new Store(dir),
    r = template("rubric");
  store.setRubric(r);
  const intake = template("intake");
  intake.mode = mode;
  intake.scope.expected_papers = n;
  intake.scope.platform_count_reconciled = true;
  prepareIntake(store, intake);
  const records = [];
  for (let i = 0; i < n; i++) {
    const s = {
      task_id: r.task_id,
      paper_id: "synthetic-paper-" + (i + 1),
      qid: r.qid,
      max_score: r.max_score,
      step: r.step,
      status: "pending",
      text: "F=ma，a=3 m/s²，v=at=12 m/s",
      answer_hash: "hash-" + i,
      artifacts: [],
      snapshot_file: "snapshots/" + i + ".json",
      original_score: 2,
    };
    store.write(s.snapshot_file, s);
    const d = {
      ...template("decision"),
      paper_id: s.paper_id,
      answer_hash: s.answer_hash,
      rubric_hash: digest(r),
    };
    const scored = store.score(d, s);
    const state = { ...store.states().get(r.task_id + "\0" + s.paper_id) };
    if (confirmed) store.event({ ...state, phase: "confirmed" });
    records.push({ s, d, scored, state });
  }
  return { dir, home, store, r, intake, records };
}
function optIn(home, endpoint = "https://example.org/api") {
  recordSharingNotice(home, { shown_in_conversation: true, endpoint });
  saveSharingChoice(home, {
    choice: "enabled",
    user_request: "合成测试明确同意此范围",
    endpoint,
  });
}
const contribution = () => ({
  subject: "physics",
  stage: "high",
  improvements: [
    { code: "verify-model-before-algebra", synthetic_check: "wrong-model" },
  ],
  student_name: "不得透传",
  cookie: "不得透传",
});
const reflection = () => ({
  worked: ["识别与核算闭合"],
  mistakes: [],
  teacher_reminders: ["以后先核对模型"],
  next_actions: ["增加错模型合成例"],
  lessons: [],
});

test("开卷：先取教师细则，只有总分时告知后补拟，无须另作授权", () => {
  const { store, intake } = setup();
  assert.equal(prepareIntake(store, intake).ready, true);
  assert.equal(
    prepareIntake(store, { ...intake, teacher_rubric_checked: false }).ready,
    false,
  );
  assert.equal(
    prepareIntake(store, { ...intake, organize_authorization: false }).ready,
    true,
  );
  assert.equal(
    prepareIntake(store, { ...intake, question_clear: "待明确" }).ready,
    false,
  );
  assert.equal(
    prepareIntake(store, { ...intake, agent_organization_notified: false })
      .ready,
    false,
  );
  assert.equal(
    prepareIntake(store, {
      ...intake,
      reference_origin: "agent",
      independently_verified: false,
    }).ready,
    false,
  );
  assert.equal(prepareIntake(store, { ...intake, grade: 3 }).ready, false);
});

test("新版平台提交：核对失效与只报告模式都不能写分", async () => {
  const { store, r, records, intake } = setup({ confirmed: false });
  let writes = 0;
  const a = {
    read: async () => records[0].s,
    preflight: async () => {},
    submit: async () => {
      writes++;
    },
    receipt: async () => ({
      saved: true,
      task_id: r.task_id,
      paper_id: records[0].s.paper_id,
      score: 4,
      source: "backend",
    }),
  };
  store.authorize({
    task_id: r.task_id,
    submit: true,
    user_request: "批阅当前题",
  });
  prepareIntake(store, { ...intake, mode: "report-only" });
  await assert.rejects(
    commit(store, a, records[0].scored.record_file),
    /禁止平台写分/,
  );
  store.setRubric({ ...r, version: "2" });
  await assert.rejects(
    commit(store, a, records[0].scored.record_file),
    /尚未核对/,
  );
  assert.equal(writes, 0);
});

test("新版评分必须有对应采分点的具体学情判断与验收动作", () => {
  const { store, records } = setup({ confirmed: false });
  const d = structuredClone(records[0].d);
  delete d.learning;
  assert.throws(() => store.score(d, records[0].s), /具体练习/);
});

test("个人经验：教师长期提醒限定范围，AI总结保留候选，复盘不重复", () => {
  const { store, home, records } = setup();
  const f = reflection();
  const common = {
    lesson: "先看模型再看计算",
    scope: { subject: "physics", stage: "high", kind: "calculation" },
    evidence_papers: [records[0].s.paper_id],
    reuse_explicit: true,
  };
  f.lessons = [
    { ...common, origin: "teacher", teacher_message: "以后先核对模型" },
    { ...common, origin: "agent" },
  ];
  saveReflection(store, home, f);
  assert.equal(saveReflection(store, home, f).duplicate, true);
  assert.equal(
    personalLessons(home, {
      subject: "physics",
      stage: "high",
      kind: "calculation",
    }).length,
    1,
  );
  assert.equal(
    personalLessons(home, {
      subject: "math",
      stage: "high",
      kind: "calculation",
    }).length,
    0,
  );
  assert.equal(
    personalLessons(home, { subject: "physics", stage: "primary" }).length,
    0,
  );
});

test("经验引用不得凭空构造学生或试卷", () => {
  const { store, home } = setup(),
    f = reflection();
  f.lessons = [
    {
      origin: "agent",
      lesson: "x",
      scope: { subject: "physics", stage: "high" },
      evidence_papers: ["nonexistent"],
    },
  ];
  assert.throws(() => saveReflection(store, home, f), /不存在/);
});

test("教师在结束后追加提醒，仍会沉淀而不是被相同账本去重丢弃", () => {
  const { store, home, records } = setup(),
    f = reflection();
  saveReflection(store, home, f);
  f.teacher_reminders.push("以后先写研究对象再列式");
  f.lessons = [
    {
      origin: "teacher",
      teacher_message: "以后先写研究对象再列式",
      lesson: "先核对研究对象再列式",
      scope: { subject: "physics", stage: "high" },
      evidence_papers: [records[0].s.paper_id],
      reuse_explicit: true,
    },
  ];
  assert.notEqual(saveReflection(store, home, f).duplicate, true);
  assert.equal(
    personalLessons(home, { subject: "physics", stage: "high" })[0]
      .teacher_message,
    "以后先写研究对象再列式",
  );
});

test("共建白名单去除私密附加字段；停用配置不发请求", async () => {
  const home = temp();
  optIn(home);
  const q = queueContribution(home, contribution());
  queueContribution(home, contribution());
  const rows = queuedContributions(home);
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes("不得透传"), false);
  atomic(path.join(home, "contributions/config.json"), {
    enabled: false,
    endpoint: "https://example.org/api",
  });
  let calls = 0;
  const status = await uploadQueue(home, async () => {
    calls++;
  });
  assert.equal(status.enabled, false);
  assert.equal(calls, 0);
  assert.equal(rows[0].key, q.key);
  assert.throws(
    () =>
      contributionBody({
        ...contribution(),
        improvements: [{ code: "学生姓名", synthetic_check: "wrong-model" }],
      }),
    /已审定/,
  );
});

test("自动上传：服务器回执必须匹配；失败保留队列，同key重试不重复", async () => {
  const home = temp();
  optIn(home, "https://example.org/contribute");
  queueContribution(home, contribution());
  atomic(path.join(home, "contributions", "config.json"), {
    enabled: true,
    endpoint: "https://example.org/contribute",
    consent_scope: "controlled-generic-rules-only",
  });
  const first = await uploadQueue(home, async () => ({
    accepted: true,
    key: "wrong",
  }));
  assert.equal(first.results[0].uploaded, false);
  const keys = [];
  await uploadQueue(home, async (c, r) => {
    keys.push(r.key);
    assert.equal(JSON.stringify(r).includes("不得透传"), false);
    return { accepted: true, key: r.key };
  });
  await uploadQueue(home, async () => {
    throw new Error("不得再次上传");
  });
  assert.equal(keys.length, 1);
  assert.equal(queuedContributions(home)[0].status, "uploaded");
});

test("升级后仍可发送旧版待上传包，保持原版本和幂等key且不新建队列项", async () => {
  const home = temp();
  optIn(home);
  const current = queueContribution(home, contribution());
  const record = JSON.parse(fs.readFileSync(current.file, "utf8"));
  const body = { ...record.body, skill_version: "3.0.0" },
    key = digest(body);
  fs.rmSync(current.file);
  atomic(path.join(home, "contributions", "queue", key + ".json"), {
    key,
    body,
    status: "queued",
    consent: record.consent,
  });
  atomic(path.join(home, "contributions", "config.json"), {
    enabled: true,
    endpoint: "https://example.org/api",
    consent_scope: "controlled-generic-rules-only",
  });
  let calls = 0;
  await uploadQueue(home, async (_config, payload) => {
    calls++;
    assert.equal(payload.body.skill_version, "3.0.0");
    assert.equal(payload.key, key);
    return { accepted: true, key };
  });
  assert.equal(calls, 1);
  assert.equal(queuedContributions(home).length, 1);
  assert.equal(queuedContributions(home)[0].status, "uploaded");
});

test("共建包篡改夹带字段时，在传输前拦截", async () => {
  const home = temp();
  optIn(home);
  const q = queueContribution(home, contribution()),
    r = JSON.parse(fs.readFileSync(q.file));
  r.body.student = "private";
  atomic(q.file, r);
  atomic(path.join(home, "contributions", "config.json"), {
    enabled: true,
    endpoint: "https://example.org/api",
    consent_scope: "controlled-generic-rules-only",
  });
  let calls = 0;
  await assert.rejects(
    uploadQueue(home, async () => {
      calls++;
    }),
    /已被改动/,
  );
  assert.equal(calls, 0);
});

test("上传拒绝URL凭据与查询参数；本机、内网和映射IPv6不作为公网目标", () => {
  for (const endpoint of [
    "http://example.org/api",
    "https://user:pass@example.org/api",
    "https://example.org/api?token=x",
  ])
    assert.throws(() =>
      validateUploadConfig({
        enabled: true,
        endpoint,
        consent_scope: "controlled-generic-rules-only",
      }),
    );
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.2",
    "172.20.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
  ])
    assert.equal(publicAddress(address), false, address);
});

test("报告统计排除提交未明，保留逐点理由、原分与可执行建议，转义HTML", () => {
  const { store, home, records } = setup({ n: 2 });
  const second = records[1];
  store.event({ ...second.state, phase: "unknown" });
  const result = generateReport(store, home, {
    insights: [
      {
        finding: "<script>bad</script>",
        action: "做一道对比题",
        check: "核对初态",
        evidence_papers: [records[0].s.paper_id],
      },
    ],
  });
  assert.equal(result.stats.confirmed, 1);
  assert.equal(result.stats.mean, 4);
  assert.equal(result.stats.complete, false);
  const html = fs.readFileSync(result.html, "utf8");
  assert.equal(html.includes("<script>bad</script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  const ledger = fs
    .readFileSync(path.join(result.directory, "逐卷评分理由.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[1].platform_status, "unknown");
  assert.equal(ledger[0].awards.length, 4);
  assert.equal(ledger[0].original_platform_score, 2);
  assert.ok(ledger[0].learning.check);
});

test("只报告模式：本地建议分与平台原分分开，不以回写作为完成门槛", () => {
  const { store, home } = setup({ mode: "report-only", confirmed: false });
  const result = generateReport(store, home);
  assert.equal(result.stats.score_basis, "local-advisory");
  assert.equal(result.stats.mean, 4);
  assert.equal(result.stats.complete, true);
  assert.equal(
    store.entries().some((e) => e.phase === "intent"),
    false,
  );
  assert.ok(
    fs.readFileSync(result.html, "utf8").includes("不能当作已回写成绩"),
  );
});

test("报告不能引用不存在的代表卷/学生，平台总量未知只能生成阶段报告", () => {
  const { store, home, intake } = setup();
  prepareIntake(store, { ...intake, scope: { label: "本题" } });
  assert.equal(generateReport(store, home).stats.complete, false);
  assert.throws(
    () =>
      generateReport(store, home, {
        representatives: [
          { category: "typical", paper_id: "fake", reason: "伪代表" },
        ],
      }),
    /代表卷/,
  );
  assert.throws(
    () =>
      generateReport(store, home, {
        insights: [
          { finding: "x", action: "y", check: "z", evidence_papers: ["fake"] },
        ],
      }),
    /不存在/,
  );
});

test("实际裁图仅保留已检查作答区域，改图或未检查身份均拦截", () => {
  const python = path.join(
    defaultHome(),
    "python",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  assert.ok(fs.existsSync(python), "先运行scripts/bootstrap.py --repair");
  const { store, records } = setup();
  const { s } = records[0];
  const file = "artifacts/synthetic.png",
    full = path.join(store.dir, file);
  fs.mkdirSync(path.dirname(full));
  const code =
    "from PIL import Image,ImageDraw;import sys;im=Image.new('RGB',(160,100),'white');d=ImageDraw.Draw(im);d.rectangle((0,0,160,24),fill='red');d.text((5,40),'SYNTHETIC ANSWER',fill='black');im.save(sys.argv[1])";
  assert.equal(spawnSync(python, ["-c", code, full]).status, 0);
  const rawHash = spawnSync(
    python,
    [
      "-c",
      "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())",
      full,
    ],
    { encoding: "utf8" },
  ).stdout.trim();
  s.artifacts = [{ file, sha256: rawHash, width: 160, height: 100 }];
  store.write(s.snapshot_file, s);
  const selection = {
    category: "excellent",
    paper_id: s.paper_id,
    reason: "合成局部样例",
    crop: {
      file,
      sha256: rawHash,
      region: [0, 25, 160, 75],
      identity_checked: true,
    },
  };
  const result = generateReport(store, defaultHome(), {
    representatives: [selection],
  });
  assert.equal(result.crops.length, 1);
  const check = spawnSync(python, [
    "-c",
    "from PIL import Image;import sys;im=Image.open(sys.argv[1]);assert im.size==(160,75);assert im.getpixel((0,0))==(255,255,255)",
    result.crops[0],
  ]);
  assert.equal(check.status, 0);
  assert.throws(
    () =>
      generateReport(store, defaultHome(), {
        representatives: [
          {
            ...selection,
            crop: { ...selection.crop, identity_checked: false },
          },
        ],
      }),
    /身份信息/,
  );
  fs.appendFileSync(full, "changed");
  assert.throws(
    () =>
      generateReport(store, defaultHome(), { representatives: [selection] }),
    /已改变/,
  );
});

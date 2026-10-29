import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store, digest, commit, validateRubric } from "../scripts/core.mjs";
import {
  readCatalog,
  stageSubjects,
  subjectDisplayName,
  selectRules,
  bindRules,
  rulesHash,
  verifyRulesBinding,
} from "../scripts/rules.mjs";
import { prepareIntake } from "../scripts/intake.mjs";
import { renderRulesDocs } from "../scripts/build_rules_docs.mjs";
import { reviewPacket, saveReview } from "../scripts/reviews.mjs";
import { generateReport } from "../scripts/reports.mjs";
import {
  subjects as publicSubjects,
  queueContribution,
  contributionBody,
} from "../scripts/experience.mjs";
const dirs = [];
const temp = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "k12-rules-"));
  dirs.push(p);
  return p;
};
after(() =>
  dirs.forEach((p) => fs.rmSync(p, { recursive: true, force: true })),
);
const template = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL("../templates/" + name + ".example.json", import.meta.url),
      "utf8",
    ),
  );
const unitOverride = () => ({
  rule_id: "phy-sign-units",
  source: "teacher",
  quote: "本题不扣单位。",
  source_ref: "教师本次明确指示",
  conflict: "仅覆盖本题单位书写的计分，不改变方向、量纲和物理量含义判断",
  replacement: "本题遗漏单位不影响得分；其他条件仍按原条款判断。",
});
function fixture() {
  const store = new Store(temp()),
    r = template("rubric"),
    i = template("intake");
  store.setRubric(r);
  i.mode = "offline";
  i.scope.expected_papers = 1;
  i.scope.platform_count_reconciled = true;
  const intake = prepareIntake(store, i);
  assert.equal(intake.ready, true);
  const s = {
    task_id: r.task_id,
    paper_id: "synthetic-paper-1",
    qid: r.qid,
    max_score: r.max_score,
    step: r.step,
    status: "pending",
    text: "F=ma，a=3 m/s²，v=at=12 m/s",
    answer_hash: "synthetic-only",
    artifacts: [],
    snapshot_file: "snapshots/example.json",
    original_score: 137,
  };
  store.write(s.snapshot_file, s);
  const d = {
    ...template("decision"),
    answer_hash: s.answer_hash,
    rubric_hash: digest(r),
  };
  store.authorize({
    task_id: r.task_id,
    submit: true,
    user_request: "本地合成验证",
  });
  return { store, r, i, intake, s, d };
}

test("3学段24组学科入口无需年级即可加载，名称与默认规则正确对应", () => {
  const c = readCatalog();
  assert.equal(Object.keys(c.subjects).length, 10);
  assert.equal(
    c.stages.reduce((n, s) => n + s.subjects.length, 0),
    24,
  );
  const ids = [...c.common_rules.map((r) => r.id)];
  for (const [code, s] of Object.entries(c.subjects)) {
    assert(publicSubjects.includes(code));
    assert.deepEqual(
      Object.keys(s.profiles),
      c.bands.map((b) => b.id),
    );
    ids.push(
      ...s.rules.map((r) => r.id),
      ...Object.values(s.profiles).flatMap((p) => p.rules.map((r) => r.id)),
    );
  }
  for (const stage of c.stages)
    for (const entry of stage.subjects) {
      const p = selectRules({
        stage: stage.id,
        subject: entry.code,
        ...(entry.code === "science" && stage.id === "middle"
          ? { related_subjects: ["physics"] }
          : {}),
      });
      assert.equal(p.context.stage, stage.id);
      assert.equal(p.context.grade, null);
      assert.equal(p.context.band, stage.id);
      assert.equal(p.subject_name, entry.name);
      assert.equal(p.activation, "always");
      assert(
        c.subjects[entry.code].rules.every((r) =>
          p.effective_rules.some((e) => e.id === r.id),
        ),
      );
    }
  assert.equal(new Set(ids).size, ids.length);
});

test("范围外科目、非法年级与学段冲突不会静默套科", () => {
  for (const grade of [0, 13, "10", 10.5])
    assert.throws(() => selectRules({ subject: "physics", grade }), /年级/);
  assert.throws(
    () => selectRules({ subject: "物理化学", grade: 10 }),
    /专属规则/,
  );
  assert.throws(
    () => selectRules({ subject: "math", grade: 5, stage: "high" }),
    /不一致/,
  );
  for (const subject of [
    "其他外语",
    "信息科技",
    "通用技术",
    "音乐",
    "美术",
    "艺术",
    "体育",
    "劳动",
    "综合实践",
  ])
    assert.throws(() => selectRules({ subject, grade: 10 }), /专属规则/);
  assert.equal(
    selectRules({ subject: "高中物理", grade: 10 }).context.subject,
    "physics",
  );
  assert.equal(
    selectRules({ subject: "english", grade: 5 }).context.target_language,
    "en",
  );
});

test("综合科学按实际关联学科加载，不用理综标签掩盖物理化学差异", () => {
  assert.throws(
    () =>
      selectRules({
        subject: "science",
        grade: 8,
        related_subjects: ["information-technology"],
      }),
    /有效/,
  );
  assert.throws(() => selectRules({ subject: "理综", grade: 11 }), /关联学科/);
  const p = selectRules({
    subject: "理综",
    grade: 11,
    related_subjects: ["physics", "chemistry"],
  });
  assert(p.effective_rules.some((r) => r.id === "phy-model"));
  assert(p.effective_rules.some((r) => r.id === "chem-reaction"));
  assert(!p.effective_rules.some((r) => r.id === "bio-mechanism"));
  assert.throws(
    () =>
      selectRules({
        subject: "science",
        grade: 8,
        related_subjects: ["physics", "physics"],
      }),
    /重复/,
  );
  assert.throws(
    () =>
      selectRules({
        subject: "science",
        grade: 8,
        related_subjects: ["unknown"],
      }),
    /有效/,
  );
});

test("明确局部覆盖只改变对应条款口径，保留该条非冲突部分和其他规则", () => {
  const a = selectRules({ subject: "physics", grade: 10 }),
    b = selectRules({
      subject: "physics",
      grade: 10,
      rule_overrides: [unitOverride()],
    });
  const changed = b.effective_rules.filter(
    (r, i) => JSON.stringify(r) !== JSON.stringify(a.effective_rules[i]),
  );
  assert.deepEqual(
    changed.map((r) => r.id),
    ["phy-sign-units"],
  );
  assert.equal(
    changed[0].original_principle,
    a.effective_rules.find((r) => r.id === "phy-sign-units").principle,
  );
  assert(changed[0].principle.startsWith(changed[0].original_principle));
  assert.equal(changed[0].override.replacement, unitOverride().replacement);
  assert(
    b.effective_rules.some(
      (r) => r.id === "phy-model" && r.authority === "operational-synthesis",
    ),
  );
  assert.notEqual(rulesHash(a), rulesHash(b));
});

test("无原话、无冲突、AI擅自覆盖、未知ID、重复覆盖及整套关闭全部拦截", () => {
  for (const field of ["quote", "source_ref", "conflict", "replacement"]) {
    const o = unitOverride();
    delete o[field];
    assert.throws(
      () => selectRules({ subject: "physics", grade: 10, rule_overrides: [o] }),
      /缺少/,
    );
  }
  for (const o of [
    { ...unitOverride(), source: "agent" },
    { ...unitOverride(), rule_id: "unknown" },
  ])
    assert.throws(() =>
      selectRules({ subject: "physics", grade: 10, rule_overrides: [o] }),
    );
  assert.throws(
    () =>
      selectRules({
        subject: "physics",
        grade: 10,
        rule_overrides: [unitOverride(), unitOverride()],
      }),
    /最新/,
  );
  for (const rule_overrides of [false, {}, [null]])
    assert.throws(() =>
      selectRules({ subject: "physics", grade: 10, rule_overrides }),
    );
  const r = template("rubric");
  assert.throws(
    () => validateRubric({ ...r, default_rules_required: false }),
    /不能整体关闭/,
  );
});

test("教师完整、仅总分和暂无细则三种情况都默认加载；调用者伪造绑定不会透传", () => {
  const { store, i } = fixture();
  let expected;
  for (const status of ["complete", "partial", "none"]) {
    const x = prepareIntake(store, {
      ...i,
      teacher_rubric_status: status,
      rubric_mode:
        status === "complete"
          ? "teacher"
          : status === "none"
            ? "agent-organized"
            : "teacher-completed",
      default_rules: { activation: "off" },
    });
    assert.equal(x.ready, true);
    assert.equal(x.default_rules.activation, "always");
    assert(x.rule_packet.effective_rules.some((r) => r.id === "phy-algebra"));
    expected ??= x.default_rules.profile_hash;
    assert.equal(x.default_rules.profile_hash, expected);
  }
});

test("冻结文本抵抗技能升级；无效intake不会丢掉上一份有效冻结口径", () => {
  const { store, i, r, intake } = fixture();
  assert.equal(prepareIntake(store, { ...i, grade: 3 }).ready, false);
  assert.equal(
    prepareIntake(store, { ...i, task_id: "wrong-task" }).ready,
    false,
  );
  const c = readCatalog();
  c.version = "9.9.9";
  c.subjects.physics.rules[0].principle = "升级后新口径，不应静默进入已有任务";
  const bound = bindRules(store, { ...i, question_kind: r.kind }, digest(r), c);
  assert.equal(bound.binding.profile_hash, intake.default_rules.profile_hash);
  assert.notEqual(bound.packet.catalog_version, "9.9.9");
  assert.equal(
    prepareIntake(store, i).default_rules.profile_hash,
    intake.default_rules.profile_hash,
  );
});

test("同一目录切换任务后仍各自保留冻结规则，不被另一个任务的指针覆盖", () => {
  const store = new Store(temp()),
    c = readCatalog(),
    a = { task_id: "task-a", subject: "physics", grade: 10 },
    b = { task_id: "task-b", subject: "math", grade: 8 };
  const first = bindRules(store, a, "r1", c);
  bindRules(store, b, "r2", c);
  c.version = "9.9.9";
  c.subjects.physics.rules[0].principle = "新规则";
  const resumed = bindRules(store, a, "r1", c);
  assert.equal(resumed.binding.profile_hash, first.binding.profile_hash);
});

test("同版不能中途改覆盖；初高中年级不分口径，明确改细则后保留新旧快照", () => {
  const { store, r, i, intake } = fixture();
  const changed = { ...i, rule_overrides: [unitOverride()] };
  const rejected = prepareIntake(store, changed);
  assert.equal(rejected.ready, false);
  assert(rejected.missing.some((x) => x.includes("更新细则版本")));
  assert.equal(prepareIntake(store, i).ready, true);
  assert.equal(prepareIntake(store, { ...i, grade: 11 }).ready, true);
  assert.equal(
    prepareIntake(store, { ...i, grade: 11 }).default_rules.profile_hash,
    intake.default_rules.profile_hash,
  );
  store.setRubric({ ...r, version: "2" });
  const next = prepareIntake(store, changed);
  assert.equal(next.ready, true);
  assert.notEqual(
    next.default_rules.profile_hash,
    intake.default_rules.profile_hash,
  );
  assert(verifyRulesBinding(store, intake.default_rules));
  assert(verifyRulesBinding(store, next.default_rules));
});

test("评分记录与逐卷报告保留实际规则指纹，报告可追溯全文快照", () => {
  const { store, s, d, intake } = fixture();
  const scored = store.score(d, s),
    record = store.read(scored.record_file);
  assert.equal(record.default_rules_hash, intake.default_rules.profile_hash);
  assert.equal(record.default_rules_file, intake.default_rules.file);
  const report = generateReport(store, temp());
  assert.equal(report.stats.default_rule_profiles.length, 1);
  const data = JSON.parse(
    fs.readFileSync(path.join(store.dir, "reports/报告数据.json"), "utf8"),
  );
  assert.equal(data.students[0].default_rules_hash, record.default_rules_hash);
  assert.equal(
    data.stats.default_rule_profiles[0].hash,
    record.default_rules_hash,
  );
});

test("默认规则快照篡改后阻止评分，不能只挂一个文件名继续判", () => {
  const { store, s, d, intake } = fixture();
  const packet = store.read(intake.default_rules.file);
  packet.effective_rules[0].principle = "篡改";
  store.write(intake.default_rules.file, packet);
  assert.throws(() => store.score(d, s), /被修改/);
  assert.equal(store.states().size, 0);
});

test("提交前复查每卷默认规则绑定，指纹不一致不会触发浏览器读写", async () => {
  const { store, s, d, i } = fixture();
  prepareIntake(store, { ...i, mode: "writeback" });
  const scored = store.score(d, s),
    record = store.read(scored.record_file);
  record.default_rules_hash = "0".repeat(64);
  store.write(scored.record_file, record);
  let called = 0;
  const adapter = {
    read: async () => {
      called++;
      return s;
    },
    submit: async () => {
      called++;
    },
  };
  await assert.rejects(
    commit(store, adapter, scored.record_file),
    /规则版本不一致/,
  );
  assert.equal(called, 0);
});

test("低置信度独立复核获得相同规则全文，不带旧分数与旧理由", () => {
  const { store, s, d, intake } = fixture();
  d.status = "review";
  d.review = { required: true, reasons: ["需重读结果"] };
  d.confidence = {
    level: "low",
    reasons: ["结果需重读"],
    affected_points: ["velocity_result"],
    score_range: [3, 4],
  };
  d.summary = "PREVIOUS-SCORE-SECRET";
  const scored = store.score(d, s),
    packet = reviewPacket(store, scored.record_file);
  assert.equal(
    rulesHash(packet.default_rules),
    intake.default_rules.profile_hash,
  );
  assert.equal(packet.snapshot.original_score, undefined);
  assert(!JSON.stringify(packet).includes("PREVIOUS-SCORE-SECRET"));
  assert.equal(packet.default_rules.overrides.length, 0);
});

test("全部人工可读规则页与唯一数据源一致，正文与路由不会各自漂移", () => {
  const docs = renderRulesDocs(readCatalog());
  assert.equal(docs.size, 12);
  for (const [file, body] of docs)
    assert.equal(
      fs.readFileSync(
        new URL("../references/" + file, import.meta.url),
        "utf8",
      ),
      body,
      file,
    );
});

test("rules命令能独立返回全文，不启动浏览器、不建立私密运行或上传目录", () => {
  const dir = temp(),
    input = path.join(dir, "context.json"),
    home = path.join(dir, "untouched-home");
  fs.writeFileSync(
    input,
    JSON.stringify({ subject: "physics", grade: 10, question_kind: "fill" }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/workflow.mjs", import.meta.url)),
      "rules",
      "--input",
      input,
      "--home",
      home,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.context.question_kind, "fill");
  assert(packet.effective_rules.some((r) => r.id === "phy-wrong-model"));
  assert.equal(fs.existsSync(home), false);
});

test("复核开始后默认规则绑定漂移，不能把旧规则下的复判当作本版有效结果", () => {
  const { store, s, d } = fixture();
  d.status = "review";
  d.review = { required: true, reasons: ["需重读"] };
  d.confidence = {
    level: "low",
    reasons: ["需重读"],
    affected_points: ["velocity_result"],
    score_range: [3, 4],
  };
  const scored = store.score(d, s),
    packet = reviewPacket(store, scored.record_file);
  const next = selectRules({
      subject: "physics",
      grade: 10,
      question_kind: "calculation",
      rule_overrides: [unitOverride()],
    }),
    hash = rulesHash(next),
    file = `rules-profiles/${hash}.json`;
  store.write(file, next);
  const i = store.read("intake.json");
  i.default_rules = {
    activation: "always",
    profile_hash: hash,
    file,
    subject: "physics",
    band: "high",
    catalog_version: next.catalog_version,
  };
  store.write("intake.json", i);
  assert.throws(
    () =>
      saveReview(store, {
        packet_file: packet.packet_file,
        checks: { original_evidence: true, question: true, rubric: true },
        summary: "仅在旧规则下复判",
        decision: d,
      }),
    /默认规则已变化/,
  );
  assert.equal(fs.existsSync(path.join(store.dir, "reviews/results")), false);
});

test("范围外学科不能新增共建，历史已入队包仍可按原版本白名单校验", () => {
  const home = temp(),
    old = {
      subject: "information-technology",
      stage: "high",
      improvements: [
        { code: "no-keyword-scoring", synthetic_check: "negation" },
      ],
    };
  assert.throws(() => queueContribution(home, old), /主要学科/);
  assert.equal(fs.existsSync(path.join(home, "contributions/queue")), false);
  assert.equal(
    contributionBody(old, "3.1.0").subject,
    "information-technology",
  );
  assert.equal(contributionBody(old, "3.1.0").skill_version, "3.1.0");
});

test("学段先决定学科列表，道德与法治和思想政治按学段显示", () => {
  assert.deepEqual(
    stageSubjects("primary").map((s) => s.name),
    ["语文", "数学", "英语", "科学", "道德与法治"],
  );
  assert.equal(
    stageSubjects("middle").find((s) => s.code === "civics").name,
    "道德与法治",
  );
  assert.equal(
    stageSubjects("high").find((s) => s.code === "civics").name,
    "思想政治",
  );
  assert(!stageSubjects("high").some((s) => s.code === "science"));
  assert.equal(subjectDisplayName("biology", "middle"), "生物学");
  assert.equal(subjectDisplayName("science", "high"), "理科综合（试卷）");
  assert.throws(
    () => selectRules({ stage: "primary", subject: "physics" }),
    /未单列/,
  );
});

test("直接给学段学科名称可识别；数学等同名科目仍缺学段时不猜测", () => {
  assert.equal(selectRules({ subject: "高中数学" }).context.stage, "high");
  assert.equal(selectRules({ subject: "高二物理" }).context.grade, null);
  assert.equal(selectRules({ subject: "初中数学" }).context.stage, "middle");
  assert.equal(selectRules({ subject: "思想政治" }).context.stage, "high");
  assert.throws(() => selectRules({ subject: "数学" }), /需明确学段/);
  assert.throws(
    () => selectRules({ subject: "高中物理", stage: "middle" }),
    /不一致/,
  );
});

test("初高中有无具体年级均采用相同学段规则，材料核对不要求年级", () => {
  for (const [stage, grades] of [
    ["middle", [7, 8, 9]],
    ["high", [10, 11, 12]],
  ]) {
    const base = selectRules({ subject: "math", stage });
    assert.equal(base.context.grade, null);
    for (const grade of grades)
      assert.deepEqual(
        selectRules({ subject: "math", stage, grade }).context,
        base.context,
      );
  }
  const { store, i } = fixture();
  delete i.grade;
  const intake = prepareIntake(store, {
    ...i,
    subject: "高中物理",
    stage: undefined,
  });
  assert.equal(intake.ready, true);
  assert.equal(intake.stage, "high");
  assert.equal(intake.grade, null);
});

test("小学未给年级可直接使用通用规则，年级或年级段仅为选填细化", () => {
  assert.equal(
    selectRules({ stage: "primary", subject: "math" }).context.band,
    "primary",
  );
  assert.equal(
    selectRules({ stage: "primary", subject: "math", grade: 4 }).context.band,
    "primary-3-4",
  );
  const grouped = selectRules({
    stage: "primary",
    subject: "math",
    primary_band: "primary-5-6",
  });
  assert.equal(grouped.context.grade, null);
  assert.equal(grouped.context.band, "primary-5-6");
  assert.throws(
    () =>
      selectRules({
        stage: "primary",
        subject: "math",
        grade: 2,
        primary_band: "primary-5-6",
      }),
    /不一致/,
  );
  const science = selectRules({
    stage: "primary",
    subject: "science",
    related_subjects: ["physics"],
  });
  assert(science.effective_rules.some((r) => r.id === "phy-model"));
});

test("旧冻结高中数值年级保留原文，新核对与评分按学段继续执行", () => {
  const { store, r, i, s, d } = fixture(),
    original = store.read(store.read("intake.json").default_rules.file);
  original.context.grade = 10;
  original.band_name = "高中（高一—高三）";
  const hash = rulesHash(original),
    file = `rules-profiles/${hash}.json`,
    binding = {
      activation: "always",
      profile_hash: hash,
      file,
      subject: "physics",
      band: "high",
      catalog_version: original.catalog_version,
    };
  store.write(file, original);
  store.write(`rules-active/${rulesHash(i.task_id)}.json`, {
    task_id: i.task_id,
    rubric_hash: digest(r),
    default_rules: binding,
  });
  const checked = prepareIntake(store, { ...i, grade: undefined });
  assert.equal(checked.ready, true);
  assert.equal(checked.grade, null);
  assert.equal(checked.default_rules.profile_hash, hash);
  assert.equal(store.read(file).context.grade, 10);
  const scored = store.score(d, s);
  assert.equal(store.read(scored.record_file).default_rules_hash, hash);
  const report = generateReport(store, temp());
  assert.equal(report.stats.default_rule_profiles[0].band, "高中");
});

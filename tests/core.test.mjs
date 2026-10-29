import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  Store,
  digest,
  calculate,
  validateRubric,
  verifyReceipt,
  commit,
  recover,
} from "../scripts/core.mjs";
const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});
const rubric = () => ({
  schema_version: 2,
  task_id: "t",
  qid: "Q9",
  version: "1",
  kind: "short_answer",
  question: "分析手法和情感",
  reference_answer: "借景抒情，悲凉",
  max_score: 4,
  step: 1,
  points: [
    { id: "a", max: 2, description: "准确解释手法", source: "agent" },
    { id: "b", max: 2, description: "准确解释情感", source: "reference" },
  ],
});
const snap = () => ({
  task_id: "t",
  paper_id: "p",
  qid: "Q9",
  max_score: 4,
  step: 1,
  status: "pending",
  text: "借秋雨写心中的凄凉",
  answer_hash: "content",
  artifacts: [],
  snapshot_file: "snapshots/p.json",
});
const decision = (r = rubric(), s = snap()) => ({
  task_id: s.task_id,
  paper_id: s.paper_id,
  answer_hash: s.answer_hash,
  rubric_hash: digest(r),
  awards: r.points.map((p) => ({
    point_id: p.id,
    score: p.max,
    reason: "结合语境判断正确",
    evidence: { type: "text", quote: s.text },
  })),
  review: { required: false, reasons: [] },
  status: "ready",
  self_check: { negation: true, context: true, duplicates: true, rules: true },
  summary: "读卷后逐点判断",
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-test-")),
    store = new Store(dir),
    r = rubric(),
    s = snap();
  store.setRubric(r);
  store.authorize({ task_id: "t", submit: true, user_request: "批阅当前任务" });
  store.write(s.snapshot_file, s);
  created.push(dir);
  const scored = store.score(decision(), s);
  return { dir, store, r, s, scored };
}
const adapter = (s) => ({
  read: async () => s,
  preflight: async () => {},
  submit: async () => {},
  receipt: async () => ({
    saved: true,
    task_id: "t",
    paper_id: "p",
    score: 4,
    source: "backend",
  }),
});
test("独立计分正常，统一返回总分", () =>
  assert.equal(calculate(rubric(), decision(), snap(), "/tmp").total_score, 4));
test("系统不再凭否定答案的关键词自动评分", () => {
  const s = snap();
  s.text = "没有借景抒情，也没有悲凉";
  const d = decision(rubric(), s);
  d.awards.forEach((a) => {
    a.score = 0;
    a.reason = "智能体判定否定，与材料不符";
    delete a.evidence;
  });
  assert.equal(calculate(rubric(), d, s, "/tmp").total_score, 0);
});
test("不存在的学生原句拒绝", () => {
  const d = decision();
  d.awards[0].evidence.quote = "参考答案中才有的原文";
  assert.throws(() => calculate(rubric(), d, snap(), "/tmp"), /引文不在/);
});
test("可选答案通过分组封顶表达，不进入错误分母", () => {
  const r = rubric();
  r.points.push({
    id: "alternative",
    max: 2,
    description: "替代情感点",
    source: "agent",
  });
  r.groups = [{ ids: ["b", "alternative"], cap: 2 }];
  const d = decision(r);
  d.awards.find((a) => a.point_id === "alternative").score = 0;
  assert.equal(calculate(r, d, snap(), "/tmp").total_score, 4);
  d.awards.find((a) => a.point_id === "alternative").score = 2;
  assert.equal(calculate(r, d, snap(), "/tmp").total_score, 4);
});
test("旧required歧义配置拦截", () => {
  const r = rubric();
  r.points[0].required = false;
  assert.throws(() => validateRubric(r), /required/);
});
test("作文拆项仍统一封顶10，不再变28", () => {
  const r = rubric();
  r.kind = "essay";
  r.max_score = 60;
  r.points = [
    { id: "c", max: 20, description: "内容", source: "agent" },
    { id: "e", max: 20, description: "表达", source: "agent" },
    { id: "d", max: 20, description: "发展", source: "agent" },
  ];
  r.cap_rules = [
    {
      id: "short",
      cap: 10,
      description: "教师明确不足200字最高10",
      source: "teacher",
    },
  ];
  const d = decision(r);
  d.awards.forEach((a, i) => (a.score = [13, 9, 6][i]));
  d.applied_caps = [
    {
      rule_id: "short",
      reason: "实际不足200字",
      evidence: { type: "text", quote: snap().text },
    },
  ];
  assert.equal(calculate(r, d, snap(), "/tmp").total_score, 10);
});
test("默写认可字形由本题智能体决定，不二次字符串推翻", () => {
  const r = rubric();
  r.kind = "dictation";
  r.points = [
    {
      id: "blank",
      max: 4,
      description: "教师本题明确说悦认可",
      source: "teacher",
    },
  ];
  const s = snap();
  s.text = "不亦悦乎";
  assert.equal(calculate(r, decision(r, s), s, "/tmp").total_score, 4);
});
test("复核未决不能标ready", () => {
  const d = decision();
  d.review = { required: true, reasons: ["字迹不清"] };
  assert.throws(() => calculate(rubric(), d, snap(), "/tmp"), /状态矛盾/);
});
test("缺参考依据直接拦截，不打50%估分", () => {
  const r = rubric();
  r.reference_answer = "";
  assert.throws(() => validateRubric(r), /reference_answer/);
});
test("越界、非整数步长、伪总分均拒绝", () => {
  for (const change of [
    (d) => (d.awards[0].score = 999),
    (d) => (d.awards[0].score = 0.5),
    (d) => (d.total_score = 28),
  ]) {
    const d = decision();
    change(d);
    assert.throws(() => calculate(rubric(), d, snap(), "/tmp"));
  }
});
test("无依据机械扣分不得创建", () => {
  const r = rubric();
  r.deduction_rules = [
    { id: "len", max: 1, description: "过短", source: "agent" },
  ];
  assert.throws(() => validateRubric(r), /扣分/);
});
test("新规则失效旧评分", () => {
  const r = rubric();
  r.version = "2";
  assert.throws(() => calculate(r, decision(), snap(), "/tmp"), /版本/);
});
test("持久化评分后才能提交，完成后幂等拦截", async () => {
  const { store, s, scored } = setup();
  assert.deepEqual(await commit(store, adapter(s), scored.record_file), {
    confirmed: true,
    score: 4,
  });
  assert.equal(store.summary().complete, true);
  await assert.rejects(commit(store, adapter(s), scored.record_file), /最新/);
});
test("填分前身份变化时不产生提交意图", async () => {
  const { store, s, scored } = setup();
  s.paper_id = "other";
  await assert.rejects(commit(store, adapter(s), scored.record_file), /当前卷/);
  assert.equal(store.pending().length, 0);
});
test("只翻页无保存回执保持unknown，不能继续写", async () => {
  const { store, s, scored } = setup();
  const a = adapter(s);
  a.receipt = async () => ({ saved: false, source: "backend" });
  assert.equal((await commit(store, a, scored.record_file)).unknown, true);
  await assert.rejects(commit(store, a, scored.record_file), /未确认/);
});
test("不同答卷/任务/分数/进度消息不能作回执", () => {
  for (const value of [
    { paper_id: "other" },
    { task_id: "other" },
    { score: 3 },
    { source: "progress" },
    { score: null },
  ])
    assert.throws(() =>
      verifyReceipt(
        {
          saved: true,
          task_id: "t",
          paper_id: "p",
          score: 4,
          source: "backend",
          ...value,
        },
        decision(),
        4,
      ),
    );
});
test("写入前intent已落盘；断网恢复仅回读不重交", async () => {
  const { store, s, scored } = setup();
  let submits = 0;
  const a = adapter(s);
  a.submit = async () => {
    submits++;
    assert.equal(store.pending()[0].phase, "intent");
  };
  a.receipt = async () => {
    throw Error("断网");
  };
  await commit(store, a, scored.record_file);
  a.receipt = adapter(s).receipt;
  assert.equal((await recover(store, a)).unconfirmed, 0);
  assert.equal(submits, 1);
});
test("待复核评分禁止提交", async () => {
  const { store, s } = setup();
  const d = decision();
  d.status = "review";
  d.review = { required: true, reasons: ["字迹模糊"] };
  const scored = store.score(d, s);
  await assert.rejects(commit(store, adapter(s), scored.record_file), /待复核/);
});
test("同卷修订递增、不同身份相同答案不混淆", () => {
  const { store, s } = setup();
  const b = store.score(decision(), s);
  assert.equal(store.read(b.record_file).revision, 2);
  s.paper_id = "p2";
  store.score(decision(rubric(), s), s);
  assert.equal(store.summary().papers, 2);
});

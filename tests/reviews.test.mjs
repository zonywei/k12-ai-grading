import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, digest, commit } from "../scripts/core.mjs";
import { prepareIntake } from "../scripts/intake.mjs";
import {
  reviewQueue,
  reviewPacket,
  saveReview,
  adjudicate,
  teacherControl,
} from "../scripts/reviews.mjs";
import { generateReport } from "../scripts/reports.mjs";
const dirs = [];
after(() =>
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
);
const template = (n) =>
  JSON.parse(
    fs.readFileSync(
      new URL("../templates/" + n + ".example.json", import.meta.url),
    ),
  );
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k12-review-"));
  dirs.push(dir);
  const store = new Store(dir),
    r = template("rubric");
  store.setRubric(r);
  const i = template("intake");
  i.scope.expected_papers = 1;
  i.scope.platform_count_reconciled = true;
  prepareIntake(store, i);
  const s = {
    task_id: r.task_id,
    paper_id: "synthetic-paper-1",
    qid: r.qid,
    max_score: 4,
    step: 1,
    status: "pending",
    text: "F=ma，a=3 m/s²，v=at=1? m/s",
    original_score: 2,
    answer_hash: "synthetic-unclear",
    snapshot_file: "snapshots/p.json",
    artifacts: [],
  };
  store.write(s.snapshot_file, s);
  const d = template("decision");
  d.answer_hash = s.answer_hash;
  d.rubric_hash = digest(r);
  d.awards.forEach((a) => (a.evidence = { type: "text", quote: s.text }));
  d.awards[3].score = 0;
  d.awards[3].reason = "末位难辨，该点暂不作最终判定。";
  d.confidence = {
    level: "low",
    reasons: ["末速度末位难辨"],
    affected_points: ["velocity_result"],
    score_range: [3, 4],
  };
  d.review = { required: true, reasons: ["末位难辨，先复核"] };
  d.status = "review";
  const scored = store.score(d, s);
  store.authorize({
    task_id: r.task_id,
    submit: true,
    user_request: "批阅当前题并保存",
  });
  return { store, r, s, d, scored, dir };
}
function review(x) {
  const packet = reviewPacket(x.store, x.scored.record_file);
  // Independent result is built from the question/evidence fixture, without old score/reasons.
  const independent = structuredClone(x.d);
  independent.summary =
    "原文能确认建模、加速度与速度关系，末位仍不能清楚确认。";
  const saved = saveReview(x.store, {
    packet_file: packet.packet_file,
    checks: { original_evidence: true, question: true, rubric: true },
    summary: "重新核对原始证据及每个采分条件，仍有结果末位不确定性。",
    decision: independent,
  });
  return { packet, saved, independent };
}
function finalInput(saved, d) {
  return {
    review_result_file: saved.review_result_file,
    decision: {
      ...structuredClone(d),
      status: "ready",
      review: { required: false, reasons: [] },
    },
    final: {
      basis:
        "前三个独立采分条件均已满足，末速度结果缺少足够清晰证据，主智能体终审3分。",
      remaining_uncertainty:
        "末位是否满足结果条件仍有不确定性，保留原图与区间。",
      alternatives_considered: [
        { score: 4, reason: "现有可见证据不足以确认结果采分点，未采用4分。" },
      ],
    },
  };
}

test("低置信度不可跳过复核直接提交；队列与独立证据包可追溯", async () => {
  const x = setup();
  assert.equal(reviewQueue(x.store).length, 1);
  const packet = reviewPacket(x.store, x.scored.record_file);
  assert.equal(Object.hasOwn(packet, "decision"), false);
  assert.equal(Object.hasOwn(packet, "score"), false);
  assert.ok(packet.snapshot);
  assert.equal(Object.hasOwn(packet.snapshot, "original_score"), false);
  assert.ok(packet.rubric);
  let writes = 0;
  await assert.rejects(
    commit(
      x.store,
      {
        submit: async () => {
          writes++;
        },
      },
      x.scored.record_file,
    ),
    /待复核/,
  );
  assert.equal(writes, 0);
  const d = {
    ...x.d,
    status: "ready",
    review: { required: false, reasons: [] },
  };
  assert.throws(() => x.store.score(d, x.s), /先复核/);
});
test("不能通过直接虚升置信度绕过主智能体终审", () => {
  const x = setup(),
    d = {
      ...x.d,
      status: "ready",
      review: { required: false, reasons: [] },
      confidence: { level: "high", reasons: [], affected_points: [] },
    };
  assert.throws(() => x.store.score(d, x.s), /主智能体终审/);
});
test("独立复核角色不能冒充终审；身份和旧版复核包不混用", () => {
  const x = setup(),
    packet = reviewPacket(x.store, x.scored.record_file);
  assert.throws(
    () =>
      saveReview(x.store, {
        packet_file: packet.packet_file,
        checks: { original_evidence: true, question: true, rubric: true },
        summary: "x",
        decision: { ...x.d, final_adjudication: {} },
      }),
    /冒充.*终审/,
  );
  x.store.setRubric({ ...x.r, version: "new" });
  assert.throws(
    () =>
      saveReview(x.store, {
        packet_file: packet.packet_file,
        checks: { original_evidence: true, question: true, rubric: true },
        summary: "x",
        decision: x.d,
      }),
    /已变化/,
  );
});
test("仍有不确定性，由主智能体终审定分并提醒教师，可正常保存回读", async () => {
  const x = setup(),
    { saved, independent } = review(x),
    out = adjudicate(x.store, finalInput(saved, independent));
  assert.equal(out.finalized, true);
  assert.ok(out.teacher_notice.includes("可主动要求自行评分"));
  const record = x.store.read(out.record_file);
  assert.equal(record.confidence.level, "low");
  assert.equal(record.total_score, 3);
  assert.equal(record.review.required, false);
  assert.equal(reviewQueue(x.store).length, 0);
  let writes = 0;
  const adapter = {
    read: async () => x.s,
    preflight: async () => {},
    submit: async () => {
      writes++;
    },
    receipt: async () => ({
      saved: true,
      task_id: x.r.task_id,
      paper_id: x.s.paper_id,
      score: 3,
      source: "backend",
    }),
  };
  assert.equal(
    (await commit(x.store, adapter, out.record_file)).confirmed,
    true,
  );
  assert.equal(writes, 1);
  const report = generateReport(x.store, x.dir, {
    insights: [
      {
        finding: "前三个独立条件已达到。",
        action: "补写结果并核对单位。",
        check: "结果与代入式一致。",
        evidence_papers: [x.s.paper_id],
      },
    ],
  });
  assert.equal(report.stats.review.finalized, 1);
  assert.equal(report.stats.review.remaining_uncertainty, 1);
  assert.ok(
    fs.readFileSync(report.html, "utf8").includes("主智能体已终审 1 份"),
  );
});
test("终审需要独立复核留痕，不得改包后静默提交或重复终审", () => {
  const x = setup(),
    { saved, independent } = review(x),
    input = finalInput(saved, independent);
  const record = adjudicate(x.store, input);
  assert.throws(() => adjudicate(x.store, input), /不能重复/);
  const original = x.store.read(saved.review_result_file);
  original.summary = "tampered";
  x.store.write(saved.review_result_file, original);
  const scored = x.store.read(record.record_file);
  assert.throws(() => x.store.score(scored, x.s), /指纹/);
});
test("教师只有主动接管才停止AI改分，恢复时不会覆盖教师处理", async () => {
  const x = setup(),
    { saved, independent } = review(x),
    out = adjudicate(x.store, finalInput(saved, independent));
  assert.throws(
    () => teacherControl(x.store, { paper_ids: [x.s.paper_id], active: true }),
    /主动要求/,
  );
  teacherControl(x.store, {
    paper_ids: [x.s.paper_id],
    active: true,
    user_request: "这份我自己评分",
  });
  let writes = 0;
  await assert.rejects(
    commit(
      x.store,
      {
        submit: async () => {
          writes++;
        },
      },
      out.record_file,
    ),
    /主动接管/,
  );
  assert.equal(writes, 0);
  assert.throws(
    () => x.store.score(x.store.read(out.record_file), x.s),
    /主动接管/,
  );
});

test("教师接管旧代表卷后仍能生成报告，旧分不进入统计或代表展示", () => {
  const x = setup(),
    { saved, independent } = review(x);
  adjudicate(x.store, finalInput(saved, independent));
  teacherControl(x.store, {
    paper_ids: [x.s.paper_id],
    active: true,
    user_request: "这一份我自己评分",
  });
  const report = generateReport(x.store, x.dir, {
    representatives: [
      {
        category: "excellent",
        paper_id: x.s.paper_id,
        reason: "旧代表选择应被撤下",
        crop: {
          file: "missing-old-image.png",
          sha256: "old",
          identity_checked: false,
        },
      },
    ],
  });
  assert.equal(report.stats.mean, null);
  assert.equal(report.stats.review.teacher_controlled, 1);
  assert.equal(report.stats.complete, false);
  const html = fs.readFileSync(report.html, "utf8");
  assert.equal(html.includes("旧代表选择应被撤下"), false);
  assert.ok(html.match(/class="status">([^<]+)/)[1].includes("教师接管"));
  const data = JSON.parse(
    fs.readFileSync(path.join(report.directory, "报告数据.json"), "utf8"),
  );
  assert.equal(data.omitted_representatives.length, 1);
  assert.equal(data.students[0].teacher_controlled, true);
});

test("批量接管先核对全部身份，错误卷号不能造成部分接管", () => {
  const x = setup();
  assert.throws(
    () =>
      teacherControl(x.store, {
        paper_ids: [x.s.paper_id, "not-in-task"],
        active: true,
        user_request: "这两份我自己评",
      }),
    /不在本次任务/,
  );
  assert.equal(x.store.teacherControlled(x.r.task_id, x.s.paper_id), false);
  assert.throws(
    () =>
      teacherControl(x.store, {
        paper_ids: x.s.paper_id,
        active: true,
        user_request: "接管",
      }),
    /答卷列表/,
  );
});

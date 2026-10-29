import fs from "node:fs";
import path from "node:path";
import { append, calculate, digest, fail } from "./core.mjs";
import { verifyRulesBinding } from "./rules.mjs";

export function reviewQueue(store) {
  return [...store.states().values()]
    .filter((e) => e.phase === "review")
    .map((e) => {
      const d = store.read(e.record_file);
      return {
        task_id: e.task_id,
        paper_id: e.paper_id,
        record_file: e.record_file,
        confidence: d.confidence || null,
        reasons: d.review.reasons,
        stage: store.teacherControlled(e.task_id, e.paper_id)
          ? "teacher-controlled"
          : "awaiting-agent-review",
      };
    });
}

export function reviewPacket(store, recordFile) {
  fail(
    /^scores\/[a-f0-9]{64}\.json$/.test(recordFile || ""),
    "复核来源须为账本评分文件",
  );
  const d = store.read(recordFile),
    state = store.states().get(d.task_id + "\0" + d.paper_id);
  fail(!store.teacherControlled(d.task_id, d.paper_id), "教师已主动接管此卷");
  fail(
    state?.phase === "review" && state.record_file === recordFile,
    "仅复核当前最新待复核卷；不覆盖已提交或教师更正",
  );
  const s = store.read(d.snapshot_file),
    r = store.rubric();
  let defaults;
  if (r.workflow_version === 3) {
    const binding = store.read("intake.json").default_rules;
    defaults = verifyRulesBinding(store, binding);
    fail(
      d.default_rules_hash === binding.profile_hash,
      "复核须使用初评分绑定的默认规则版本",
    );
  }
  const packet = {
    task_id: d.task_id,
    paper_id: d.paper_id,
    rubric_hash: digest(r),
    snapshot_hash: digest(s),
    snapshot_file: d.snapshot_file,
    source_record_file: recordFile,
    source_record_hash: digest(d),
    rubric: r,
    snapshot: s,
    ...(defaults ? { default_rules: defaults } : {}),
  };
  const file = "reviews/packets/" + digest(packet) + ".json";
  store.write(file, packet);
  const blindSnapshot = structuredClone(s);
  delete blindSnapshot.original_score;
  // The independent reader gets question/rubric/original evidence, not prior scores or reasoning.
  return {
    packet_file: file,
    task_id: d.task_id,
    paper_id: d.paper_id,
    rubric: r,
    snapshot: blindSnapshot,
    ...(defaults ? { default_rules: defaults } : {}),
    instruction:
      "只根据本题、有效学科/学段默认规则、细则与原始作答独立重判；不读取上一轮分数和判分理由。",
  };
}

export function saveReview(store, input) {
  fail(
    /^reviews\/packets\/[a-f0-9]{64}\.json$/.test(input.packet_file || ""),
    "复核包路径非法",
  );
  const p = store.read(input.packet_file),
    s = store.read(p.snapshot_file),
    r = store.rubric();
  fail(
    digest(p) === path.basename(input.packet_file, ".json") &&
      p.rubric_hash === digest(r) &&
      p.snapshot_hash === digest(s),
    "复核证据/细则已变化，应重新生成复核包",
  );
  if (r.workflow_version === 3) {
    const binding = store.read("intake.json").default_rules;
    verifyRulesBinding(store, binding);
    fail(
      p.default_rules && digest(p.default_rules) === binding.profile_hash,
      "独立复核的默认规则已变化，须核对版本后重新生成复核包",
    );
  }
  const state = store.states().get(p.task_id + "\0" + p.paper_id);
  fail(
    state?.phase === "review" && state.record_file === p.source_record_file,
    "复核来源已更新或已提交",
  );
  fail(
    input.checks?.original_evidence === true &&
      input.checks?.question === true &&
      input.checks?.rubric === true &&
      input.summary?.trim(),
    "复核须对照原始证据、原题和细则",
  );
  fail(!input.decision?.final_adjudication, "独立复核不能冒充主智能体终审");
  calculate(r, input.decision, s, store.dir);
  const result = {
    packet_file: input.packet_file,
    checks: input.checks,
    summary: input.summary,
    decision: input.decision,
  };
  const file = "reviews/results/" + digest(result) + ".json";
  store.write(file, result);
  append(path.join(store.dir, "reviews/events.jsonl"), {
    phase: "independent-review-saved",
    paper_id: p.paper_id,
    result_file: file,
  });
  return { review_result_file: file, needs_primary_final: true };
}

export function adjudicate(store, input) {
  fail(
    /^reviews\/results\/[a-f0-9]{64}\.json$/.test(
      input.review_result_file || "",
    ),
    "缺少独立复核结果",
  );
  const result = store.read(input.review_result_file),
    p = store.read(result.packet_file),
    s = store.read(p.snapshot_file);
  const state = store.states().get(p.task_id + "\0" + p.paper_id);
  fail(
    state?.phase === "review" && state.record_file === p.source_record_file,
    "该卷已处理或身份变化，不能重复终审",
  );
  fail(input.final?.basis?.trim(), "主智能体须说明最终取分依据");
  const d = {
    ...input.decision,
    final_adjudication: {
      ...input.final,
      review_result_file: input.review_result_file,
      reviewer_role: "primary",
      teacher_notification_required: true,
    },
  };
  const scored = store.score(d, s);
  append(path.join(store.dir, "reviews/events.jsonl"), {
    phase: "primary-finalized",
    paper_id: d.paper_id,
    source_record_file: p.source_record_file,
    record_file: scored.record_file,
    confidence: d.confidence.level,
  });
  return {
    ...scored,
    finalized: true,
    teacher_notice:
      "本卷曾有低置信度评分，已完成复核并由主智能体终审定分；教师可主动要求自行评分。",
  };
}

export function teacherControl(store, input) {
  const r = store.rubric();
  fail(
    input.user_request?.trim() &&
      typeof input.active === "boolean" &&
      input.paper_ids?.length,
    "接管/交回须来自教师主动要求，并指明答卷",
  );
  fail(
    Array.isArray(input.paper_ids) &&
      input.paper_ids.every((id) => typeof id === "string" && id.trim()) &&
      new Set(input.paper_ids).size === input.paper_ids.length,
    "答卷列表须为不重复的有效ID数组",
  );
  const states = store.states();
  for (const paperId of input.paper_ids) {
    fail(states.has(r.task_id + "\0" + paperId), "接管答卷不在本次任务中");
  }
  for (const paperId of input.paper_ids) {
    store.write(
      "reviews/teacher-control/" + digest([r.task_id, paperId]) + ".json",
      {
        task_id: r.task_id,
        paper_id: paperId,
        active: input.active,
        user_request: input.user_request,
      },
    );
  }
  return {
    teacher_controlled: input.active,
    papers: input.paper_ids.length,
    platform_write: false,
  };
}

import fs from "node:fs";
import path from "node:path";
import { append, atomic, digest, fail, json, privateDir } from "./core.mjs";
import { readCatalog } from "./rules.mjs";
import { consentForQueue } from "./sharing.mjs";

const skillVersion = json(new URL("../package.json", import.meta.url)).version;

// Historical wire vocabulary stays valid for already queued packages.
const vocabulary = json(
  new URL("../references/community/vocabulary.json", import.meta.url),
);
export const subjects = vocabulary.subjects;
export const improvementCodes = vocabulary.improvement_codes;
export const syntheticChecks = vocabulary.synthetic_checks;
const readLines = (p) =>
  fs.existsSync(p)
    ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : [];

export function saveReflection(store, home, reflection) {
  for (const k of ["worked", "mistakes", "teacher_reminders", "next_actions"])
    fail(Array.isArray(reflection[k]), "复盘缺少" + k);
  fail(
    reflection.worked.length + reflection.mistakes.length > 0 &&
      reflection.next_actions.length > 0,
    "复盘须有本次事实与下一步",
  );
  const states = [...store.states().values()];
  const refs = new Set(states.map((e) => e.paper_id));
  const runKey = digest([store.rubric().task_id, states]);
  const reflectionHash = digest(reflection);
  const ledger = path.join(home, "experience", "reflections.jsonl");
  if (
    readLines(ledger).some(
      (x) => x.run_key === runKey && x.reflection_hash === reflectionHash,
    )
  )
    return { saved: true, duplicate: true, run_key: runKey };
  const lessons = reflection.lessons || [];
  for (const lesson of lessons) {
    fail(
      ["teacher", "agent"].includes(lesson.origin) && lesson.lesson?.trim(),
      "经验来源或内容缺失",
    );
    fail(
      lesson.scope?.subject && lesson.scope?.stage,
      "经验必须限定学科和学段",
    );
    fail(
      Array.isArray(lesson.evidence_papers) &&
        lesson.evidence_papers.every((id) => refs.has(id)),
      "经验引用不存在的试卷",
    );
    if (lesson.origin === "teacher")
      fail(
        lesson.teacher_message?.trim(),
        "教师经验须保留实际提醒原话（仅本地）",
      );
  }
  const savedLessons = lessons.map((l) => ({
    ...l,
    task_id: store.rubric().task_id,
    // An AI observation cannot promote itself into a scoring policy.
    status:
      l.origin === "teacher" && l.reuse_explicit === true
        ? "active-personal"
        : "candidate",
    run_key: runKey,
  }));
  privateDir(path.dirname(ledger));
  append(ledger, {
    run_key: runKey,
    reflection_hash: reflectionHash,
    task_id: store.rubric().task_id,
    reflection: { ...reflection, lessons: savedLessons },
  });
  store.write("reflection.json", {
    ...reflection,
    lessons: savedLessons,
    run_key: runKey,
  });
  return { saved: true, run_key: runKey, lessons: savedLessons.length };
}

export function personalLessons(home, scope) {
  return readLines(path.join(home, "experience", "reflections.jsonl"))
    .flatMap((x) => x.reflection.lessons || [])
    .filter(
      (x) =>
        x.status === "active-personal" &&
        x.scope.subject === scope.subject &&
        x.scope.stage === scope.stage &&
        (!x.scope.kind || x.scope.kind === scope.kind),
    )
    .reverse();
}

/** Public queue contains controlled vocabulary only: no student/teacher prose, IDs, dates, counts or crops. */
export function contributionBody(candidate, version = skillVersion) {
  fail(
    typeof version === "string" &&
      /^[1-9]\d{0,2}\.\d{1,3}\.\d{1,3}$/.test(version),
    "共建包技能版本格式非法",
  );
  fail(
    subjects.includes(candidate.subject) &&
      ["primary", "middle", "high", "general"].includes(candidate.stage),
    "共建范围非法",
  );
  fail(
    Array.isArray(candidate.improvements) &&
      candidate.improvements.length > 0 &&
      candidate.improvements.length <= 12,
    "缺少共建改进项",
  );
  const improvements = candidate.improvements
    .map((x) => {
      fail(
        improvementCodes.includes(x.code) &&
          syntheticChecks.includes(x.synthetic_check),
        "共建只能使用已审定通用规则与合成检查类型",
      );
      return { code: x.code, synthetic_check: x.synthetic_check };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    schema_version: 1,
    skill_version: version,
    subject: candidate.subject,
    stage: candidate.stage,
    improvements,
  };
}

export function queueContribution(home, candidate) {
  fail(
    Object.hasOwn(readCatalog().subjects, candidate.subject),
    "新共建条目仅接受当前10类主要学科；历史队列保留原样",
  );
  const consent = consentForQueue(home);
  if (!consent)
    return {
      queued: false,
      message: "尚未选择共享或已关闭；本机个人经验照常保留，不生成待发送队列",
    };
  const body = contributionBody(candidate);
  const key = digest(body),
    dir = privateDir(path.join(home, "contributions", "queue"));
  const target = path.join(dir, key + ".json");
  const previous = fs.existsSync(target) ? json(target) : null;
  if (
    !previous ||
    (previous.status !== "uploaded" &&
      digest(previous.consent || {}) !== digest(consent))
  )
    atomic(target, { key, body, status: "queued", consent });
  const status = json(target).status;
  return {
    queued: status === "queued",
    already_uploaded: status === "uploaded",
    key,
    file: target,
  };
}

export function queuedContributions(home) {
  const dir = path.join(home, "contributions", "queue");
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
        .map((n) => ({ file: path.join(dir, n), ...json(path.join(dir, n)) }))
    : [];
}

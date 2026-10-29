import fs from "node:fs";
import { createHash } from "node:crypto";

const catalogURL = new URL("../references/rules/catalog.json", import.meta.url);
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
export const rulesHash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const readCatalog = () =>
  JSON.parse(fs.readFileSync(catalogURL, "utf8"));
const clean = (s) =>
  typeof s === "string" ? s.trim().toLowerCase().replace(/\s+/g, " ") : "";
const kinds = new Set([
  "dictation",
  "translation",
  "short_answer",
  "essay",
  "objective",
  "fill",
  "calculation",
  "proof",
  "experiment",
  "source_response",
  "project",
]);
function normalizedOverrides(value) {
  check(Array.isArray(value), "规则覆盖应为逐条数组，不能整体关闭默认规则");
  return value
    .map((o) => {
      check(
        o && typeof o === "object" && !Array.isArray(o),
        "覆盖条款格式无效",
      );
      return Object.fromEntries(
        [
          "rule_id",
          "source",
          "quote",
          "source_ref",
          "conflict",
          "replacement",
        ].map((k) => [k, typeof o[k] === "string" ? o[k].trim() : o[k]]),
      );
    })
    .sort((a, b) => String(a.rule_id).localeCompare(String(b.rule_id)));
}

export function stageSubjects(stage, catalog = readCatalog()) {
  const found = catalog.stages.find((s) => s.id === stage);
  check(found, "需明确学段：小学、初中或高中");
  return found.subjects.map((s) => ({ ...s }));
}

export function subjectDisplayName(subject, stage, catalog = readCatalog()) {
  if (subject === "science" && stage === "high") return "理科综合（试卷）";
  return (
    catalog.stages
      .find((s) => s.id === stage)
      ?.subjects.find((s) => s.code === subject)?.name ||
    catalog.subjects[subject]?.name ||
    subject
  );
}

export function rulesContext(input, catalog = readCatalog()) {
  const original = clean(input.subject);
  const prefix = original.match(
    /^(小学|初中|高中|高[一二三]|初[一二三])\s*/,
  )?.[1];
  const raw = original.replace(
    /^(小学|初中|高中|高[一二三]|初[一二三])\s*/,
    "",
  );
  const subject = Object.keys(catalog.subjects).find(
    (code) =>
      code === raw ||
      catalog.subjects[code].aliases.some((a) => clean(a) === raw),
  );
  check(
    subject,
    `尚无“${String(input.subject || "未明确学科")}”的主要学科专属规则；本技能仅支持当前索引范围，不能误套邻近学科`,
  );
  const hasGrade =
    input.grade !== undefined && input.grade !== null && input.grade !== "";
  if (hasGrade)
    check(
      Number.isInteger(input.grade) && input.grade >= 1 && input.grade <= 12,
      "年级信息无效；初中、高中不要求具体年级，小学可选填",
    );
  const stageNames = {
    小学: "primary",
    初中: "middle",
    高中: "high",
    primary: "primary",
    middle: "middle",
    high: "high",
  };
  const explicit = input.stage ? stageNames[clean(input.stage)] : null;
  check(!input.stage || explicit, "需明确学段：小学、初中或高中");
  const fromPrefix = prefix
    ? prefix.startsWith("小学")
      ? "primary"
      : prefix.startsWith("初")
        ? "middle"
        : "high"
    : null;
  const fromGrade = hasGrade
    ? input.grade <= 6
      ? "primary"
      : input.grade <= 9
        ? "middle"
        : "high"
    : null;
  const evidence = [explicit, fromPrefix, fromGrade].filter(Boolean);
  check(new Set(evidence).size <= 1, "学段、题目学科名称或已给年级信息不一致");
  const stage =
    evidence[0] ||
    (raw === "思想政治"
      ? "high"
      : ["理综", "理科综合"].includes(raw)
        ? "high"
        : null);
  check(
    stage,
    "需明确学段：小学、初中或高中；同名学科不能只凭学科名猜测。已有材料能确定时不再询问",
  );
  const composite = subject === "science" && stage === "high";
  check(
    stageSubjects(stage, catalog).some((s) => s.code === subject) || composite,
    "该学段未单列此学科；小学相关自然主题请归入科学，不能作为小学独立分科入口",
  );
  let band = stage;
  const grade = stage === "primary" && hasGrade ? input.grade : null;
  if (stage === "primary") {
    if (grade !== null)
      band = catalog.bands.find(
        (b) =>
          b.stage === "primary" &&
          Number.isInteger(b.grade_min) &&
          grade >= b.grade_min &&
          grade <= b.grade_max,
      ).id;
    if (input.primary_band) {
      check(
        catalog.bands.some(
          (b) => b.id === input.primary_band && b.stage === "primary",
        ),
        "小学年级段无效",
      );
      check(
        grade === null || band === input.primary_band,
        "小学年级段与已给年级不一致",
      );
      band = input.primary_band;
    }
  }
  const related = input.related_subjects ?? [];
  check(
    Array.isArray(related) &&
      related.every(
        (code) =>
          typeof code === "string" &&
          catalog.subjects[code] &&
          code !== subject,
      ),
    "关联学科须为有效的其他学科代码，由智能体按题目识别",
  );
  check(new Set(related).size === related.length, "关联学科不能重复");
  if (subject === "science" && stage !== "primary")
    check(
      related.length > 0,
      "初中综合科学/高中理综须先由智能体按本题识别关联学科，不能仅用整卷标签评分",
    );
  const kind = input.question_kind || input.kind || "";
  check(!kind || kinds.has(kind), "默认规则题型无效");
  return {
    subject,
    grade,
    stage,
    band,
    target_language: subject === "english" ? "en" : "",
    related_subjects: [...related].sort(),
    question_kind: kind,
  };
}

function comparableContext(context) {
  // Existing immutable middle/high snapshots may contain a former numeric grade.
  return {
    ...context,
    grade: context.stage === "primary" ? (context.grade ?? null) : null,
  };
}

function applyOverrides(baseRules, overrides) {
  check(Array.isArray(overrides), "规则覆盖应是逐条记录，不能整体关闭默认规则");
  const byId = new Map();
  for (const o of overrides) {
    check(
      o && baseRules.some((r) => r.id === o.rule_id),
      "不能覆盖不存在或本题未加载的规则",
    );
    check(!byId.has(o.rule_id), "同一规则只保留本次最新明确覆盖");
    check(
      ["teacher", "exam"].includes(o.source),
      "覆盖只能依据本次教师明确要求或本次正式细则",
    );
    for (const k of ["quote", "source_ref", "conflict", "replacement"])
      check(
        typeof o[k] === "string" && o[k].trim(),
        `逐条覆盖缺少${k}：须记录明确原话、来源、冲突与替代口径`,
      );
    byId.set(o.rule_id, o);
  }
  return baseRules.map((r) =>
    byId.has(r.id)
      ? {
          ...r,
          principle:
            r.principle +
            "\n本次局部优先口径（仅处理所述冲突，其他条件保留）：" +
            byId.get(r.id).replacement,
          authority:
            byId.get(r.id).source === "teacher"
              ? "merged-with-current-teacher"
              : "merged-with-current-exam",
          original_principle: r.principle,
          override: byId.get(r.id),
        }
      : { ...r },
  );
}

/** Returns the full text for the host agent to read, not a keyword scoring engine. */
export function selectRules(input, catalog = readCatalog()) {
  const context = rulesContext(input, catalog);
  const subject = catalog.subjects[context.subject],
    band = catalog.bands.find((b) => b.id === context.band);
  const codes = [context.subject, ...context.related_subjects];
  const baseRules = [...catalog.common_rules];
  for (const code of codes) {
    const s = catalog.subjects[code];
    baseRules.push(
      ...s.rules.map((r) => ({ ...r, subject: code })),
      ...s.profiles[context.band].rules.map((r) => ({ ...r, subject: code })),
    );
  }
  check(
    new Set(baseRules.map((r) => r.id)).size === baseRules.length,
    "规则库包含重复ID",
  );
  const overrides = normalizedOverrides(input.rule_overrides ?? []);
  return {
    schema_version: 1,
    activation: "always",
    catalog_version: catalog.version,
    catalog_hash: rulesHash(catalog),
    context,
    subject_name: subjectDisplayName(context.subject, context.stage, catalog),
    band_name: band.name,
    authority_notice: catalog.authority_notice,
    merge_policy: catalog.merge_policy,
    course_scope: subject.profiles[context.band].course_scope,
    reading_instruction:
      "逐条理解默认规则，按when判断本题适用项。教师未提及的规则保留；只有总分不构成逐条覆盖。再依据原题、参考答案和教师要求组织本题采分条件。不得把规则文字当成学生作答证据。",
    sources: [
      ...new Set(codes.flatMap((code) => catalog.subjects[code].sources)),
    ],
    example: subject.profiles[context.band].example,
    base_rules: baseRules,
    overrides,
    effective_rules: applyOverrides(baseRules, overrides),
  };
}

export function verifyRulesBinding(store, binding) {
  check(
    binding?.activation === "always" &&
      /^[a-f0-9]{64}$/.test(binding.profile_hash || ""),
    "默认学科规则尚未绑定",
  );
  check(
    binding.file === `rules-profiles/${binding.profile_hash}.json`,
    "默认规则快照路径与指纹不符",
  );
  const packet = store.read(binding.file);
  check(
    rulesHash(packet) === binding.profile_hash,
    "默认规则快照被修改，须修复并复核受影响评分",
  );
  check(
    packet.activation === "always" &&
      packet.schema_version === 1 &&
      packet.catalog_version === binding.catalog_version,
    "默认规则版本绑定不一致",
  );
  check(
    packet.context.subject === binding.subject &&
      packet.context.band === binding.band,
    "默认规则学科或学段绑定不一致",
  );
  return packet;
}

/** Persist immutable text; a skill upgrade cannot silently change an active task. */
export function bindRules(store, input, rubricHash, catalog = readCatalog()) {
  const context = rulesContext(input, catalog);
  const overrides = normalizedOverrides(input.rule_overrides ?? []);
  const activeFile = `rules-active/${rulesHash(input.task_id)}.json`;
  let previous;
  try {
    previous = store.read(activeFile);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let packet;
  if (previous?.task_id === input.task_id && previous.default_rules) {
    const frozen = verifyRulesBinding(store, previous.default_rules);
    if (
      rulesHash(comparableContext(frozen.context)) ===
        rulesHash(comparableContext(context)) &&
      rulesHash(frozen.overrides) === rulesHash(overrides)
    )
      packet = frozen;
    else
      check(
        previous.rubric_hash !== rubricHash,
        "学科、学段、题型或覆盖条款变化：须先更新细则版本并复核受影响答卷，不能同版中途换口径",
      );
  }
  packet ??= selectRules(input, catalog);
  const hash = rulesHash(packet),
    file = `rules-profiles/${hash}.json`;
  store.write(file, packet);
  const binding = {
    activation: "always",
    catalog_version: packet.catalog_version,
    profile_hash: hash,
    file,
    subject: context.subject,
    band: context.band,
  };
  store.write(activeFile, {
    task_id: input.task_id,
    rubric_hash: rubricHash,
    default_rules: binding,
  });
  return { binding, packet };
}

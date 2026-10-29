import { digest, fail, validateRubric } from "./core.mjs";
import {
  bindRules,
  verifyRulesBinding,
  rulesContext,
  subjectDisplayName,
} from "./rules.mjs";

export function prepareIntake(store, input) {
  const r = validateRubric(store.rubric());
  const missing = [];
  for (const [key, label] of Object.entries({
    question_clear: "清晰完整的原题（含图表与各小问）",
    reference_clear: "参考答案及适用范围",
    rules_clear: "分值、步长及采分细则",
    scope: "本次阅卷范围",
  })) {
    if (!input[key] || (typeof input[key] === "string" && !input[key].trim()))
      missing.push(label);
  }
  for (const key of ["question_clear", "reference_clear", "rules_clear"])
    if (input[key] !== true) missing.push(key + "尚未确认清楚");
  if (typeof input.scope !== "object" || !input.scope?.label?.trim())
    missing.push("明确的本次阅卷范围");
  let context;
  try {
    context = rulesContext({ ...input, question_kind: r.kind });
  } catch (error) {
    missing.push(error.message);
  }
  if (
    !["teacher", "reference", "agent-organized", "teacher-completed"].includes(
      input.rubric_mode,
    )
  )
    missing.push("细则来源：教师完整细则、正式参考细则或智能体补拟");
  if (input.teacher_rubric_checked !== true)
    missing.push("应先索取教师已有评分细则；已提供则不重复询问");
  if (!["complete", "partial", "none"].includes(input.teacher_rubric_status))
    missing.push("教师细则完整度：完整、仅总分/部分要求或暂无");
  if (
    input.rubric_mode === "teacher" &&
    input.teacher_rubric_status !== "complete"
  )
    missing.push("教师细则不全，应保留已有要求并标注其余条件由智能体补拟");
  if (
    ["agent-organized", "teacher-completed"].includes(input.rubric_mode) &&
    (input.agent_organization_notified !== true ||
      !input.rubric_generation_notice?.trim())
  )
    missing.push(
      "须先告知教师：将保留已有要求，依据内置通用规则和参考答案补拟其余细则",
    );
  if (!["teacher", "official", "agent"].includes(input.reference_origin))
    missing.push("参考答案来源");
  if (
    input.reference_origin === "agent" &&
    input.independently_verified !== true
  )
    missing.push("智能体拟定答案的独立验算/核证");
  if (input.task_id !== r.task_id) missing.push("本次任务身份");
  if (!["writeback", "offline", "report-only"].includes(input.mode))
    missing.push("交付模式：平台阅卷、离线评分或只审计出报告");
  if (input.unresolved?.length) missing.push(...input.unresolved);
  let defaults;
  if (input.task_id === r.task_id && context) {
    try {
      defaults = bindRules(
        store,
        {
          ...input,
          ...context,
          primary_band: context.stage === "primary" ? context.band : undefined,
          question_kind: r.kind,
        },
        digest(r),
      );
    } catch (error) {
      missing.push(error.message);
    }
  }
  const result = {
    ...input,
    ...(context
      ? {
          subject: context.subject,
          stage: context.stage,
          grade: context.grade,
          subject_label: subjectDisplayName(context.subject, context.stage),
        }
      : {}),
    default_rules: defaults?.binding || null,
    task_id: r.task_id,
    rubric_hash: digest(r),
    ready: missing.length === 0,
    missing,
    checked_at: new Date().toISOString(),
  };
  store.write("intake.json", result);
  return { ...result, rule_packet: defaults?.packet || null };
}

export function ensureFinishedIntake(store) {
  const i = store.read("intake.json");
  fail(
    i.ready &&
      i.task_id === store.rubric().task_id &&
      i.rubric_hash === digest(store.rubric()),
    "开卷材料尚未核对完成",
  );
  if (store.rubric().workflow_version === 3 || i.default_rules)
    verifyRulesBinding(store, i.default_rules);
  return i;
}

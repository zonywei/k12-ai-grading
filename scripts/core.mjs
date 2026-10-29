import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { verifyRulesBinding } from "./rules.mjs";
export const fail = (test, message) => {
  if (!test) throw new Error(message);
};
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export function privateDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(p, 0o700);
  return p;
}
export function atomic(p, data) {
  privateDir(path.dirname(p));
  const temp = p + "." + randomBytes(6).toString("hex") + ".tmp";
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, p);
}
export function append(p, data) {
  privateDir(path.dirname(p));
  const fd = fs.openSync(p, "a", 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ ...data, at: new Date().toISOString() }) + "\n",
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export const defaultHome = () =>
  path.join(
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || os.homedir()
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : path.join(os.homedir(), ".local", "share"),
    "k12-ai-grading",
  );
const number = (n) => typeof n === "number" && Number.isFinite(n);
export const aligned = (n, step) =>
  number(n) && Math.abs(n / step - Math.round(n / step)) < 1e-7;
export const round = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function validateRubric(r) {
  fail(r && r.schema_version === 2, "rubric schema_version必须为2");
  if ("default_rules_required" in r)
    fail(
      r.default_rules_required === true && r.workflow_version === 3,
      "v3默认学科规则不能整体关闭；本次明确要求仅逐条局部覆盖",
    );
  for (const k of ["task_id", "qid", "version", "question", "reference_answer"])
    fail(typeof r[k] === "string" && r[k].trim(), "缺少" + k);
  fail(
    number(r.max_score) &&
      r.max_score > 0 &&
      number(r.step) &&
      r.step > 0 &&
      aligned(r.max_score, r.step),
    "满分或步长非法",
  );
  fail(
    [
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
    ].includes(r.kind),
    "题型非法",
  );
  fail(Array.isArray(r.points) && r.points.length > 0, "缺少采分点");
  const ids = new Set();
  let max = 0;
  for (const p of r.points) {
    fail(
      typeof p.id === "string" && p.id && !ids.has(p.id),
      "采分点ID重复或缺失",
    );
    ids.add(p.id);
    fail(!("required" in p), "不使用含糊required；任选点须配置groups");
    fail(
      number(p.max) && p.max > 0 && aligned(p.max, r.step),
      "采分点分值非法",
    );
    max += p.max;
    fail(
      typeof p.description === "string" && p.description.trim(),
      "采分点缺少条件",
    );
    fail(
      ["teacher", "reference", "agent"].includes(p.source),
      "采分点来源必须标注",
    );
  }
  const grouped = new Set();
  for (const g of r.groups || []) {
    fail(
      Array.isArray(g.ids) &&
        g.ids.length > 0 &&
        new Set(g.ids).size === g.ids.length,
      "分组成员非法",
    );
    let sum = 0;
    for (const id of g.ids) {
      fail(ids.has(id) && !grouped.has(id), "分组不存在或重叠");
      grouped.add(id);
      sum += r.points.find((p) => p.id === id).max;
    }
    fail(
      number(g.cap) && g.cap > 0 && g.cap <= sum && aligned(g.cap, r.step),
      "分组封顶非法",
    );
    max -= sum - g.cap;
  }
  fail(
    Math.abs(max - r.max_score) < 1e-6,
    "采分点经分组封顶后的满分必须等于题目满分",
  );
  const dids = new Set();
  for (const d of r.deduction_rules || []) {
    fail(
      d.id &&
        !dids.has(d.id) &&
        d.description &&
        ["teacher", "reference"].includes(d.source),
      "扣分须有教师/明确细则依据及唯一ID",
    );
    dids.add(d.id);
    fail(number(d.max) && d.max > 0 && aligned(d.max, r.step), "扣分上限非法");
  }
  const cids = new Set();
  for (const c of r.cap_rules || []) {
    fail(
      c.id &&
        !cids.has(c.id) &&
        c.description &&
        ["teacher", "reference"].includes(c.source),
      "总分封顶须有明确细则依据及唯一ID",
    );
    cids.add(c.id);
    fail(
      number(c.cap) &&
        c.cap >= 0 &&
        c.cap <= r.max_score &&
        aligned(c.cap, r.step),
      "总分封顶非法",
    );
  }
  return r;
}
export function validateEvidence(e, s, runDir) {
  fail(e && typeof e === "object", "给分/扣分需作答证据");
  if (e.type === "text") {
    fail(
      typeof e.quote === "string" && e.quote.trim() && s.text.includes(e.quote),
      "引文不在本份作答中",
    );
    return;
  }
  fail(e.type === "image", "证据类型须为text或image");
  const a = (s.artifacts || []).find(
    (a) => a.file === e.file && a.sha256 === e.sha256,
  );
  fail(a, "图片不属于当前快照");
  const file = path.resolve(runDir, e.file);
  fail(file.startsWith(path.resolve(runDir) + path.sep), "图片路径越界");
  fail(
    fs.existsSync(file) &&
      createHash("sha256").update(fs.readFileSync(file)).digest("hex") ===
        e.sha256,
    "原图缺失或被修改",
  );
  fail(
    Array.isArray(e.region) &&
      e.region.length === 4 &&
      e.region.every(number) &&
      e.region[0] >= 0 &&
      e.region[1] >= 0 &&
      e.region[2] > 0 &&
      e.region[3] > 0,
    "图片区域须[x,y,w,h]",
  );
  fail(
    e.region[0] + e.region[2] <= a.width &&
      e.region[1] + e.region[3] <= a.height,
    "证据区域超出原图",
  );
  fail(
    typeof e.observation === "string" && e.observation.trim(),
    "图片证据缺少可见内容说明",
  );
}
export function calculate(r, d, s, runDir) {
  validateRubric(r);
  if (r.workflow_version === 3)
    fail(
      s.qid === r.qid && s.max_score === r.max_score && s.step === r.step,
      "作答快照与题号/满分/步长不一致",
    );
  for (const k of ["task_id", "paper_id", "answer_hash"])
    fail(d[k] === s[k], "评分与快照不一致：" + k);
  fail(
    d.rubric_hash === digest(r) && d.task_id === r.task_id,
    "评分标准版本/任务不一致",
  );
  fail(
    Array.isArray(d.awards) && d.awards.length === r.points.length,
    "必须逐点记录，包括0分点",
  );
  const awards = new Map();
  for (const a of d.awards) {
    fail(!awards.has(a.point_id), "重复得分点");
    awards.set(a.point_id, a);
  }
  let total = 0;
  const parts = {};
  for (const p of r.points) {
    const a = awards.get(p.id);
    fail(
      a &&
        number(a.score) &&
        a.score >= 0 &&
        a.score <= p.max &&
        aligned(a.score, r.step),
      "采分点分数非法：" + p.id,
    );
    fail(a.reason?.trim(), "缺少逐点理由");
    if (a.score > 0) validateEvidence(a.evidence, s, runDir);
    parts[p.id] = a.score;
    total += a.score;
  }
  for (const g of r.groups || [])
    total -= Math.max(0, g.ids.reduce((v, id) => v + parts[id], 0) - g.cap);
  const used = new Set();
  for (const a of d.deductions || []) {
    const rule = (r.deduction_rules || []).find((x) => x.id === a.rule_id);
    fail(rule && !used.has(a.rule_id), "扣分规则缺失/重复");
    used.add(a.rule_id);
    fail(
      number(a.amount) &&
        a.amount >= 0 &&
        a.amount <= rule.max &&
        aligned(a.amount, r.step) &&
        a.reason?.trim(),
      "扣分非法",
    );
    validateEvidence(a.evidence, s, runDir);
    total -= a.amount;
  }
  total = Math.max(0, total);
  const caps = new Set();
  for (const c of d.applied_caps || []) {
    const rule = (r.cap_rules || []).find((x) => x.id === c.rule_id);
    fail(rule && !caps.has(c.rule_id) && c.reason?.trim(), "封顶规则缺失/重复");
    caps.add(c.rule_id);
    validateEvidence(c.evidence, s, runDir);
    total = Math.min(total, rule.cap);
  }
  fail(
    d.review &&
      typeof d.review.required === "boolean" &&
      Array.isArray(d.review.reasons),
    "缺少复核状态",
  );
  fail(
    d.review.required === Boolean(d.review.reasons.length),
    "复核状态与未决理由矛盾",
  );
  fail(
    ["ready", "review"].includes(d.status) &&
      (d.status === "review") === d.review.required,
    "ready/review状态矛盾",
  );
  fail(
    d.self_check?.negation === true &&
      d.self_check?.context === true &&
      d.self_check?.duplicates === true &&
      d.self_check?.rules === true,
    "缺少智能体复读检查",
  );
  fail(d.summary?.trim(), "缺少作答总体依据");
  if (r.workflow_version === 3 || d.confidence) {
    const c = d.confidence;
    fail(
      c &&
        ["high", "medium", "low"].includes(c.level) &&
        Array.isArray(c.reasons) &&
        c.reasons.every((x) => typeof x === "string" && x.trim()),
      "须记录定性评分置信度及实际原因，不能用百分比冒充正确率",
    );
    fail(
      Array.isArray(c.affected_points) &&
        c.affected_points.every((id) => r.points.some((p) => p.id === id)),
      "置信度疑点须关联实际采分点",
    );
    if (c.level !== "high") {
      fail(
        c.reasons.length > 0 && c.affected_points.length > 0,
        "低/中置信度须记录原因与受影响采分点",
      );
      fail(
        Array.isArray(c.score_range) &&
          c.score_range.length === 2 &&
          c.score_range.every((x) => number(x) && aligned(x, r.step)) &&
          c.score_range[0] >= 0 &&
          c.score_range[1] <= r.max_score &&
          c.score_range[0] <= round(total) &&
          c.score_range[1] >= round(total),
        "低/中置信度须保留合理分数区间",
      );
      fail(
        d.review.required || d.final_adjudication,
        "低置信度须先复核，再由主智能体终审定分",
      );
    }
  }
  if (d.final_adjudication) verifyFinalAdjudication(r, d, s, runDir);
  if (r.workflow_version === 3) {
    fail(
      d.learning?.judgment?.trim() &&
        d.learning?.action?.trim() &&
        d.learning?.check?.trim(),
      "须记录本题学情判断、具体练习和验收办法",
    );
    fail(
      Array.isArray(d.learning.point_ids) &&
        d.learning.point_ids.length > 0 &&
        d.learning.point_ids.every((id) => r.points.some((p) => p.id === id)),
      "学情判断须关联本题采分点",
    );
  }
  if (d.total_score !== undefined)
    fail(Math.abs(d.total_score - round(total)) < 1e-6, "总分与统一核算不符");
  return { total_score: round(total), point_scores: parts, status: d.status };
}

export function verifyFinalAdjudication(r, d, s, runDir) {
  const f = d.final_adjudication;
  fail(
    f.reviewer_role === "primary" &&
      f.basis?.trim() &&
      f.teacher_notification_required === true,
    "终审须由主智能体定分、留依据并提醒教师",
  );
  fail(
    /^reviews\/results\/[a-f0-9]{64}\.json$/.test(f.review_result_file || ""),
    "终审缺少先行独立复核记录",
  );
  const result = json(path.join(runDir, f.review_result_file));
  fail(
    digest(result) === path.basename(f.review_result_file, ".json") &&
      !result.decision?.final_adjudication,
    "复核记录指纹不一致或复核角色冒充终审",
  );
  fail(
    /^reviews\/packets\/[a-f0-9]{64}\.json$/.test(result.packet_file || ""),
    "复核缺少原始证据包",
  );
  const packet = json(path.join(runDir, result.packet_file));
  fail(
    digest(packet) === path.basename(result.packet_file, ".json") &&
      packet.task_id === d.task_id &&
      packet.paper_id === d.paper_id &&
      packet.rubric_hash === digest(r) &&
      packet.snapshot_hash === digest(s),
    "复核包与本卷/细则/快照不一致",
  );
  fail(
    /^scores\/[a-f0-9]{64}\.json$/.test(packet.source_record_file || ""),
    "终审来源路径非法",
  );
  const source = json(path.join(runDir, packet.source_record_file));
  if (r.workflow_version === 3) {
    const binding = json(path.join(runDir, "intake.json")).default_rules;
    verifyRulesBinding(
      { read: (file) => json(path.join(runDir, file)) },
      binding,
    );
    fail(
      packet.default_rules &&
        digest(packet.default_rules) === binding.profile_hash &&
        source.default_rules_hash === binding.profile_hash,
      "终审须使用初评与独立复核同版的默认学科规则",
    );
  }
  fail(
    digest(source) === packet.source_record_hash &&
      source.review.required === true &&
      source.task_id === d.task_id &&
      source.paper_id === d.paper_id,
    "终审来源不是该卷有效待复核记录",
  );
  fail(
    result.checks?.original_evidence === true &&
      result.checks?.question === true &&
      result.checks?.rubric === true &&
      result.summary?.trim(),
    "复核须重读原始证据、题目与细则",
  );
  calculate(r, result.decision, s, runDir);
  fail(
    d.status === "ready" && d.review.required === false,
    "主智能体终审应给出最终可提交分数",
  );
  if (d.confidence?.level !== "high")
    fail(
      f.remaining_uncertainty?.trim(),
      "终审仍有不确定性时须如实保留，不能虚升置信度",
    );
  fail(
    Array.isArray(f.alternatives_considered) &&
      f.alternatives_considered.length > 0 &&
      f.alternatives_considered.every(
        (x) =>
          number(x.score) &&
          x.score >= 0 &&
          x.score <= r.max_score &&
          aligned(x.score, r.step) &&
          x.reason?.trim(),
      ),
    "终审须比较候选分数并说明取舍，不能机械取平均",
  );
  return packet;
}
export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    privateDir(this.dir);
    this.journal = path.join(this.dir, "journal.jsonl");
  }
  read(name) {
    return json(path.join(this.dir, name));
  }
  write(name, value) {
    atomic(path.join(this.dir, name), value);
  }
  entries() {
    return fs.existsSync(this.journal)
      ? fs
          .readFileSync(this.journal, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
      : [];
  }
  event(e) {
    append(this.journal, e);
  }
  states() {
    const m = new Map();
    for (const e of this.entries())
      if (e.paper_id) m.set(e.task_id + "\0" + e.paper_id, e);
    return m;
  }
  pending() {
    return [...this.states().values()].filter((e) =>
      ["intent", "unknown"].includes(e.phase),
    );
  }
  setRubric(r) {
    validateRubric(r);
    const h = digest(r),
      file = "rubrics/" + h + ".json";
    this.write(file, r);
    this.write("active.json", { rubric_hash: h, file });
    return { rubric_hash: h };
  }
  rubric() {
    return this.read(this.read("active.json").file);
  }
  teacherControlled(taskId, paperId) {
    const file = path.join(
      this.dir,
      "reviews/teacher-control",
      digest([taskId, paperId]) + ".json",
    );
    return fs.existsSync(file) && json(file).active === true;
  }
  authorize(a) {
    const r = this.rubric();
    fail(
      a.task_id === r.task_id && a.submit === true && a.user_request?.trim(),
      "必须绑定教师当前任务的实际提交请求",
    );
    this.write("authorization.json", a);
  }
  score(d, s) {
    const r = this.rubric();
    let defaults;
    if (r.workflow_version === 3) {
      const intake = this.read("intake.json");
      fail(
        intake.ready === true &&
          intake.task_id === r.task_id &&
          intake.rubric_hash === digest(r),
        "默认规则启用前须完成本版材料与细则核对",
      );
      const packet = verifyRulesBinding(this, intake.default_rules);
      fail(
        (intake.stage !== "primary" ||
          (packet.context.grade ?? null) === (intake.grade ?? null)) &&
          packet.context.stage === intake.stage &&
          packet.context.question_kind === r.kind,
        "默认规则与当前学段、小学选填年级或题型不一致",
      );
      defaults = intake.default_rules;
    }
    const value = calculate(r, d, s, this.dir);
    const prior = this.states().get(d.task_id + "\0" + d.paper_id);
    fail(
      !this.teacherControlled(d.task_id, d.paper_id),
      "教师已主动接管此卷，智能体停止改分",
    );
    if (
      prior?.phase === "review" &&
      r.workflow_version === 3 &&
      this.read(prior.record_file).confidence?.level !== "high" &&
      d.status === "ready"
    )
      fail(d.final_adjudication, "低置信度转最终分须先独立复核、主智能体终审");
    if (d.final_adjudication) {
      const packet = verifyFinalAdjudication(r, d, s, this.dir);
      fail(
        prior?.phase === "review" &&
          prior.record_file === packet.source_record_file,
        "终审来源不是本卷最新待复核记录",
      );
    }
    fail(
      !prior || !["confirmed", "intent", "unknown"].includes(prior.phase),
      "该卷已提交或提交状态未明，不能覆盖",
    );
    const record = {
      ...d,
      ...value,
      revision: (prior?.revision || 0) + 1,
      snapshot_file: s.snapshot_file,
      ...(defaults
        ? {
            default_rules_hash: defaults.profile_hash,
            default_rules_file: defaults.file,
          }
        : {}),
    };
    const file =
      "scores/" + digest([d.task_id, d.paper_id, record.revision]) + ".json";
    this.write(file, record);
    this.event({
      phase: d.review.required ? "review" : "scored",
      task_id: d.task_id,
      paper_id: d.paper_id,
      revision: record.revision,
      record_file: file,
      score: value.total_score,
    });
    return { record_file: file, ...value };
  }
  summary() {
    const states = [...this.states().values()];
    const counts = {};
    for (const e of states) counts[e.phase] = (counts[e.phase] || 0) + 1;
    return {
      papers: states.length,
      counts,
      unconfirmed: this.pending().length,
      complete:
        this.pending().length === 0 &&
        states.length > 0 &&
        states.every((e) => e.phase === "confirmed"),
    };
  }
}
/** Adapter must perform actual saved-score readback. UI navigation alone is never a receipt. */
export async function commit(store, adapter, recordFile) {
  fail(store.pending().length === 0, "有未确认提交，必须先recover回读");
  const r = store.rubric(),
    d = store.read(recordFile),
    s = store.read(d.snapshot_file),
    auth = store.read("authorization.json");
  fail(
    !store.teacherControlled(d.task_id, d.paper_id),
    "教师已主动接管此卷，智能体停止提交",
  );
  if (r.workflow_version === 3) {
    const intake = store.read("intake.json");
    fail(
      intake.ready === true &&
        intake.task_id === r.task_id &&
        intake.rubric_hash === digest(r),
      "题目、答案和本版细则尚未核对完成",
    );
    fail(intake.mode === "writeback", "当前是离线/只出报告模式，禁止平台写分");
    if (r.workflow_version === 3) {
      verifyRulesBinding(store, intake.default_rules);
      fail(
        d.default_rules_hash === intake.default_rules.profile_hash &&
          d.default_rules_file === intake.default_rules.file,
        "本卷评分与当前默认规则版本不一致，须复核后重新记录",
      );
    }
  }
  fail(
    auth.task_id === r.task_id && auth.submit === true,
    "当前任务未授权提交",
  );
  const value = calculate(r, d, s, store.dir);
  fail(value.status === "ready", "待复核卷不能提交");
  const prior = store.states().get(d.task_id + "\0" + d.paper_id);
  fail(
    prior?.phase === "scored" && prior.record_file === recordFile,
    "不是该卷最新已校验记录或已提交",
  );
  const current = await adapter.read(false);
  for (const k of ["task_id", "paper_id", "answer_hash"])
    fail(current[k] === d[k], "当前卷已变化：" + k);
  fail(
    current.qid === r.qid &&
      current.max_score === r.max_score &&
      current.step === r.step &&
      current.status === "pending",
    "题号/分值/待评状态不一致",
  );
  await adapter.preflight(d);
  const base = {
    task_id: d.task_id,
    paper_id: d.paper_id,
    record_file: recordFile,
    score: value.total_score,
    revision: d.revision,
  };
  store.event({ ...base, phase: "intent" }); // durable BEFORE any external mutation
  try {
    await adapter.submit(value.total_score, d);
    const receipt = await adapter.receipt(d);
    verifyReceipt(receipt, d, value.total_score);
    store.event({
      ...base,
      phase: "confirmed",
      receipt: {
        paper_id: receipt.paper_id,
        score: receipt.score,
        source: receipt.source,
      },
    });
    return { confirmed: true, score: value.total_score };
  } catch (e) {
    store.event({
      ...base,
      phase: "unknown",
      reason: "提交或回读未闭合，请先recover",
    });
    return {
      confirmed: false,
      unknown: true,
      message: "提交状态未明，已阻止继续提交；先回读，不重交。",
    };
  }
}
export function verifyReceipt(receipt, d, score) {
  fail(
    receipt?.saved === true &&
      receipt.task_id === d.task_id &&
      receipt.paper_id === d.paper_id &&
      number(receipt.score) &&
      receipt.score === score &&
      ["backend", "reviewed-list"].includes(receipt.source),
    "没有同卷、同任务、同分数的已保存回执",
  );
}
export async function recover(store, adapter) {
  const results = [];
  for (const e of store.pending()) {
    const d = store.read(e.record_file);
    try {
      const receipt = await adapter.receipt(d);
      verifyReceipt(receipt, d, e.score);
      store.event({
        ...e,
        phase: "confirmed",
        receipt: {
          paper_id: receipt.paper_id,
          score: receipt.score,
          source: receipt.source,
        },
        recovered: true,
      });
      results.push({ paper_id: e.paper_id, confirmed: true });
    } catch {
      results.push({ paper_id: e.paper_id, confirmed: false });
    }
  }
  return { results, unconfirmed: store.pending().length };
}

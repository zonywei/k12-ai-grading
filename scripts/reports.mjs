import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { calculate, digest, fail, json, privateDir, round } from "./core.mjs";
import { verifyRulesBinding, subjectDisplayName } from "./rules.mjs";

const displayNumber = (v) => (v == null ? "—" : Number(v.toFixed(2)));
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const subjectNames = {
  chinese: "语文",
  math: "数学",
  english: "英语",
  physics: "物理",
  chemistry: "化学",
  biology: "生物",
  science: "科学",
  history: "历史",
  geography: "地理",
  civics: "道德与法治/思想政治",
  "information-technology": "信息科技",
  "foreign-language": "其他外语",
  "general-technology": "通用技术",
  "visual-arts": "美术",
  "integrated-practice": "综合实践",
  music: "音乐",
  arts: "艺术",
  pe: "体育",
  labor: "劳动",
};
const phaseLabel = (phase) =>
  ({
    confirmed: "平台已确认",
    scored: "本地建议分",
    review: "待复核，分数暂定",
    intent: "提交待核验",
    unknown: "保存状态待核验",
  })[phase] || "待核验";
const hashBytes = (b) => createHash("sha256").update(b).digest("hex");
function bound(runDir, file) {
  const root = fs.realpathSync(runDir),
    resolved = fs.realpathSync(path.resolve(root, file));
  fail(
    resolved.startsWith(root + path.sep),
    "报告来源不能越出本次私密运行目录",
  );
  return resolved;
}
const writePrivate = (file, content) => {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
};

export function loadRecords(store) {
  return [...store.states().values()].map((state, index) => {
    fail(state.record_file, "缺少逐卷评分记录");
    const record = json(bound(store.dir, state.record_file));
    const snapshot = json(bound(store.dir, record.snapshot_file));
    const rubric = json(
      bound(store.dir, "rubrics/" + record.rubric_hash + ".json"),
    );
    fail(
      digest(rubric) === record.rubric_hash &&
        state.task_id === record.task_id &&
        state.paper_id === record.paper_id,
      "报告身份/细则指纹不一致",
    );
    const validated = calculate(rubric, record, snapshot, store.dir);
    fail(validated.total_score === state.score, "报告分数与账本不一致");
    return {
      alias: "卷" + String(index + 1).padStart(3, "0"),
      state,
      record,
      snapshot,
      rubric,
    };
  });
}

function selectRepresentatives(
  rows,
  selections = [],
  advisory = false,
  excluded = () => false,
) {
  const out = [];
  const selectedCategories = new Set();
  for (const s of selections) {
    const row = rows.find((x) => x.record.paper_id === s.paper_id);
    fail(
      row &&
        ["excellent", "typical", "anomalous"].includes(s.category) &&
        s.reason?.trim(),
      "代表卷须来自本次账本并有选择理由",
    );
    fail(
      !selectedCategories.has(s.category),
      "每类先选一份最有讲评价值的代表卷",
    );
    selectedCategories.add(s.category);
    if (!excluded(row)) out.push({ ...s, row });
  }
  const confirmed = rows.filter(
    (x) =>
      !excluded(x) &&
      (advisory ? x.record.status === "ready" : x.state.phase === "confirmed"),
  );
  const excellent = confirmed
    .filter((x) => x.record.total_score / x.rubric.max_score >= 0.85)
    .sort(
      (a, b) =>
        b.record.total_score / b.rubric.max_score -
        a.record.total_score / a.rubric.max_score,
    )[0];
  const ordered = [...confirmed].sort(
    (a, b) =>
      a.record.total_score / a.rubric.max_score -
      b.record.total_score / b.rubric.max_score,
  );
  const typical = ordered[Math.floor((ordered.length - 1) / 2)];
  const anomalous = rows.find(
    (x) =>
      !excluded(x) &&
      (x.record.review.required ||
        (x.record.final_adjudication &&
          x.record.confidence?.level !== "high") ||
        ["unknown", "intent"].includes(x.state.phase)),
  );
  for (const [category, row, reason] of [
    ["excellent", excellent, "得分完整度较高，可展示可复用的作答步骤"],
    ["typical", typical, "本批次已确认得分位于中部，仅作为常态作答示例"],
    [
      "anomalous",
      anomalous,
      "展示识别、评分或保存核验方面的特殊情况，以实际记录状态为准",
    ],
  ]) {
    if (row && !out.some((s) => s.category === category))
      out.push({ category, row, reason });
  }
  return out;
}

function cropEvidence(store, home, selection, outDir) {
  if (!selection.crop) return null;
  const { row, crop } = selection;
  fail(
    crop.identity_checked === true,
    "报告插图须先检查姓名、学号、二维码与其他身份信息",
  );
  const original = row.snapshot.artifacts.find(
    (a) => a.file === crop.file && a.sha256 === crop.sha256,
  );
  fail(original, "代表卷图片不属于本份作答");
  const source = bound(store.dir, crop.file);
  fail(hashBytes(fs.readFileSync(source)) === crop.sha256, "代表卷原图已改变");
  const output = path.join(
    outDir,
    selection.category + "-" + row.alias + ".png",
  );
  const python = path.join(
    home,
    "python",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  fail(fs.existsSync(python), "请先自动配置Python裁图环境");
  const helper = fileURLToPath(new URL("./media.py", import.meta.url));
  const result = spawnSync(python, [helper], {
    input: JSON.stringify({ source, output, region: crop.region }),
    encoding: "utf8",
    timeout: 30000,
  });
  fail(result.status === 0, "代表卷裁图失败，保留文字证据并修复后重生成");
  return {
    file: output,
    data: "data:image/png;base64," + fs.readFileSync(output).toString("base64"),
  };
}

export function generateReport(store, home, analysis = {}) {
  const rows = loadRecords(store),
    intake = fs.existsSync(path.join(store.dir, "intake.json"))
      ? store.read("intake.json")
      : {};
  const task = store.rubric().task_id;
  const ruleProfiles = [
    ...new Set(rows.map((x) => x.record.default_rules_hash).filter(Boolean)),
  ].map((hash) => {
    const file = `rules-profiles/${hash}.json`,
      packet = store.read(file);
    verifyRulesBinding(store, {
      activation: "always",
      catalog_version: packet.catalog_version,
      profile_hash: hash,
      file,
      subject: packet.context.subject,
      band: packet.context.band,
    });
    return {
      hash,
      file,
      subject: subjectDisplayName(packet.context.subject, packet.context.stage),
      band:
        packet.context.stage === "high"
          ? "高中"
          : packet.context.stage === "middle"
            ? "初中"
            : packet.band_name,
      catalog_version: packet.catalog_version,
      overrides: packet.overrides.length,
    };
  });
  const ruleNotice = ruleProfiles.length
    ? "评分口径：" +
      ruleProfiles
        .map(
          (p) =>
            p.band +
            " · " +
            p.subject +
            "默认原则与本题细则合并" +
            (p.overrides ? `（明确局部覆盖${p.overrides}条）` : ""),
        )
        .join("；") +
      "。"
    : "";
  fail(
    rows.every((x) => x.record.task_id === task),
    "一个报告只覆盖同一授权任务；多任务请分别汇总",
  );
  fail(
    rows.every(
      (x) =>
        x.rubric.max_score === store.rubric().max_score &&
        x.rubric.qid === store.rubric().qid,
    ),
    "不同题号或满分须分开报告，不能混算原始均分",
  );
  const byId = new Map(rows.map((x) => [x.record.paper_id, x]));
  for (const insight of analysis.insights || []) {
    fail(
      insight.finding?.trim() &&
        insight.action?.trim() &&
        insight.check?.trim(),
      "讲评须说明问题、具体做法和验收办法",
    );
    fail(
      insight.evidence_papers?.length &&
        insight.evidence_papers.every((p) => byId.has(p)),
      "讲评引用了不存在的试卷",
    );
  }
  const teacherControlled = (x) =>
    store.teacherControlled(x.record.task_id, x.record.paper_id);
  const confirmed = rows.filter(
    (x) => x.state.phase === "confirmed" && !teacherControlled(x),
  );
  const reviewStats = {
    pending: rows.filter(
      (x) => x.record.review.required && !teacherControlled(x),
    ).length,
    finalized: rows.filter((x) => x.record.final_adjudication).length,
    remaining_uncertainty: rows.filter(
      (x) =>
        x.record.final_adjudication && x.record.confidence?.level !== "high",
    ).length,
    teacher_controlled: rows.filter(teacherControlled).length,
  };
  const scoreDisplay = (x) =>
    teacherControlled(x)
      ? "教师接管；本地旧分不代表教师最新分"
      : x.record.review.required && x.record.confidence?.score_range
        ? x.record.confidence.score_range.join("–") +
          " / " +
          x.rubric.max_score +
          "（待复核区间）"
        : x.record.total_score +
          " / " +
          x.rubric.max_score +
          (x.record.final_adjudication ? "（已终审）" : "");
  const mode = intake.mode || "writeback",
    advisory = mode !== "writeback";
  if (advisory)
    fail(
      !store
        .entries()
        .some((e) => ["intent", "unknown", "confirmed"].includes(e.phase)),
      "离线/只出报告任务包含平台写入事件，须先核验模式",
    );
  const analysisRows = advisory
    ? rows.filter((x) => x.record.status === "ready" && !teacherControlled(x))
    : confirmed;
  const scores = analysisRows.map((x) => x.record.total_score),
    sum = scores.reduce((a, b) => a + b, 0);
  const expected = intake.scope?.expected_papers;
  const coverageChecked =
    intake.scope?.platform_count_reconciled === true &&
    Number.isInteger(expected) &&
    expected === rows.length;
  const complete =
    coverageChecked &&
    rows.length > 0 &&
    !rows.some(teacherControlled) &&
    (advisory
      ? rows.every((x) => x.record.status === "ready")
      : rows.every((x) => x.state.phase === "confirmed"));
  const sourceLabel = advisory ? "本地建议" : "平台确认";
  const outstanding = [];
  if (!coverageChecked) outstanding.push("授权范围总量待核对");
  if (reviewStats.pending)
    outstanding.push(`${reviewStats.pending}份待主智能体复核终审`);
  if (reviewStats.teacher_controlled)
    outstanding.push(
      `${reviewStats.teacher_controlled}份由教师接管，最新结果待回读`,
    );
  const unheld = rows.filter((x) => !teacherControlled(x));
  const unknown = unheld.filter((x) =>
    ["intent", "unknown"].includes(x.state.phase),
  ).length;
  const awaitingSave = unheld.filter((x) => x.state.phase === "scored").length;
  if (!advisory && unknown) outstanding.push(`${unknown}份保存状态待核验`);
  if (!advisory && awaitingSave)
    outstanding.push(`${awaitingSave}份待保存确认`);
  if (!rows.length) outstanding.push("尚无评分记录");
  const status =
    (advisory
      ? mode === "report-only"
        ? "审计报告（未回写平台） · "
        : "离线评分报告（未回写平台） · "
      : "") +
    (complete
      ? "已完成并核对授权范围"
      : "阶段报告：" + (outstanding.join("；") || "尚未满足本批次完成条件"));
  const stats = {
    recorded: rows.length,
    confirmed: confirmed.length,
    unconfirmed: rows.length - confirmed.length,
    expected: expected ?? null,
    coverage_checked: coverageChecked,
    complete,
    mode,
    default_rule_profiles: ruleProfiles,
    review: reviewStats,
    score_basis: advisory ? "local-advisory" : "confirmed-platform",
    analysis_papers: analysisRows.length,
    mean: scores.length ? round(sum / scores.length) : null,
  };
  const bins = [0, 0, 0, 0];
  for (const row of analysisRows)
    bins[
      Math.min(
        3,
        Math.floor((row.record.total_score / row.rubric.max_score) * 4),
      )
    ]++;
  const outDir = privateDir(path.join(store.dir, "reports")),
    assets = privateDir(path.join(outDir, "crops"));
  const reps = selectRepresentatives(
    rows,
    analysis.representatives,
    advisory,
    teacherControlled,
  ).map((s) => ({ ...s, image: cropEvidence(store, home, s, assets) }));
  const omittedRepresentatives = (analysis.representatives || [])
    .filter((s) => teacherControlled(byId.get(s.paper_id)))
    .map((s) => ({
      category: s.category,
      paper_id: s.paper_id,
      reason: "teacher-controlled-current-score-unverified",
    }));
  const audit = rows.map((x) => ({
    alias: x.alias,
    task_id: x.record.task_id,
    paper_id: x.record.paper_id,
    platform_status: x.state.phase,
    rubric_hash: x.record.rubric_hash,
    rubric_version: x.rubric.version,
    default_rules_hash: x.record.default_rules_hash || null,
    default_rules_file: x.record.default_rules_file || null,
    total_score: x.record.total_score,
    max_score: x.rubric.max_score,
    original_platform_score: Number.isFinite(x.snapshot.original_score)
      ? x.snapshot.original_score
      : null,
    awards: x.record.awards,
    deductions: x.record.deductions || [],
    applied_caps: x.record.applied_caps || [],
    summary: x.record.summary,
    review: x.record.review,
    confidence: x.record.confidence || null,
    final_adjudication: x.record.final_adjudication || null,
    teacher_controlled: teacherControlled(x),
    learning: x.record.learning || null,
    record_file: x.state.record_file,
  }));
  writePrivate(
    path.join(outDir, "逐卷评分理由.jsonl"),
    audit.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  writePrivate(
    path.join(outDir, "报告数据.json"),
    JSON.stringify(
      {
        stats,
        bins,
        students: audit,
        analysis,
        omitted_representatives: omittedRepresentatives,
      },
      null,
      2,
    ) + "\n",
  );
  const labels = {
    excellent: "优秀卷",
    typical: "典型卷",
    anomalous: "异常卷（复核/终审留痕）",
  };
  const representativeHtml = ["excellent", "typical", "anomalous"]
    .map((category) => {
      const s = reps.find((x) => x.category === category);
      if (!s)
        return `<article><h3>${labels[category]}</h3><p>本批次没有足够依据选择该类代表，不凑数。</p></article>`;
      const quote = s.row.record.awards.find((a) => a.evidence?.type === "text")
        ?.evidence.quote;
      return `<article><h3>${labels[category]} · ${s.row.alias}</h3><p>${esc(s.reason)}</p><p>${esc(scoreDisplay(s.row))} · ${phaseLabel(s.row.state.phase)}</p>${s.image ? `<img alt="已检查身份信息的作答局部" src="${s.image.data}">` : quote ? `<blockquote>${esc(quote.slice(0, 300))}</blockquote>` : "<p>原作答为图片；待选择并检查局部裁图后补充展示。</p>"}<p>${esc(s.row.record.summary)}</p></article>`;
    })
    .join("");
  const table = rows
    .map((x) => {
      const l = x.record.learning;
      return `<tr><td>${x.alias}</td><td>${esc(scoreDisplay(x))}<small>${teacherControlled(x) ? "教师已接管" : phaseLabel(x.state.phase)}</small></td><td>${esc(l?.judgment || x.record.summary)}</td><td>${esc(l?.action || "待根据本题证据补充具体练习")}<small>验收：${esc(l?.check || "待补充；不从一次作答推断整体能力")}</small></td></tr>`;
    })
    .join("");
  const pointGroups = new Map();
  for (const x of analysisRows) {
    const key = x.record.rubric_hash;
    if (!pointGroups.has(key))
      pointGroups.set(key, {
        rubric: x.rubric,
        n: 0,
        points: Object.fromEntries(x.rubric.points.map((p) => [p.id, 0])),
      });
    const group = pointGroups.get(key);
    group.n++;
    for (const [id, score] of Object.entries(x.record.point_scores))
      group.points[id] += score;
  }
  const pointHtml = [...pointGroups.values()]
    .map(
      (g) =>
        `<h3>细则 ${esc(g.rubric.version)} · ${g.n} 份${sourceLabel}</h3><ul>${g.rubric.points.map((p) => `<li>${esc(p.description)}：${Number(((g.points[p.id] / (p.max * g.n)) * 100).toFixed(1))}%（独立采分点达成率${g.rubric.groups?.length ? "，任选项封顶前口径" : ""}）</li>`).join("")}</ul>`,
    )
    .join("");
  const chart = bins
    .map(
      (n, i) =>
        `<div class="bar"><span>${["0–不足25%", "25–不足50%", "50–不足75%", "75–100%"][i]}</span><i style="width:${analysisRows.length ? (n / analysisRows.length) * 100 : 0}%"></i><b>${n}</b></div>`,
    )
    .join("");
  const insights = (analysis.insights || [])
    .slice(0, 3)
    .map(
      (i) =>
        `<li><strong>${esc(i.finding)}</strong><p>${esc(i.action)} 验收：${esc(i.check)}</p><small>依据：${i.evidence_papers.map((p) => byId.get(p).alias).join("、")}</small></li>`,
    )
    .join("");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>阅卷报告</title><style>body{font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif;color:#182b3b;background:#f4f6f7;margin:0}main{max-width:1120px;margin:32px auto;padding:32px;background:white}h1{font-size:32px}h2{margin-top:36px;border-top:1px solid #ccd9df;padding-top:20px}h3{font-size:18px}.scope,small{color:#526575}small{display:block}.status{padding:14px;background:#edf3f6;border-left:4px solid #315b73}.cards{display:flex;gap:18px;flex-wrap:wrap}.cards div{flex:1;padding:12px;background:#f1f5f7}.cards b{font-size:27px;display:block}table{width:100%;border-collapse:collapse}td,th{padding:12px 8px;text-align:left;vertical-align:top;border-bottom:1px solid #dbe2e6}td:first-child{white-space:nowrap}article{padding:16px;border:1px solid #ccd9df;margin:16px 0;break-inside:avoid}img{max-width:100%;max-height:450px;object-fit:contain}blockquote{background:#f6f7f8;padding:12px;margin:12px 0;white-space:pre-wrap}.bar{display:flex;align-items:center;gap:10px;margin:8px 0}.bar span{width:130px}.bar i{height:18px;background:#4c7d8d}.bar b{font-size:14px} @media(max-width:650px){main{margin:0;padding:18px}table{font-size:13px}td,th{padding:8px 4px}}@media print{body{background:white}main{margin:0;padding:0}h2{break-after:avoid}tr{break-inside:avoid}}</style><main><p class="scope">教师私用 · ${esc(intake.subject_label || subjectDisplayName(intake.subject, intake.stage) || subjectNames[intake.subject] || "本学科")} · ${esc(intake.stage === "primary" && intake.grade ? "小学" + intake.grade + "年级" : { primary: "小学", middle: "初中", high: "高中" }[intake.stage] || "")} · ${esc(store.rubric().qid)}</p><h1>阅卷报告</h1><p class="status">${status}</p><div class="cards"><div><b>${rows.length}</b>已记录</div><div><b>${advisory ? analysisRows.length : confirmed.length}</b>${sourceLabel}</div><div><b>${advisory ? rows.length - analysisRows.length : stats.unconfirmed}</b>${advisory ? "待完成" : "尚未确认"}</div><div><b>${displayNumber(stats.mean)}</b>${sourceLabel}均分</div></div><p>范围：${esc(intake.scope?.label || "本次授权任务")}。${coverageChecked ? "授权范围总量已核对。" : "授权范围总量尚未核对，不能据此宣称全部阅完。"}${advisory ? "此处均分为本地建议分，原平台分单列于审计数据，不能当作已回写成绩。" : "均分只含已确认记录；"}不同题目满分不得直接混合比较。本报告判断限于这些题目的可见证据，不推断品行或整体能力。</p>${ruleNotice ? `<p>${esc(ruleNotice)}</p>` : ""}<h2>得分分布与采分点</h2><p>按本题满分比例分组，不据此设定及格线。</p>${chart}${pointHtml}<h2>下一步讲评</h2>${insights ? `<ol>${insights}</ol>` : "<p>待智能体根据逐卷证据补充最值得讲的1—3项，避免凭均分猜测原因。</p>"}<h2>复核与终审</h2><p>待复核 ${reviewStats.pending} 份；主智能体已终审 ${reviewStats.finalized} 份，其中保留不确定性 ${reviewStats.remaining_uncertainty} 份；教师主动接管 ${reviewStats.teacher_controlled} 份。</p>${reviewStats.finalized ? "<p>相关答卷已由主智能体终审定分。教师可主动要求自行评分。</p>" : ""}<h2>代表卷</h2>${representativeHtml}<h2>逐卷学情与建议</h2><table><thead><tr><th>索引</th><th>分数/状态</th><th>本题判断</th><th>具体做法与验收</th></tr></thead><tbody>${table}</tbody></table><h2>核验边界</h2><p>每份试卷的采分点、零分理由、扣分依据、封顶规则、细则版本和平台状态保存在同目录“逐卷评分理由.jsonl”。复核卷和提交状态未明卷保留原状态。代表卷中的“异常”表示需核验事项，不是作弊结论。作答图片只展示经过身份检查的局部。</p></main></html>`;
  writePrivate(path.join(outDir, "阅卷报告.html"), html);
  writePrivate(
    path.join(outDir, "阅卷报告.md"),
    `# 阅卷报告\n\n${status}\n\n已记录 ${rows.length} 份；${sourceLabel} ${analysisRows.length} 份；${advisory ? "待完成" : "未确认"} ${rows.length - analysisRows.length} 份；${sourceLabel}均分 ${displayNumber(stats.mean)}。\n\n只评价本题表现。详见本目录 HTML 报告和逐卷评分理由。\n`,
  );
  return {
    directory: outDir,
    html: path.join(outDir, "阅卷报告.html"),
    stats,
    report_complete:
      rows.length > 0 &&
      Boolean(analysis.insights?.length) &&
      rows.every(
        (x) =>
          x.record.learning?.judgment &&
          x.record.learning?.action &&
          x.record.learning?.check,
      ) &&
      reps.every((s) => !s.row.snapshot.artifacts.length || s.image),
    crops: reps.filter((s) => s.image).map((s) => s.image.file),
    needs_images: reps
      .filter((s) => s.row.snapshot.artifacts.length && !s.image)
      .map((s) => ({ category: s.category, paper_id: s.row.record.paper_id })),
  };
}

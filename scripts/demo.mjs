#!/usr/bin/env node
/** Synthetic report preview only. Never connects to a grading platform. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Store, defaultHome, digest, fail, json, privateDir } from "./core.mjs";
import { prepareIntake } from "./intake.mjs";
import { generateReport } from "./reports.mjs";
import { queueContribution, saveReflection } from "./experience.mjs";
import { uploadQueue } from "./contribute.mjs";
import {
  reviewQueue,
  reviewPacket,
  saveReview,
  adjudicate,
} from "./reviews.mjs";

const root = new URL("../", import.meta.url);
const template = (n) =>
  JSON.parse(
    fs.readFileSync(new URL("templates/" + n + ".example.json", root), "utf8"),
  );
const run = fs.mkdtempSync(path.join(os.tmpdir(), "k12-synthetic-preview-"));
const store = new Store(run),
  home = privateDir(path.join(run, "isolated-experience"));
const rubric = template("rubric");
store.setRubric(rubric);
const intake = template("intake");
intake.mode = "offline";
intake.scope = {
  label: "3份合成答卷，仅演示报告，未连接平台",
  expected_papers: 3,
  platform_count_reconciled: true,
};
prepareIntake(store, intake);
const python = path.join(
  defaultHome(),
  "python",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
fail(fs.existsSync(python), "先运行bootstrap.py --repair");
const texts = [
  "F=ma，a=3 m/s²，v=at=12 m/s",
  "F=ma，a=3 m/s²，v=at=16 m/s",
  "F=ma，a=3 m/s²，末速度末位难辨",
];
const reps = [];
for (let i = 0; i < 3; i++) {
  const file = "artifacts/synthetic-" + i + ".png",
    target = path.join(
      privateDir(path.join(run, "artifacts")),
      path.basename(file),
    );
  const draw =
    "from PIL import Image,ImageDraw,ImageFont;import sys;im=Image.new('RGB',(760,220),'white');d=ImageDraw.Draw(im);f=ImageFont.truetype('DejaVuSans.ttf',24) if False else ImageFont.load_default(size=26);d.rectangle((0,0,760,39),fill='#e4d5d5');d.text((15,7),'SYNTHETIC HEADER - excluded from crop',font=ImageFont.load_default(size=20),fill='black');d.text((20,65),'F = ma;   a = 6 / 2 = 3 m/s^2',font=f,fill='#193448');d.text((20,120),sys.argv[2],font=f,fill='#193448');im.save(sys.argv[1])";
  const values = [
    "v = at = 3 x 4 = 12 m/s",
    "v = at = 3 x 4 = 16 m/s",
    "v = at = 1? m/s",
  ];
  fail(
    spawnSync(python, ["-c", draw, target, values[i]]).status === 0,
    "合成图创建失败",
  );
  const sha256 = createHash("sha256")
    .update(fs.readFileSync(target))
    .digest("hex");
  const s = {
    task_id: rubric.task_id,
    paper_id: "synthetic-paper-" + (i + 1),
    qid: rubric.qid,
    max_score: 4,
    step: 1,
    status: "pending",
    text: texts[i],
    answer_hash: digest(texts[i]),
    artifacts: [{ file, sha256, width: 760, height: 220 }],
    snapshot_file: "snapshots/" + i + ".json",
  };
  store.write(s.snapshot_file, s);
  const d = template("decision");
  d.paper_id = s.paper_id;
  d.answer_hash = s.answer_hash;
  d.rubric_hash = digest(rubric);
  d.awards.forEach((a) => {
    a.evidence = { type: "text", quote: texts[i] };
    a.reason = "对象、关系式和该采分点符合本题条件。";
  });
  if (i === 1) {
    d.awards[3].score = 0;
    d.awards[3].reason =
      "关系式正确，3×4的计算结果写成16；该结果点不成立，独立方法点保留。";
    d.summary = "对象、加速度和速度关系正确，末速度计算失误。";
    d.learning = {
      judgment: "能够衔接受力与运动，末步运算尚需核对。",
      action: "保留正确列式，重算末步，再做一道同结构计算题。",
      check: "用数量级与单位各核对一次，确认计算值与等式一致。",
      point_ids: ["velocity_method", "velocity_result"],
    };
  } else if (i === 2) {
    d.awards[2].score = 0;
    d.awards[3].score = 0;
    d.awards[2].reason = "速度关系处需核对原始笔迹，暂不判定此点。";
    d.awards[3].reason = "末位数字难辨，暂定分不能作为最终成绩。";
    d.confidence = {
      level: "low",
      reasons: ["末位难辨"],
      affected_points: ["velocity_method", "velocity_result"],
      score_range: [2, 4],
    };
    d.review = {
      required: true,
      reasons: ["末速度末位难辨，须核对原图后再判"],
    };
    d.status = "review";
    d.summary = "对象与加速度可核对，速度处仍需复核；不把难辨直接判成错误。";
    d.learning = {
      judgment: "目前只能确认对象和加速度，末速度尚不能作结论。",
      action: "由智能体重取或放大原图、独立复核，再由主智能体终审。",
      check: "先读清末位与单位，再按同一细则裁定速度两点。",
      point_ids: ["velocity_method", "velocity_result"],
    };
  }
  store.score(d, s);
  reps.push({
    category: ["excellent", "typical", "anomalous"][i],
    paper_id: s.paper_id,
    reason: [
      "展示从受力关系到运动关系的完整衔接。",
      "展示正确方法与运算结果分开评价。",
      "展示低置信度复核、主智能体终审与剩余不确定性留痕。",
    ][i],
    crop: { file, sha256, region: [0, 40, 760, 175], identity_checked: true },
  });
}
for (const pending of reviewQueue(store)) {
  const packet = reviewPacket(store, pending.record_file),
    snap = packet.snapshot;
  const independent = template("decision");
  independent.paper_id = snap.paper_id;
  independent.answer_hash = snap.answer_hash;
  independent.rubric_hash = digest(rubric);
  independent.awards.forEach((a) => {
    a.evidence = { type: "text", quote: snap.text };
    a.reason = "依据原题及原始作答独立核对。";
  });
  independent.awards[2].evidence = {
    type: "image",
    file: snap.artifacts[0].file,
    sha256: snap.artifacts[0].sha256,
    region: [0, 40, 760, 175],
    observation: "可见速度关系v=at，末速度末位仍难辨。",
  };
  independent.awards[3].score = 0;
  independent.awards[3].reason = "末速度结果点未能清晰确认，留待主智能体终审。";
  independent.confidence = {
    level: "low",
    reasons: ["末速度末位仍有不确定性"],
    affected_points: ["velocity_result"],
    score_range: [3, 4],
  };
  independent.review = {
    required: true,
    reasons: ["独立复核后仍需主智能体终审"],
  };
  independent.status = "review";
  independent.summary =
    "复核可确认速度关系，前三项可成立，末速度结果仍未完全核明。";
  independent.learning = {
    judgment: "受力与运动关系能衔接，结果表达尚不能完全核实。",
    action: "保留正确列式，重新写清结果并核对代入计算。",
    check: "检查清晰结果是否与过程及单位一致。",
    point_ids: ["velocity_method", "velocity_result"],
  };
  const checked = saveReview(store, {
    packet_file: packet.packet_file,
    checks: { original_evidence: true, question: true, rubric: true },
    summary: "独立重读原图并逐点对照，确认v=at，末位仍有疑点。",
    decision: independent,
  });
  adjudicate(store, {
    review_result_file: checked.review_result_file,
    decision: {
      ...independent,
      status: "ready",
      review: { required: false, reasons: [] },
    },
    final: {
      basis:
        "主智能体确认建模、加速度、速度关系三项均有卷面依据，终审3分；没有机械平均候选分。",
      remaining_uncertainty: "末速度末位仍不能完全核清，保留原图与不确定性。",
      alternatives_considered: [
        { score: 2, reason: "原图已显示v=at，不能漏记独立方法分。" },
        { score: 4, reason: "结果条件缺少足够清晰证据，未采用满分。" },
      ],
    },
  });
}
const finish = template("finish");
finish.analysis.representatives = reps;
finish.analysis.insights = [
  {
    finding: "方法与运算要分开反馈。",
    action: "先让学生标出受力式和运动式，再只订正运算末步，补一道同结构题。",
    check: "核对两种关系各自的对象、条件及计算结果。",
    evidence_papers: ["synthetic-paper-1", "synthetic-paper-2"],
  },
];
finish.reflection.worked = ["合成演示保留了正确方法分，并把难辨卷单列待复核。"];
finish.reflection.next_actions = [
  "正式使用先校准一组临界、替代解法和难辨锚点。",
];
const report = generateReport(store, defaultHome(), finish.analysis);
saveReflection(store, home, finish.reflection);
queueContribution(home, finish.contribution);
const upload = await uploadQueue(home);
console.log(
  JSON.stringify({ synthetic: true, run_dir: run, report, upload }, null, 2),
);

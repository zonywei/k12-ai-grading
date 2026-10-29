#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Store, atomic, defaultHome, fail, json } from "./core.mjs";
import { prepareIntake } from "./intake.mjs";
import { selectRules } from "./rules.mjs";
import {
  sharingStatus,
  recordSharingNotice,
  saveSharingChoice,
} from "./sharing.mjs";
import { generateReport } from "./reports.mjs";
import {
  personalLessons,
  queueContribution,
  saveReflection,
} from "./experience.mjs";
import { uploadQueue, validateUploadConfig } from "./contribute.mjs";
import {
  reviewQueue,
  reviewPacket,
  saveReview,
  adjudicate,
  teacherControl,
} from "./reviews.mjs";

const args = process.argv.slice(2);
const opt = (k, fallback) => {
  const i = args.indexOf("--" + k);
  return i < 0 ? fallback : args[i + 1];
};
const home = path.resolve(opt("home", defaultHome()));
const command = args[0];
const input = opt("input", "");
const data = input ? json(path.resolve(input)) : {};
let result;
const runStore = () =>
  new Store(path.resolve(opt("run-dir", path.join(home, "current"))));
if (command === "sharing-status") result = sharingStatus(home);
else if (command === "sharing-notice") result = recordSharingNotice(home, data);
else if (command === "sharing-choice") result = saveSharingChoice(home, data);
else if (command === "rules") result = selectRules(data);
else if (command === "review-queue") result = reviewQueue(runStore());
else if (command === "review-packet")
  result = reviewPacket(runStore(), data.record_file);
else if (command === "review-save") result = saveReview(runStore(), data);
else if (command === "review-finalize") result = adjudicate(runStore(), data);
else if (command === "review-teacher-control")
  result = teacherControl(runStore(), data);
else if (command === "intake")
  result = prepareIntake(
    new Store(path.resolve(opt("run-dir", path.join(home, "current")))),
    data,
  );
else if (command === "lessons") result = personalLessons(home, data);
else if (command === "finish") {
  const store = new Store(
    path.resolve(opt("run-dir", path.join(home, "current"))),
  );
  fail(
    data.reflection,
    "阅卷结束须主动复盘，由智能体生成reflection；不交给教师填表",
  );
  const report = generateReport(store, home, data.analysis);
  const reflection = saveReflection(store, home, data.reflection);
  let contribution;
  try {
    contribution = data.contribution
      ? queueContribution(home, data.contribution)
      : { queued: false, message: "本次没有通用改进，不凑共建内容" };
  } catch {
    contribution = {
      queued: false,
      message: "共建候选未通过检查，报告与本地经验已保留；候选仅留本地待修复",
    };
  }
  let upload;
  try {
    upload = await uploadQueue(home);
  } catch {
    upload = {
      enabled: false,
      message: "上传配置/队列待修复，报告与本地经验已保留",
    };
  }
  const n = report.stats.review?.finalized || 0;
  result = {
    report,
    reflection,
    contribution,
    upload,
    needs_primary_review: report.stats.review?.pending || 0,
    teacher_notice: n
      ? `本次${n}份曾有低置信度评分，已完成复核及主智能体终审定分；教师可主动要求自行评分。`
      : "",
  };
  store.write("finish.json", result);
} else if (command === "configure-upload") {
  if (data.enabled === true) {
    validateUploadConfig(data);
    fail(
      sharingStatus(home, data.endpoint).enabled,
      "须先说明此目的地并记录教师明确共享选择",
    );
  }
  atomic(path.join(home, "contributions", "config.json"), data);
  result = { configured: true, enabled: data.enabled === true };
} else if (command === "upload") result = await uploadQueue(home);
else {
  console.log(
    "智能体入口：sharing-status|sharing-notice|sharing-choice|rules|intake|lessons|finish|review-queue|review-packet|review-save|review-finalize|review-teacher-control|configure-upload|upload --input FILE [--run-dir PRIVATE_DIR] [--home PRIVATE_USER_DATA]。教师不处理JSON。",
  );
  process.exit(command ? 2 : 0);
}
console.log(JSON.stringify(result, null, 2));

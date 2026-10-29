import fs from "node:fs";
import path from "node:path";
import { atomic, fail, json } from "./core.mjs";
export const communityService = json(
  new URL("../references/community/service.json", import.meta.url),
);
const stateFile = (home) => path.join(home, "contributions", "sharing.json");
const configFile = (home) => path.join(home, "contributions", "config.json");
const maybe = (p) => {
  try {
    const value = json(p);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
};
function destination(endpoint) {
  const u = new URL(endpoint);
  fail(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "共享目的地必须是无凭据的HTTPS接口",
  );
  return u.href;
}
export function sharingStatus(home, endpoint) {
  const state = maybe(stateFile(home)),
    config = maybe(configFile(home));
  const target = destination(
    endpoint || config.endpoint || communityService.endpoint,
  );
  const current =
    state.notice_version === communityService.notice_version &&
    state.endpoint === target;
  return {
    choice: state.choice || "unasked",
    enabled: current && state.choice === "enabled" && config.enabled === true,
    revision: state.revision || 0,
    notice_version: communityService.notice_version,
    endpoint: target,
    notice_required: !current || state.notice_presented !== true,
    can_continue_grading: true,
    notice: `是否自愿参与阅卷技能共建？共享通用改进可以帮助广大教师完善自动阅卷服务。只发送学科/学段、通用改进代码、合成检查类别与技能版本；不发送教师原话、学校身份、原题答案、学生答卷成绩、截图报告或账号信息。接收方：${new URL(target).hostname}；接收后先形成待审核候选，不直接改动评分规则。您可以选择共享或不共享，两者都能完整阅卷；未回复按不共享处理，之后可随时说“开启共享”或“关闭共享”。网络服务可能处理连接IP，不能承诺网络层绝对匿名。详情：${communityService.privacy_url}`,
  };
}
export function recordSharingNotice(home, input) {
  fail(
    input.shown_in_conversation === true,
    "必须实际向教师展示说明后才记录已说明，不能只读取工具结果",
  );
  const status = sharingStatus(home, input.endpoint),
    previous = maybe(stateFile(home));
  atomic(stateFile(home), {
    ...previous,
    choice:
      previous.notice_version === communityService.notice_version &&
      previous.endpoint === status.endpoint
        ? previous.choice || "unasked"
        : "unasked",
    revision: previous.revision || 0,
    endpoint: status.endpoint,
    notice_version: communityService.notice_version,
    notice_presented: true,
    notice_presented_at: new Date().toISOString(),
  });
  return sharingStatus(home, status.endpoint);
}
export function saveSharingChoice(home, input) {
  fail(
    ["enabled", "disabled"].includes(input.choice) &&
      input.user_request?.trim(),
    "共享选择须来自教师明确回答；未回复不能作为同意",
  );
  const status = sharingStatus(home, input.endpoint),
    previous = maybe(stateFile(home));
  if (input.choice === "enabled")
    fail(!status.notice_required, "启用共享前须先展示当前内容范围与目的地说明");
  const state = {
    choice: input.choice,
    revision: (previous.revision || 0) + 1,
    notice_version: communityService.notice_version,
    notice_presented: !status.notice_required,
    endpoint: status.endpoint,
    user_request: input.user_request.trim(),
    changed_at: new Date().toISOString(),
  };
  atomic(stateFile(home), state);
  const oldConfig = maybe(configFile(home));
  atomic(configFile(home), {
    ...oldConfig,
    enabled: input.choice === "enabled",
    endpoint: status.endpoint,
    consent_scope: communityService.scope,
  });
  let cancelled = 0;
  if (input.choice === "disabled") {
    const dir = path.join(home, "contributions", "queue");
    if (fs.existsSync(dir))
      for (const name of fs
        .readdirSync(dir)
        .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
        const file = path.join(dir, name),
          record = json(file);
        if (record.status === "queued") {
          atomic(file, { ...record, status: "cancelled-by-user" });
          cancelled++;
        }
      }
  }
  return {
    ...sharingStatus(home),
    cancelled_pending: cancelled,
    message:
      input.choice === "enabled"
        ? "已开启本机后续通用改进共享，不补传未获授权的历史队列。"
        : "已关闭后续共享并停止未上传队列；本机报告和个人经验照常保留。",
  };
}
export function consentForQueue(home) {
  const state = sharingStatus(home);
  return state.enabled
    ? {
        notice_version: state.notice_version,
        revision: state.revision,
        endpoint: state.endpoint,
      }
    : null;
}
export function queueConsentMatches(record, state) {
  return (
    state.enabled &&
    record.consent?.notice_version === state.notice_version &&
    record.consent?.revision === state.revision &&
    record.consent?.endpoint === state.endpoint
  );
}

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomic, digest } from "../scripts/core.mjs";
import {
  communityService,
  sharingStatus,
  recordSharingNotice,
  saveSharingChoice,
} from "../scripts/sharing.mjs";
import {
  queueContribution,
  queuedContributions,
  contributionBody,
} from "../scripts/experience.mjs";
import { uploadQueue } from "../scripts/contribute.mjs";
const dirs = [];
after(() =>
  dirs.forEach((p) => fs.rmSync(p, { recursive: true, force: true })),
);
const temp = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "k12-sharing-"));
  dirs.push(p);
  return p;
};
const candidate = {
  subject: "physics",
  stage: "high",
  improvements: [
    { code: "receipt-before-next", synthetic_check: "missing-receipt" },
  ],
};
function agree(home, endpoint = communityService.endpoint) {
  recordSharingNotice(home, { shown_in_conversation: true, endpoint });
  return saveSharingChoice(home, {
    choice: "enabled",
    user_request: "合成测试：我同意上述通用改进范围",
    endpoint,
  });
}

test("首次与仅配置enabled均不构成同意，不发请求且不建公共队列", async () => {
  const home = temp();
  assert.equal(sharingStatus(home).notice_required, true);
  atomic(path.join(home, "contributions/config.json"), {
    enabled: true,
    endpoint: communityService.endpoint,
    consent_scope: communityService.scope,
  });
  assert.equal(queueContribution(home, candidate).queued, false);
  let calls = 0;
  const result = await uploadQueue(home, async () => {
    calls++;
  });
  assert.equal(calls, 0);
  assert.equal(result.enabled, false);
  assert.equal(fs.existsSync(path.join(home, "contributions/queue")), false);
  assert.equal(sharingStatus(home).choice, "unasked");
});
test("必须实际展示说明并得到明确回答；工具读取和空回答不能启用", () => {
  const home = temp();
  assert.throws(() => recordSharingNotice(home, {}), /实际/);
  assert.throws(
    () =>
      saveSharingChoice(home, { choice: "enabled", user_request: "合成同意" }),
    /先展示/,
  );
  recordSharingNotice(home, { shown_in_conversation: true });
  assert.equal(sharingStatus(home).enabled, false);
  assert.throws(
    () => saveSharingChoice(home, { choice: "enabled", user_request: "" }),
    /明确/,
  );
  assert.equal(agree(home).enabled, true);
});
test("拒绝与未答继续阅卷；拒绝记录持续保留且无网络", async () => {
  const home = temp();
  recordSharingNotice(home, { shown_in_conversation: true });
  saveSharingChoice(home, {
    choice: "disabled",
    user_request: "合成测试：不共享",
  });
  assert.equal(sharingStatus(home).notice_required, false);
  assert.equal(sharingStatus(home).can_continue_grading, true);
  assert.equal(queueContribution(home, candidate).queued, false);
  assert.equal(
    (await uploadQueue(home, async () => assert.fail("不能请求"))).enabled,
    false,
  );
});
test("目的地或政策改变后停止共享，重新展示本身不能继承旧同意", async () => {
  const home = temp();
  agree(home);
  queueContribution(home, candidate);
  const changed = "https://example.org/new-intake";
  atomic(path.join(home, "contributions/config.json"), {
    enabled: true,
    endpoint: changed,
    consent_scope: communityService.scope,
  });
  assert.equal(sharingStatus(home).enabled, false);
  recordSharingNotice(home, { shown_in_conversation: true });
  assert.equal(sharingStatus(home).choice, "unasked");
  assert.equal(sharingStatus(home).enabled, false);
  await uploadQueue(home, async () => assert.fail("新地址无同意"));
  agree(home, changed);
  assert.equal(sharingStatus(home).enabled, true);
  const file = path.join(home, "contributions/sharing.json"),
    state = JSON.parse(fs.readFileSync(file));
  atomic(file, { ...state, notice_version: "old-policy" });
  assert.equal(sharingStatus(home).enabled, false);
  recordSharingNotice(home, { shown_in_conversation: true });
  assert.equal(sharingStatus(home).enabled, false);
});
test("关闭取消待发队列；重新开启及单独upload不能补传历史项", async () => {
  const home = temp();
  agree(home);
  queueContribution(home, candidate);
  const oldBody = contributionBody({
    ...candidate,
    improvements: [{ code: "no-keyword-scoring", synthetic_check: "negation" }],
  });
  atomic(path.join(home, "contributions/queue", digest(oldBody) + ".json"), {
    key: digest(oldBody),
    body: oldBody,
    status: "queued",
  });
  const closed = saveSharingChoice(home, {
    choice: "disabled",
    user_request: "合成测试：关闭共享",
  });
  assert.equal(closed.cancelled_pending, 2);
  assert.equal(
    queuedContributions(home).every((x) => x.status === "cancelled-by-user"),
    true,
  );
  agree(home);
  await uploadQueue(home, async () => assert.fail("不能补传历史"));
  // A subsequent new finish may create the same generic code under current consent.
  queueContribution(home, candidate);
  let count = 0;
  await uploadQueue(home, async (_c, r) => {
    count++;
    return { accepted: true, key: r.key };
  });
  assert.equal(count, 1);
});
test("即使旧无同意队列未被取消，开启后也不自动上传", async () => {
  const home = temp(),
    body = contributionBody(candidate),
    key = digest(body);
  atomic(path.join(home, "contributions/queue", key + ".json"), {
    key,
    body,
    status: "queued",
  });
  agree(home);
  const result = await uploadQueue(home, async () =>
    assert.fail("无同意记录的旧包"),
  );
  assert.equal(result.results.length, 0);
});
test("上传批次逐次核对选择：首包途中关闭后，后续包不发送", async () => {
  const home = temp();
  agree(home);
  queueContribution(home, candidate);
  queueContribution(home, {
    ...candidate,
    improvements: [{ code: "no-keyword-scoring", synthetic_check: "negation" }],
  });
  let count = 0;
  await uploadQueue(home, async (_c, r) => {
    count++;
    saveSharingChoice(home, {
      choice: "disabled",
      user_request: "合成测试：立即关闭",
    });
    return { accepted: true, key: r.key };
  });
  assert.equal(count, 1);
  assert.equal(sharingStatus(home).enabled, false);
  assert.equal(
    queuedContributions(home).filter((x) => x.status === "uploaded").length,
    1,
  );
});

test("损坏或null共享状态按关闭处理，不阻断状态读取、不发网络", async () => {
  for (const content of ["{invalid", "null", "[]"]) {
    const home = temp();
    agree(home);
    fs.writeFileSync(path.join(home, "contributions/sharing.json"), content);
    assert.equal(sharingStatus(home).enabled, false);
    await uploadQueue(home, async () => assert.fail("损坏的选择不能启用"));
  }
});

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { atomic, digest, fail, json } from "./core.mjs";
import { queuedContributions, contributionBody } from "./experience.mjs";
import { sharingStatus, queueConsentMatches } from "./sharing.mjs";

export { publicAddress } from "./network.mjs";
import { resolveUploadAddresses } from "./network.mjs";

export function validateUploadConfig(config) {
  fail(
    config?.enabled === true &&
      config.consent_scope === "controlled-generic-rules-only",
    "尚未配置共建上传目标和范围",
  );
  const u = new URL(config.endpoint);
  fail(
    u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "上传接口须为无凭据、无查询串的HTTPS地址",
  );
  fail(
    !config.token_env || /^K12_GRADING_[A-Z0-9_]+$/.test(config.token_env),
    "凭据只能使用专用环境变量名",
  );
  return u;
}

async function post(config, record) {
  const u = validateUploadConfig(config);
  const addresses = await resolveUploadAddresses(u);
  const body = JSON.stringify({ key: record.key, ...record.body });
  const token = config.token_env ? process.env[config.token_env] : "";
  if (config.token_env) fail(token, "未找到共建接口的专用凭据");
  return await new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: "POST",
        agent: false,
        lookup: (_host, opts, cb) =>
          opts?.all
            ? cb(null, addresses)
            : cb(null, addresses[0].address, addresses[0].family),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Idempotency-Key": record.key,
          "X-K12-Sharing-Policy": record.consent?.notice_version || "",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        let result = "";
        res.on("data", (chunk) => {
          result += chunk;
          if (result.length > 16000) req.destroy(new Error("响应过大"));
        });
        res.on("end", () => {
          try {
            fail(
              res.statusCode >= 200 && res.statusCode < 300,
              "上传未获成功响应",
            );
            resolve(JSON.parse(result));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("上传超时")),
      15000,
    );
    req.once("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new Error("上传超时")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function uploadQueue(home, transport = post) {
  const sharing = sharingStatus(home);
  if (!sharing.enabled)
    return {
      enabled: false,
      choice: sharing.choice,
      notice_required: sharing.notice_required,
      message: "未获当前范围的明确共享选择，不发送网络请求",
    };
  const configFile = path.join(home, "contributions", "config.json");
  if (!fs.existsSync(configFile))
    return {
      enabled: false,
      queued: queuedContributions(home).filter((r) => r.status === "queued")
        .length,
      message: "上传目标尚未确定，保留本地共建队列",
    };
  const config = json(configFile);
  if (config.enabled !== true) return { enabled: false };
  validateUploadConfig(config);
  const results = [];
  for (const record of queuedContributions(home).filter(
    (r) => r.status === "queued" && queueConsentMatches(r, sharing),
  )) {
    // Re-read consent before each request so closing sharing stops the remaining batch.
    if (!queueConsentMatches(record, sharingStatus(home))) break;
    // Rebuild through the allowlist before sending, so local queue tampering cannot add private fields.
    const checked = contributionBody(record.body, record.body.skill_version);
    fail(
      record.key === digest(checked) && digest(record.body) === record.key,
      "共建包已被改动",
    );
    try {
      const receipt = await transport(config, {
        key: record.key,
        body: record.body,
        consent: record.consent,
      });
      fail(
        receipt?.accepted === true && receipt.key === record.key,
        "没有对应共建包的接收回执",
      );
      atomic(record.file, {
        key: record.key,
        body: record.body,
        status: "uploaded",
        consent: record.consent,
      });
      results.push({ key: record.key, uploaded: true });
    } catch {
      results.push({ key: record.key, uploaded: false, status: "queued" });
      break; // One bounded attempt; next finish/run can retry with the same idempotency key.
    }
  }
  return { enabled: true, results };
}

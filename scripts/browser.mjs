import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fail, digest, privateDir, commit, recover } from "./core.mjs";
const hashBytes = (b) => createHash("sha256").update(b).digest("hex");
export class BrowserAdapter {
  constructor(store, page, allowed) {
    this.store = store;
    this.page = page;
    this.allowed = allowed;
    this.responses = [];
    this.networkEnabled = false;
    page.on("response", (response) => {
      if (!this.networkEnabled) return;
      try {
        this.checkUrl(response.url());
        const u = new URL(response.url());
        if (
          !/\/(?:.*\/)?(?:login|auth|token|password|currentUser|teacherAccount)/i.test(
            u.pathname,
          ) &&
          ["xhr", "fetch"].includes(response.request().resourceType())
        ) {
          this.responses.push(response);
          if (this.responses.length > 100) this.responses.shift();
        }
      } catch {}
    });
  }
  async network() {
    const out = [];
    for (let i = 0; i < this.responses.length; i++) {
      const r = this.responses[i],
        u = new URL(r.url());
      out.push({
        index: i,
        method: r.request().method(),
        origin: u.origin,
        path: u.pathname,
        query_keys: [...u.searchParams.keys()].filter(
          (k) => !/(token|cookie|password|secret)/i.test(k),
        ),
        status: r.status(),
      });
    }
    return out;
  }
  async responseData(data) {
    fail(
      Number.isInteger(data.index) && this.responses[data.index],
      "请求索引已失效",
    );
    const response = this.responses[data.index];
    fail(
      Array.isArray(data.paths) && data.paths.length > 0,
      "必须指定需要的JSON字段路径",
    );
    const body = await response.json();
    const clean = (v) => {
      if (Array.isArray(v)) return v.map(clean);
      if (v && typeof v === "object")
        return Object.fromEntries(
          Object.entries(v)
            .filter(
              ([k]) =>
                !/(token|cookie|password|secret|authorization|session)/i.test(
                  k,
                ),
            )
            .map(([k, x]) => [k, clean(x)]),
        );
      return v;
    };
    const result = {};
    for (const p of data.paths) {
      fail(
        typeof p === "string" &&
          !/(token|cookie|password|secret|authorization|session)/i.test(p),
        "不得读取凭据字段",
      );
      result[p] = clean(p.split(".").reduce((v, k) => v?.[k], body));
    }
    return result;
  }
  checkUrl(url) {
    const u = new URL(url);
    fail(
      (!this.allowed &&
        u.protocol === "https:" &&
        /(^|\.)zhixue\.com$/i.test(u.hostname)) ||
        (this.allowed && u.origin === this.allowed),
      "仅允许本次教师指定的平台源；跨源需核实来源后单独适配",
    );
    return url;
  }
  async selected(spec) {
    fail(spec?.selector, "缺少定位配置");
    const frame = spec.frame_url
      ? this.page.frames().find((f) => f.url().startsWith(spec.frame_url))
      : this.page.mainFrame();
    fail(frame, "未找到目标iframe");
    const loc = frame.locator(spec.selector);
    fail((await loc.count()) === 1, "定位必须唯一：" + spec.selector);
    return loc;
  }
  async field(spec) {
    if (spec?.constant !== undefined) {
      fail(spec.observed?.trim(), "常量缺少当前页面观察依据");
      return String(spec.constant);
    }
    if (spec?.url_param) {
      const v = new URL(this.page.url()).searchParams.get(spec.url_param);
      fail(v, "URL缺少所需标识");
      return v;
    }
    const loc = await this.selected(spec);
    if (spec.attr) return String((await loc.getAttribute(spec.attr)) || "");
    return (await loc.innerText()).trim();
  }
  config() {
    return this.store.read("adapter.json");
  }
  async read(capture = true) {
    this.checkUrl(this.page.url());
    const cfg = this.config();
    const r = this.store.rubric();
    const values = {};
    for (const key of [
      "task_id",
      "paper_id",
      "qid",
      "max_score",
      "step",
      "status",
    ])
      values[key] = await this.field(cfg[key]);
    fail(!cfg.paper_id.constant, "答卷ID不能是常量");
    fail(values.task_id && values.paper_id, "缺少稳定任务/答卷标识");
    const loc = await this.selected(cfg.answer);
    fail(await loc.isVisible(), "作答区不可见");
    const text = (await loc.innerText()).trim();
    const hasMedia =
      (await loc.locator("img,canvas,svg").count()) +
      Number(await loc.evaluate((e) => e.matches("img,canvas,svg")));
    if (hasMedia)
      fail(
        await loc.evaluate((e) => {
          const imgs = [
            ...(e.matches("img") ? [e] : []),
            ...e.querySelectorAll("img"),
          ];
          return imgs.every((i) => i.complete && i.naturalWidth > 0);
        }),
        "原图尚未加载，不能判为空白",
      );
    const artifacts = [];
    let mediaHash = "";
    if (hasMedia) {
      const bytes = await loc.screenshot({
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
      mediaHash = hashBytes(bytes);
      if (capture) {
        const file = "artifacts/" + randomUUID() + ".png";
        privateDir(path.join(this.store.dir, "artifacts"));
        fs.writeFileSync(path.join(this.store.dir, file), bytes, {
          mode: 0o600,
        });
        const size = await loc.boundingBox();
        artifacts.push({
          file,
          sha256: mediaHash,
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
        });
      }
    }
    fail(text || hasMedia, "未加载作答；不当作空白评分");
    const answer_hash = digest({
      task_id: values.task_id,
      paper_id: values.paper_id,
      text,
      mediaHash,
    });
    const result = {
      ...values,
      max_score: Number(values.max_score),
      step: Number(values.step),
      status: values.status === cfg.pending_value ? "pending" : "not-pending",
      text,
      answer_hash,
      artifacts,
    };
    fail(
      result.task_id === r.task_id && result.qid === r.qid,
      "当前任务或题号与原题不一致",
    );
    fail(
      result.max_score === r.max_score && result.step === r.step,
      "平台分值与规则不一致",
    );
    if (capture) {
      result.snapshot_file = "snapshots/" + randomUUID() + ".json";
      this.store.write(result.snapshot_file, result);
      this.store.write("current.json", result);
    }
    return result;
  }
  async preflight() {
    const c = this.config();
    fail(
      c.submit_semantics === "save-current" && c.observed_evidence?.trim(),
      "未观察确认当前题提交语义",
    );
    fail(
      c.submit?.selector && !c.next_button,
      "提交与下一份必须分离，不支持next回退",
    );
    await this.selected(c.score_input);
    await this.selected(c.submit);
    fail(
      c.receipt?.kind === "backend" && c.receipt.observed_evidence?.trim(),
      "缺少观察验证过的只读保存回执接口",
    );
    fail(
      c.receipt.url_template.includes("{paper_id}"),
      "回读必须按稳定答卷ID查分",
    );
    fail(
      c.receipt.saved_value !== undefined &&
        c.receipt.saved_value !== null &&
        Object.values(c.receipt.fields || {}).length === 4 &&
        ["task_id", "paper_id", "score", "saved"].every(
          (k) => typeof c.receipt.fields[k] === "string" && c.receipt.fields[k],
        ),
      "回执字段或已保存状态缺失",
    );
    this.checkUrl(
      c.receipt.url_template
        .replaceAll("{paper_id}", "p")
        .replaceAll("{task_id}", "t"),
    );
  }
  async submit(score, d) {
    const c = this.config(),
      current = await this.read(false);
    fail(
      current.paper_id === d.paper_id &&
        current.answer_hash === d.answer_hash &&
        current.task_id === d.task_id,
      "填分前答卷变化",
    );
    const input = await this.selected(c.score_input);
    await input.fill(String(score));
    fail(Number(await input.inputValue()) === score, "分数未填入");
    const again = await this.read(false);
    fail(
      again.paper_id === d.paper_id &&
        again.answer_hash === d.answer_hash &&
        again.status === "pending",
      "点击前答卷变化",
    );
    await (await this.selected(c.submit)).click();
  }
  async receipt(d) {
    let last;
    for (const delay of [0, 200, 500]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        return await this.receiptOnce(d);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }
  async receiptOnce(d) {
    const cfg = this.config().receipt;
    fail(cfg?.kind === "backend", "未配置已保存回读");
    const url = cfg.url_template
      .replaceAll("{paper_id}", encodeURIComponent(d.paper_id))
      .replaceAll("{task_id}", encodeURIComponent(d.task_id));
    this.checkUrl(url);
    const value = await this.page.evaluate(
      async ({ url, fields }) => {
        const response = await fetch(url, {
          credentials: "include",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("readback unavailable");
        const body = await response.json();
        const get = (key) =>
          String(fields[key] || "")
            .split(".")
            .reduce((a, k) => a?.[k], body);
        return {
          task_id: get("task_id"),
          paper_id: get("paper_id"),
          score: get("score"),
          saved: get("saved"),
        };
      },
      { url, fields: cfg.fields },
    );
    fail(
      cfg.saved_value !== undefined && value.saved === cfg.saved_value,
      "后台记录尚未保存",
    );
    fail(
      value.task_id !== undefined &&
        value.task_id !== null &&
        value.paper_id !== undefined &&
        value.paper_id !== null,
      "回读缺少稳定标识",
    );
    fail(
      (typeof value.score === "number" && Number.isFinite(value.score)) ||
        (typeof value.score === "string" &&
          /^\d+(?:\.\d+)?$/.test(value.score)),
      "回读分数缺失或非法",
    );
    return {
      task_id: String(value.task_id),
      paper_id: String(value.paper_id),
      score: Number(value.score),
      saved: true,
      source: "backend",
    };
  }
}
export async function observe(page, store) {
  const frames = [];
  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(() => {
        const visible = (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const css = (e) => {
          if (e.id) return "#" + CSS.escape(e.id);
          const parts = [];
          while (e && e.tagName !== "HTML" && parts.length < 7) {
            const p = e.parentElement;
            parts.unshift(
              e.tagName.toLowerCase() +
                ":nth-of-type(" +
                (p
                  ? [...p.children]
                      .filter((n) => n.tagName === e.tagName)
                      .indexOf(e) + 1
                  : 1) +
                ")",
            );
            e = p;
          }
          return parts.join(" > ");
        };
        return {
          text: document.body.innerText.slice(0, 16000),
          elements: [
            ...document.querySelectorAll(
              'input,textarea,button,a,[role="button"],img,canvas,[data-paper-id],[data-task-id]',
            ),
          ]
            .filter(visible)
            .slice(0, 150)
            .map((e) => ({
              selector: css(e),
              tag: e.tagName,
              type: e.getAttribute("type"),
              label: (
                e.innerText ||
                e.getAttribute("aria-label") ||
                e.getAttribute("placeholder") ||
                ""
              ).slice(0, 100),
              paper_id: e.getAttribute("data-paper-id"),
              task_id: e.getAttribute("data-task-id"),
            })),
        };
      });
      const u = new URL(
        frame.url() === "about:blank" ? "https://www.zhixue.com/" : frame.url(),
      );
      frames.push({ frame_url: u.origin + u.pathname, ...data });
    } catch {}
  }
  privateDir(path.join(store.dir, "artifacts"));
  const file = "artifacts/observe-" + randomUUID() + ".png";
  await page.screenshot({ path: path.join(store.dir, file), scale: "css" });
  if (process.platform !== "win32")
    fs.chmodSync(path.join(store.dir, file), 0o600);
  return { frames, screenshot: file };
}
export async function dispatch(store, adapter, payload) {
  const { command, data = {} } = payload;
  const page = adapter.page;
  if (command === "status")
    return {
      open: !page.isClosed(),
      platform: new URL(page.url()).hostname,
      summary: store.summary(),
    };
  if (command === "observe") return observe(page, store);
  if (command === "network") {
    if (data.enabled !== undefined) {
      adapter.networkEnabled = data.enabled === true;
      adapter.responses = [];
    }
    return adapter.network();
  }
  if (command === "response") return adapter.responseData(data);
  if (command === "configure") {
    fail(data.observed_evidence?.trim(), "配置须记录当前页面观察依据");
    store.write("adapter.json", data);
    return { configured: true };
  }
  if (command === "navigate") {
    adapter.checkUrl(data.url);
    await page.goto(data.url, { waitUntil: "domcontentloaded" });
    return { navigated: true };
  }
  if (command === "click") {
    fail(data.intent === "navigate", "通用click仅用于导航");
    const loc = await adapter.selected(data);
    const label = (await loc.innerText()).trim();
    fail(
      label && !/提交|保存|下一份|下一卷|确认评分/.test(label),
      "评分操作须走commit闭环",
    );
    await loc.click();
    return { clicked: true };
  }
  if (command === "read") return adapter.read(true);
  if (command === "rubric") return store.setRubric(data);
  if (command === "authorize") {
    store.authorize(data);
    return { authorized: true };
  }
  if (command === "score") {
    const snapshot = store.read(data.snapshot_file || "current.json");
    return store.score(data.decision, snapshot);
  }
  if (command === "commit") return commit(store, adapter, data.record_file);
  if (command === "recover") return recover(store, adapter);
  if (command === "summary") return store.summary();
  if (command === "stop") return { stop: true };
  throw new Error("未知命令");
}

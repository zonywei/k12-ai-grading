#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store, privateDir, atomic, json, defaultHome, fail } from "./core.mjs";
import { BrowserAdapter, dispatch } from "./browser.mjs";
const argv = process.argv.slice(2),
  command = argv[0] || "help";
const option = (k, fallback) => {
  const i = argv.indexOf("--" + k);
  return i < 0 ? fallback : argv[i + 1];
};
const runDir = path.resolve(
    option("run-dir", path.join(defaultHome(), "current")),
  ),
  nap = (ms) => new Promise((r) => setTimeout(r, ms));
if (command === "help") {
  console.log(
    "智能体入口：node scripts/zx.mjs serve --run-dir PRIVATE_DIR [--channel chrome]\n复用会话：observe|read|summary|recover|stop --run-dir PRIVATE_DIR\nJSON输入：rubric|configure|authorize|score|commit|navigate|click --input FILE\n教师只登录并提供原题、答案，不需要命令。",
  );
  process.exit(0);
}
if (command === "serve" || command === "open") {
  // The teacher's launch request is enough: inspect/repair privately before opening a session.
  if (!option("test-origin", "")) {
    const setupFile = fileURLToPath(new URL("./bootstrap.py", import.meta.url));
    const cachedPython = path.join(
      defaultHome(),
      "python",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const interpreter = option(
      "python",
      fs.existsSync(cachedPython)
        ? cachedPython
        : process.platform === "win32"
          ? "python"
          : "python3",
    );
    const setup = spawnSync(interpreter, [setupFile, "--repair"], {
      cwd: path.dirname(path.dirname(setupFile)),
      encoding: "utf8",
      timeout: 360000,
    });
    fail(
      setup.status === 0,
      "环境自动配置未完成；由智能体检查bootstrap结果并修复，教师无需处理依赖",
    );
    const state = JSON.parse(setup.stdout);
    fail(state.ready === true, "阅卷环境尚未就绪");
    if (state.teacher_notice)
      console.log(
        JSON.stringify({ environment: true, message: state.teacher_notice }),
      );
  }
  const store = new Store(runDir),
    inbox = privateDir(path.join(runDir, "commands")),
    outbox = privateDir(path.join(runDir, "responses")),
    lock = path.join(runDir, "service.lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    throw new Error(
      "此运行目录已有服务或中断锁；先status核对进程，禁止同时启动。",
    );
  }
  for (const name of fs
    .readdirSync(inbox)
    .filter((n) => /^[a-f0-9-]+\.json$/.test(n))) {
    atomic(path.join(outbox, name), {
      ok: false,
      error: "服务重启：旧请求未执行。先recover再决定下一步。",
    });
    fs.renameSync(
      path.join(inbox, name),
      path.join(privateDir(path.join(runDir, "interrupted-commands")), name),
    );
  }
  let context;
  const close = async () => {
    if (context) await context.close().catch(() => {});
    fs.rmSync(lock, { force: true });
  };
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => close().finally(() => process.exit(0)));
  try {
    const { chromium } = await import("playwright");
    const testOrigin = option("test-origin", "");
    if (testOrigin)
      fail(
        /^http:\/\/127\.0\.0\.1:\d+$/.test(testOrigin),
        "测试源仅支持本机127.0.0.1",
      );
    const envState = path.join(defaultHome(), "environment.json");
    const configuredChannel = fs.existsSync(envState)
      ? json(envState).browser_channel
      : "chrome";
    context = await chromium.launchPersistentContext(
      privateDir(path.join(runDir, "profile")),
      {
        headless: argv.includes("--headless"),
        channel: option("channel", configuredChannel) || undefined,
        viewport: { width: 1360, height: 900 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      },
    );
    let page = context.pages()[0] || (await context.newPage());
    const url = option("url", testOrigin || "https://www.zhixue.com/");
    const origin = new URL(url).origin;
    fail(
      new URL(url).protocol === "https:" || origin === testOrigin,
      "真实平台必须使用HTTPS",
    );
    const allowedOrigin =
      testOrigin ||
      (/^https:\/\/[^/]*zhixue\.com(?=\/|$)/i.test(url) ? undefined : origin);
    let adapter = new BrowserAdapter(store, page, allowedOrigin);
    adapter.checkUrl(url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    console.log(
      JSON.stringify({
        ready: true,
        message: "浏览器已打开；请教师在浏览器登录。",
        run_dir: runDir,
      }),
    );
    let stopped = false;
    while (!stopped && !page.isClosed()) {
      for (const name of fs
        .readdirSync(inbox)
        .filter((n) => /^[a-f0-9-]+\.json$/.test(n))
        .sort()) {
        const file = path.join(inbox, name);
        let response;
        try {
          fail(fs.statSync(file).size < 2_000_000, "请求过大");
          const payload = json(file);
          let result;
          if (payload.command === "tabs") {
            result = context.pages().map((p, index) => ({
              index,
              title: "浏览器页面",
              url:
                new URL(
                  p.url() === "about:blank"
                    ? "https://www.zhixue.com/"
                    : p.url(),
                ).origin +
                new URL(
                  p.url() === "about:blank"
                    ? "https://www.zhixue.com/"
                    : p.url(),
                ).pathname,
            }));
          } else if (payload.command === "select") {
            const target = context.pages()[payload.data?.index];
            fail(target && !target.isClosed(), "标签页不存在");
            adapter.checkUrl(target.url());
            page = target;
            adapter = new BrowserAdapter(store, page, allowedOrigin);
            await page.bringToFront();
            result = { selected: true };
          } else result = await dispatch(store, adapter, payload);
          response = { ok: !result?.unknown, result };
          stopped = Boolean(result?.stop);
        } catch (e) {
          response = { ok: false, error: e.message };
        }
        atomic(path.join(outbox, name), response);
        fs.rmSync(file, { force: true });
        if (stopped) break;
      }
      if (!stopped) await nap(150);
    }
  } finally {
    await close();
  }
} else {
  const lock = path.join(runDir, "service.lock");
  fail(fs.existsSync(lock), "服务未运行；由智能体先启动serve");
  const pid = Number(fs.readFileSync(lock, "utf8"));
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(
      "服务已退出，锁保留；确认无运行进程后仅移除service.lock并重启，先recover。",
    );
  }
  const input = option("input", ""),
    data = input ? json(path.resolve(input)) : {},
    id = randomUUID() + ".json",
    target = path.join(runDir, "responses", id);
  atomic(path.join(runDir, "commands", id), { command, data });
  const end = Date.now() + 45000;
  while (!fs.existsSync(target) && Date.now() < end) await nap(100);
  fail(
    fs.existsSync(target),
    "命令未收到结果；提交命令必须先recover，禁止重发",
  );
  const response = json(target);
  fs.rmSync(target, { force: true });
  console.log(JSON.stringify(response, null, 2));
  process.exitCode = response.ok ? 0 : 2;
}

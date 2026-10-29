import test from "node:test";
import assert from "node:assert/strict";
import { resolveUploadAddresses, publicAddress } from "../scripts/network.mjs";
import { communityService } from "../scripts/sharing.mjs";
const publicRows = [{ address: "104.21.77.248", family: 4 }];
test("普通公网DNS直接固定地址，不调用加密解析", async () => {
  let fallback = 0;
  assert.deepEqual(
    await resolveUploadAddresses(
      communityService.endpoint,
      async () => publicRows,
      async () => {
        fallback++;
      },
    ),
    publicRows,
  );
  assert.equal(fallback, 0);
});
test("内置服务遇Fake-IP时使用真实公网地址，不把Fake-IP视为公网", async () => {
  let calls = 0;
  const result = await resolveUploadAddresses(
    communityService.endpoint,
    async () => [{ address: "198.18.5.130", family: 4 }],
    async (host) => {
      calls++;
      assert.equal(host, "grading.zonywei.com");
      return publicRows;
    },
  );
  assert.deepEqual(result, publicRows);
  assert.equal(calls, 1);
  assert.equal(publicAddress("198.18.5.130"), false);
});
test("自定义域名、内网和本机地址仍拒绝，不借加密解析绕过", async () => {
  for (const [url, rows] of [
    ["https://example.org/api", [{ address: "198.18.5.130", family: 4 }]],
    [communityService.endpoint, [{ address: "127.0.0.1", family: 4 }]],
    ["https://10.0.0.1/api", []],
  ])
    await assert.rejects(
      resolveUploadAddresses(
        url,
        async () => rows,
        async () => assert.fail("不应调用"),
      ),
      /内网|保留地址/,
    );
});
test("加密解析得到非公网结果或失败时停止，不尝试内网地址", async () => {
  const native = async () => [{ address: "198.18.5.130", family: 4 }];
  await assert.rejects(
    resolveUploadAddresses(communityService.endpoint, native, async () => [
      { address: "10.0.0.1", family: 4 },
    ]),
    /内网|保留地址/,
  );
  await assert.rejects(
    resolveUploadAddresses(communityService.endpoint, native, async () => {
      throw new Error("合成解析失败");
    }),
    /解析失败/,
  );
});

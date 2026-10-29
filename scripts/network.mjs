import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { fail } from "./core.mjs";
import { communityService } from "./sharing.mjs";
const defaultHost = new URL(communityService.endpoint).hostname;
export function publicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return net.isIPv6(ip) && /^[23][0-9a-f]{3}:/i.test(ip);
}
const proxyAlias = (ip) =>
  net.isIPv4(ip) &&
  ip.startsWith("198.") &&
  [18, 19].includes(Number(ip.split(".")[1]));

async function publicServiceDNS(host) {
  fail(host === defaultHost, "加密解析仅用于已内置的公开共建服务");
  // Query only the public service hostname. No grading payload, identity or token is sent to DNS.
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", host);
  url.searchParams.set("type", "A");
  return await new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { agent: false, headers: { accept: "application/dns-json" } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > 16384)
            req.destroy(new Error("解析响应过大"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            fail(res.statusCode === 200, "未获得加密解析响应");
            const result = JSON.parse(body);
            fail(
              result.Status === 0 &&
                result.Question?.some(
                  (q) => q.name.replace(/\.$/, "").toLowerCase() === host,
                ),
              "解析响应与共建域名不一致",
            );
            const rows = (result.Answer || [])
              .filter((a) => a.type === 1 && net.isIPv4(a.data))
              .map((a) => ({ address: a.data, family: 4 }));
            fail(
              rows.length && rows.every((a) => publicAddress(a.address)),
              "解析目标不是可验证公网地址",
            );
            resolve(rows);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("加密解析超时")),
      5000,
    );
    req.once("close", () => clearTimeout(timer));
    req.on("error", reject);
  });
}
export async function resolveUploadAddresses(
  url,
  nativeLookup = dns.lookup,
  secureLookup = publicServiceDNS,
) {
  const u = new URL(url),
    host = u.hostname.replace(/^\[|\]$/g, "");
  let rows = [];
  if (net.isIP(host)) rows = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      rows = await nativeLookup(host, { all: true });
    } catch (error) {
      if (host !== defaultHost) throw error;
    }
  }
  // Fake-IP stays non-public. For the one known public service, obtain real public addresses and pin them.
  if (
    host === defaultHost &&
    (!rows.length || rows.some((a) => proxyAlias(a.address)))
  ) {
    fail(
      rows.every((a) => publicAddress(a.address) || proxyAlias(a.address)),
      "上传目标不能是本机、内网或保留地址",
    );
    rows = await secureLookup(host);
  }
  fail(
    rows.length && rows.every((a) => publicAddress(a.address)),
    "上传目标不能是本机、内网或保留地址",
  );
  return rows;
}

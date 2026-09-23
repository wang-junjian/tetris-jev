#!/usr/bin/env node
/**
 * Jev 本地代理 —— 浏览器 CORS 桥
 *
 * 实测 api.typesafe.ai 的 CORS 为 origin 白名单，浏览器无法直连（预检返回
 * "Disallowed CORS origin"）。本脚本零依赖（Node 20+ 自带 fetch），把页面
 * 发来的请求原样转发到 https://api.typesafe.ai 并补上 CORS 响应头。
 *
 * 用法:
 *   TYPESAFE_API_KEY=sk-xxxx node jev-proxy.mjs [port]     # 可选：在代理侧配 key
 *   node jev-proxy.mjs 8787                                 # 默认端口 8787
 *
 * 页面里把「API 地址」改为 http://localhost:8787 即可；
 * API key 仍可填在页面里（代理只转发 Authorization 头，客户端携带的优先）。
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const UPSTREAM = "https://api.typesafe.ai";
const ENV_KEY = process.env.TYPESAFE_API_KEY || "";
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
};

http.createServer(async (req, res) => {
  // 统一补 CORS 头
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // GET：静态托管（index.html 已改为 ES module，file:// 直开会被浏览器拦截）
  if (req.method === "GET") {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const rel = normalize(urlPath).replace(/^([/\\])+/, "");
    const file = join(ROOT, rel === "" || rel === "." ? "index.html" : rel);
    if (!file.startsWith(ROOT)) { // ROOT 以分隔符结尾，阻止 ../ 穿越
      res.writeHead(403); res.end("forbidden"); return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404); res.end("not found");
    }
    return;
  }

  if (req.method !== "POST" || !req.url.startsWith("/v1/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "only POST /v1/* is proxied" }));
    return;
  }

  // 读取请求体
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  // 转发：客户端自带 Authorization 则优先，否则用环境变量里的 key
  const headers = {
    "Content-Type": "application/json",
    ...(body.length ? { "Content-Length": body.length } : {}),
  };
  const clientAuth = req.headers["authorization"];
  headers["Authorization"] = clientAuth || (ENV_KEY ? `Bearer ${ENV_KEY}` : "");

  try {
    const upstream = await fetch(UPSTREAM + req.url, {
      method: "POST",
      headers,
      body: body.length ? body : undefined,
    });
    const respBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Content-Length": respBody.length,
    });
    res.end(respBody);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_failed", detail: String(err) }));
  }
}).listen(PORT, () => {
  console.log(`Jev proxy listening on http://localhost:${PORT}  ->  ${UPSTREAM}`);
  console.log(`页面入口: http://localhost:${PORT}/  （静态托管 + /v1/* 转发）`);
  console.log(ENV_KEY ? "Using TYPESAFE_API_KEY from env." : "No env key set; page-side key will be forwarded.");
});

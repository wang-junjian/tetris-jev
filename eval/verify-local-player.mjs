#!/usr/bin/env node
/* ================================================================
 *  真实浏览器验证「本地启发式玩家」在静态托管下能否跑起来
 *
 *  为什么需要独立脚本：CI 只做静态断言（文件在不在、语法通不通），
 *  它没法回答「点下去到底会不会动」。而静态站点最容易出的问题恰恰是
 *  默认后端选错 —— 页面能开、玩家点了报错。这里用真 Chrome 跑一遍。
 *
 *  关键技巧：用 --host-resolver-rules 把 tetris.test 映射到 127.0.0.1，
 *  让页面看到的主机名不是 localhost —— 这样才会走「静态托管」的默认分支
 *  （本地启发式默认开启），否则测到的是本地开发分支，白测。
 *
 *  依赖 puppeteer-core（可选，不入 CI）：
 *    NODE_PATH=/Users/junjian/.workbuddy/binaries/node/workspace/node_modules \
 *      node eval/verify-local-player.mjs
 *
 *  用法：
 *    node eval/verify-local-player.mjs [--dir site] [--shots eval/shots] [--hold 5000]
 * ================================================================ */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const root = path.resolve(arg("--dir", "site"));
const shotDir = path.resolve(arg("--shots", "eval/shots"));
const holdMs = Number(arg("--hold", "5000"));
const CHROME = arg("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const HOST = "tetris.test";

if (!existsSync(path.join(root, "index.html"))) {
  console.error(`✗ ${root} 下没有 index.html，先 bash eval/build-site.sh`);
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css", ".png": "image/png", ".mp4": "video/mp4", ".txt": "text/plain",
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(root, urlPath);
    if (urlPath.endsWith("/")) file = path.join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
});

const problems = [];
const pass = [];
const ok = (m) => pass.push(m);
const bad = (m) => problems.push(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
mkdirSync(shotDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", `--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

  /* 错误按阶段归集：A/B 阶段的任何异常都是真问题；C 阶段主动切回后端模式，
     会（且应该）触发 /v1/health 探测 —— 那个失败是预期行为，不能算 bug。 */
  let phase = "A";
  const errors = [];
  page.on("pageerror", (e) => errors.push(`[${phase}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${phase}] console.error: ${m.text()}`); });
  page.on("requestfailed", (r) => {
    errors.push(`[${phase}] requestfailed: ${r.url()} — ${r.failure()?.errorText}`);
  });
  /* 404 只有 console.error 一行、没有 URL，必须单独记状态码才能定位到具体资源 */
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`[${phase}] HTTP ${r.status()}: ${r.url()}`);
  });

  await page.goto(`http://${HOST}:${port}/index.html`, { waitUntil: "networkidle2" });
  await sleep(600);

  /* ---------- A. 默认后端应为本地启发式 ---------- */
  const initial = await page.evaluate(() => ({
    host: location.hostname,
    useLocal: document.getElementById("useLocal").checked,
    tag: document.getElementById("providerTag").textContent.trim(),
    startText: document.getElementById("aiStart").textContent.trim(),
    keyDisabled: document.getElementById("apiKey").disabled,
    baseDisabled: document.getElementById("baseUrl").disabled,
    stepDisabled: document.querySelector('input[name="aimode"][value="step"]').disabled,
    mode: document.querySelector('input[name="aimode"]:checked').value,
  }));

  if (initial.useLocal) ok(`静态托管（${initial.host}）默认启用本地启发式`);
  else bad(`静态托管下未默认启用本地启发式（host=${initial.host}，这会让页面要求填 API Key）`);

  if (/本地启发式/.test(initial.tag)) ok(`后端标记：「${initial.tag}」`);
  else bad(`后端标记不符，期望含「本地启发式」，实际「${initial.tag}」`);

  if (initial.keyDisabled && initial.baseDisabled) ok("本地模式下 API Key / 地址输入已禁用（避免误导填写）");
  else bad("本地模式下仍可编辑 API Key/地址");

  if (initial.stepDisabled && initial.mode === "placement") ok("逐步动作模式已禁用并回落到落点决策");
  else bad(`联网模式未正确禁用：stepDisabled=${initial.stepDisabled}, mode=${initial.mode}`);

  if (/启发式/.test(initial.startText)) ok(`按钮文案：「${initial.startText}」`);
  else bad(`按钮文案未跟随后端：「${initial.startText}」`);

  await page.screenshot({ path: path.join(shotDir, "initial.png") });

  /* ---------- B. 点下去要真的动 ---------- */
  await page.click("#aiStart");
  await sleep(holdMs);

  const running = await page.evaluate(() => ({
    decisions: Number(document.getElementById("stDecisions").textContent),
    latency: document.getElementById("stLatency").textContent,
    tokens: document.getElementById("stTokens").textContent,
    badge: document.getElementById("badge").textContent,
    entries: document.querySelectorAll("#log .entry").length,
    firstEntry: document.querySelector("#log .entry")?.innerText.slice(0, 220) || "",
    err: document.getElementById("errbox").classList.contains("show")
      ? document.getElementById("errbox").textContent : "",
    score: Number(document.getElementById("score").textContent),
    lines: Number(document.getElementById("lines").textContent),
    boardFilled: (() => {
      const s = window.TetrisAPI?.getState?.();
      return s?.grid ? s.grid.flat().filter((c) => c !== ".").length : -1;
    })(),
  }));

  if (running.decisions >= 2) ok(`玩家在跑：${running.decisions} 次决策 / ${holdMs}ms，棋盘 ${running.boardFilled} 格已填充`);
  else bad(`点击启动后决策数只有 ${running.decisions}（期望 ≥2），玩家没真正跑起来`);

  if (running.entries >= 1) ok(`决策日志已渲染 ${running.entries} 条，首条：${running.firstEntry.split("\n")[0]}`);
  else bad("决策日志为空");

  if (running.tokens === "0") ok("Token 用量为 0（纯前端，无网络调用）");
  else bad(`本地模式不该消耗 token，实际 ${running.tokens}`);

  if (/启发式/.test(running.badge)) ok(`运行时徽章：「${running.badge}」`);
  else bad(`运行时徽章未标明后端：「${running.badge}」`);

  if (!running.err) ok("无错误提示框");
  else bad(`出现错误提示：${running.err}`);

  if (running.lines > 0) ok(`已消行 ${running.lines} 行，得分 ${running.score}`);
  else ok(`暂未消行（${holdMs}ms 内正常），得分 ${running.score}`);

  await page.screenshot({ path: path.join(shotDir, "running.png") });

  /* ---------- C. 取消勾选应回到后端模式 ---------- */
  phase = "C";
  const probeFrom = errors.length;
  await page.evaluate(() => { document.getElementById("aiStop").click(); });
  await sleep(300);
  await page.evaluate(() => {
    const el = document.getElementById("useLocal");
    el.checked = false;
    el.dispatchEvent(new Event("change"));
  });
  await sleep(800);
  const backToApi = await page.evaluate(() => ({
    keyDisabled: document.getElementById("apiKey").disabled,
    tag: document.getElementById("providerTag").textContent.trim(),
    startText: document.getElementById("aiStart").textContent.trim(),
  }));
  if (!backToApi.keyDisabled && /Jev|Laya/.test(backToApi.tag)) ok(`取消勾选后回到后端模式：「${backToApi.tag}」，Key 可填`);
  else bad(`取消勾选未恢复后端模式：disabled=${backToApi.keyDisabled}, tag=${backToApi.tag}`);

  const probeFails = errors.slice(probeFrom).filter((e) => /\/v1\/health/.test(e));
  if (probeFails.length) ok("切回后端模式后按预期探测 /v1/health（本机无服务，页面已降级为 Jev 分支且未崩溃）");

  /* ---------- D. 文档索引页可加载 ---------- */
  phase = "D";
  await page.goto(`http://${HOST}:${port}/docs/index.html`, { waitUntil: "networkidle2" });
  await sleep(400);
  const docs = await page.evaluate(() => ({
    title: document.querySelector("h1")?.textContent.trim(),
    cards: document.querySelectorAll("a.card").length,
    back: document.querySelector("a.back")?.getAttribute("href"),
  }));
  if (docs.cards >= 6) ok(`文档索引页：${docs.cards} 张卡片，标题「${docs.title}」`);
  else bad(`文档索引页卡片只有 ${docs.cards} 张`);
  await page.screenshot({ path: path.join(shotDir, "docs-index.png"), fullPage: true });

  await page.goto(`http://${HOST}:${port}/index.html`, { waitUntil: "networkidle2" });
  const backOk = await page.evaluate(() => !!document.getElementById("board"));
  if (backOk) ok("从索引页回到游戏页正常");
  else bad("从索引页回到游戏页失败");

  /* ---------- E. 窄视口（375px）不能横向溢出 ---------- */
  phase = "E";
  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
  await page.goto(`http://${HOST}:${port}/index.html`, { waitUntil: "networkidle2" });
  await sleep(600);
  const narrow = await page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const spill = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 2) continue;
      /* 处于横向滚动容器内的超宽元素是设计意图，跳过 */
      let p = el.parentElement, inScroller = false;
      while (p && p !== document.body) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll") { inScroller = true; break; }
        p = p.parentElement;
      }
      if (!inScroller) spill.push(`${el.tagName.toLowerCase()}.${el.className || "-"} right=${Math.round(r.right)}`);
    }
    return { vw, scrollW: doc.scrollWidth, spill: spill.slice(0, 5) };
  });
  if (narrow.scrollW <= narrow.vw + 2) ok(`375px 视口无横向溢出（scrollWidth ${narrow.scrollW} ≤ ${narrow.vw}）`);
  else bad(`375px 视口横向溢出：scrollWidth ${narrow.scrollW} > ${narrow.vw}，撑破元素 ${narrow.spill.join(" | ") || "(未定位)"}`);
  await page.screenshot({ path: path.join(shotDir, "mobile.png"), fullPage: false });

  /* ---------- 汇总 ---------- */
  /* A/B 是「纯静态托管下的开箱体验」，它必须零噪音：任何报错都是真问题。
     C/D 主动切回后端模式并重新加载页面，探测 /v1/health 的失败是设计内行为。 */
  /* Chrome 对失败请求会额外打一条无 URL 的 console.error，所以「连不上后端」
     这一现象要按错误文本一起识别，否则过滤不干净会导致假失败。 */
  const isProbeNoise = (e) => /\/v1\/health/.test(e) || /ERR_CONNECTION_REFUSED/.test(e);
  const noise = errors.filter((e) => /^\[[AB]\]/.test(e));
  const expected = errors.filter((e) => /^\[[CD]\]/.test(e) && !isProbeNoise(e));
  if (!noise.length) ok("A/B 阶段（静态托管开箱体验）零 pageerror / console.error / 失败请求");
  for (const e of noise) bad(e);
  for (const e of expected) bad(`C/D 阶段出现预期外错误：${e}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${problems.length ? "✗" : "✓"} 浏览器验证：${pass.length} 项通过，${problems.length} 项失败`);
for (const p of pass) console.log("  ✓ " + p);
for (const p of problems) console.log("  ✗ " + p);
console.log(`  截图：${shotDir}`);
process.exit(problems.length ? 1 : 0);

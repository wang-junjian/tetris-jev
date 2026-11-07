#!/usr/bin/env node
/* ================================================================
 *  静态站点发布前自检（零依赖，Node 18+）
 *
 *  为什么需要：本项目没有构建步骤，Pages 上的产物就是仓库里的文件本身。
 *  因此「发布正确」等价于「引用能解析 + 模块能加载」，这两件事必须在
 *  推送之前用机器验一遍，而不是部署完再点开看。
 *
 *  检查项：
 *    1. 必需文件齐备（index.html / engine.js / .nojekyll / docs/index.html）
 *    2. HTML 中所有本地引用（src / href / import from / 动态 import）都能解析
 *    3. 不存在 file:// 引用（Pages 上必然失效）
 *    4. 不存在明文 http:// 资源（https 站点会被混合内容策略拦截）
 *    5. engine.js 能在 Node 中导入，且导出 Engine / enumeratePlacements
 *
 *  用法：
 *    node eval/check-site.mjs                # 默认检查 site/
 *    node eval/check-site.mjs --dir .        # 直接检查仓库根
 * ================================================================ */
import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf("--dir");
const root = path.resolve(dirIdx >= 0 ? argv[dirIdx + 1] : "site");

const problems = [];
const notes = [];
const bad = (msg) => problems.push(msg);

/* ---------- 1. 必需文件 ---------- */
const REQUIRED = ["index.html", "engine.js", "docs/index.html"];
/* .nojekyll 是组装产物：只对组装后的站点目录要求，直接查仓库根时（--dir .）跳过 */
if (path.basename(root) === "site") REQUIRED.push(".nojekyll");
if (!existsSync(root)) {
  console.error(`✗ 目录不存在：${root}（先组装 site/）`);
  process.exit(1);
}
for (const f of REQUIRED) {
  if (!existsSync(path.join(root, f))) bad(`缺少必需文件 ${f}`);
}

/* ---------- 遍历 HTML ---------- */
async function htmlFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "assets") continue;
      await htmlFiles(p, out);
    } else if (entry.name.endsWith(".html")) out.push(p);
  }
  return out;
}

/* 引用抽取：HTML 属性 + ES module import（本项目页面用 module 脚本引用引擎） */
function refsOf(html) {
  const refs = new Set();
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) refs.add(m[1]);
  for (const m of html.matchAll(/\bfrom\s+["']([^"']+)["']/g)) refs.add(m[1]);
  for (const m of html.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) refs.add(m[1]);
  return [...refs];
}

const isRemote = (r) => /^(https?:)?\/\//i.test(r) || /^(data|mailto|tel|javascript|blob):/i.test(r) || r.startsWith("#");

let htmlCount = 0;
let refCount = 0;
let scriptCount = 0;
const files = existsSync(root) ? await htmlFiles(root) : [];

for (const file of files) {
  htmlCount++;
  const html = await readFile(file, "utf8");
  const rel = path.relative(root, file) || path.basename(file);

  /* 文档正文与代码示例里出现的 file:// 字样是讲解，不是引用 —— 只判真正的引用目标 */
  for (const ref of refsOf(html)) {
    if (/^file:/i.test(ref)) bad(`${rel}: 引用了 file:// 路径，Pages 上无效 → ${ref}`);
    if (isRemote(ref)) {
      /* 混合内容：https 站点加载明文 http 资源会被浏览器直接拦掉 */
      if (/^http:\/\//i.test(ref)) bad(`${rel}: 明文 http 资源会在 https 站点被拦截 → ${ref}`);
      continue;
    }
    refCount++;
    const clean = ref.split(/[?#]/)[0];
    if (!clean) continue;

    const target = path.resolve(path.dirname(file), clean);
    const inside = !path.relative(root, target).startsWith("..");
    if (!inside) {
      bad(`${rel}: 引用逃出站点根目录 → ${ref}`);
      continue;
    }
    if (clean.endsWith("/")) {
      if (!existsSync(path.join(target, "index.html"))) bad(`${rel}: 目录引用缺少 index.html → ${ref}`);
    } else if (!existsSync(target)) {
      bad(`${rel}: 引用不存在 → ${ref}`);
    } else if (statSync(target).isDirectory() && !existsSync(path.join(target, "index.html"))) {
      bad(`${rel}: 目录引用缺少 index.html → ${ref}`);
    }
  }
}

/* ---------- 5. 内联 module 脚本语法 ---------- */
/* 页面逻辑全部内联在 <script type="module"> 里，静态检查看不见它：
   一个多余的括号在 CI 里完全隐形，上线才白屏。这里抽出来交给 node --check。 */
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "site-check-"));
for (const file of files) {
  const html = await readFile(file, "utf8");
  const rel = path.relative(root, file) || path.basename(file);
  const blocks = [...html.matchAll(/<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [i, m] of blocks.entries()) {
    const tmp = path.join(tmpDir, `${rel.replace(/[^\w.-]/g, "_")}.${i}.mjs`);
    writeFileSync(tmp, m[1]);
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
      scriptCount++;
    } catch (err) {
      const msg = String(err.stderr || err.message).split("\n").slice(0, 4).join("\n      ");
      bad(`${rel}: 第 ${i + 1} 段内联 module 脚本语法错误\n      ${msg}`);
    }
  }
}
rmSync(tmpDir, { recursive: true, force: true });

/* ---------- 6. engine.js 可加载 ---------- */
const enginePath = path.join(root, "engine.js");
if (existsSync(enginePath)) {
  try {
    const mod = await import(pathToFileURL(enginePath).href);
    for (const name of ["Engine", "enumeratePlacements", "heuristicScore"]) {
      if (typeof mod[name] !== "function") bad(`engine.js: 缺少导出 ${name}（页面与评估工具都依赖它）`);
    }
    notes.push(`engine.js 可导入，导出 ${Object.keys(mod).length} 项`);
  } catch (err) {
    bad(`engine.js 在 Node 中导入失败：${err.message}`);
  }
}

/* ---------- 汇总 ---------- */
notes.unshift(`站点根：${root}`);
notes.unshift(`扫描 ${htmlCount} 个 HTML、${refCount} 条本地引用`);
if (scriptCount) notes.push(`${scriptCount} 段内联 module 脚本语法通过`);

if (problems.length) {
  console.error("✗ 站点自检失败：\n");
  for (const p of problems) console.error("  - " + p);
  console.error(`\n共 ${problems.length} 项问题`);
  process.exit(1);
}
console.log("✓ 站点自检通过");
for (const n of notes) console.log("  · " + n);

#!/usr/bin/env node
/**
 * trace -> 交互式 HTML 回放报告
 *
 * 读取 eval/trace_game.mjs 录制的单局 trace JSON，生成一个自包含的 HTML：
 * - 汇总统计：token、耗时、置信度、启发式一致率、策略/健康度分布、行数曲线
 * - 输入结构解析：用本局真实数据说明「输入是怎么喂给 Jev 的」
 * - 逐步回放：←/→ 或滑块逐块查看棋盘（落子前后）、概率分布、完整输入/输出 JSON
 *
 * 用法: node eval/trace_to_html.mjs eval/runs/trace-seed42.json [out.html]
 */
import fs from "node:fs";
import path from "node:path";
import { Engine, SHAPES, COLS, ROWS } from "../engine.js";

const inPath = process.argv[2];
if (!inPath) { console.error("用法: node eval/trace_to_html.mjs <trace.json> [out.html]"); process.exit(1); }
const trace = JSON.parse(fs.readFileSync(inPath, "utf8"));
const outPath = process.argv[3] || inPath.replace(/\.json$/, ".html");

/* 重放对局，计算每步落子的具体格子（用于在棋盘上高亮新落的方块） */
function replayPlacedCells() {
  const engine = new Engine({ seed: trace.meta.seed });
  engine.start(); engine.setGravity(false);
  for (const s of trace.steps) {
    engine.cur.rot = s.chosenRot; engine.cur.x = s.chosenX; engine.cur.y = 0;
    const gy = engine.ghostY();
    const m = SHAPES[s.piece][s.chosenRot];
    const cells = [];
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++)
      if (m[y][x] && gy + y >= 0) cells.push([gy + y, s.chosenX + x]);
    s.placedCells = cells;
    engine.hardDrop();
    const replayed = engine.grid.map(r => r.join(""));
    if (replayed.join("/") !== s.boardAfter.join("/"))
      console.error(`警告: 第 ${s.pieceNo} 步重放与录制不一致`);
  }
}
replayPlacedCells();

/* ---------- 汇总统计（生成期算好，直接写进 HTML） ---------- */
const S = trace.steps;
const n = S.length;
const sum = (f) => S.reduce((a, s) => a + f(s), 0);
const avg = (f) => sum(f) / n;
const quant = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
const conf = (s) => s.response.answers.placement?.confidence ?? 0;
const stats = {
  pieces: n, lines: trace.meta.lines, score: trace.meta.score,
  tokens: sum(s => s.tokens),
  avgMs: Math.round(avg(s => s.ms)), p95Ms: quant(S.map(s => s.ms), 0.95),
  avgConf: +(avg(conf) * 100).toFixed(1),
  agreePct: Math.round(100 * S.filter(s => s.agree).length / n),
  clearedMoves: S.filter(s => s.linesClearedByMove > 0).length,
  tetrisMoves: S.filter(s => s.linesClearedByMove === 4).length,
  strategyDist: {}, healthDist: [0, 0, 0, 0],
  avgCandidates: +(avg(s => s.candidates.length)).toFixed(1),
};
for (const s of S) {
  const st = s.response.answers.strategy?.choice || "–";
  stats.strategyDist[st] = (stats.strategyDist[st] || 0) + 1;
  const h = s.response.answers.board_health?.score;
  // score 是期望分值（如 1.81 ≈ Rough），按最近档归类
  if (typeof h === "number") stats.healthDist[Math.max(0, Math.min(3, Math.round(h)))]++;
}
const HEALTH_NAMES = ["Clean", "Fine", "Rough", "Critical"];

/* ---------- 输入结构解析（用第一步真实数据举例） ---------- */
const s0 = S[0];
const req0 = s0.request;
const stateExampleRows = Object.entries(req0.state.game)
  .map(([k, v]) => {
    const val = Array.isArray(v) && v.length > 6
      ? `[${v.slice(0, 3).map(x => JSON.stringify(x)).join(", ")}, … 共 ${v.length} 项]`
      : JSON.stringify(v);
    return `<tr><td><code>${k}</code></td><td class="ex">${escapeHtml(val.length > 120 ? val.slice(0, 120) + "…" : val)}</td></tr>`;
  }).join("");
const priorityRows = req0.questions.placement.instructions.priorities
  .map((p, i) => `<li><b>${i + 1}.</b> ${escapeHtml(p)}</li>`).join("");
const cand0 = s0.candidates[0];

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const embedded = JSON.stringify(trace).replace(/</g, "\\u003c");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jev 对局回放 — seed ${trace.meta.seed}</title>
<style>
  :root {
    --bg: #f5f4ef; --ink: #141414; --line: #d8d5cc; --red: #e63329;
    --muted: #6f6c64; --panel: #ffffff; --green: #2c7a3f; --amber: #b06a00;
    --mono: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Inter, -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; background: var(--bg); color: var(--ink); font-size: 14px; line-height: 1.55; }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 0 20px 60px; }
  header { padding: 24px 0 16px; border-bottom: 3px solid var(--ink); margin-bottom: 20px; }
  header h1 { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
  header h1 em { font-style: normal; color: var(--red); }
  header .meta { color: var(--muted); font-size: 12.5px; margin-top: 4px; font-family: var(--mono); }
  h2.sec { font-size: 13px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; background: var(--ink); color: #fff; padding: 8px 12px; margin: 22px 0 0; }
  .sec-body { background: var(--panel); border: 2px solid var(--ink); border-top: none; padding: 14px 16px; }
  .chips { display: flex; gap: 10px; flex-wrap: wrap; }
  .chip { border: 1.5px solid var(--line); border-radius: 4px; padding: 6px 12px; background: #fbfaf6; }
  .chip .k { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: var(--muted); }
  .chip .v { font-family: var(--mono); font-size: 18px; font-weight: 700; }
  .dist { margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .dist h3 { font-size: 11px; font-weight: 800; letter-spacing: 1px; color: var(--muted); text-transform: uppercase; margin-bottom: 6px; }
  .drow { display: flex; align-items: center; gap: 8px; font-size: 12.5px; margin: 3px 0; }
  .drow .nm { width: 110px; text-align: right; font-family: var(--mono); color: var(--muted); }
  .drow .tr { flex: 1; height: 10px; background: #f0eee7; border-radius: 2px; overflow: hidden; }
  .drow .fl { height: 100%; background: var(--ink); }
  .drow .ct { width: 60px; font-family: var(--mono); color: var(--muted); }
  table.kv { border-collapse: collapse; width: 100%; margin: 8px 0; }
  table.kv td { border: 1px solid var(--line); padding: 4px 8px; font-size: 12.5px; vertical-align: top; }
  table.kv td:first-child { white-space: nowrap; background: #f0eee7; }
  td.ex { font-family: var(--mono); font-size: 11px; word-break: break-all; }
  ol.prio { margin: 6px 0 6px 18px; font-size: 13px; }
  ol.prio li { margin: 3px 0; }
  .note { background: #f0eee7; border-left: 3px solid var(--ink); padding: 8px 12px; font-size: 12.5px; margin: 10px 0; }

  /* ---------- 回放器 ---------- */
  .player-nav { position: sticky; top: 0; z-index: 5; background: var(--bg); padding: 10px 0; display: flex; align-items: center; gap: 10px; border-bottom: 2px solid var(--ink); }
  .player-nav button { font: inherit; font-weight: 700; padding: 6px 16px; border: 2px solid var(--ink); background: var(--panel); cursor: pointer; border-radius: 4px; }
  .player-nav button:hover { background: var(--ink); color: #fff; }
  .player-nav input[type="range"] { flex: 1; accent-color: var(--red); }
  .player-nav .pos { font-family: var(--mono); font-weight: 700; white-space: nowrap; }
  .step-grid { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 14px; }
  .boards { display: flex; gap: 14px; }
  .board-box { text-align: center; }
  .board-box .cap { font-size: 11px; font-weight: 700; letter-spacing: 1px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
  table.board { border-collapse: collapse; background: #fbfaf6; border: 2px solid var(--ink); }
  table.board td { width: 16px; height: 16px; border: 1px solid #eceade; padding: 0; }
  table.board td.f { background: var(--ink); }
  table.board td.new { outline: 2px solid var(--red); outline-offset: -2px; }
  .decision { flex: 1; min-width: 320px; }
  .decision .head { font-size: 15px; font-weight: 800; margin-bottom: 6px; }
  .decision .head .pc { display: inline-block; min-width: 22px; text-align: center; color: #fff; border-radius: 3px; padding: 0 5px; margin-right: 6px; }
  .decision .sub { color: var(--muted); font-size: 12.5px; font-family: var(--mono); margin-bottom: 8px; }
  .tag { display: inline-block; font-size: 11px; font-weight: 700; border: 1.5px solid; border-radius: 999px; padding: 1px 9px; margin-right: 6px; }
  .tag.ok { color: var(--green); border-color: var(--green); }
  .tag.no { color: var(--amber); border-color: var(--amber); }
  .bars { margin: 8px 0; }
  .bar { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-family: var(--mono); margin: 2px 0; }
  .bar .name { width: 200px; text-align: right; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar .track { flex: 1; height: 9px; background: #f0eee7; border-radius: 2px; overflow: hidden; }
  .bar .fill { height: 100%; background: var(--ink); }
  .bar .fill.top { background: var(--red); }
  .bar .pct { width: 42px; color: var(--muted); }
  details.json { margin-top: 10px; }
  details.json summary { cursor: pointer; font-size: 12px; font-weight: 700; color: var(--muted); user-select: none; }
  details.json summary:hover { color: var(--ink); }
  details.json pre { background: #141414; color: #e8e6df; padding: 10px 12px; border-radius: 4px; font-size: 11px; line-height: 1.5; overflow: auto; max-height: 420px; margin-top: 6px; }
  .clear-badge { color: var(--red); font-weight: 800; }
  footer { margin-top: 26px; color: var(--muted); font-size: 12px; border-top: 1.5px solid var(--line); padding-top: 12px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>JEV 对局回放 <em>·</em> 逐步看懂模型的思考</h1>
  <div class="meta">model ${escapeHtml(trace.meta.model)} · seed ${trace.meta.seed} · ${escapeHtml(trace.meta.date.slice(0, 19).replace("T", " "))} · 模式: ${escapeHtml(trace.meta.mode)}</div>
</header>

<h2 class="sec">汇总统计</h2>
<div class="sec-body">
  <div class="chips">
    <div class="chip"><div class="k">方块数</div><div class="v">${stats.pieces}</div></div>
    <div class="chip"><div class="k">消行</div><div class="v">${stats.lines}</div></div>
    <div class="chip"><div class="k">得分</div><div class="v">${stats.score}</div></div>
    <div class="chip"><div class="k">Token 总量</div><div class="v">${stats.tokens}</div></div>
    <div class="chip"><div class="k">平均耗时</div><div class="v">${stats.avgMs}ms</div></div>
    <div class="chip"><div class="k">P95 耗时</div><div class="v">${stats.p95Ms}ms</div></div>
    <div class="chip"><div class="k">平均置信度</div><div class="v">${stats.avgConf}%</div></div>
    <div class="chip"><div class="k">与启发式一致</div><div class="v">${stats.agreePct}%</div></div>
    <div class="chip"><div class="k">消行手数</div><div class="v">${stats.clearedMoves}</div></div>
    <div class="chip"><div class="k">平均候选数</div><div class="v">${stats.avgCandidates}</div></div>
  </div>
  <div class="dist">
    <div>
      <h3>策略判断分布（投机问题 strategy）</h3>
      ${Object.entries(stats.strategyDist).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        `<div class="drow"><span class="nm">${k}</span><span class="tr"><span class="fl" style="width:${Math.round(100 * v / n)}%"></span></span><span class="ct">${v} 次</span></div>`).join("")}
    </div>
    <div>
      <h3>棋盘健康度分布（投机问题 board_health）</h3>
      ${stats.healthDist.map((v, i) =>
        `<div class="drow"><span class="nm">${HEALTH_NAMES[i]}</span><span class="tr"><span class="fl" style="width:${Math.round(100 * v / n)}%"></span></span><span class="ct">${v} 次</span></div>`).join("")}
    </div>
  </div>
  <div class="note">结局: ${trace.meta.gameOver ? `第 ${n} 块后 top-out` : `打满 ${trace.meta["maxPieces"] || n} 块未死`} · 总耗时 ${trace.meta.durationSec}s</div>
</div>

<h2 class="sec">输入结构解析 —— 数据是怎么喂给 Jev 的</h2>
<div class="sec-body">
  <p>每一步都是一次 <code>POST /v1/systemone</code> 请求，请求体 = <code>{ state, model, questions }</code>。
  代码负责枚举全部合法落点并模拟后果，把数字<b>词化</b>成自然语言；Jev 不读数字、不做算术，只读词，返回带概率分布的判断。</p>
  <h3 style="margin-top:10px;font-size:12px;letter-spacing:1px;color:var(--muted)">① state.game —— 局面词化（第 1 步真实值）</h3>
  <table class="kv">${stateExampleRows}</table>
  <h3 style="margin-top:10px;font-size:12px;letter-spacing:1px;color:var(--muted)">② questions.placement —— 主问题：选哪个落点</h3>
  <p style="font-size:13px;margin:4px 0">${escapeHtml(req0.questions.placement.instructions.question)}</p>
  <p style="font-size:12.5px;color:var(--muted)">优先级（权重全靠措辞顺序）：</p>
  <ol class="prio">${priorityRows}</ol>
  <p style="font-size:12.5px;color:var(--muted)">每个候选落点一条 criteria，全部用词不用数，含<b>显著事实</b>（唯一/最高/最低等客观比较）。本局第 1 步共 ${s0.candidates.length} 个候选，示例 <code>${cand0.id}</code>：</p>
  <table class="kv">${Object.entries(cand0.desc).map(([k, v]) =>
    `<tr><td><code>${k}</code></td><td class="ex">${escapeHtml(Array.isArray(v) ? v.join("；") : v)}</td></tr>`).join("")}</table>
  <h3 style="margin-top:10px;font-size:12px;letter-spacing:1px;color:var(--muted)">③ 投机问题（同请求随附，只进日志不影响落点）</h3>
  <table class="kv">
    <tr><td><code>strategy</code></td><td class="ex">当前局面该用哪种策略（build_clean / clear_lines / repair_surface / survive）</td></tr>
    <tr><td><code>board_health</code></td><td class="ex">棋盘健康度打分：Clean / Fine / Rough / Critical</td></tr>
    <tr><td><code>next_piece_fits</code></td><td class="ex">下一块（next_piece）是否有明显干净的落位</td></tr>
  </table>
</div>

<h2 class="sec">逐步回放（← → 键或滑块切换）</h2>
<div class="sec-body">
  <div class="player-nav">
    <button id="prev">‹ 上一块</button>
    <input type="range" id="slider" min="1" max="${n}" value="1">
    <button id="next">下一块 ›</button>
    <span class="pos" id="pos">1 / ${n}</span>
  </div>
  <div class="step-grid">
    <div class="boards">
      <div class="board-box"><div class="cap">决策前</div><table class="board" id="boardBefore"></table></div>
      <div class="board-box"><div class="cap">落子后（红框 = 新落的方块）</div><table class="board" id="boardAfter"></table></div>
    </div>
    <div class="decision">
      <div class="head" id="dHead"></div>
      <div class="sub" id="dSub"></div>
      <div id="dTags"></div>
      <div class="bars" id="dBars"></div>
      <details class="json" id="dInWrap"><summary>完整输入 JSON（发给 Jev 的 state + questions）</summary><pre id="dIn"></pre></details>
      <details class="json" id="dOutWrap"><summary>完整输出 JSON（Jev 返回的 answers + usage）</summary><pre id="dOut"></pre></details>
    </div>
  </div>
</div>

<footer>由 eval/trace_game.mjs 录制 · eval/trace_to_html.mjs 生成 · 棋盘红框为本步新落下的方块；消行后棋盘为消行完成的最终状态</footer>
</div>

<script>
const TRACE = ${embedded};
const COLORS = { I:"#31b8c9", O:"#e0a91f", T:"#9b4fc9", S:"#54a63c", Z:"#d93a35", J:"#3358c9", L:"#dd7c26" };
const HEALTH = ["Clean", "Fine", "Rough", "Critical"];
const steps = TRACE.steps;
let cur = 0;
const $ = (id) => document.getElementById(id);

function renderBoard(el, rows, highlight) {
  const hl = new Set((highlight || []).map(([y, x]) => y + "," + x));
  let html = "";
  for (let y = 0; y < rows.length; y++) {
    html += "<tr>";
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x];
      const filled = c !== ".";
      const isNew = hl.has(y + "," + x);
      html += '<td class="' + (filled ? "f" : "") + (isNew ? " new" : "") + '"' +
        (filled ? ' style="background:' + (COLORS[c] || "#141414") + '"' : "") + "></td>";
    }
    html += "</tr>";
  }
  el.innerHTML = html;
}

function render() {
  const s = steps[cur];
  const a = s.response.answers.placement || {};
  const strat = s.response.answers.strategy?.choice || "–";
  const health = s.response.answers.board_health?.score;
  const fits = s.response.answers.next_piece_fits?.noul;
  const cd = s.candidates.find(c => c.id === s.chosen)?.desc || {};
  $("pos").textContent = (cur + 1) + " / " + steps.length;
  $("slider").value = cur + 1;
  $("dHead").innerHTML = '<span class="pc" style="background:' + COLORS[s.piece] + '">' + s.piece + "</span>" +
    "第 " + s.pieceNo + " 块 → " + s.chosen + "（" + (cd.where || "") + "）" +
    (s.linesClearedByMove ? ' <span class="clear-badge">消 ' + s.linesClearedByMove + " 行!</span>" : "");
  $("dSub").textContent = "conf " + ((a.confidence || 0) * 100).toFixed(0) + "% · " + s.ms + "ms · " + s.tokens + " tok" +
    " · 候选 " + s.candidates.length + " 个 · next " + s.nextPiece +
    " · 累计 " + s.linesAfter + " 行 / " + s.scoreAfter + " 分";
  $("dTags").innerHTML =
    '<span class="tag">' + "strategy: " + strat + "</span>" +
    (health != null ? '<span class="tag">' + "health: " + HEALTH[Math.max(0, Math.min(3, Math.round(health)))] + " (" + health.toFixed(2) + ")</span>" : "") +
    (fits != null ? '<span class="tag">' + "next fits: " + (fits * 100).toFixed(0) + "%</span>" : "") +
    (s.agree ? '<span class="tag ok">与启发式一致</span>' : '<span class="tag no">与启发式不同（启发式选 ' + s.heuristicBest + "）</span>");
  const probs = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 8);
  $("dBars").innerHTML = probs.map(([id, p]) => {
    const c = s.candidates.find(c => c.id === id);
    const label = id + " · " + (c?.desc?.where || "") + (c?.desc?.lines_cleared !== "none" ? " · " + c.desc.lines_cleared : "");
    return '<div class="bar"><span class="name" title="' + label + '">' + label + "</span>" +
      '<span class="track"><span class="fill' + (id === s.chosen ? " top" : "") + '" style="width:' + Math.round(p * 100) + '%"></span></span>' +
      '<span class="pct">' + Math.round(p * 100) + "%</span></div>";
  }).join("");
  $("dIn").textContent = JSON.stringify(s.request, null, 2);
  $("dOut").textContent = JSON.stringify(s.response, null, 2);
  renderBoard($("boardBefore"), s.boardBefore);
  renderBoard($("boardAfter"), s.boardAfter, s.placedCells);
  $("prev").disabled = cur === 0;
  $("next").disabled = cur === steps.length - 1;
}
$("prev").onclick = () => { if (cur > 0) { cur--; render(); } };
$("next").onclick = () => { if (cur < steps.length - 1) { cur++; render(); } };
$("slider").oninput = (e) => { cur = Number(e.target.value) - 1; render(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" && cur > 0) { cur--; render(); }
  if (e.key === "ArrowRight" && cur < steps.length - 1) { cur++; render(); }
});
render();
</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`报告 -> ${outPath}（${(html.length / 1024).toFixed(0)} KB，${n} 步）`);

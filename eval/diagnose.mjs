#!/usr/bin/env node
/* ================================================================
 *  Tetris × Jev 失误诊断 —— 离线分析决策日志（路线图第 3 步）
 *
 *  输入：harness --log 产出的 jsonl（每步决策：state、全部落点及
 *  其启发式分、Jev 的四个判断）。
 *
 *  术语纪律（CONTEXT.md）：启发式只是标注器。
 *    - 劣招标注 = Jev 所选落点与启发式最优落点分差超阈值，
 *      是待审查线索，不是失误定论。
 *    - next_piece_fits 的「准确率」对照的是下一步客观可复算的
 *      事实（是否存在不造洞落点），同样是标注而非真理。
 *
 *  分析维度（docs/roadmap.md 第 3 步）：
 *    1. 劣招标注分布（分差分位、按阶段/高度/块型/对局分组）
 *    2. 策略-行为一致性（选 survive 时是否真的选了保命落点…）
 *    3. next_piece_fits 判断准确率（对照下一步候选事实）
 *    4. 置信度与劣招的相关性
 *
 *  用法:
 *    node eval/diagnose.mjs [--log eval/runs/jev-v2.jsonl] [--threshold 1.0] [--out docs/xx.md]
 * ================================================================ */
import fs from "node:fs";

/* ---------- 参数 ---------- */
const args = { log: "eval/runs/jev-v2.jsonl", threshold: 1.0, out: "" };
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, "");
  if (!(k in args)) { console.error(`未知参数 --${k}`); process.exit(1); }
  args[k] = process.argv[i + 1];
}
const THRESHOLD = +args.threshold;

/* ---------- 读取与派生 ---------- */
const recs = fs.readFileSync(args.log, "utf8").trim().split("\n").map(JSON.parse);
for (const r of recs) {
  const best = r.candidates.reduce((b, p) => (p.heuristic > b.heuristic ? p : b));
  const ch = r.candidates.find(p => p.id === r.chosen) || r.candidates[0];
  r._gap = +(best.heuristic - ch.heuristic).toFixed(2); // ≥0，越大越劣（标注意义）
  r._blunder = r._gap > THRESHOLD;
  r._best = best; r._chosen = ch;
  r._maxH = Math.max(...r.state.column_heights_left_to_right);
  r._danger = r._maxH > 15; // 危高（CONTEXT.md）
}
const byGame = new Map();
for (const r of recs) {
  if (!byGame.has(r.seed)) byGame.set(r.seed, []);
  byGame.get(r.seed).push(r);
}

/* ---------- 小工具 ---------- */
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : "-");
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quantiles = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
};
const line = (label, n, total, extra = "") =>
  `| ${label} | ${n} | ${pct(n, total)} | ${extra} |`;
const ref = r => `seed ${r.seed} #${r.pieceNo}`;

const out = [];
const emit = s => out.push(s);

/* ================================================================
 * 0. 总览
 * ================================================================ */
const gaps = recs.map(r => r._gap);
const gq = quantiles(gaps);
const nBlunder = recs.filter(r => r._blunder).length;
const nAgree = recs.filter(r => r.agree).length;
emit(`# 失误诊断报告：${args.log}`);
emit(``);
emit(`- 决策记录 ${recs.length} 条，对局 ${byGame.size} 个（seeds ${[...byGame.keys()].join(", ")}）`);
emit(`- 劣招阈值：分差 > ${THRESHOLD}（Dellacherie 尺度：消一行 +0.76，一个洞 -0.36）`);
emit(`- 与启发式最优一致（agree）：${nAgree}/${recs.length}（${pct(nAgree, recs.length)}）`);
emit(`- 劣招标注：${nBlunder}/${recs.length}（${pct(nBlunder, recs.length)}）`);
emit(`- 分差分位：p50 ${gq.p50} / p75 ${gq.p75} / p90 ${gq.p90} / p95 ${gq.p95} / p99 ${gq.p99} / max ${gq.max}`);
emit(``);

/* ================================================================
 * 1. 劣招标注分布
 * ================================================================ */
emit(`## 1. 劣招标注分布`);
emit(``);
// 1a 按对局阶段（pieceNo 分桶）
emit(`### 1a 按阶段（pieceNo）`);
emit(``);
emit(`| 阶段 | 决策数 | 劣招数 | 劣招率 | 平均分差 |`);
emit(`|---|---|---|---|---|`);
const buckets = [[1, 50], [51, 100], [101, 150], [151, 200]];
for (const [lo, hi] of buckets) {
  const rs = recs.filter(r => r.pieceNo >= lo && r.pieceNo <= hi);
  if (!rs.length) continue;
  const b = rs.filter(r => r._blunder).length;
  emit(`| ${lo}-${hi} | ${rs.length} | ${b} | ${pct(b, rs.length)} | ${mean(rs.map(r => r._gap)).toFixed(2)} |`);
}
emit(``);
// 1b 按盘面高度
emit(`### 1b 按盘面高度（maxHeight，危高 > 15）`);
emit(``);
emit(`| 高度 | 决策数 | 劣招数 | 劣招率 | 平均分差 |`);
emit(`|---|---|---|---|---|`);
const hBands = [[0, 4, "很低 0-4"], [5, 8, "低 5-8"], [9, 12, "中 9-12"], [13, 15, "高 13-15"], [16, 20, "危高 16+"]];
for (const [lo, hi, label] of hBands) {
  const rs = recs.filter(r => r._maxH >= lo && r._maxH <= hi);
  if (!rs.length) continue;
  const b = rs.filter(r => r._blunder).length;
  emit(`| ${label} | ${rs.length} | ${b} | ${pct(b, rs.length)} | ${mean(rs.map(r => r._gap)).toFixed(2)} |`);
}
emit(``);
// 1c 按当前块型
emit(`### 1c 按当前块型`);
emit(``);
emit(`| 块型 | 决策数 | 劣招数 | 劣招率 | 平均分差 |`);
emit(`|---|---|---|---|---|`);
for (const t of ["I", "O", "T", "S", "Z", "J", "L"]) {
  const rs = recs.filter(r => r.piece === t);
  const b = rs.filter(r => r._blunder).length;
  emit(`| ${t} | ${rs.length} | ${b} | ${pct(b, rs.length)} | ${mean(rs.map(r => r._gap)).toFixed(2)} |`);
}
emit(``);
// 1d 按对局 + 临终段
emit(`### 1d 按对局与临终段`);
emit(``);
emit(`| 对局 | 决策数 | 劣招数 | 劣招率 | 临终 10 手劣招 |`);
emit(`|---|---|---|---|---|`);
for (const [seed, rs] of byGame) {
  const b = rs.filter(r => r._blunder).length;
  const tail = rs.slice(-10);
  const tb = tail.filter(r => r._blunder).length;
  emit(`| seed ${seed} | ${rs.length} | ${b} | ${pct(b, rs.length)} | ${tb}/10 |`);
}
emit(``);
// 1e 最差标注 top 10
emit(`### 1e 分差最大的 10 条标注（待人工审查线索，非定论）`);
emit(``);
emit(`| 决策 | 块 | 分差 | Jev 选择 | 启发式最优 |`);
emit(`|---|---|---|---|---|`);
const worst = [...recs].sort((a, b) => b._gap - a._gap).slice(0, 10);
for (const r of worst) {
  const cd = r._chosen.desc, bd = r._best.desc;
  emit(`| ${ref(r)} | ${r.piece} | ${r._gap} | ${cd.where}（${cd.lines_cleared}/${cd.holes_created}） | ${bd.where}（${bd.lines_cleared}/${bd.holes_created}） |`);
}
emit(``);

/* ================================================================
 * 2. 策略-行为一致性
 * ================================================================ */
// 行为判据：各策略宣称的事，所选落点是否兑现（由 desc 客观词判定）
const CONSISTENCY = {
  survive: r => ["stack gets lower", "stack does not get taller"].includes(r._chosen.desc.height_change),
  clear_lines: r => r._chosen.desc.lines_cleared !== "none",
  repair_surface: r => r._chosen.desc.holes_created === "none",
  build_clean: r => r._chosen.desc.holes_created === "none",
};
emit(`## 2. 策略-行为一致性`);
emit(``);
emit(`判据：survive → 堆不升高；clear_lines → 消了行；repair_surface / build_clean → 未造新洞。`);
emit(``);
emit(`| Jev 所报策略 | 次数 | 行为一致 | 一致率 | 其中劣招标注 |`);
emit(`|---|---|---|---|---|`);
for (const s of Object.keys(CONSISTENCY)) {
  const rs = recs.filter(r => r.answers.strategy === s);
  if (!rs.length) continue;
  const ok = rs.filter(CONSISTENCY[s]).length;
  const b = rs.filter(r => r._blunder).length;
  emit(`| ${s} | ${rs.length} | ${ok} | ${pct(ok, rs.length)} | ${b}（${pct(b, rs.length)}） |`);
}
emit(``);
// 危高时的策略选择
const danger = recs.filter(r => r._danger);
const dangerSurvive = danger.filter(r => r.answers.strategy === "survive");
emit(`### 2a 危高（maxHeight > 15）时的策略切换`);
emit(``);
emit(`- 危高决策 ${danger.length} 条，其中 Jev 报 survive：${dangerSurvive.length}（${pct(dangerSurvive.length, danger.length)}）`);
// 危高却未报 survive 时的代价
const dangerNotSurvive = danger.filter(r => r.answers.strategy !== "survive");
if (dangerNotSurvive.length) {
  const b = dangerNotSurvive.filter(r => r._blunder).length;
  emit(`- 危高却未报 survive：${dangerNotSurvive.length} 条，其中劣招标注 ${b}（${pct(b, dangerNotSurvive.length)}）`);
  const byStrat = {};
  for (const r of dangerNotSurvive) byStrat[r.answers.strategy] = (byStrat[r.answers.strategy] || 0) + 1;
  emit(`- 未切换时的策略分布：${Object.entries(byStrat).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}
emit(``);
// 2b 消行取舍：有消行选项时 Jev 是否消行；放弃时的代价
emit(`### 2b 消行取舍`);
emit(``);
const clearAvail = recs.filter(r => r.candidates.some(p => p.desc.lines_cleared !== "none"));
const missed = clearAvail.filter(r => r._chosen.desc.lines_cleared === "none");
emit(`- 有消行选项的决策 ${clearAvail.length} 条，Jev 放弃消行 ${missed.length}（${pct(missed.length, clearAvail.length)}）`);
if (missed.length) {
  const byPiece = {};
  for (const r of missed) byPiece[r.piece] = (byPiece[r.piece] || 0) + 1;
  emit(`- 放弃消行的块型分布：${Object.entries(byPiece).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  emit(`- 放弃消行的平均分差 ${mean(missed.map(r => r._gap)).toFixed(2)}（对照全体 ${mean(gaps).toFixed(2)}）`);
  emit(`- 明细：${missed.map(r => `${ref(r)}(${r.piece},差${r._gap})`).join("、")}`);
}
emit(``);
// 2c 造洞取舍：选造洞落点时是否存在无洞替代
emit(`### 2c 造洞取舍`);
emit(``);
const holeTaken = recs.filter(r => r._chosen.desc.holes_created !== "none");
const avoidable = holeTaken.filter(r => r.candidates.some(p => p.desc.holes_created === "none"));
emit(`- Jev 选造洞落点 ${holeTaken.length} 条，其中存在无洞替代 ${avoidable.length}（${pct(avoidable.length, holeTaken.length)}）`);
emit(`- 造洞决策的平均分差 ${mean(holeTaken.map(r => r._gap)).toFixed(2)}，其中劣招标注 ${holeTaken.filter(r => r._blunder).length} 条`);
emit(`- 注：priorities 本身允许「消行多 / 危高」时造洞，无洞替代可能在别的维度更差，此项只作灰色地带参考。`);
emit(``);

/* ================================================================
 * 3. next_piece_fits 判断准确率
 * ================================================================ */
// 对照事实（可复算标注）：同一对局下一手是否存在 holes_created 为 none 的落点
emit(`## 3. next_piece_fits 判断准确率`);
emit(``);
emit(`对照标注：下一手候选中存在「holes_created = none」的落点 → 客观上有干净位。noul ≥ 0.5 视为 Jev 判 true。`);
emit(``);
let tp = 0, tn = 0, fp = 0, fn = 0, skip = 0;
for (const r of recs) {
  const rs = byGame.get(r.seed);
  const nxt = rs.find(x => x.pieceNo === r.pieceNo + 1);
  if (!nxt) { skip++; continue; } // 对局最后一手，无下一步可对照
  const truth = nxt.candidates.some(p => p.desc.holes_created === "none");
  const pred = r.answers.next_piece_fits >= 0.5;
  if (pred && truth) tp++; else if (pred && !truth) fp++;
  else if (!pred && truth) fn++; else tn++;
}
const total = tp + tn + fp + fn;
emit(`| | 客观有干净位 | 客观无干净位 |`);
emit(`|---|---|---|`);
emit(`| Jev 判 true | ${tp} | ${fp} |`);
emit(`| Jev 判 false | ${fn} | ${tn} |`);
emit(``);
emit(`- 准确率 ${pct(tp + tn, total)}（${tp + tn}/${total}，跳过对局末手 ${skip} 条）`);
emit(`- 误报（判 true 实际无）：${fp}；漏报（判 false 实际有）：${fn}`);
emit(``);

/* ================================================================
 * 4. 置信度与劣招的相关性
 * ================================================================ */
emit(`## 4. 置信度与劣招的相关性`);
emit(``);
emit(`| 置信度区间 | 决策数 | 劣招数 | 劣招率 | 平均分差 |`);
emit(`|---|---|---|---|---|`);
const cBands = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]];
for (const [lo, hi] of cBands) {
  const rs = recs.filter(r => r.answers.placement.confidence >= lo && r.answers.placement.confidence < hi);
  if (!rs.length) continue;
  const b = rs.filter(r => r._blunder).length;
  emit(`| ${lo.toFixed(1)}-${Math.min(hi, 1).toFixed(1)} | ${rs.length} | ${b} | ${pct(b, rs.length)} | ${mean(rs.map(r => r._gap)).toFixed(2)} |`);
}
emit(``);
const agreeRs = recs.filter(r => r.agree), blunderRs = recs.filter(r => r._blunder);
const disagreeRs = recs.filter(r => !r.agree && !r._blunder);
emit(`- 平均置信度：一致 ${mean(agreeRs.map(r => r.answers.placement.confidence)).toFixed(2)} / 分歧但非劣招 ${mean(disagreeRs.map(r => r.answers.placement.confidence)).toFixed(2)} / 劣招标注 ${mean(blunderRs.map(r => r.answers.placement.confidence)).toFixed(2)}`);
const overconf = recs.filter(r => r._blunder && r.answers.placement.confidence >= 0.8);
emit(`- 高置信（≥0.8）劣招：${overconf.length} 条（占全部劣招 ${pct(overconf.length, nBlunder)}）`);
if (overconf.length) emit(`  - ${overconf.map(r => `${ref(r)}(${r.piece},差${r._gap},置${r.answers.placement.confidence})`).join("、")}`);
emit(``);

/* ================================================================
 * 5. 临终段复盘（每局最后 15 手）
 * ================================================================ */
emit(`## 5. 临终段复盘（每局最后 15 手）`);
emit(``);
emit(`| 对局 | 临终劣招 | 临终策略序列（→ 死） | 临终 maxHeight 轨迹 |`);
emit(`|---|---|---|---|`);
for (const [seed, rs] of byGame) {
  const tail = rs.slice(-15);
  const tb = tail.filter(r => r._blunder).length;
  const strats = tail.map(r => ({ build_clean: "B", clear_lines: "C", repair_surface: "R", survive: "S" })[r.answers.strategy]).join("");
  const hs = tail.map(r => r._maxH).join(",");
  emit(`| seed ${seed} | ${tb}/15 | ${strats} | ${hs} |`);
}
emit(``);
emit(`（B=build_clean C=clear_lines R=repair_surface S=survive）`);
emit(``);

/* ---------- 输出 ---------- */
const report = out.join("\n");
if (args.out) { fs.writeFileSync(args.out, report); console.error(`报告已写入 ${args.out}`); }
else console.log(report);

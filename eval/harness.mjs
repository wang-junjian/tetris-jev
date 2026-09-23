#!/usr/bin/env node
/* ================================================================
 *  Tetris × Jev 评估工具 —— 固定种子批量对局
 *
 *  用途：所有改动的回归基准（主指标：消行数 / 存活块数 / 最差对局）。
 *  玩家：
 *    heuristic  对照玩家（Dellacherie 权重，仅作标尺 —— ADR 0001）
 *    random     随机对照（ seeded ）
 *    jev        Jev 判断驱动（需要 TYPESAFE_API_KEY，直连 api.typesafe.ai）
 *
 *  用法:
 *    node eval/harness.mjs --player heuristic [--games 100] [--seed-start 0] [--max-pieces 500]
 *    node eval/harness.mjs --player random --games 100
 *    TYPESAFE_API_KEY=sk-... node eval/harness.mjs --player jev --games 20 \
 *        [--model jev-latest] [--log eval/runs/jev-v2.jsonl] [--chain 1]
 *
 *  --chain 1 开启判断链实验（先 strategy 后落点两跳；2026-09-23 验证为回退，默认关闭）。
 *
 *  --log 记录每步决策（state、全部落点及其启发式分、Jev 答案），
 *  供离线劣招标注与失误诊断使用（诊断脚本见 eval/diagnose.mjs）。
 * ================================================================ */
import fs from "node:fs";
import path from "node:path";
import {
  Engine, mulberry32, enumeratePlacements, gridStats,
  buildState, buildQuestions, buildStrategyQuestions, buildPlacementQuestions, STRATEGY_OPTIONS,
} from "../engine.js";

/* ---------- 参数 ---------- */
const args = { player: "heuristic", games: 100, "seed-start": 0, "max-pieces": 500, model: "jev-latest", log: "", chain: "" };
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, "");
  if (!(k in args)) { console.error(`未知参数 --${k}`); process.exit(1); }
  args[k] = process.argv[i + 1];
}
args.games = +args.games; args["seed-start"] = +args["seed-start"]; args["max-pieces"] = +args["max-pieces"];

/* ---------- 玩家 ---------- */
// 对照玩家：取启发式最高分（标尺角色，不进 Jev 决策路径）
function heuristicDecide(engine, placements) {
  return placements.reduce((b, p) => (p.heuristic > b.heuristic ? p : b), placements[0]);
}
function randomDecideFactory(rng) {
  return (engine, placements) => placements[Math.floor(rng() * placements.length)];
}
// Jev API 调用（直连 api.typesafe.ai，429/529 与网络错误指数退避重试）
async function askJev(body, key) {
  const maxRetry = 6;
  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // 网络层错误（对端断连 / TLS 重置等）：指数退避重试
      if (attempt < maxRetry) {
        const wait = 1000 * 2 ** attempt;
        process.stderr.write(`  网络错误(${err.cause?.code || err.message})，${wait / 1000}s 后重试 (${attempt + 1}/${maxRetry})\n`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
    if ((resp.status === 429 || resp.status === 529) && attempt < maxRetry) {
      const ra = Number(resp.headers.get("retry-after"));
      await new Promise(r => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt));
      continue;
    }
    if (!resp.ok) {
      let detail = "";
      try { const b = await resp.json(); detail = b?.detail?.message || JSON.stringify(b); } catch { detail = resp.statusText; }
      throw new Error(`HTTP ${resp.status}: ${detail}`);
    }
    return resp.json();
  }
}
// Jev 玩家：默认单请求模式（v3 词化，当前最强配置）；
// --chain 1 开启判断链实验（路线图第 5 步）：第一跳先问 strategy
// （board_health / next_piece_fits 作投机问题随附，仅进日志），
// 把 Jev 自己的回答原样喂回第二跳 state 的 game.chosen_strategy，再问落点。
// 代码只传话，不改写回答 —— ADR 0001 边界内。
// 注：2026-09-23 验证判断链为回退（v4 均值 50.5 行 vs v3 71.5），默认关闭。
function jevDecideFactory(key, model, log, chain) {
  return async (engine, placements, ctx) => {
    // 第一跳（仅判断链模式）：strategy
    let d1 = null, msStrategy = 0, strategy;
    if (chain) {
      const t0 = performance.now();
      d1 = await askJev({ state: buildState(engine), model, questions: buildStrategyQuestions() }, key);
      msStrategy = Math.round(performance.now() - t0);
      strategy = d1.answers.strategy?.choice;
    }
    // 第二跳（判断链）/ 唯一一跳（默认）：placement
    const state = buildState(engine, { strategy: strategy ? `${strategy}: ${STRATEGY_OPTIONS[strategy]}` : undefined });
    const questions = chain ? buildPlacementQuestions(placements) : buildQuestions(placements);
    const t1 = performance.now();
    const d2 = await askJev({ state, model, questions }, key);
    const msPlacement = Math.round(performance.now() - t1);
    const a = d2.answers.placement;
    const byId = new Map(placements.map(p => [p.id, p]));
    const chosen = byId.get(a.choice) || placements[0];
    const hBest = placements.reduce((b, p) => (p.heuristic > b.heuristic ? p : b), placements[0]);
    log?.write(JSON.stringify({
      ...ctx, ms: msStrategy + msPlacement, ...(chain ? { ms_strategy: msStrategy, ms_placement: msPlacement } : {}),
      tokens: (d1 ? (d1.usage?.input_tokens || 0) + (d1.usage?.output_tokens || 0) : 0)
            + ((d2.usage?.input_tokens || 0) + (d2.usage?.output_tokens || 0)),
      piece: engine.cur.type, next: engine.nextType,
      state: state.game,
      candidates: placements.map(p => ({ id: p.id, rot: p.rot, x: p.x, heuristic: +p.heuristic.toFixed(2), desc: questions.placement.criteria[p.id] })),
      answers: {
        placement: { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities },
        strategy: chain ? strategy : d2.answers.strategy?.choice,
        board_health: (d1 || d2).answers.board_health?.score,
        next_piece_fits: (d1 || d2).answers.next_piece_fits?.noul,
      },
      chosen: chosen.id, heuristic_best: hBest.id, agree: chosen.id === hBest.id,
    }) + "\n");
    return chosen;
  };
}

/* ---------- 单局 ---------- */
function executePlacement(engine, p) {
  // 传送到枚举验证过的合法姿态（rot, x, y=0 无碰撞），再硬降
  engine.cur.rot = p.rot; engine.cur.x = p.x; engine.cur.y = 0;
  engine.hardDrop();
}
async function playGame(seed, decide, maxPieces, log) {
  const engine = new Engine({ seed });
  engine.start(); engine.setGravity(false);
  let pieces = 0;
  while (!engine.over && pieces < maxPieces) {
    const placements = enumeratePlacements(engine);
    if (!placements.length) { engine.hardDrop(); pieces++; continue; }
    const p = await decide(engine, placements, { seed, pieceNo: pieces + 1 });
    if (!p) { engine.hardDrop(); pieces++; continue; }
    executePlacement(engine, p);
    pieces++;
    if (log && pieces % 25 === 0) process.stderr.write(`  seed ${seed}: ${pieces} pieces, ${engine.lines} lines\r`);
  }
  const end = gridStats(engine.grid);
  return {
    seed, lines: engine.lines, score: engine.score, pieces,
    toppedOut: engine.over, endMaxHeight: end.maxHeight, endHoles: end.holes,
  };
}

/* ---------- 汇总 ---------- */
function quantiles(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, median: q(0.5), p10: q(0.1), min: s[0], max: s[s.length - 1] };
}
const fmt = (name, st) =>
  `${name.padEnd(7)} mean ${st.mean.toFixed(1).padStart(7)}  median ${String(st.median).padStart(5)}  p10 ${String(st.p10).padStart(5)}  min ${String(st.min).padStart(4)}  max ${String(st.max).padStart(5)}`;

/* ---------- 主流程 ---------- */
let log = null;
if (args.log) {
  fs.mkdirSync(path.dirname(args.log), { recursive: true });
  log = fs.createWriteStream(args.log);
}
let decide;
if (args.player === "heuristic") decide = heuristicDecide;
else if (args.player === "random") { const rng = mulberry32(0xC0FFEE); decide = randomDecideFactory(rng); }
else if (args.player === "jev") {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) { console.error("需要 TYPESAFE_API_KEY 环境变量"); process.exit(1); }
  decide = jevDecideFactory(key, args.model, log, !!args.chain);
} else { console.error(`未知玩家 ${args.player}`); process.exit(1); }

const results = [];
for (let g = 0; g < args.games; g++) {
  const seed = args["seed-start"] + g;
  results.push(await playGame(seed, decide, args["max-pieces"], log));
  if (args.player === "jev") console.error(`game ${g + 1}/${args.games}  seed ${seed}  lines ${results[g].lines}  pieces ${results[g].pieces}`);
}
log?.end();

const capped = results.filter(r => !r.toppedOut).length;
console.log(`\nplayer=${args.player}  games=${args.games}  seeds=${args["seed-start"]}..${args["seed-start"] + args.games - 1}  maxPieces=${args["max-pieces"]}`);
console.log(fmt("lines", quantiles(results.map(r => r.lines))));
console.log(fmt("pieces", quantiles(results.map(r => r.pieces))));
console.log(`top-out ${results.length - capped}/${results.length} 局（${capped} 局打满 ${args["max-pieces"]} 块未死）`);
const worst = [...results].sort((a, b) => a.lines - b.lines).slice(0, 5);
console.log("最差 5 局: " + worst.map(r => `seed ${r.seed} (${r.lines} 行/${r.pieces} 块)`).join(", "));

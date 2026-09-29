#!/usr/bin/env node
/**
 * 单局完整录制 —— 用真实 Jev 玩一局，记录每次调用的完整输入/输出
 *
 * 与 harness.mjs 的 --log 不同：这里记录完整的请求体（state + questions）
 * 与完整响应体（answers + usage），以及落子前后的棋盘，供生成可交互的
 * 逐步回放 HTML 报告（eval/trace_to_html.mjs）。
 *
 * 用法:
 *   source ~/.zshrc   # 需要 TYPESAFE_API_KEY
 *   node eval/trace_game.mjs [--seed 0] [--url https://api.typesafe.ai] \
 *        [--model jev-latest] [--max-pieces 500] [--out eval/runs/trace-seed0.json]
 */
import fs from "node:fs";
import path from "node:path";
import { Engine, enumeratePlacements, describePlacements, buildState, buildQuestions, STRATEGY_OPTIONS } from "../engine.js";

const args = { seed: 0, "max-pieces": 500, model: "jev-latest", url: "https://api.typesafe.ai", out: "" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
args.seed = Number(args.seed); args["max-pieces"] = Number(args["max-pieces"]);
if (!args.out) args.out = `eval/runs/trace-seed${args.seed}-${Date.now()}.json`;

const KEY = process.env.TYPESAFE_API_KEY || "";
if (!KEY && args.url.includes("typesafe.ai")) { console.error("需要 TYPESAFE_API_KEY（source ~/.zshrc）"); process.exit(1); }

async function askJev(body) {
  const maxRetry = 6;
  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = await fetch(args.url + "/v1/systemone", {
        method: "POST",
        headers: { ...(KEY ? { Authorization: "Bearer " + KEY } : {}), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < maxRetry) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
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

const engine = new Engine({ seed: args.seed });
engine.start(); engine.setGravity(false);

const steps = [];
let pieces = 0;
const t0all = Date.now();
while (!engine.over && pieces < args["max-pieces"]) {
  const placements = enumeratePlacements(engine);
  if (!placements.length) { engine.hardDrop(); pieces++; continue; }
  const boardBefore = engine.grid.map(r => r.join(""));
  const body = { state: buildState(engine), model: args.model, questions: buildQuestions(placements) };
  const t0 = performance.now();
  const resp = await askJev(body);
  const ms = Math.round(performance.now() - t0);
  const a = resp.answers.placement;
  const byId = new Map(placements.map(p => [p.id, p]));
  const chosen = byId.get(a.choice) || placements[0];
  const hBest = placements.reduce((b, p) => (p.heuristic > b.heuristic ? p : b), placements[0]);
  // 执行落子
  engine.cur.rot = chosen.rot; engine.cur.x = chosen.x; engine.cur.y = 0;
  const lock = engine.hardDrop();
  pieces++;
  steps.push({
    pieceNo: pieces, piece: chosen.type, nextPiece: body.state.game.next_piece,
    boardBefore,
    boardAfter: engine.grid.map(r => r.join("")),
    linesAfter: engine.lines, scoreAfter: engine.score,
    linesClearedByMove: lock.cleared,
    request: body, response: resp,
    ms, tokens: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
    chosen: chosen.id, chosenRot: chosen.rot, chosenX: chosen.x,
    heuristicBest: hBest.id, agree: chosen.id === hBest.id,
    candidates: placements.map(p => ({ id: p.id, rot: p.rot, x: p.x, heuristic: +p.heuristic.toFixed(2), desc: body.questions.placement.criteria[p.id] })),
  });
  process.stderr.write(`  piece ${pieces}: ${chosen.type} -> ${chosen.id} conf ${(a.confidence * 100).toFixed(0)}% ${ms}ms, lines ${engine.lines}\n`);
}

const trace = {
  meta: {
    game: "Tetris × Jev 单局完整录制",
    backend: args.url, model: args.model, seed: args.seed,
    date: new Date().toISOString(),
    mode: "placement（单请求，placement 主问题 + strategy/board_health/next_piece_fits 投机问题）",
    pieces, lines: engine.lines, score: engine.score,
    gameOver: engine.over, durationSec: Math.round((Date.now() - t0all) / 1000),
    strategyOptions: STRATEGY_OPTIONS,
  },
  steps,
};
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(trace, null, 2));
console.log(`\n完成: ${pieces} 块, ${engine.lines} 行, score ${engine.score}, ${trace.meta.durationSec}s`);
console.log(`trace -> ${args.out}`);

"use strict";
/* ================================================================
 *  Tetris × Jev —— 共享引擎（浏览器 / Node 通用，零依赖 ES module）
 *
 *  职责边界（见 docs/adr/0001）：代码只枚举、模拟、词化，不估值。
 *  - 引擎：棋盘、7-bag（可注入种子）、旋转、消行、计分
 *  - 评估计算：落点枚举、局面统计、词化（数字转词 + 显著事实）
 *  - Jev 问题构造：单请求模式（默认，v3）+ 判断链两跳（实验，strategy → placement）
 *
 *  heuristicScore 只允许用于对照玩家与离线劣招标注，永不进入决策路径。
 * ================================================================ */

export const COLS = 10, ROWS = 20;

/* ---------- 方块定义 ---------- */
const BASE = {
  I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  O: [[1,1],[1,1]],
  T: [[0,1,0],[1,1,1],[0,0,0]],
  S: [[0,1,1],[1,1,0],[0,0,0]],
  Z: [[1,1,0],[0,1,1],[0,0,0]],
  J: [[1,0,0],[1,1,1],[0,0,0]],
  L: [[0,0,1],[1,1,1],[0,0,0]],
};
export const SHAPES = {};
for (const t of Object.keys(BASE)) {
  SHAPES[t] = [];
  let m = BASE[t];
  for (let r = 0; r < 4; r++) {
    SHAPES[t].push(m);
    m = m[0].map((_, i) => m.map(row => row[i]).reverse());
  }
}
const KICKS = [0, -1, 1, -2, 2];
const LINE_SCORES = [0, 100, 300, 500, 800];

/* ---------- 确定性随机（评估工具需要固定种子的 7-bag） ---------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 引擎（纯逻辑，无 DOM） ---------- */
export class Engine {
  constructor(opts = {}) {
    this.gravityOn = true; this.listeners = {};
    this.rng = opts.rng || (opts.seed != null ? mulberry32(opts.seed) : Math.random);
    this.reset();
  }
  on(evt, cb) { (this.listeners[evt] ||= []).push(cb); }
  _emit(evt, data) { (this.listeners[evt] || []).forEach(cb => { try { cb(data); } catch {} }); }
  reset() {
    this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill("."));
    this.score = 0; this.lines = 0; this.level = 1;
    this.over = false; this.started = false; this.paused = false;
    this.bag = [];
    this.cur = null; this.nextType = this._draw();
    this._spawn();
  }
  _draw() {
    if (!this.bag.length) {
      this.bag = ["I","O","T","S","Z","J","L"];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }
  _spawn() {
    const type = this.nextType; this.nextType = this._draw();
    const m = SHAPES[type][0];
    this.cur = { type, rot: 0, x: Math.floor((COLS - m[0].length) / 2), y: type === "I" ? -1 : 0 };
    if (this._collides(m, this.cur.x, this.cur.y)) {
      this.over = true; this._emit("gameover", { score: this.score });
    }
  }
  _collides(m, px, py) {
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
      if (!m[y][x]) continue;
      const gx = px + x, gy = py + y;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
      if (gy >= 0 && this.grid[gy][gx] !== ".") return true;
    }
    return false;
  }
  move(dx) {
    if (!this.cur || this.over) return { ok: false, moved: false };
    const m = SHAPES[this.cur.type][this.cur.rot];
    if (this._collides(m, this.cur.x + dx, this.cur.y)) return { ok: true, moved: false };
    this.cur.x += dx;
    return { ok: true, moved: true };
  }
  rotate(dir = 1) {
    if (!this.cur || this.over) return { ok: false, moved: false };
    if (this.cur.type === "O") return { ok: true, moved: true };
    const nr = (this.cur.rot + dir + 4) % 4;
    const m = SHAPES[this.cur.type][nr];
    let x = -1;
    for (const d of KICKS) if (!this._collides(m, this.cur.x + d, this.cur.y)) { x = this.cur.x + d; break; }
    if (x < 0) return { ok: true, moved: false };
    this.cur.x = x; this.cur.rot = nr;
    return { ok: true, moved: true };
  }
  softDrop() {
    if (!this.cur || this.over) return { ok: false, moved: false };
    const m = SHAPES[this.cur.type][this.cur.rot];
    if (!this._collides(m, this.cur.x, this.cur.y + 1)) { this.cur.y++; this.score += 1; return { ok: true, moved: true }; }
    return this._lock();
  }
  hardDrop() {
    if (!this.cur || this.over) return { ok: false, moved: false };
    const m = SHAPES[this.cur.type][this.cur.rot];
    let dist = 0;
    while (!this._collides(m, this.cur.x, this.cur.y + 1)) { this.cur.y++; dist++; }
    this.score += dist * 2;
    return this._lock();
  }
  ghostY() {
    if (!this.cur) return 0;
    const m = SHAPES[this.cur.type][this.cur.rot];
    let y = this.cur.y;
    while (!this._collides(m, this.cur.x, y + 1)) y++;
    return y;
  }
  _lock() {
    const m = SHAPES[this.cur.type][this.cur.rot];
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
      if (m[y][x]) {
        const gy = this.cur.y + y, gx = this.cur.x + x;
        if (gy >= 0) this.grid[gy][gx] = this.cur.type;
      }
    }
    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (this.grid[y].every(c => c !== ".")) {
        this.grid.splice(y, 1);
        this.grid.unshift(Array(COLS).fill("."));
        cleared++; y++;
      }
    }
    if (cleared) {
      this.score += LINE_SCORES[cleared] * this.level;
      this.lines += cleared;
      this.level = Math.floor(this.lines / 10) + 1;
      this._emit("lineclear", { cleared });
    }
    this._spawn();
    const r = { ok: true, moved: true, locked: true, cleared };
    this._emit("lock", r);
    return r;
  }
  gravityTick() {
    if (!this.cur || this.over) return;
    const m = SHAPES[this.cur.type][this.cur.rot];
    if (!this._collides(m, this.cur.x, this.cur.y + 1)) this.cur.y++;
    else this._lock();
  }
  start() { this.started = true; }
  setGravity(on) { this.gravityOn = on; }
  applyAction(action) {
    if (this.over) return { ok: false, gameOver: true };
    if (!this.started) this.start();
    let r;
    switch (action) {
      case "left":       r = this.move(-1); break;
      case "right":      r = this.move(1);  break;
      case "rotate":     r = this.rotate(1);  break;
      case "rotate_ccw": r = this.rotate(-1); break;
      case "soft_drop":  r = this.softDrop(); break;
      case "hard_drop":  r = this.hardDrop(); break;
      default: return { ok: false, error: "unknown action: " + action };
    }
    return { ...r, gameOver: this.over };
  }
  getState() {
    return {
      cols: COLS, rows: ROWS,
      grid: this.grid.map(r => r.join("")),
      current: this.cur ? { type: this.cur.type, rotation: this.cur.rot, col: this.cur.x, row: this.cur.y } : null,
      next: this.nextType,
      score: this.score, lines: this.lines, level: this.level,
      gameOver: this.over, paused: this.paused,
    };
  }
  getStateText() {
    const L = [];
    L.push(`Board ${COLS} columns x ${ROWS} rows (row 0 = top). '.' = empty; letters = frozen blocks.`);
    this.grid.forEach((row, i) => L.push(`row${String(i).padStart(2, "0")}: ${row.join("")}`));
    const c = this.cur;
    L.push("");
    L.push(`Current piece: ${c.type}, rotation ${c.rot}, top-left at column ${c.x}, row ${c.y}. Four rotations (bounding boxes, '#' = cells):`);
    SHAPES[c.type].forEach((m, r) => { L.push(`rot${r}:`); m.forEach(row => L.push("  " + row.map(v => v ? "#" : ".").join(""))); });
    L.push(`Next piece: ${this.nextType}`);
    L.push(`Score: ${this.score}, Lines cleared: ${this.lines}, Level: ${this.level}`);
    return L.join("\n");
  }
}

/* ================================================================
 *  落点枚举 + 模拟评估（纯函数，代码负责一切确定性计算）
 *  设计参考 trungdq88/jev-tetris public/tetris.js
 * ================================================================ */
function collidesGrid(grid, m, px, py) {
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
    if (!m[y][x]) continue;
    const gx = px + x, gy = py + y;
    if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
    if (gy >= 0 && grid[gy][gx] !== ".") return true;
  }
  return false;
}
export function gridStats(grid) {
  const heights = new Array(COLS).fill(0);
  for (let x = 0; x < COLS; x++)
    for (let y = 0; y < ROWS; y++) if (grid[y][x] !== ".") { heights[x] = ROWS - y; break; }
  let holes = 0;
  for (let x = 0; x < COLS; x++) {
    let covered = false;
    for (let y = 0; y < ROWS; y++) {
      if (grid[y][x] !== ".") covered = true;
      else if (covered) holes++;
    }
  }
  let bump = 0;
  for (let x = 0; x < COLS - 1; x++) bump += Math.abs(heights[x] - heights[x + 1]);
  const wells = [];
  for (let x = 0; x < COLS; x++) {
    const left = x === 0 ? Infinity : heights[x - 1];
    const right = x === COLS - 1 ? Infinity : heights[x + 1];
    const d = Math.min(left, right) - heights[x];
    if (d >= 3) wells.push({ column: x, depth: d });
  }
  return { heights, maxHeight: Math.max(...heights), aggregateHeight: heights.reduce((a, b) => a + b, 0), holes, bumpiness: bump, wells };
}
function clearGridRows(grid) {
  const kept = grid.filter(r => r.some(c => c === ".")).map(r => r.slice());
  const cleared = ROWS - kept.length;
  while (kept.length < ROWS) kept.unshift(Array(COLS).fill("."));
  return { grid: kept, cleared };
}
// —— 数字转词：Jev 读文本强于算术（官方 jaggedness notes）——
export function describeLines(n) { return ["none", "one line", "two lines", "three lines", "four lines (a Tetris)"][n] ?? `${n} lines`; }
export function describeHoles(n) { return n === 0 ? "none" : n === 1 ? "one hole" : n === 2 ? "two holes" : "three or more holes"; }
export function describeHeight(h) {
  if (h <= 4) return "very low"; if (h <= 8) return "low"; if (h <= 12) return "medium";
  if (h <= 15) return "high"; return "dangerously high, close to the top";
}
export function describeSurface(b) { return b <= 4 ? "flat" : b <= 9 ? "slightly uneven" : b <= 16 ? "bumpy" : "very jagged"; }
export function describeWells(list) {
  if (!list.length) return "no deep wells";
  if (list.length === 1) return `one deep well at column ${list[0].column + 1}`;
  return `${list.length} deep wells`;
}
// 仅对照玩家 / 离线劣招标注使用（ADR 0001：禁止进入 Jev 决策路径）
export function heuristicScore(after, linesCleared) {
  return -0.51 * after.aggregateHeight + 0.76 * linesCleared - 0.36 * after.holes - 0.18 * after.bumpiness;
}
// 枚举当前方块的每个合法落点（rotation × column），模拟锁定后的结果
// 注意：旋转矩阵保留了空边框（如竖直 I 的条在第 2 列），
// 必须按方块实际占据的列范围枚举，否则会漏掉贴墙落点（如竖 I 在 column 0）
export function enumeratePlacements(engine) {
  const type = engine.cur.type;
  const before = gridStats(engine.grid);
  const seen = new Set();
  const placements = [];
  SHAPES[type].forEach((m, rot) => {
    // 归一化：矩阵内方块实际占据的列范围 [offX, offX+width)
    let offX = 0;
    while (offX < m[0].length && m.every(row => !row[offX])) offX++;
    let endX = m[0].length;
    while (endX > offX && m.every(row => !row[endX - 1])) endX--;
    const width = endX - offX;
    if (width <= 0) return;
    for (let xa = 0; xa <= COLS - width; xa++) {
      const x = xa - offX; // 引擎坐标（矩阵左上角），可为负
      if (collidesGrid(engine.grid, m, x, 0)) continue;
      let y = 0;
      while (!collidesGrid(engine.grid, m, x, y + 1)) y++;
      const locked = engine.grid.map(r => r.slice());
      for (let my = 0; my < m.length; my++) for (let mx = 0; mx < m[my].length; mx++)
        if (m[my][mx] && y + my >= 0) locked[y + my][x + mx] = type;
      const key = locked.map(r => r.join("")).join("/");
      if (seen.has(key)) continue; // 不同旋转产生相同结果（O/I/S/Z）
      seen.add(key);
      const { grid: afterGrid, cleared } = clearGridRows(locked);
      const after = gridStats(afterGrid);
      const p = {
        id: `p${placements.length}`,
        type, rot, x, y,
        colLeft: xa, colRight: xa + width - 1, // 实际占据列（0-indexed，含）
        linesCleared: cleared,
        holesCreated: Math.max(0, after.holes - before.holes),
        holesRemoved: Math.max(0, before.holes - after.holes),
        heightDelta: after.maxHeight - before.maxHeight,
        after,
      };
      p.heuristic = heuristicScore(after, cleared);
      placements.push(p);
    }
  });
  return placements;
}
// 数字转词（显著事实中的计数，Jev 读词强于读数）
const NUM_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const numWord = n => (n <= 10 ? NUM_WORDS[n] : String(n));
// Choice criteria 条目：每个落点一个对象，字段名跨选项一致，全部用词不用数
export function describePlacement(p) {
  const left = p.colLeft + 1, right = p.colRight + 1; // 1-indexed，按实际占据列
  const where = left === right ? `column ${left}` : `columns ${left}-${right}`;
  let hChange;
  if (p.linesCleared > 0 && p.heightDelta < 0) hChange = "stack gets lower";
  else if (p.heightDelta <= 0) hChange = "stack does not get taller";
  else if (p.heightDelta === 1) hChange = "stack grows by one row";
  else hChange = "stack grows by several rows";
  return {
    where,
    lines_cleared: describeLines(p.linesCleared),
    holes_created: describeHoles(p.holesCreated),
    holes_uncovered: p.holesRemoved > 0 ? describeHoles(p.holesRemoved) : "none",
    stack_height_after: describeHeight(p.after.maxHeight),
    height_change: hChange,
    surface_after: describeSurface(p.after.bumpiness),
    wells_after: describeWells(p.after.wells),
  };
}
// 显著事实（CONTEXT.md）：跨落点的客观比较事实（唯一 / 最高 / 最低 / 排名），
// 全部由候选落点数据复算，不含方向性评价 —— ADR 0001 边界内。
// 动机见 docs/jev-v2-failure-patterns.md P1/P2：消行能力埋在普通字段里被忽视。
// 返回 { id: desc }，desc 在 describePlacement 基础上按需追加 salient_facts 数组。
export function describePlacements(placements) {
  const descs = {};
  for (const p of placements) descs[p.id] = describePlacement(p);
  const clearers = placements.filter(p => p.linesCleared > 0);
  const holeFree = placements.filter(p => p.holesCreated === 0);
  const minH = Math.min(...holeFree.map(p => p.after.maxHeight));
  const lowest = holeFree.filter(p => p.after.maxHeight === minH);
  for (const p of placements) {
    const facts = [];
    if (p.linesCleared > 0) {
      if (clearers.length === 1) facts.push("the only placement that clears a line");
      else facts.push(`one of the ${numWord(clearers.length)} placements that clear lines`);
      const maxClear = Math.max(...clearers.map(q => q.linesCleared));
      if (maxClear > 1 && p.linesCleared === maxClear && clearers.every(q => q === p || q.linesCleared < maxClear))
        facts.push("clears the most lines of any placement");
    }
    if (p.holesCreated === 0 && holeFree.length > 1) {
      if (lowest.length === 1 && lowest[0] === p)
        facts.push(`the lowest stack among the ${numWord(holeFree.length)} hole-free placements`);
      else if (lowest.length > 1 && lowest.length <= 3 && lowest.includes(p))
        // 并列只在小集团（≤3）内报告：大集团并列无区分度，反而是噪音
        facts.push(`tied for the lowest stack among the ${numWord(holeFree.length)} hole-free placements`);
    }
    if (p.holesCreated === 0 && holeFree.length === 1)
      facts.push("the only placement that creates no holes");
    if (facts.length) descs[p.id].salient_facts = facts;
  }
  return descs;
}
// Jev 的 placement 问题：priorities 列表即权重，想改风格改这里
export const PLACEMENT_PRIORITIES = [
  "Clearing lines is good. Clearing more lines at once is better.",
  "Do not create holes. A placement with holes_created of none beats one that creates holes, unless the one with holes clears far more lines or the stack is dangerously high.",
  "Keep the stack low. Prefer a lower stack_height_after and a height_change that does not grow the stack.",
  "Keep the surface flat. Prefer surface_after of flat over slightly uneven, bumpy, or very jagged.",
  "One deep well is acceptable because the next I piece can fill it. Several deep wells are bad.",
  "When the stack is dangerously high, survival matters more than a clean surface.",
];
export const STRATEGY_OPTIONS = {
  build_clean: "The stack is low and tidy. Keep building a flat surface and wait for a chance to clear several lines at once.",
  clear_lines: "Lines can be cleared soon. Take clears as they come and keep the stack from growing.",
  repair_surface: "The surface is jagged or has holes. Prefer placements that smooth it out or uncover holes, even without clearing lines.",
  survive: "The stack is close to the top. Take any placement that lowers or does not raise the stack, even if it is ugly.",
};
export const HEALTH_LEVELS = [
  "Clean: low, flat stack with no holes",
  "Fine: some unevenness or a hole or two, plenty of room",
  "Rough: several holes or a jagged surface, room is shrinking",
  "Critical: stack near the top, the game may be lost within a few pieces",
];
export function buildState(engine, opts = {}) {
  const stats = gridStats(engine.grid);
  const game = {
    rules: "Standard Tetris. Board is 10 columns wide and 20 rows tall. Rows fill left to right; a full row disappears. The game is lost when the stack reaches the top.",
    board_rows_top_to_bottom: engine.grid.map(r => r.join("")),
    legend: "# is a filled cell, . is an empty cell. The first row is the top of the board.",
    column_heights_left_to_right: stats.heights,
    stack_height: describeHeight(stats.maxHeight),
    holes_in_stack: describeHoles(stats.holes),
    surface: describeSurface(stats.bumpiness),
    current_piece: engine.cur.type,
    next_piece: engine.nextType,
    lines_cleared_so_far: engine.lines,
  };
  // 判断链第二跳专用：Jev 自己的 strategy 回答原样喂回（代码只传话，不改写）
  if (opts.strategy) game.chosen_strategy = opts.strategy;
  return { game };
}
// 单请求模式（v3 词化，当前默认）：placement 主问题 + strategy/health/fits 投机问题
export function buildQuestions(placements) {
  const criteria = describePlacements(placements); // 含显著事实，日志记录同一版本
  return {
    placement: {
      type: "choice",
      instructions: {
        question: "Which placement of `game.current_piece` should the player choose? Each option describes the board after that placement.",
        priorities: PLACEMENT_PRIORITIES,
      },
      criteria,
    },
    strategy: {
      type: "choice",
      instructions: "Looking at `game`, which strategy fits the current situation best for the next few pieces?",
      criteria: STRATEGY_OPTIONS,
    },
    board_health: {
      type: "score",
      instructions: "How healthy is the stack in `game` for a Tetris player who wants to keep playing for a long time?",
      criteria: HEALTH_LEVELS,
    },
    next_piece_fits: {
      type: "noul",
      instructions: "Given `game.column_heights_left_to_right` and `game.surface`, is there an obvious clean spot for `game.next_piece` after this move, without creating holes?",
      criteria: {
        true: "A clean spot is easy to see.",
        false: "The next piece will be awkward to place.",
      },
    },
  };
}
// 判断链第一跳：strategy 问题（board_health / next_piece_fits 为投机问题随附，
// 只进日志供诊断，不消费——P3 校准差，见 docs/jev-v2-failure-patterns.md）。
// 实验模式（路线图第 5 步）：2026-09-23 验证为回退（v4 均值 50.5 行 vs v3 71.5），
// 机制：喂回的策略文本与 priorities/显著事实竞争权重，P1/P2 回升。保留供后续实验。
export function buildStrategyQuestions() {
  return {
    strategy: {
      type: "choice",
      instructions: "Looking at `game`, which strategy fits the current situation best for the next few pieces?",
      criteria: STRATEGY_OPTIONS,
    },
    board_health: {
      type: "score",
      instructions: "How healthy is the stack in `game` for a Tetris player who wants to keep playing for a long time?",
      criteria: HEALTH_LEVELS,
    },
    next_piece_fits: {
      type: "noul",
      instructions: "Given `game.column_heights_left_to_right` and `game.surface`, is there an obvious clean spot for `game.next_piece` after this move, without creating holes?",
      criteria: {
        true: "A clean spot is easy to see.",
        false: "The next piece will be awkward to place.",
      },
    },
  };
}
// 判断链第二跳：placement 问题。state 中已带 game.chosen_strategy（Jev 自己的
// 第一跳回答，代码只传话——ADR 0001 边界内）。
export function buildPlacementQuestions(placements) {
  const criteria = describePlacements(placements); // 含显著事实，日志记录同一版本
  return {
    placement: {
      type: "choice",
      instructions: {
        question: "Which placement of `game.current_piece` should the player choose? Each option describes the board after that placement. `game.chosen_strategy` is the strategy you just chose for the next few pieces — pick the placement that best carries it out.",
        priorities: PLACEMENT_PRIORITIES,
      },
      criteria,
    },
  };
}

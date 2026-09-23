# Jev 棋力改进路线图

> 会话交接文档：任何新会话接手前，先读 [CONTEXT.md](../CONTEXT.md)（术语）、
> [adr/0001](adr/0001-jev-driven-no-code-evaluation.md)（第一原则）、本文档。
> 评估工具用法见 [README](../README.md) 的「评估工具」一节。

## 目标与边界

让 **Jev 自己玩得好**（不是让代码玩到最牛）。改进手段仅限：state 组织、
问题设计、选项描述（词化）。决策路径禁止代码估值（ADR 0001）。

## 测量协议（所有改动共用）

- 分层：代码层改动 100+ 局固定种子；Jev 层改动 20~30 局固定种子先行验证
- 每局 500 块截断；主指标：平均消行数、存活块数、最差对局
- **当前基线**（seeds 0-99，max-pieces 500）：启发式平均 193.9 行；随机 0 行
- **Jev 基线**（2026-09-23，枚举修复后，3 局 seeds 0-2，max-pieces 200）：
  58 / 50 / 68 行（平均 58.7），数据在 `eval/runs/jev-v2.jsonl`（~550 条决策记录）
- Jev 层改动的验证命令：
  `TYPESAFE_API_KEY=sk-... node eval/harness.mjs --player jev --games 20 --log eval/runs/<改动名>.jsonl`
  （成本敏感时可减到 --games 5 --max-pieces 150 先行）

## 路线图

- [x] **1. 抽引擎 + 评估工具** —— `engine.js`（seeded 7-bag）+ `eval/harness.mjs`
- [x] **2. 启发式/随机对照玩家** —— 基线已建立；首日发现枚举 bug（竖直 I 无法贴左墙，已修复，棋力 ×5）
- [x] **3. 失误诊断**：`eval/diagnose.mjs` 完成，产出 [失误模式清单](jev-v2-failure-patterns.md)
  （报告 `eval/runs/jev-v2-diagnosis.md`）。结论：I 块竖插失明（P1）+ 放弃消行代价极大（P2）
  是第 4 步靶子；危高应对良好、置信度信号可信；next_piece_fits 校准差（P3）暂不消费。
- [x] **4. 词化改进（显著事实）**：落点描述加入全场相对定位
  （"三个不造洞选项中堆最低的"、"唯一能消行的落点"）。
  边界规则：客观可复算的比较事实（唯一/最高/最低/排名）合法；
  方向性评价词（"更安全"）与估值结果非法。预期收益最大的单项。
  靶子来自第 3 步的失误模式清单。
  **已实现并验证**（`describePlacements()`，2026-09-23，seeds 0-1，max-pieces 200，
  日志 `eval/runs/jev-v3.jsonl`）：**73 / 70 行（均值 71.5，+32%）且两局打满 200 块**
  （v2 同口径 58 / 50 行，186/162 块 top-out）；I 块劣招率 16.0%→5.4%（P1 消退），
  劣招率 5.2%→2.8%；残余：放弃消行仍罕见但单次代价大（2 次，平均分差 7.09）。
- [ ] **5. 判断链**：strategy → placement 两跳串行——先问 strategy，
  把 Jev 自己的回答喂回 placement 问题的 state 再问落点。代码只传话。
  每步 2 次调用（~0.5-0.8s），不分档，直接作为默认模式。
- [ ] **6. fan-out 打分实验**：30 落点并行独立 Score，代码只取最高分。
  仅作对照实验（开关控制），用数据决定去留——细粒度打分的可比性存疑。
- [ ] **7. 文档与 prompt 存档**：更新 `docs/jev-development-guide.html`
  （新数据 + 枚举 bug 案例 + 失误模式清单），prompt 按 v1/v2 传统存档 v3。

## 会话建议

每步一个会话，`/clear` 分隔。第 3 步会话开场可直接说：
「读 docs/roadmap.md 和 eval/runs/jev-v2.jsonl，执行路线图第 3 步」。

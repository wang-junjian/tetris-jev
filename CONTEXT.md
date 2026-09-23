# Tetris × Jev

Web 俄罗斯方块：代码负责枚举、模拟与翻译，AI 玩家 Jev（TypeSafe System One 模型）通过语义判断选择落子。项目目的是验证"代码枚举 + 模型判断"范式，而不是追求最强棋力。

## Language

**Jev 驱动 (Jev-driven)**:
项目第一原则：决策路径中一切好坏判断来自 Jev，代码不估值。代码的角色只有三个——枚举合法落点、模拟后果、翻译输入。

**落点 (Placement)**:
当前方块一组 (rotation, column) 的合法下落位置，连同锁定消行后的局面后果。
_Avoid_: 动作、move、step

**词化 (Verbalization)**:
把棋盘与落点的数值翻译成自然语言描述的过程。Jev 不读数字、不做算术，只读词。
_Avoid_: 序列化、prompt 工程

**显著事实 (Salient fact)**:
词化中允许包含的客观比较事实（唯一 / 最高 / 最低 / 排名），用于区分描述雷同的落点。必须可由 state 数据复算，不得含方向性评价。

**估值 (Evaluation)**:
对落点好坏的数值评分（如 Dellacherie 启发式 `-0.51h + 0.76c − 0.36o − 0.18b`）。禁止进入 Jev 决策路径；只允许出现在对照玩家与离线诊断中。
_Avoid_: 评估（与 Jev 的判断混淆时禁用）

**判断 (Judgment)**:
Jev 对一个问题返回的 typed answer（Choice / Score / Noul），含概率与置信度。

**投机问题 (Speculative question)**:
与主问题并行发出的辅助问题；其判断是否被消费由代码决定。（沿用 TypeSafe 文档术语）

**判断链 (Judgment chain)**:
一个 Jev 判断作为 state 输入下一个问题的串行结构，如 strategy → placement。
_Avoid_: 两跳问答

**对照玩家 (Baseline player)**:
纯启发式或随机的自动玩家，仅作测量标尺，与 Jev 同环境对照，不与 Jev 交互。
_Avoid_: 对手、敌人

**劣招标注 (Blunder label)**:
离线诊断中，Jev 所选落点与启发式最优落点分差超阈值的决策记录。是待审查线索，不是失误定论——启发式不是真理。
_Avoid_: 失误、错误（这两个词只在人工确认后使用）

**失误模式 (Failure pattern)**:
诊断归纳出的可归因失败类别（如"危高未切换保命策略"），是改进输入的靶子。

**危高 (Danger height)**:
maxHeight > 15 的棋盘状态，词化为 "dangerously high"。

**井 (Well)**:
深度 ≥ 3 格的竖直空槽，长条 I 的消行通道。

**Top-out**:
方块堆到顶、新方块无法入场导致对局结束。

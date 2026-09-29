#!/usr/bin/env python3
"""Laya 棋力根因 A/B/C 对照实验。

同一局面，三组提问方式：
  A 现状   —— placement 的 9 个候选，每项是 8 字段对象（与线上完全一致）
  B 极简   —— 同样 9 个候选，但每项压成一句短自然语言，避免被 head 预算截断
  C 判别力 —— 只留 2 个候选：启发式最优 vs 最差（分差 8.65，消一行才值 0.76
             分，属于「肉眼可辨」的悬殊局面），每项同样是极简文本

判读：
  A 与 B 的差距 = 选项截断造成的损失（适配层问题，可修）
  C 的 top 概率   = 模型对这套 state 表示的真实判别力上限（模型问题）
     C 若 ≈ 0.5，说明模型根本没有「看懂」棋局，任何适配调优都无济于事。
"""
import json
import os
import sys

os.environ.setdefault("USE_TF", "0")
import numpy as np  # noqa: E402
import laya  # noqa: E402
from laya.common import encode_text, render_options  # noqa: E402
from laya.agent import Agent  # noqa: E402

MODELS = os.path.expanduser("~/.workbuddy/models/laya")
CKPT = sys.argv[1] if len(sys.argv) > 1 else "typed-decisions"
body = json.load(open(sys.argv[2] if len(sys.argv) > 2 else "/tmp/laya-req2.json"))
state, Q, H = body["state"], body["questions"], body["heuristics"]


def flat(ins):
    if isinstance(ins, str):
        return ins
    if isinstance(ins, dict):
        parts = [str(ins["question"])] if ins.get("question") else []
        if ins.get("priorities"):
            parts.append("Priorities (highest first):\n" +
                         "\n".join(f"{i + 1}. {p}" for i, p in enumerate(ins["priorities"])))
        return "\n".join(parts)
    return json.dumps(ins, ensure_ascii=False)


def lean(c):
    """把 describePlacement 的 8 字段压成一句短自然语言，优先保决定性字段。"""
    def ph(v, noun):
        return f"no {noun}" if str(v) in ("none", "no") else f"{str(v)} {noun}"
    return ", ".join([
        ph(c["lines_cleared"], "lines cleared"),
        ph(c["holes_created"], "holes created"),
        c["height_change"],
        f"{c['stack_height_after']} stack",
        c["surface_after"],
    ])


def entropy(p):
    p = np.asarray(p, dtype=float) / np.sum(p)
    return float(-(p * np.log(p + 1e-12)).sum() / np.log(len(p)))


def head_budget(tok, q, max_len, head_max_len):
    """题干是否完整进模型？选项被压到多少 token？"""
    qi = Agent._to_internal(q)
    opts = render_options(qi)
    ins = str(qi["ins"]).replace(tok.mask_token, " ")
    head_full = len(encode_text(tok, "%s question: %s" % (qi["t"], ins),
                                add_special_tokens=False)["input_ids"])
    oids = []
    for o in opts:
        full = encode_text(tok, " " + o.replace(tok.mask_token, " "),
                           add_special_tokens=False)["input_ids"]
        oids.append([tok.mask_token_id] + full[:48])
    per = None
    if head_max_len - sum(len(o) for o in oids) < 16:
        per = max(4, (head_max_len - 16) // max(1, len(oids)))
        oids = [o[:per] for o in oids]
    return head_full, max(8, head_max_len - sum(len(o) for o in oids)), per


print(f"加载 {CKPT} ...", flush=True)
agent = laya.load(MODELS, subfolder=(None if CKPT == "english" else CKPT))
tok = agent.tok
MAX_LEN, HEAD_MAX = agent.cfg.get("max_len", 512), agent.cfg.get("head_max_len", 192)
print(f"max_len={MAX_LEN}  head_max_len={HEAD_MAX}")

pl = dict(Q["placement"])
pl["instructions"] = flat(pl["instructions"])
crit = pl["criteria"]

best_id = max(H, key=lambda k: H[k])
worst_id = min(H, key=lambda k: H[k])

variants = [
    ("A 现状（9 项 8 字段对象）", dict(pl)),
    ("B 极简（9 项短自然语言）", {**pl, "criteria": {k: lean(v) for k, v in crit.items()}}),
    ("C 判别力（最优 vs 最差）", {
        "type": "choice", "instructions": pl["instructions"],
        "criteria": {best_id: lean(crit[best_id]), worst_id: lean(crit[worst_id])},
    }),
]

for name, q in variants:
    ots = [len(encode_text(tok, " " + o.replace(tok.mask_token, " "),
                           add_special_tokens=False)["input_ids"])
           for o in render_options(Agent._to_internal(q))]
    res = agent.predict(state, {"placement": q})
    a = res["answers"]["placement"]
    probs = list(a["probabilities"].values())
    picked = a["choice"]
    tag = ""
    if len(ots) > 1 and picked in H:
        rank = sorted(H, key=lambda k: -H[k]).index(picked)
        tag = f"  启发式排名 {rank + 1}/{len(H)}"
        if picked == best_id:
            tag += " ← 命中最优"
        elif picked == worst_id:
            tag += " ← 命中最差"
    print(f"\n{name}")
    hf, hu, per = head_budget(tok, q, MAX_LEN, HEAD_MAX)
    print(f"  题干（question+priorities）: 原始 {hf} token -> 入模型 {hu} token"
          f"{'   <<< 题干被截断！' if hu < hf else '   (完整)'}")
    print(f"  选项 token（原始）: {ots}   每项上限 {per or 48}"
          f"{' <<< 选项被压缩' if per else ''}")
    print(f"  选择: {picked}   top={max(probs):.3f}   熵={entropy(probs):.3f}{tag}")

print(f"\n参考：启发式最优 {best_id} ({H[best_id]})，最差 {worst_id} ({H[worst_id]})")
print("      9 选项均匀分布时 top=0.111 熵=1.0；2 选项均匀时 top=0.5 熵=1.0")

#!/usr/bin/env python3
"""Laya prompt 预算诊断 —— 定位「选项信息是否真的进了模型」。

背景（为什么棋力只有几百分）
--------------------------------------------------------------
项目把 placement 的每个候选落点渲染成一个 8 字段对象
（engine.js: describePlacement），Laya 的 render_criterion 会把它
json.dumps 成约 250 字符。而 Laya 的 head 预算（head_max_len）必须把
**所有**选项塞进一个固定 token 数里；一旦总和超预算，common.py 的
build_sequence 会把每个选项按 max(4,(head_max_len-16)//n) 截断。

本脚本打印「原文 -> 实际进模型」的落差，并用 options_distinct 检测
选项是否已塌缩成相同的 token span（塌缩后模型无法区分，argmax 近乎随机）。

同时对照 strategy 问题（4 个短自然语言选项，不会被截断），比较两者的
概率分布锐度——若 placement 平而 strategy 尖，即证明问题是「选项格式 /
预算」而非模型完全无棋力。

用法:
    python eval/laya_prompt_diag.py [typed-decisions|english] [/tmp/laya-req.json]
"""
import json
import os
import sys

os.environ.setdefault("USE_TF", "0")
import numpy as np  # noqa: E402
import laya  # noqa: E402
from laya.common import encode_text, render_options, serialize_state  # noqa: E402
from laya.agent import Agent  # noqa: E402

MODELS = os.path.expanduser("~/.workbuddy/models/laya")
CKPT = sys.argv[1] if len(sys.argv) > 1 else "typed-decisions"
REQ = sys.argv[2] if len(sys.argv) > 2 else "/tmp/laya-req.json"


def flatten_instructions(ins):
    """与 laya-server.py 完全一致的展平逻辑。"""
    if isinstance(ins, str):
        return ins
    if isinstance(ins, dict):
        parts = []
        if ins.get("question"):
            parts.append(str(ins["question"]))
        if ins.get("goal"):
            parts.append(str(ins["goal"]))
        prios = ins.get("priorities")
        if isinstance(prios, list) and prios:
            parts.append("Priorities (highest first):\n" +
                         "\n".join(f"{i + 1}. {p}" for i, p in enumerate(prios)))
        rest = {k: v for k, v in ins.items() if k not in ("question", "goal", "priorities")}
        if rest:
            parts.append(json.dumps(rest, ensure_ascii=False))
        return "\n".join(parts)
    return json.dumps(ins, ensure_ascii=False)


def explain(tok, state, q, max_len, head_max_len):
    """复刻 build_sequence 的预算分配，把中间量全部暴露出来。"""
    mask_tok = tok.mask_token
    opts = render_options(q)
    ins = str(q["ins"]).replace(mask_tok, " ")
    head_ids = encode_text(tok, "%s question: %s" % (q["t"], ins),
                           add_special_tokens=False)["input_ids"]
    raw_lens, opt_ids = [], []
    for o in opts:
        full = encode_text(tok, " " + o.replace(mask_tok, " "),
                           add_special_tokens=False)["input_ids"]
        raw_lens.append(len(full))
        opt_ids.append([tok.mask_token_id] + full[:48])

    per_option = None
    if head_max_len - sum(len(o) for o in opt_ids) < 16:
        per_option = max(4, (head_max_len - 16) // max(1, len(opt_ids)))
        opt_ids = [o[:per_option] for o in opt_ids]

    budget = head_max_len - sum(len(o) for o in opt_ids)
    head_used = head_ids[:max(8, budget)]
    state_ids = encode_text(tok, serialize_state(state).replace(mask_tok, " "),
                            add_special_tokens=False)["input_ids"]
    n_before_state = 1 + len(head_used) + 1 + sum(len(o) for o in opt_ids) + 1
    room = max(0, max_len - n_before_state - 1)
    return {
        "opts": opts, "raw_lens": raw_lens, "opt_ids": opt_ids, "per_option": per_option,
        "head_full": len(head_ids), "head_used": len(head_used),
        "state_tokens": len(state_ids), "state_kept": min(len(state_ids), room),
        "room": room, "n_before_state": n_before_state,
        "options": len(opt_ids), "options_distinct": len({tuple(o) for o in opt_ids}),
    }


def show(tok, title, ex):
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")
    print(f"选项数 {ex['options']}   head 预算上限 {ex['head_full'] and ''}"
          f"实际保留 head {ex['head_used']} token")
    if ex["per_option"]:
        print(f"!! 选项总长超预算 -> 每选项压到 {ex['per_option']} token")
    print(f"顶部分布: options={ex['options']}  options_distinct={ex['options_distinct']}"
          f"{'   <<< 已塌缩：存在无法区分的选项！' if ex['options_distinct'] < ex['options'] else ''}")
    for i, o in enumerate(ex["opts"]):
        kept = ex["opt_ids"][i]
        print(f"\n  [{i}] 原文 {len(o)} 字符 / {ex['raw_lens'][i]} token  ->  入模型 {len(kept)} token")
        print(f"      原文: {o}")
        print(f"      入模型: {tok.decode(kept[1:])!r}")


def entropy(p):
    p = np.asarray(p, dtype=float)
    p = p / p.sum()
    return float(-(p * np.log(p + 1e-12)).sum() / np.log(len(p)))


def main():
    body = json.load(open(REQ))
    state, questions = body["state"], body["questions"]

    print(f"加载 checkpoint: {CKPT} ...", flush=True)
    agent = laya.load(MODELS, subfolder=(None if CKPT == "english" else CKPT))
    tok, cfg = agent.tok, agent.cfg
    max_len, head_max_len = cfg.get("max_len", 512), cfg.get("head_max_len", 192)
    print(f"max_len={max_len}  head_max_len={head_max_len}")

    # 两套视图：api_q 给 predict（展平后的原始键），norm 给 explain（Laya 内部键）
    api_q, norm = {}, {}
    for qid, q in questions.items():
        q = dict(q)
        q["instructions"] = flatten_instructions(q.get("instructions", ""))
        api_q[qid] = q
        norm[qid] = Agent._to_internal(q)

    state_chars = len(json.dumps(state, ensure_ascii=False))
    print(f"\nstate: {state_chars} 字符")

    for qid in ("placement", "strategy"):
        ex = explain(tok, state, norm[qid], max_len, head_max_len)
        show(tok, f"{qid}（{'对象型 criteria，每项 8 字段' if qid == 'placement' else '字符串 criteria，短自然语言'}）", ex)
        print(f"\n  state 预算: 需要 {ex['state_tokens']} token / 可用 room {ex['room']}"
              f" -> 保留 {ex['state_kept']}"
              f"{'   <<< state 被截断！' if ex['state_kept'] < ex['state_tokens'] else '   (完整)'}")

    # ---- 实际推理：比较两类问题的分布锐度 ----
    print(f"\n{'=' * 72}\n实际推理：分布锐度对照\n{'=' * 72}")
    with np.errstate(all="ignore"):
        res = agent.predict(state, api_q)
    for qid, a in res.get("answers", {}).items():
        if a.get("type") == "choice":
            probs = list(a["probabilities"].values())
            print(f"  {qid:16s} choice={a['choice']:10s} top={max(probs):.3f} "
                  f"熵={entropy(probs):.3f} ({len(probs)} 选项)")
        else:
            print(f"  {qid:16s} {a.get('type')}: {json.dumps({k: v for k, v in a.items() if k not in ('probabilities', 'legend')})}")
    print(f"\n  usage: {json.dumps(res.get('usage', {}))}")
    print("\n判读：熵越接近 1 越接近均匀（模型无信息），越接近 0 越确定。")


if __name__ == "__main__":
    main()

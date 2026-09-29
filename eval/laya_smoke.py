#!/usr/bin/env python3
"""Laya 本地部署冒烟测试：加载模型 + 三类问题（choice/score/noul）各跑一次。

用法:
    USE_TF=0 <venv-python> eval/laya_smoke.py [--multilingual]

验证点:
1. 模型能否在本机加载（自动探测 MPS / CPU）
2. predict 接口是否与 Jev /v1/systemone 的 typed answers 同构
3. 单次延迟量级（用于评估能否实时驱动俄罗斯方块）
"""
import json
import sys
import time

USE_TF = "0"
import os

import laya

subfolder = "typed-decisions" if "--typed" in sys.argv else None
# HF 在当前网络不可达，权重已从 ModelScope 镜像下载到本地（HF 仓库同构目录）
LOCAL_ROOT = os.path.expanduser("~/.workbuddy/models/laya")

t0 = time.time()
if not os.path.isdir(LOCAL_ROOT):
    sys.exit(f"模型目录不存在: {LOCAL_ROOT} —— 请先从 ModelScope 下载")
agent = laya.load(LOCAL_ROOT, subfolder=subfolder)
print(f"[load] {time.time() - t0:.1f}s  checkpoint={subfolder or 'english'}")

# 探测推理设备
try:
    import torch
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
except Exception:
    dev = "unknown"
print(f"[device] {dev}")

# 用一个迷你俄罗斯方块 state 做三类问题的联合测试
state = {
    "game": {
        "board_rows_top_to_bottom": ["..........", "...#......", "..##......"],
        "column_heights_left_to_right": [0, 1, 2, 1, 0, 0, 0, 0, 0, 0],
        "current_piece": "J",
        "next_piece": "I",
        "lines_cleared_so_far": 0,
    }
}
questions = {
    "placement": {
        "type": "choice",
        "instructions": {
            "question": "Which placement of `game.current_piece` should the player choose?",
            "priorities": ["Avoid creating holes", "Keep the stack flat"],
        },
        "criteria": {
            "p1": "Col 0, rotation 0 — fills the leftmost slot",
            "p2": "Col 8, rotation 2 — creates a covered hole",
            "p3": "Col 4, rotation 1 — keeps surface flat",
        },
    },
    "board_health": {
        "type": "score",
        "instructions": "How healthy is the stack in `game`?",
        "criteria": ["empty board", "low stack", "high stack"],
    },
    "next_piece_fits": {
        "type": "noul",
        "instructions": "Is there an obvious clean spot for `game.next_piece`?",
        "criteria": {"true": "easy to see", "false": "awkward"},
    },
}

# 预热 + 计时（首次调用含编译/缓存开销）
t0 = time.time()
result = agent.predict(state, questions)
print(f"[first predict] {(time.time() - t0) * 1000:.0f}ms")

times = []
for _ in range(3):
    t0 = time.time()
    result = agent.predict(state, questions)
    times.append((time.time() - t0) * 1000)
print(f"[warm predict] median {sorted(times)[1]:.0f}ms  runs={[f'{t:.0f}' for t in times]}")

print(json.dumps(result["answers"], indent=2, ensure_ascii=False, default=str))
print("[smoke] OK")

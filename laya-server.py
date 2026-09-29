#!/usr/bin/env python3
"""Laya 本地推理服务 —— Jev /v1/systemone 协议兼容层

把页面 / eval 工具发来的 Jev 协议请求（POST /v1/systemone）转交给本地
Laya 模型（agent.predict），响应字段对齐页面消费的 Jev 格式。与
jev-proxy.mjs 并列构成双后端：同一个协议，Jev 走云端、Laya 走本地。

用法:
    <venv-python> laya-server.py [port]          # 默认端口 8788
    LAYA_CHECKPOINT=english <venv-python> laya-server.py

页面里把「API 地址」改为 http://localhost:8788 即可（页面启动时会探测
GET /v1/health 识别后端类型，无需 API key）。eval 工具:
    node eval/harness.mjs --player jev --url http://localhost:8788 --games 20

协议适配点（Jev -> Laya）:
  1. model 名映射 checkpoint: laya/laya-typed -> typed-decisions(默认),
     laya-en/english -> english（根目录）
  2. instructions 为对象时展平为自然语言（Laya 默认会 json.dumps，
     模型读 JSON 文本不如读展平后的句子）
  3. choice 答案的 confidence 用 answer_confidence（top 概率口径，与
     Jev 页面显示口径一致），校准置信保留在 calibrated_confidence
  4. 候选超过 head_max_len 时截短 criteria 文本重试一次，仍失败返回
     Jev 风格错误体 {detail:{message}}（页面按此解析）
"""
import json
import mimetypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("USE_TF", "0")  # transformers 探测 TF 时 abseil 可能死锁
import laya

ROOT = Path(__file__).resolve().parent
MODELS_ROOT = Path(os.environ.get("LAYA_MODELS", "~/.workbuddy/models/laya")).expanduser()
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8788))
DEFAULT_CKPT = os.environ.get("LAYA_CHECKPOINT", "typed-decisions")

# model 名 -> checkpoint subfolder（None = english，仓库根目录）
MODEL_MAP = {
    "laya": "typed-decisions",
    "laya-typed": "typed-decisions",
    "typed-decisions": "typed-decisions",
    "laya-en": None,
    "english": None,
    "": DEFAULT_CKPT,
}

_agents = {}            # subfolder(str or "root") -> Agent，惰性加载
_agent_lock = threading.Lock()
_infer_lock = threading.Lock()  # MPS 推理非线程安全，串行化


def get_agent(subfolder):
    key = subfolder or "root"
    with _agent_lock:
        if key not in _agents:
            print(f"[laya-server] loading checkpoint: {subfolder or 'english'} ...", flush=True)
            _agents[key] = laya.load(str(MODELS_ROOT), subfolder=subfolder)
            print(f"[laya-server] loaded ({key})", flush=True)
        return _agents[key]


def flatten_instructions(ins):
    """对象型 instructions 展平为自然语言；字符串原样返回。"""
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
        # 其余未知键兜底为 JSON，信息不丢
        rest = {k: v for k, v in ins.items() if k not in ("question", "goal", "priorities")}
        if rest:
            parts.append(json.dumps(rest, ensure_ascii=False))
        return "\n".join(parts)
    return json.dumps(ins, ensure_ascii=False)


def shorten(value, limit=80):
    if isinstance(value, str) and len(value) > limit:
        return value[:limit - 1] + "…"
    return value


def shrink_questions(questions, limit=80):
    """截短所有 criteria 文本（options 超限降级用）。"""
    out = {}
    for qid, q in questions.items():
        q = dict(q)
        crit = q.get("criteria")
        if isinstance(crit, dict):
            q["criteria"] = {k: shorten(v, limit) for k, v in crit.items()}
        elif isinstance(crit, list):
            q["criteria"] = [shorten(v, limit) for v in crit]
        out[qid] = q
    return out


def adapt_request(body):
    """Jev 协议请求 -> (state, questions, subfolder)。"""
    state = body.get("state")
    questions = body.get("questions") or {}
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions must be a non-empty object")
    norm = {}
    for qid, q in questions.items():
        if not isinstance(q, dict) or "type" not in q:
            raise ValueError(f"question {qid!r}: missing 'type'")
        q = dict(q)
        q["instructions"] = flatten_instructions(q.get("instructions", ""))
        norm[qid] = q
    model = str(body.get("model") or "").strip()
    if model.startswith("jev"):  # 页面默认值打到本地服务：按默认 checkpoint 处理
        model = ""
    subfolder = MODEL_MAP.get(model, DEFAULT_CKPT)
    if subfolder == "typed-decisions" and not (MODELS_ROOT / "typed-decisions").is_dir():
        subfolder = None  # 权重不齐时回退 english
    return state, norm, subfolder


def adapt_answer(ans):
    """choice 置信度对齐 Jev 页面口径；校准置信保留。"""
    if isinstance(ans, dict) and "answer_confidence" in ans:
        ans.setdefault("calibrated_confidence", ans.get("confidence"))
        ans["confidence"] = ans["answer_confidence"]
    return ans


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")

    def log_message(self, fmt, *args):  # 安静模式：只打印错误与关键事件
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/v1/health":
            body = json.dumps({
                "provider": "laya",
                "checkpoints": sorted({v or "english" for v in MODEL_MAP.values()}),
                "default_checkpoint": DEFAULT_CKPT,
                "models_root": str(MODELS_ROOT),
            }).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # 静态托管（与 jev-proxy.mjs 相同的路径安全规则）
        from urllib.parse import unquote
        rel = os.path.normpath(unquote(path)).lstrip("/\\")
        file = ROOT / (rel or "index.html")
        if not str(file).startswith(str(ROOT)):
            self._error(403, "forbidden")
            return
        try:
            data = file.read_bytes()
        except OSError:
            self._error(404, "not found")
            return
        ctype = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, code, message):
        body = json.dumps({"detail": {"message": message}}).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.path.split("?")[0].startswith("/v1/"):
            self._error(404, "only POST /v1/* is supported")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._error(400, f"bad request body: {e}")
            return

        try:
            state, questions, subfolder = adapt_request(body)
        except ValueError as e:
            self._error(422, str(e))
            return

        agent = get_agent(subfolder)
        with _infer_lock:
            try:
                result = agent.predict(state, questions)
            except ValueError as e:
                if "exceed head_max_len" in str(e):
                    # 降级：截短候选描述后重试一次
                    try:
                        with _infer_lock:
                            result = agent.predict(state, shrink_questions(questions))
                        print("[laya-server] degraded: criteria shortened after head_max_len overflow", flush=True)
                    except ValueError as e2:
                        self._error(422, f"options exceed budget even after shortening: {e2}")
                        return
                else:
                    self._error(422, f"laya validation: {e}")
                    return
            except Exception as e:  # 模型/设备层意外错误
                self._error(500, f"inference failed: {e}")
                return

        answers = {k: adapt_answer(v) for k, v in result.get("answers", {}).items()}
        out = {
            "model": subfolder or "english",
            "answers": answers,
            "usage": result.get("usage", {"input_tokens": 0, "output_tokens": 0}),
        }
        data = json.dumps(out).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    if not MODELS_ROOT.is_dir():
        sys.exit(f"模型目录不存在: {MODELS_ROOT} —— 先从 ModelScope 下载权重")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Laya server  http://localhost:{PORT}  checkpoint={DEFAULT_CKPT}  models={MODELS_ROOT}")
    print(f"页面入口: http://localhost:{PORT}/  （静态托管 + /v1/systemone 本地推理）")
    print("页面把 API 地址指到这里即可；eval: node eval/harness.mjs --player jev --url http://localhost:%d" % PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

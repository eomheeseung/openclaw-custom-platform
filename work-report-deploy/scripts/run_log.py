#!/usr/bin/env python3
"""실행 이력. cron 이 조용히 실패하면 금요일 아침까지 아무도 모른다."""
import json
import os
from datetime import datetime

import paths

MAX_KEEP = 30


def _path(nn):
    return f"{paths.data_dir(nn)}/work-report/runs.json"


def record(nn, ok, stats=None, failures=None, error=None):
    p = _path(nn)
    try:
        runs = json.load(open(p)).get("runs", [])
    except Exception:
        runs = []
    runs.insert(0, {
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "ok": bool(ok), "stats": stats or {}, "failures": failures or [], "error": error,
    })
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump({"runs": runs[:MAX_KEEP]}, open(p, "w"), ensure_ascii=False, indent=2)


def recent(nn, n=10):
    try:
        return json.load(open(_path(nn))).get("runs", [])[:n]
    except Exception:
        return []

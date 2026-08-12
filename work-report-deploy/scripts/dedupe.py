#!/usr/bin/env python3
"""중복 병합 + 노이즈 압축.

한 작업이 두레이·Gmail·드라이브에 동시에 남는다. 병합하지 않으면 한 일이
3줄로 부풀어, 읽는 사람은 업무가 3배로 늘어난 줄 안다.
"""
from datetime import datetime, timedelta
from difflib import SequenceMatcher
import re

SIM_THRESHOLD = 0.6
TIME_WINDOW_DAYS = 3
MINOR_PATTERNS = [r"문구", r"오탈자", r"오타", r"텍스트 수정", r"이미지 교체", r"링크 수정"]


def _norm(s):
    return re.sub(r"[\s\-_·,.()\[\]]+", "", (s or "")).lower()


def similarity(a, b):
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _parse(at):
    try:
        return datetime.fromisoformat((at or "").replace("Z", "+00:00"))
    except Exception:
        return None


def _close_in_time(a, b):
    da, db = _parse(a.get("at")), _parse(b.get("at"))
    if not da or not db:
        return True
    if da.tzinfo is None or db.tzinfo is None:
        da, db = da.replace(tzinfo=None), db.replace(tzinfo=None)
    return abs(da - db) <= timedelta(days=TIME_WINDOW_DAYS)


def merge_duplicates(items):
    out = []
    for it in items:
        target = None
        for cand in out:
            if similarity(it["text"], cand["text"]) >= SIM_THRESHOLD and _close_in_time(it, cand):
                target = cand
                break
        if target:
            target["sources"].append({"source": it["source"], "url": it.get("url")})
            if it.get("status") == "wip":  # 진행중이 하나라도 있으면 완료로 단정하지 않는다
                target["status"] = "wip"
        else:
            new = dict(it)
            new["sources"] = [{"source": it["source"], "url": it.get("url")}]
            out.append(new)
    return out


def _is_minor(text):
    return any(re.search(p, text or "") for p in MINOR_PATTERNS)


def compress_minor(items, threshold=3):
    minor = [x for x in items if _is_minor(x.get("text"))]
    if len(minor) < threshold:
        return items
    rest = [x for x in items if not _is_minor(x.get("text"))]
    srcs = []
    for m in minor:
        srcs += m.get("sources") or [{"source": m.get("source"), "url": m.get("url")}]
    rest.append({
        "text": f"문구·오탈자 수정 등 {len(minor)}건",
        "source": minor[0].get("source"), "url": None,
        "biz_id": minor[0].get("biz_id"), "at": minor[0].get("at"),
        "status": "done", "sources": srcs, "merged_count": len(minor),
    })
    return rest

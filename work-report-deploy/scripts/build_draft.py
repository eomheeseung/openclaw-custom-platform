#!/usr/bin/env python3
"""초안 조립 → drafts/draft-{주차}.json 저장.

- 파일 저장인 이유: OpenClaw 는 모델 응답 성공 시에만 세션 기록 → API 장애 때
  대화가 통째로 사라진다 (2026-08-03~04 실증). 파일이면 초안이 살아남는다.
- 주차별 보관인 이유: 이월 대조(직전 주차의 '차주' → 이번 회차)에 직전 파일이 필요.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datetime import datetime

import paths
import run_log
from collect import collect
from dedupe import merge_duplicates, compress_minor, similarity
from week_util import week_label, prev_week_label

CARRY_SIM = 0.6


def split_common(items, businesses):
    ids = {b["id"] for b in businesses}
    return ([x for x in items if x.get("biz_id") in ids],
            [x for x in items if x.get("biz_id") not in ids])


def group_by_business(items, businesses):
    return [{"id": b["id"], "name": b["name"], "alias": b.get("alias", b["name"]),
             "items": [x for x in items if x.get("biz_id") == b["id"]]}
            for b in businesses]


def parse_repo(spec, default_owner):
    """'owner/repo' 또는 'repo' → (owner, repo). owner 생략 시 연동 페이지의 owner."""
    spec = (spec or "").strip()
    if not spec:
        return None
    if "/" in spec:
        o, r = spec.split("/", 1)
        return (o.strip(), r.strip())
    return (default_owner, spec) if default_owner else None


def gather_github_repos(businesses, gh_cfg):
    """사업 마스터의 github_repos(→ biz_id 분류) + 개인 레포(쉼표 구분, 공통)."""
    out = []
    default_owner = gh_cfg.get("owner")
    for b in businesses:
        for spec in b.get("github_repos") or []:
            pr = parse_repo(spec, default_owner)
            if pr:
                out.append((pr[0], pr[1], b["id"]))
    for spec in (gh_cfg.get("repo") or "").split(","):
        pr = parse_repo(spec, default_owner)
        if pr:
            out.append((pr[0], pr[1], None))
    return out


def find_unsourced(items):
    return [x for x in items if not x.get("sources")]


def apply_carryover(items, prev_next_items):
    """직전 주차 '차주' 항목과 대조.
    - 이번 주에 비슷한 제목이 wip/next 로 잡힘 → carry 표시 (「지난주 예정 → 계속」)
    - done 으로 잡힘 → 그대로 흡수 (표시 없음)
    - 아예 안 잡힘 → carry=True 인 next 항목으로 이월 추가 (안 했으면 그대로 남긴다)
    """
    out = list(items)
    for prev in prev_next_items:
        match = None
        for cur in out:
            if similarity(prev.get("text", ""), cur.get("text", "")) >= CARRY_SIM:
                match = cur
                break
        if match is None:
            out.append({"text": prev.get("text", ""), "source": "carry", "url": None,
                        "biz_id": prev.get("biz_id"), "at": "", "status": "next",
                        "sources": [], "carry": True})
        elif match.get("status") in ("wip", "next"):
            match["carry"] = True
    return out


def _load_prev_next(nn, date_from):
    p = f"{paths.data_dir(nn)}/work-report/drafts/draft-{prev_week_label(date_from)}.json"
    if not os.path.exists(p):
        return []
    try:
        prev = json.load(open(p))
    except Exception:
        return []
    items = []
    for g in prev.get("businesses", []):
        for it in g.get("items", []):
            if it.get("status") == "next":
                items.append(dict(it, biz_id=g.get("id")))
    for it in prev.get("common", []):
        if it.get("status") == "next":
            items.append(it)
    return items


def build(nn, date_from, date_to):
    base = paths.data_dir(nn)
    cfg = json.load(open(f"{base}/work-report/config.json"))
    master = paths.load_businesses()
    businesses = [b for b in master if nn in (b.get("members") or [])]

    # 외부 연동 페이지가 저장한 토큰·memberId (integrations.json) 를 우선 사용
    try:
        integ = json.load(open(f"{base}/integrations.json"))
    except Exception:
        integ = {}
    dooray_member = ((integ.get("dooray") or {}).get("memberId")
                     or cfg.get("dooray_member_id"))
    gh_cfg = dict(cfg.get("github") or {})
    gh_integ = integ.get("github") or {}
    for k in ("owner", "repo", "token", "username"):
        gh_cfg.setdefault(k, gh_integ.get(k))
    gh_cfg["repos"] = gather_github_repos(businesses, gh_cfg)
    items, stats, failures = collect(
        cfg.get("tools", []), businesses, date_from, date_to,
        member_id=dooray_member,
        github=gh_cfg,
        figma_name=(cfg.get("profile") or {}).get("name"))
    items = merge_duplicates(items)
    items = compress_minor(items)
    items = apply_carryover(items, _load_prev_next(nn, date_from))

    grouped, common = split_common(items, businesses)
    week = week_label(date_from)
    draft = {
        "period": f"{date_from}~{date_to}", "week": week, "ai": [],
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "businesses": group_by_business(grouped, businesses),
        "common": common, "stats": stats, "failures": failures,
        "warnings": find_unsourced(items),
    }
    out_dir = f"{base}/work-report/drafts"
    os.makedirs(out_dir, exist_ok=True)
    out = f"{out_dir}/draft-{week}.json"
    json.dump(draft, open(out, "w"), ensure_ascii=False, indent=2)
    run_log.record(nn, ok=True, stats=stats, failures=failures)
    return out, draft


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("사용법: build_draft.py <userNN> <from:YYYY-MM-DD> <to:YYYY-MM-DD>")
        sys.exit(2)
    nn, f, t = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        path, d = build(nn, f, t)
        total = sum(len(g["items"]) for g in d["businesses"]) + len(d["common"])
        print(json.dumps({"ok": True, "path": path, "week": d["week"], "total": total,
                          "stats": d["stats"], "failures": d["failures"],
                          "warnings": len(d["warnings"])}, ensure_ascii=False))
    except Exception as e:
        run_log.record(nn, ok=False, error=str(e))
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

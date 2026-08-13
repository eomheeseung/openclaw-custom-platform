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
from datetime import datetime, timedelta

import paths
import run_log
from classify import classify
from collect import collect
from dedupe import merge_duplicates, compress_minor, compress_doc_set, similarity
from week_util import week_label, prev_week_label

CARRY_SIM = 0.6


def split_common(items, businesses):
    ids = {b["id"] for b in businesses}
    return ([x for x in items if x.get("biz_id") in ids],
            [x for x in items if x.get("biz_id") not in ids])


def group_by_business(items, businesses, drop_empty=False):
    """활동 없는 사업도 남긴다 — 빠뜨림/없음 구분용.
    단 담당 사업이 많으면(디자이너·팀장급 전 사업 접근) 빈 사업 나열이 노이즈라 drop_empty."""
    groups = [{"id": b["id"], "name": b["name"], "alias": b.get("alias", b["name"]),
               "items": [x for x in items if x.get("biz_id") == b["id"]]}
              for b in businesses]
    return [g for g in groups if g["items"]] if drop_empty else groups


def drop_unmapped_personal_drive(items):
    """개인 드라이브(공유 드라이브가 아닌 곳) 파일 중 **사업이 특정되지 않은 것**은 버린다.

    개인 드라이브에는 작업 중 소재가 쌓인다 (IMG_7410.PNG, 스톡 이미지, 로고 후보 …).
    경로로 사업을 알 수 없어 전부 공통에 몰리면 보고서의 분별력이 떨어진다(실측 21건).
    단 "밀도_메타광고리포트.txt" 처럼 **파일명으로 사업이 드러나면 남긴다** — 실제 산출물이다.
    """
    return [x for x in items
            if not (x.get("source") == "drive" and not x.get("project") and not x.get("biz_id"))]


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
    doc = paths.load_master()
    master = doc.get("businesses", [])
    all_access = nn in (doc.get("all_access") or [])
    if all_access:
        # 디자이너·팀장급: 전 사업이 분류 대상. 대신 활동 있는 사업만 보고서에 싣는다.
        businesses = master
    else:
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
    items, stats, failures = collect(
        cfg.get("tools", []), businesses, date_from, date_to,
        member_id=dooray_member,
        github=gh_cfg,
        figma_name=(cfg.get("profile") or {}).get("name"),
        nn=nn, member_email=(integ.get("google") or {}).get("email") or cfg.get("email"))
    items = classify(items, businesses)   # 사업 매핑: 등록ID → 프로젝트명 유사도 → 별칭 키워드
    items = drop_unmapped_personal_drive(items)
    items = merge_duplicates(items)
    items = compress_minor(items)
    items = compress_doc_set(items)   # 번호 붙은 제출 서류 묶음 → 한 줄
    items = apply_carryover(items, _load_prev_next(nn, date_from))

    grouped, common = split_common(items, businesses)
    week = week_label(date_from)
    # profile·recipients 를 초안에 실어 보낸다 — 비서가 config 를 따로 읽지 않고
    # 소속·직책·수신자를 **지어낸** 사고가 있었다(실측: 기술구현그룹→"AI팀", 매니저→"선임연구원",
    # 수신자가 설정돼 있는데도 "정해달라"고 물음). 초안에 있으면 지어낼 여지가 없다.
    draft = {
        "period": f"{date_from}~{date_to}", "week": week, "ai": [],
        "profile": cfg.get("profile") or {}, "recipients": cfg.get("recipients") or {},
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "businesses": group_by_business(grouped, businesses,
                                        drop_empty=all_access or len(businesses) > 6),
        "common": common, "stats": stats, "failures": failures,
        "warnings": find_unsourced(items),
    }
    # 항목마다 번호를 박아둔다 — 다듬기 때 모델이 파일 전체(9KB)를 다시 쓰지 않고
    # "3번을 이 문장으로" 처럼 번호만 돌려주면 되게 하기 위해서다.
    # 전체 재작성을 시켰더니 한 회차에 4분 넘게 걸렸다(실측).
    n = 0
    for g in draft["businesses"]:
        for it in g["items"]:
            n += 1
            it["n"] = n
    for it in draft["common"]:
        n += 1
        it["n"] = n

    out_dir = f"{base}/work-report/drafts"
    os.makedirs(out_dir, exist_ok=True)
    out = f"{out_dir}/draft-{week}.json"
    json.dump(draft, open(out, "w"), ensure_ascii=False, indent=2)
    run_log.record(nn, ok=True, stats=stats, failures=failures)
    return out, draft


def this_week():
    """이번 주 월~금. 기간을 생략해도 바로 돌 수 있게 한다."""
    today = datetime.now()
    mon = today - timedelta(days=today.weekday())
    return mon.strftime("%Y-%m-%d"), (mon + timedelta(days=4)).strftime("%Y-%m-%d")


if __name__ == "__main__":
    # 인자를 생략하면 이 컨테이너의 사용자 번호와 이번 주를 쓴다 —
    # 에이전트가 번호를 찾느라 헤매지 않도록(실측: 탐색만 수 분).
    args = sys.argv[1:]
    nn = args[0] if args and args[0].isdigit() else paths.self_nn()
    if not nn:
        print(json.dumps({"ok": False, "error": "사용자 번호를 알 수 없습니다"}, ensure_ascii=False))
        sys.exit(2)
    rest = [a for a in args if not a.isdigit()]
    f, t = (rest[0], rest[1]) if len(rest) >= 2 else this_week()
    try:
        path, d = build(nn, f, t)
        total = sum(len(g["items"]) for g in d["businesses"]) + len(d["common"])
        rows = [{"n": it["n"], "biz": g["alias"], "text": it["text"], "status": it["status"]}
                for g in d["businesses"] for it in g["items"]]
        rows += [{"n": it["n"], "biz": "", "text": it["text"], "status": it["status"]}
                 for it in d["common"]]
        print(json.dumps({"ok": True, "path": path, "week": d["week"], "total": total,
                          "stats": d["stats"], "failures": d["failures"],
                          "warnings": len(d["warnings"]), "items": rows}, ensure_ascii=False))
        # 카드는 finish.py 만 낸다 — 여기서도 내면 다듬기 전/후 카드가 두 번 그려진다.
        # (SOUL 을 명령 중심으로 줄인 뒤 마지막 단계를 건너뛰지 않는 것을 확인했다)
    except Exception as e:
        run_log.record(nn, ok=False, error=str(e))
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

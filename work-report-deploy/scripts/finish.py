#!/usr/bin/env python3
"""다듬기 뒤 마무리 — 글자 검증 · 카드 출력 · 두레이 회신을 한 번에.

단계를 나눠 시키면 모델이 빠뜨린다(실측: verify_draft 0회 실행, notify 는 명령이 잘려 실패).
모델이 실행할 명령을 `build_draft.py` → (다듬기) → `finish.py` 두 개로 줄인다.

회신문도 여기서 만든다 — 모델이 요약을 새로 쓰면 한글이 깨진다(주간업무보고 → 업묵보고).

사용법: `python3 finish.py <userNN> [주차]`
"""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# "03-2 공통 발급 흐름" 처럼 앞머리에 페이지 번호가 붙은 조각 — 산출물 이름이 아니다
RE_PAGEY = __import__("re").compile(r"^\s*\d{1,2}(?:-\d{1,2})?\s+")

import notify
import paths
import verify_draft
import week_util


def _rebuild(nn):
    """build_draft 를 이 프로세스 안에서 직접 돌린다.

    별도 명령으로 두면 모델이 결과를 안 기다리고 다음 명령을 쳐서 경합이 난다(실측).
    수집은 사람에 따라 60~100초 걸리지만, 도구는 그만큼 기다려 준다(101초 결과 도착 확인).
    """
    import build_draft
    f, t = build_draft.this_week()
    return build_draft.build(nn, f, t)


def unpolished_items(draft):
    """수집된 원문이 그대로 남아 있는 항목 — 다듬기 전에는 보고서 문장이 아니다.

    대상: 메일(제목=문장 아님), 드라이브·피그마(파일명=문장 아님).
    캘린더는 제외한다 — 사람이 직접 쓴 일정 제목이라 이미 업무 문장이다.
    깃헙 커밋 메시지도 제외 — 이미 "무엇을 했는지" 로 쓰여 있다.

    판단 근거는 `polished` 한 가지다 — polish.py 가 문장을 바꿨을 때만 붙는다.
    ⚠ 이 표시가 생기기 전에 만들어진 초안은 이미 다듬은 항목도 걸린다(1회성).
    """
    MAIL = {"gmail", "mail"}
    ASSET = {"drive", "figma"}
    out = []
    groups = list(draft.get("businesses") or []) + [{"items": draft.get("common") or []}]
    for g in groups:
        for it in g.get("items") or []:
            if it.get("polished"):
                continue
            src = str(it.get("source") or "")
            srcs = json.dumps(it.get("sources") or [], ensure_ascii=False)
            is_mail = src in MAIL or any(f'"{k}"' in srcs for k in MAIL)
            is_asset = src in ASSET or any(f'"{k}"' in srcs for k in ASSET)
            if is_mail:
                out.append(it)
            elif is_asset and (it.get("merged_count")
                               or (it.get("frame_count") or 0) >= 3
                               or RE_PAGEY.match(it.get("text") or "")):
                # 드라이브 전부를 요구하면 문서가 많은 사람은 55건이 걸린다(실측 user05).
                # 그 55건은 "사업수행계획서" 처럼 이미 산출물 이름이다 — 문제는 페이지 조각뿐.
                out.append(it)
    return out


def run(nn, week=None):
    week = week or week_util.week_label(datetime.now().strftime("%Y-%m-%d"))
    path = f"{paths.data_dir(nn)}/work-report/drafts/draft-{week}.json"

    if not os.path.exists(path):
        print("초안이 없어 수집부터 시작합니다", file=sys.stderr)
        _rebuild(nn)

    fixed = verify_draft.verify(nn, week)          # 모델이 깨뜨린 글자 복원
    draft = json.load(open(path))

    # 낡은 초안 차단 — build_draft.py 가 끝나기 전에 finish.py 를 치는 회차가 있다.
    # 실측(2026-08-28): user15 는 build_draft 가 68초째 도는 중에 finish 가 실행돼
    # **어제 초안으로 카드가 나갔다**. 오류만 나는 게 아니라 틀린 보고서가 나간다.
    gen = str(draft.get("generated_at") or "")[:10]
    today = datetime.now().strftime("%Y-%m-%d")
    if gen and gen != today:
        # 실측(2026-08-28): 모델이 build_draft(60~100초) 를 안 기다리고 finish 를 쳐서
        # **어제 초안으로 카드가 나갔고**, 늦게 온 build_draft 결과는 갈 곳이 없어
        # "Bash failed" 로 떴다. 명령을 둘로 나눠 두는 한 이 경합은 계속 난다.
        # → 여기서 직접 수집한다. 모델이 칠 명령이 하나면 경합 자체가 없다.
        print(f"초안이 오늘 것이 아니라 수집부터 다시 합니다 (기존: {draft.get('generated_at')})",
              file=sys.stderr)
        _rebuild(nn)
        draft = json.load(open(path))

    # 0) 다듬기 게이트 — 메일에서 온 항목은 제목이 곧 문장이라 그대로 두면 보고서가 아니다.
    #    실측(2026-W35): "…문의드립니다.", "입찰공고 배정 알림" 이 그대로 올라갔다.
    #    다듬기 단계가 이미 있는데 모델이 건너뛴다 → 안 하면 카드를 안 내주는 쪽으로 강제한다.
    pending = unpolished_items(draft)
    if pending:
        print("다듬기가 필요한 항목이 남아 있어 초안을 확정하지 않았습니다.")
        print("아래 항목을 polish.py 로 고친 뒤 finish.py 를 다시 실행하세요.")
        print("  제목·파일명이 아니라 **무엇을 했는지** 로 바꿔 쓰세요.")
        print("    보낸 메일  '…문의드립니다'        → '… 유지보수 용역 문의 발송'")
        print("    받은 메일  '…요청드립니다'        → '… 요청 대응'")
        print("    파일명    '03-2 공통 발급 흐름'   → '배지 발급 흐름 화면 설계'")
        print("    파일명    '배지 4종_조합배지1'     → '배지 4종 디자인 시안 작성'")
        print("    피그마    'mildo · Design Renewal — 26개 프레임 (홈, 마이페이지 …)'")
        print("              → '밀도 홈·마이페이지·밸런스게임 등 화면 개선 디자인'")
        print("    피그마    '… · 퀵가이드 메뉴얼 — 10개 프레임 (퀵가이드 1~8 …)'")
        print("              → '맞춤배움길 배지발급 퀵가이드 8페이지 제작'")
        print("  본인 업무가 아니면 drop 하세요. 폴더명이 있으면 무슨 일인지 판단하는 데 쓰세요.")
        for it in pending:
            if it.get("folder"):
                hint = f"  (폴더: {it['folder']})"
            elif it.get("screens"):
                hint = f"  (화면: {', '.join(it['screens'][:6])})"
            else:
                hint = ""
            # UI 로 한 번 편집된 초안은 n 이 없을 수 있다(과거 API 가 잘라냈다) → 죽지 않게
            num = it.get("n")
            label = f"{num}번 " if num is not None else ""
            src = it.get("source") or (it.get("sources") or [{}])[0].get("source") or "?"
            print(f"  - {label}[{src}]: {it.get('text', '')}{hint}")
        nums = [it["n"] for it in pending if it.get("n") is not None]
        if len(nums) < len(pending):
            print("  ⚠ 번호가 없는 항목이 있다. build_draft.py 를 다시 실행해 초안을 새로 만들어라.")
        return {"ok": False, "week": week, "pending": nums}

    # 1) 카드 — 다듬기가 끝난 **지금** 상태여야 한다.
    #    build_draft 직후에 내면 파일명·광고 문구가 그대로 박힌다(실측).
    print(f"```work-draft\n{json.dumps(draft, ensure_ascii=False, indent=2)}\n```")

    # 2) 두레이 회신 — 요청이 두레이에서 왔을 때만.
    sent = False
    if os.environ.get("TIDECLAW_FROM_DOORAY") == "1" or "--dooray" in sys.argv:
        msg = notify.draft_summary(nn)
        sent = bool(msg) and notify.notify(nn, msg)[0]

    return {"ok": True, "week": week, "typos_fixed": len(fixed), "dooray_sent": sent}


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    nn = args[0] if args and args[0].isdigit() else paths.self_nn()
    if not nn:
        print(json.dumps({"ok": False, "error": "사용자 번호를 알 수 없습니다"}, ensure_ascii=False))
        sys.exit(2)
    week = next((a for a in args if "-W" in a), None)
    try:
        print(json.dumps(run(nn, week), ensure_ascii=False))
    except FileNotFoundError:
        # 실측(user05 2026-08-28): build_draft.py 가 101초 걸리는 사이 모델이 먼저
        # finish.py 를 쳐서 "초안 파일이 없습니다" 로 죽었다. 왜 없는지 알려줘야 재시도한다.
        print(json.dumps({
            "ok": False,
            "error": "초안 파일이 없습니다",
            "hint": "build_draft.py 가 아직 실행 중일 수 있다(수집이 많으면 100초 이상). "
                    "그 명령의 출력을 받은 뒤에 finish.py 를 실행해라. "
                    "build_draft.py 를 다시 실행하지 마라 — 수집을 처음부터 다시 한다.",
        }, ensure_ascii=False))
        sys.exit(1)

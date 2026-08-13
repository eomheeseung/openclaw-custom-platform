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
import notify
import paths
import verify_draft
import week_util


def run(nn, week=None):
    week = week or week_util.week_label(datetime.now().strftime("%Y-%m-%d"))
    path = f"{paths.data_dir(nn)}/work-report/drafts/draft-{week}.json"

    fixed = verify_draft.verify(nn, week)          # 모델이 깨뜨린 글자 복원
    draft = json.load(open(path))

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
        print(json.dumps({"ok": False, "error": "초안 파일이 없습니다"}, ensure_ascii=False))
        sys.exit(1)

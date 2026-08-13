#!/usr/bin/env python3
"""확정된 초안을 메일 본문으로 조립하고 발송한다.

본문을 모델이 쓰지 않는 이유:
  · 소속·직책·수신자를 지어낸 사고가 있었다 (기술구현그룹→"AI팀", 매니저→"선임연구원").
  · 한글을 새로 쓰면 글자가 깨진다 (주간업무보고 → 업묵보고). 기관에 그대로 나간다.
  · 두레이 안내 문구·링크가 본문에 섞여 들어갔다.
draft 파일의 값만 조립하면 셋 다 생기지 않는다.

사용법:
  python3 send_report.py            # 본문 미리보기 (발송 안 함)
  python3 send_report.py --send     # 실제 발송
"""
import json
import os
import subprocess
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
import week_util

TOOL_KO = {"dooray": "두레이", "gmail": "메일", "calendar": "캘린더",
           "drive": "드라이브", "github": "GitHub", "figma": "Figma"}


def build_mail(draft):
    prof = draft.get("profile") or {}
    team, name, title = prof.get("team", ""), prof.get("name", ""), prof.get("title", "")
    period = draft.get("period", "")
    # 회사 표준 제목 — "(AI)" 같은 표기를 붙이지 않는다
    subject = f"[주간보고][{period.replace('~', '~')}]{team} {name} {title}".rstrip()

    groups = list(draft.get("businesses") or []) + [{"alias": "", "items": draft.get("common") or []}]
    done, nxt = [], []
    for g in groups:
        alias = g.get("alias") or ""
        for it in g.get("items") or []:
            tag = f"[{alias}] " if alias else ""
            line = f"- {tag}{it.get('text', '')}"
            urls = [s.get("url") for s in (it.get("sources") or []) if s.get("url")]
            if urls:
                line += f"\n  ↳ 증적: {urls[0]}"
            # status 는 done · wip · next 세 값이다. 카드와 같은 기준으로 갈라야
            # 화면에서 본 것과 메일이 달라지지 않는다.
            (done if it.get("status") == "done" else nxt).append(line)

    ai = [f"- {x.get('text', '')}" for x in (draft.get("ai") or [])]
    body = [f"기간({period}) {team} / {name} / {title}", "", "■ 완료"]
    body += done or ["- 해당 없음"]
    body += ["", "■ 진행 · 차주 계획"] + (nxt or ["- 해당 없음"])
    body += ["", "■ 업무 - AI 툴 활용"] + (ai or ["- 해당 없음"])
    return subject, "\n".join(body)


def send(nn, subject, body, to, cc):
    payload = json.dumps({"to": ",".join(to), "cc": ",".join(cc),
                          "subject": subject, "body": body}, ensure_ascii=False)
    # gcurl 은 컨테이너 안에서 게이트웨이로 보내는 래퍼다 (발송 큐에 적재)
    out = subprocess.run(["gcurl", "POST", "/api/mail/send", payload],
                         capture_output=True, text=True, timeout=60).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"ok": False, "raw": out[:200]}


def run(nn, week=None, do_send=False):
    week = week or week_util.week_label(datetime.now().strftime("%Y-%m-%d"))
    path = f"{paths.data_dir(nn)}/work-report/drafts/draft-{week}.json"
    draft = json.load(open(path))
    subject, body = build_mail(draft)
    rc = draft.get("recipients") or {}
    to, cc = rc.get("to") or [], rc.get("cc") or []
    if not do_send:
        return {"ok": True, "preview": True, "subject": subject, "to": to, "cc": cc, "body": body}
    if not to:
        return {"ok": False, "error": "수신자가 설정돼 있지 않습니다 (work-report/config.json)"}
    res = send(nn, subject, body, to, cc)
    return {"ok": bool(res.get("ok")), "subject": subject, "to": to, "cc": cc, "result": res}


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    nn = args[0] if args and args[0].isdigit() else paths.self_nn()
    if not nn:
        print(json.dumps({"ok": False, "error": "사용자 번호를 알 수 없습니다"}, ensure_ascii=False))
        sys.exit(2)
    week = next((a for a in args if "-W" in a), None)
    try:
        r = run(nn, week, do_send="--send" in sys.argv)
        if r.get("preview"):
            print(f"제목: {r['subject']}")
            print(f"수신: {', '.join(r['to']) or '(미설정)'}"
                  + (f" · 참조: {', '.join(r['cc'])}" if r['cc'] else ""))
            print()
            print(r["body"])
        else:
            print(json.dumps(r, ensure_ascii=False))
    except FileNotFoundError:
        print(json.dumps({"ok": False, "error": "초안 파일이 없습니다"}, ensure_ascii=False))
        sys.exit(1)

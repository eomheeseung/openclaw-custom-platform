#!/usr/bin/env python3
"""초안 카드 블록을 **완성된 문자열로** 내준다.

비서에게 "JSON 을 읽어서 카드로 감싸라" 고 지시하면 지키지 않는다(실측: 매 실행마다 결과가 달랐다.
어떤 회차는 카드 대신 메일 본문을 썼고, 어떤 회차는 소속을 "AI팀" 으로 지어냈다).
그래서 붙여넣기만 하면 되는 형태로 만들어 준다 — 재작성할 여지를 남기지 않는다.

사용법: `python3 card.py 02` → ```work-draft … ``` 블록을 그대로 출력
"""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
import week_util


def card(nn, week=None):
    week = week or week_util.week_label(datetime.now().strftime("%Y-%m-%d"))
    path = f"{paths.data_dir(nn)}/work-report/drafts/draft-{week}.json"
    d = json.load(open(path))
    body = json.dumps(d, ensure_ascii=False, indent=2)
    return f"```work-draft\n{body}\n```"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("사용법: card.py <userNN> [주차]")
        sys.exit(2)
    try:
        print(card(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
    except FileNotFoundError:
        print("초안 파일이 없습니다. 먼저 초안을 생성하세요.")
        sys.exit(1)

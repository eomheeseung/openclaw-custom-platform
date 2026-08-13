#!/usr/bin/env python3
"""실행 환경(호스트/컨테이너) 경로 해석 + 사업 마스터 로더.

- 스크립트는 컨테이너 안(gog·dooray CLI 위치)에서 돌지만, 테스트는 호스트에서 돈다.
- businesses.json 은 호스트 공용 파일이라 컨테이너에 마운트되지 않는다 →
  단일 진실원인 automap-api 를 HTTP 로 읽고, 안 되면 파일로 폴백한다.
"""
import json
import os
import urllib.request

API_URLS = [
    "http://172.18.0.1:18799/api/work-report/businesses",  # 컨테이너 → 호스트 게이트웨이
    "http://localhost:18799/api/work-report/businesses",   # 호스트
]
FILE_FALLBACK = "/opt/openclaw/data/businesses.json"


def in_container():
    return os.path.isdir("/home/node/.openclaw")


def self_nn():
    """이 컨테이너의 사용자 번호. `OPENCLAW_GATEWAY_TOKEN=tc-user02` 에서 뽑는다.

    스크립트가 스스로 알아내지 못하면 에이전트가 환경변수·cron 설정·소스를 뒤지며
    한참을 헤맨다(실측: 웹에서 직접 대화할 때 번호를 몰라 탐색만 수 분).
    """
    import re
    m = re.search(r"user(\d{1,2})", os.environ.get("OPENCLAW_GATEWAY_TOKEN", ""))
    return m.group(1).zfill(2) if m else None


def data_dir(nn):
    """userNN 데이터 루트. 컨테이너에서는 bind mount 라 nn 무관."""
    return "/home/node/.openclaw" if in_container() else f"/opt/openclaw/data/user{nn}"


def load_master():
    """businesses.json 문서 전체 (all_access 포함)."""
    urls = API_URLS if in_container() else list(reversed(API_URLS))
    for u in urls:
        try:
            with urllib.request.urlopen(u, timeout=5) as r:
                d = json.loads(r.read().decode())
                if d.get("ok"):
                    return d
        except Exception:
            continue
    try:
        return json.load(open(FILE_FALLBACK))
    except Exception:
        return {}


def load_businesses():
    urls = API_URLS if in_container() else list(reversed(API_URLS))
    for u in urls:
        try:
            with urllib.request.urlopen(u, timeout=5) as r:
                d = json.loads(r.read().decode())
                if d.get("ok"):
                    return d.get("businesses", [])
        except Exception:
            continue
    try:
        return json.load(open(FILE_FALLBACK)).get("businesses", [])
    except Exception:
        return []

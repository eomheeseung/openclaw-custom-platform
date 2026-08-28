#!/usr/bin/env python3
"""
SR 시스템에서 지정 기간의 SR 목록을 조회한다.

사용:
  python3 sr_fetch.py <project_id> 2026-07-13 2026-07-17
  python3 sr_fetch.py e-jinro-support 2026-07-13 2026-07-17

인증 (사업별):
  /home/node/.openclaw/business-report/{project_id}/auth.env
    - SR_BASE_URL=https://sr.tideflo.work
    - SR_TENANT=<slug>          (API 경로 /api/{tenant}/sr)
    - SR_API_TOKEN=srt_<64hex>  (있으면 이걸 사용)
    - SR_COOKIE=<ci_session>    (임시 폴백)

출력:
  stdout에 JSON: { "ok": true, "range": {...}, "count": N, "items": [...] }
  실패 시 exit code 2 + 원인
"""
import sys
import os
import re
import json
import urllib.request
import urllib.error
import urllib.parse
from html.parser import HTMLParser
from datetime import datetime, date, timedelta

STATUS_OPEN = {'신규', '분류됨', '대기', '진행중'}
STATUS_CLOSED = {'해결됨', '종료'}


def parse_iso_date(s):
    """SR API 반환 형식: '2026-07-15T13:41:13+09:00' 또는 '2026-07-15' → date"""
    if not s:
        return None
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def classify_items(items, week_from, week_to):
    """SR 리스트를 상태 · closed_at 기준으로 분류.
    - 신규/분류됨/대기        → planned
    - 진행중                 → planned + work_items_in_progress
    - 해결됨/종료 (주간 내)   → progress + work_items_completed
    - 해결됨/종료 (주간 밖)   → drop
    반환: { kept_items, classified }
    kept_items: sr-table 카드에 보여줄 items (drop 제외)
    classified: draft-card 용
    """
    wf = parse_iso_date(week_from)
    wt = parse_iso_date(week_to)

    kept = []
    progress = []
    planned = []
    work_completed = []
    work_in_progress = []

    for it in items:
        status = (it.get('status') or '').strip()

        if status in STATUS_OPEN:
            kept.append(it)
            planned.append(it)
            if status == '진행중':
                work_in_progress.append(it)
        elif status in STATUS_CLOSED:
            # 해결됨 SR 은 closed_at 이 None 일 수 있음 → updated_at 으로 fallback
            closed = parse_iso_date(it.get('closed_at') or '') or parse_iso_date(it.get('updated_at') or '')
            if wf and wt and closed and wf <= closed <= wt:
                kept.append(it)
                progress.append(it)
                work_completed.append(it)
            # 주간 밖에 종료된 SR 은 drop
        else:
            # 알 수 없는 상태 · 안전하게 kept 에만 포함 (sr-table 에는 보임 · 자동 분류 X)
            kept.append(it)

    # work_items 순서: 완료 먼저 → 진행중 다음 (D1)
    work_items_ordered = (
        [{'sr_no': it.get('sr_no'), 'title': it.get('title'), 'status_ko': it.get('status'), 'work_status': '작업완료'} for it in work_completed]
        + [{'sr_no': it.get('sr_no'), 'title': it.get('title'), 'status_ko': it.get('status'), 'work_status': '진행중'} for it in work_in_progress]
    )
    return {
        'items': kept,
        'classified': {
            'progress': progress,
            'planned': planned,
            'work_items': work_items_ordered,
        },
    }


def year_ago_iso(week_to):
    """week_to 기준 1년 전 (넉넉한 fetch range 시작점)"""
    wt = parse_iso_date(week_to)
    if not wt:
        return '2020-01-01'
    return (wt - timedelta(days=365)).isoformat()


BR_ROOT = '/home/node/.openclaw/business-report'

def project_auth_path(project_id):
    return f'{BR_ROOT}/{project_id}/auth.env'


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    return env


def fetch(url, headers, timeout=20):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode('utf-8', errors='replace')


class SRListParser(HTMLParser):
    """SR 목록 페이지 HTML → 항목 리스트.
    실제 마크업: <tr class="sr-row" data-href="/sports/sr/{id}"><td class="col-*">…</td>…</tr>
    """
    COLS = {
        'col-srno': 'sr_no',
        'col-subject': 'title',
        'col-requester': 'requester',
        'col-status': 'status',
        'col-priority': 'priority',
        'col-created': 'created_at',
        'col-updated': 'updated_at',
        'col-closed': 'closed_at',
        'col-channel': 'channel',
    }

    def __init__(self):
        super().__init__()
        self.items = []
        self._row = None
        self._current_col_key = None
        self._text_buf = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        classes = d.get('class', '').split()
        if tag == 'tr' and 'sr-row' in classes:
            self._row = {}
            href = d.get('data-href', '')
            m = re.search(r'/sports/sr/(\d+)', href)
            if m:
                self._row['id'] = int(m.group(1))
        elif tag == 'td' and self._row is not None:
            self._current_col_key = None
            for cls in classes:
                if cls in self.COLS:
                    self._current_col_key = self.COLS[cls]
                    break
            self._text_buf = []

    def handle_endtag(self, tag):
        if tag == 'td' and self._current_col_key is not None:
            txt = re.sub(r'\s+', ' ', ''.join(self._text_buf)).strip()
            self._row[self._current_col_key] = txt
            self._current_col_key = None
        elif tag == 'tr' and self._row is not None:
            if self._row.get('sr_no', '').startswith('SR-'):
                self.items.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._current_col_key is not None:
            self._text_buf.append(data)


def parse_list_html(html):
    p = SRListParser()
    p.feed(html)
    return p.items


def fetch_detail(base, headers, sr_id):
    """SR 상세 조회 (내용/이력 필요할 때)"""
    url = f'{base}/sports/sr/{sr_id}'
    status, html = fetch(url, headers)
    return {'status': status, 'raw_html_len': len(html)}


def main():
    if len(sys.argv) < 4:
        print(json.dumps({'ok': False, 'error': 'usage: sr_fetch.py <project_id> <from> <to> [--with-detail]'}, ensure_ascii=False))
        sys.exit(2)

    project_id = sys.argv[1]
    date_from = sys.argv[2]
    date_to = sys.argv[3]
    with_detail = '--with-detail' in sys.argv

    auth_path = project_auth_path(project_id)
    if not os.path.exists(auth_path):
        print(json.dumps({'ok': False, 'error': f'사업 {project_id} 인증 파일 없음 ({auth_path})'}, ensure_ascii=False))
        sys.exit(2)

    env = load_env(auth_path)
    base = env.get('SR_BASE_URL', 'https://sr.tideflo.work').rstrip('/')
    tenant = env.get('SR_TENANT', '').strip()
    api_token = env.get('SR_API_TOKEN', '').strip()
    cookie = env.get('SR_COOKIE', '').strip()

    if api_token:
        if not tenant:
            print(json.dumps({'ok': False, 'error': 'SR_TENANT 값이 필요합니다 (예: sports)', 'via': 'api'}, ensure_ascii=False))
            sys.exit(2)
        headers = {'Authorization': f'Bearer {api_token}', 'Accept': 'application/json'}
        # 넉넉한 range (1년 전 ~ 주간 금요일) 로 조회 → 클라이언트에서 status·closed_at 기반 분류
        # 이유: SR API 가 status 필터 안 함 · updated_at 만 기준으로 하면 오래 진행중 SR 놓침
        fetch_from = year_ago_iso(date_to)
        url = f'{base}/api/{tenant}/sr?date_field=created_at&from={fetch_from}&to={date_to}&limit=500'
        try:
            status_code, body = fetch(url, headers)
            if status_code == 401:
                print(json.dumps({'ok': False, 'error': '토큰이 유효하지 않거나 폐기됨(401). SR 마이페이지에서 재발급 후 SR_API_TOKEN 갱신.', 'via': 'api'}, ensure_ascii=False))
                sys.exit(2)
            if status_code != 200:
                print(json.dumps({'ok': False, 'error': f'HTTP {status_code}', 'via': 'api', 'detail': body[:300]}, ensure_ascii=False))
                sys.exit(2)
            data = json.loads(body)
            raw_items = data.get('items', [])
            result = classify_items(raw_items, date_from, date_to)
            print(json.dumps({
                'ok': True,
                'via': 'api',
                'range': {'from': date_from, 'to': date_to},
                'fetch_range': {'from': fetch_from, 'to': date_to},
                'raw_count': len(raw_items),
                'count': len(result['items']),
                'items': result['items'],
                'classified': result['classified'],
            }, ensure_ascii=False))
            return
        except (urllib.error.URLError, json.JSONDecodeError) as e:
            print(json.dumps({'ok': False, 'error': str(e), 'via': 'api'}, ensure_ascii=False))
            sys.exit(2)

    if not cookie:
        print(json.dumps({'ok': False, 'error': 'SR_COOKIE / SR_API_TOKEN 둘 다 미설정'}, ensure_ascii=False))
        sys.exit(2)

    # 임시: 쿠키 방식으로 HTML 파싱
    headers = {
        'Cookie': f'ci_session={cookie}',
        'User-Agent': 'TideClawWeeklyReport/0.1',
        'Accept': 'text/html,application/xhtml+xml',
    }
    # 실제 필터 파라미터: from, to, perPage (SR 목록 페이지 <form>에서 확인)
    qs = urllib.parse.urlencode({
        'perPage': 100,
        'from': date_from,
        'to': date_to,
    })
    url = f'{base}/sports/sr?{qs}'
    try:
        status, html = fetch(url, headers)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e), 'via': 'cookie'}, ensure_ascii=False))
        sys.exit(2)

    if status in (301, 302) or 'login' in html.lower()[:2000]:
        print(json.dumps({
            'ok': False,
            'error': '세션 만료 추정. sr.env의 SR_COOKIE를 갱신하세요.',
            'via': 'cookie',
            'status': status,
        }, ensure_ascii=False))
        sys.exit(2)

    if status != 200:
        print(json.dumps({'ok': False, 'error': f'HTTP {status}', 'via': 'cookie'}, ensure_ascii=False))
        sys.exit(2)

    items = parse_list_html(html)

    if with_detail:
        for it in items:
            if it.get('id'):
                it['detail'] = fetch_detail(base, headers, it['id'])

    print(json.dumps({
        'ok': True,
        'via': 'cookie',
        'range': {'from': date_from, 'to': date_to},
        'count': len(items),
        'items': items,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()

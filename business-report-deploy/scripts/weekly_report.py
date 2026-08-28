#!/usr/bin/env python3
"""
사업 주간보고 오케스트레이터. 다중 사업 지원.

사용:
  # 사업 목록
  python3 weekly_report.py projects

  # 이번 주 SR 조회 (project_id 지정)
  python3 weekly_report.py this-week <project_id>
  python3 weekly_report.py week <project_id> 2026-07-13 2026-07-17

  # hwpx 생성
  python3 weekly_report.py build <project_id> <draft.json>

주차: 월~금
"""
import sys
import os
import json
import subprocess
import re
from datetime import date, timedelta


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BR_ROOT = '/home/node/.openclaw/business-report'
OUTPUT_ROOT = '/home/node/documents/business-report/output'


# ── 어휘 기반 오탈자 교정 ─────────────────────────────
# 원인: Moonshot Kimi 계열 (K2·K3) 이 특정 한글 단어를 토크나이저 문제로 손상시켜 출력함
# 예: "아카데미" → "아침미"·"아침데미"·"아침이디" 등으로 왜곡
# 해결: 프로젝트 meta 어휘 + 공통 어휘 를 기준으로 Levenshtein 거리 임계 안이면 자동 교정
COMMON_VOCAB = [
    # 주간보고 관용어
    '진행사항', '예정사항', '참고사항', '주간보고', '작업항목', '주요과업',
    '진행중', '완료', '종료', '해결됨', '신규', '대기', '분류됨', '작업완료',
    '이번주', '다음주', '지난주', '이번주차', '다음주차',
    # ⚠ 아래는 '교정 대상' 이 아니라 '건드리지 말 것' 목록이다.
    # vocab 에 있는 단어는 _correct_word 가 그대로 돌려준다.
    # 없으면 '주차'→'이번주차', '주간보고서'→'주간보고' 로 멀쩡한 말이 망가진다(실측).
    '주차', '주간보고서', '보고서', '주간',
    '홈페이지', '유지보수', '개선', '주식회사', '타이드플로', '수행사',
]


def _levenshtein(a, b):
    """편집 거리 계산 (문자 삽입·삭제·대체)."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def _extract_vocab_from_meta(meta):
    """meta.json 의 name·org·vendor 에서 한글 어휘 추출 (2자 이상)."""
    vocab = list(COMMON_VOCAB)
    if not meta:
        return vocab
    text_parts = [
        meta.get('name', ''),
        meta.get('org', ''),
        meta.get('vendor', ''),
        meta.get('subtitle', ''),
    ]
    for text in text_parts:
        if not text:
            continue
        # 한글 2자 이상 단어 추출 (숫자·공백·특수문자로 분리)
        for word in re.findall(r'[가-힣]{2,}', text):
            if word not in vocab:
                vocab.append(word)
    return vocab


def _correct_word(word, vocab, max_ratio=0.5):
    """단어 하나 교정. vocab 안에 유사한 단어 있으면 그거로 대체.
    두 가지 기준 (둘 중 하나 만족):
      1. 편집거리 <= len(target) * max_ratio
      2. 첫글자 + 끝글자 모두 일치 AND 길이 차이 <= 3 (강한 경계 매칭)
    """
    if not word or len(word) < 2:
        return word
    if word in vocab:
        return word
    best = None
    best_dist = None
    best_boundary = False
    for target in vocab:
        if abs(len(target) - len(word)) > 3:
            continue
        # 최소 한쪽 경계라도 같아야 후보 (완전 무관 단어 오탐 방지)
        boundary_match = (word[0] == target[0]) and (word[-1] == target[-1])
        edge_match = (word[0] == target[0]) or (word[-1] == target[-1])
        if not edge_match:
            continue
        d = _levenshtein(word, target)
        # 편집거리 임계 안 · 또는 양쪽 경계 다 일치 (경계 매칭이 강하면 편집거리 더 허용)
        threshold = max(1, int(len(target) * max_ratio))
        if boundary_match:
            threshold = max(threshold, len(target) - 1)  # 경계 확실하면 안쪽 대부분 달라도 OK
        if d > threshold:
            continue
        # 최고 후보 갱신 (경계 매칭 우선 · 그다음 편집거리)
        if best is None or (boundary_match and not best_boundary) or (boundary_match == best_boundary and d < best_dist):
            best = target
            best_dist = d
            best_boundary = boundary_match
    return best if best is not None else word


def correct_text(text, vocab):
    """텍스트 안의 한글 단어들 교정. 다른 문자·공백·조사 등은 그대로 유지."""
    if not text or not vocab:
        return text
    def repl(m):
        return _correct_word(m.group(0), vocab)
    return re.sub(r'[가-힣]{2,}', repl, text)


def correct_draft_data(draft, meta):
    """draft.json 안의 progress·planned·remarks·work_items 텍스트 필드 교정."""
    vocab = _extract_vocab_from_meta(meta)

    def fix_list(lst):
        if not isinstance(lst, list):
            return lst
        fixed = []
        for it in lst:
            if isinstance(it, str):
                fixed.append(correct_text(it, vocab))
            elif isinstance(it, dict):
                new = dict(it)
                for key in ('text', 'title'):
                    if isinstance(new.get(key), str):
                        new[key] = correct_text(new[key], vocab)
                if isinstance(new.get('details'), list):
                    new['details'] = [correct_text(x, vocab) if isinstance(x, str) else x for x in new['details']]
                fixed.append(new)
            else:
                fixed.append(it)
        return fixed

    for key in ('progress', 'planned', 'remarks', 'work_items'):
        if key in draft:
            draft[key] = fix_list(draft[key])
    # title · period · business_name 도 교정
    for key in ('title', 'business_name'):
        if isinstance(draft.get(key), str):
            draft[key] = correct_text(draft[key], vocab)
    return draft
# ─────────────────────────────────────────────


def load_manifest():
    path = f'{BR_ROOT}/projects.json'
    if not os.path.exists(path):
        return {'projects': [], 'default': None}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def load_project_meta(project_id):
    path = f'{BR_ROOT}/{project_id}/meta.json'
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def project_template(project_id):
    return f'{BR_ROOT}/{project_id}/template.hwpx'


def week_range(anchor=None):
    d = anchor or date.today()
    monday = d - timedelta(days=d.weekday())
    friday = monday + timedelta(days=4)
    return monday, friday


def week_of_month_iso(monday: date):
    """ISO 4일 규칙: 그 주의 목요일이 속한 월의 몇 주차.
    반환: (year, month, week_no)
    """
    thursday = monday + timedelta(days=3)
    y, m = thursday.year, thursday.month
    # 그 월의 첫 주 = 그 월의 첫 목요일이 포함된 주 (그 주의 월요일)
    first_of_month = date(y, m, 1)
    # 그 월의 첫 목요일
    first_thu_offset = (3 - first_of_month.weekday()) % 7
    first_thu = first_of_month + timedelta(days=first_thu_offset)
    first_mon_of_wk1 = first_thu - timedelta(days=3)
    week_no = ((monday - first_mon_of_wk1).days // 7) + 1
    return y, m, week_no


def week_of_month_label(monday: date) -> str:
    y, m, wk = week_of_month_iso(monday)
    fri = monday + timedelta(days=4)
    return f'{y}년 {m}월 {wk}주차 ({monday.month}/{monday.day}~{fri.month}/{fri.day})'


def monday_of_week_num(year: int, month: int, week_no: int) -> date:
    """ISO 4일 규칙 역변환: (year, month, week_no) → 그 주의 월요일.
    예: (2026, 7, 2) → 2026-07-06 (7월 2주차 = 7/6~7/10)
    """
    first_of_month = date(year, month, 1)
    first_thu_offset = (3 - first_of_month.weekday()) % 7
    first_thu = first_of_month + timedelta(days=first_thu_offset)
    first_mon_of_wk1 = first_thu - timedelta(days=3)
    return first_mon_of_wk1 + timedelta(days=(week_no - 1) * 7)


def cmd_projects():
    m = load_manifest()
    out = {'default': m.get('default'), 'projects': []}
    for pid in m.get('projects', []):
        meta = load_project_meta(pid)
        if meta:
            out['projects'].append(meta)
    print(json.dumps(out, ensure_ascii=False))


def cmd_fetch(project_id, from_str, to_str):
    result = subprocess.run(
        ['python3', os.path.join(SCRIPT_DIR, 'sr_fetch.py'), project_id, from_str, to_str],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(result.stdout or result.stderr, file=sys.stderr)
        sys.exit(result.returncode)
    print(result.stdout)


def substitute_week_in_filename(original, monday):
    """원본 파일명에서 주차/날짜 패턴을 이번 주로 치환 (ISO 4일 규칙).
    감지 성공 시 (치환된 파일명, 감지된 패턴, 치환 결과) 튜플 반환.
    감지 실패 시 (None, None, None) 반환.
    """
    year, month_no, week_no = week_of_month_iso(monday)

    patterns = [
        # 1. 연도포함: 2026년 7월 2주차
        (r'\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*주차', f'{year}년 {month_no}월 {week_no}주차'),
        # 2. 연도없이: 7월 2주차
        (r'\d{1,2}\s*월\s*\d{1,2}\s*주차', f'{month_no}월 {week_no}주차'),
        # 3. ISO 날짜: 2026-07-13
        (r'\d{4}-\d{2}-\d{2}', monday.strftime('%Y-%m-%d')),
        # 4. 점 구분 날짜: 2026.07.13
        (r'\d{4}\.\d{2}\.\d{2}', monday.strftime('%Y.%m.%d')),
    ]
    for pattern, replacement in patterns:
        if re.search(pattern, original):
            new_name = re.sub(pattern, replacement, original)
            return (new_name, pattern, replacement)
    return (None, None, None)


def cmd_build(project_id, draft_path):
    meta = load_project_meta(project_id)
    if not meta:
        print(json.dumps({'ok': False, 'error': f'unknown project: {project_id}'}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)

    with open(draft_path, encoding='utf-8') as f:
        draft = json.load(f)

    # LLM 토크나이저 오탈자 자동 교정 (아침미 → 아카데미 등)
    draft = correct_draft_data(draft, meta)
    # 교정된 draft 를 임시 파일에 저장해서 hwpx_gen 에 넘김
    corrected_draft_path = draft_path + '.corrected.json'
    with open(corrected_draft_path, 'w', encoding='utf-8') as f:
        json.dump(draft, f, ensure_ascii=False)

    period = draft.get('period', '')
    m = re.match(r'(\d{4})[.\s-]+(\d{1,2})[.\s-]+(\d{1,2})\s*~\s*(\d{4})[.\s-]+(\d{1,2})[.\s-]+(\d{1,2})', period)
    monday = None
    if m:
        y, mo, dstart, _, _, _ = m.groups()
        monday = date(int(y), int(mo), int(dstart))

    # 원본 파일명 규칙 시도
    output_filename = None
    original_fn = meta.get('template_original_filename')
    if original_fn and monday:
        substituted, _, _ = substitute_week_in_filename(original_fn, monday)
        if substituted:
            output_filename = substituted

    # 폴백: 기본 규칙
    if not output_filename:
        if monday:
            label = week_of_month_label(monday)
            fn_label = label.replace(' ', '_').replace('/', '-')
        else:
            fn_label = 'weekly'
        business = draft.get('business_name') or meta.get('name', project_id)
        output_filename = f'[{business}] {fn_label}.hwpx'

    # ⚠ 파일명에는 교정을 돌리지 않는다.
    # 파일명은 템플릿 원본(사람이 지은 이름) + 계산된 주차 숫자로 조립된다 — 모델이
    # 만든 문장이 아니라 교정할 대상이 아니다. 돌렸더니 오히려 망가졌다(실측 2026-08-28:
    # "8월 4주차 주간보고서" → "8월 4이번주차 주간보고" 로 몇 주째 잘못 생성되고 있었다).

    out_dir = os.path.join(OUTPUT_ROOT, project_id)
    os.makedirs(out_dir, exist_ok=True)
    output = os.path.join(out_dir, output_filename)

    template = project_template(project_id)
    if not os.path.exists(template):
        print(json.dumps({'ok': False, 'error': f'template 없음: {template}'}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)

    result = subprocess.run(
        ['python3', os.path.join(SCRIPT_DIR, 'hwpx_gen.py'), template, output, corrected_draft_path],
        capture_output=True, text=True
    )
    # 임시 파일 정리
    try:
        os.remove(corrected_draft_path)
    except OSError:
        pass
    if result.returncode != 0:
        print(result.stdout or result.stderr, file=sys.stderr)
        sys.exit(result.returncode)
    print(result.stdout)


def main():
    if len(sys.argv) < 2:
        print('usage: weekly_report.py [projects | this-week <pid> | week <pid> <from> <to> | build <pid> <draft.json>]')
        sys.exit(2)

    sub = sys.argv[1]

    if sub == 'projects':
        cmd_projects()

    elif sub == 'this-week' and len(sys.argv) >= 3:
        pid = sys.argv[2]
        mon, fri = week_range()
        print(json.dumps({
            'project_id': pid,
            'monday': mon.isoformat(),
            'friday': fri.isoformat(),
            'label': week_of_month_label(mon),
        }, ensure_ascii=False))
        cmd_fetch(pid, mon.isoformat(), fri.isoformat())

    elif sub == 'week' and len(sys.argv) >= 5:
        from_str, to_str = sys.argv[3], sys.argv[4]
        y, m, d = [int(x) for x in from_str.split('-')]
        mon = date(y, m, d)
        print(json.dumps({
            'project_id': sys.argv[2],
            'monday': from_str,
            'friday': to_str,
            'label': week_of_month_label(mon),
        }, ensure_ascii=False))
        cmd_fetch(sys.argv[2], from_str, to_str)

    elif sub == 'week-num' and len(sys.argv) >= 6:
        # weekly_report.py week-num <project_id> <year> <month> <weekno>
        # ISO 4일 규칙으로 (year, month, weekno) → monday/friday 계산 · SR 조회까지
        pid = sys.argv[2]
        year, month, week_no = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
        mon = monday_of_week_num(year, month, week_no)
        fri = mon + timedelta(days=4)
        print(json.dumps({
            'project_id': pid,
            'monday': mon.isoformat(),
            'friday': fri.isoformat(),
            'label': week_of_month_label(mon),
        }, ensure_ascii=False))
        cmd_fetch(pid, mon.isoformat(), fri.isoformat())

    elif sub == 'build' and len(sys.argv) >= 4:
        cmd_build(sys.argv[2], sys.argv[3])

    else:
        print('usage: weekly_report.py [projects | this-week <pid> | week <pid> <from> <to> | week-num <pid> <year> <month> <weekno> | build <pid> <draft.json>]')
        sys.exit(2)


if __name__ == '__main__':
    main()
